import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { probePublicHealth, restoreWorkspace } from "../src/process/recovery.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { namedTunnelProtocolArgs } from "../src/tunnel/protocol.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

class ManagedNamedTunnelStub implements TunnelProvider {
  readonly name = "cloudflare-named";
  starts = 0;
  restarts = 0;
  stops = 0;
  running = false;
  processRunning = false;
  connected = false;
  url: string | null = null;

  constructor(private readonly targetUrl = "https://c2c-demo.example.com") {}

  async start(): Promise<string> {
    this.starts += 1;
    this.running = true;
    this.processRunning = true;
    this.connected = true;
    this.url = this.targetUrl;
    return this.targetUrl;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
    this.processRunning = false;
    this.connected = false;
    this.url = null;
  }

  async restart(): Promise<string> {
    this.restarts += 1;
    this.running = true;
    this.processRunning = true;
    this.connected = true;
    this.url = this.targetUrl;
    return this.targetUrl;
  }

  status(): TunnelStatus {
    return {
      running: this.running,
      url: this.url,
      provider: this.name,
      processRunning: this.processRunning,
      connected: this.connected,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake-cloudflared",
      running: this.running,
      url: this.url,
      problems: [],
    };
  }
}

const dirs: string[] = [];
const previousEnv = {
  C2C_STATE_DIR: process.env.C2C_STATE_DIR,
  C2C_TUNNEL_PROTOCOL: process.env.C2C_TUNNEL_PROTOCOL,
  C2C_TUNNEL_KEEP_PROXY: process.env.C2C_TUNNEL_KEEP_PROXY,
  TUNNEL_ORIGIN_CERT: process.env.TUNNEL_ORIGIN_CERT,
  TUNNEL_CRED_FILE: process.env.TUNNEL_CRED_FILE,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
};

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
  while (dirs.length) cleanup(dirs.pop()!);
  for (const key of Object.keys(previousEnv) as Array<keyof typeof previousEnv>) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Named Tunnel self-healing and resilience", () => {
  it("defaults Named Tunnel protocol to http2 while preserving explicit C2C_TUNNEL_PROTOCOL overrides", () => {
    expect(namedTunnelProtocolArgs({}, null)).toEqual([]);
    expect(namedTunnelProtocolArgs({}, "http2")).toEqual(["--protocol", "http2"]);
    expect(namedTunnelProtocolArgs({ C2C_TUNNEL_PROTOCOL: "quic" }, "http2")).toEqual(["--protocol", "quic"]);
  });

  it("applies defaultProtocol and strips proxy environment variables unless C2C_TUNNEL_KEEP_PROXY=1", async () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:7897";
    process.env.HTTPS_PROXY = "http://127.0.0.1:7897";
    process.env.ALL_PROXY = "socks5://127.0.0.1:7897";
    delete process.env.C2C_TUNNEL_PROTOCOL;

    const first = new FakeCloudflaredProcess();
    first.kill.mockImplementation(() => {
      first.exit(0);
      return true;
    });
    const second = new FakeCloudflaredProcess();
    second.kill.mockImplementation(() => {
      second.exit(0);
      return true;
    });
    spawnMock
      .mockImplementationOnce(() => first as unknown as ChildProcess)
      .mockImplementationOnce(() => second as unknown as ChildProcess);

    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-proxy-strip",
      hostname: "c2c-demo.example.com",
      binaryOverride: "fake-cloudflared",
      defaultProtocol: "http2",
      stripProxyEnv: true,
    });

    const p1 = tunnel.start(48_765);
    first.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await expect(p1).resolves.toBe("https://c2c-demo.example.com");

    const [, firstArgs, firstOpts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(firstArgs).toContain("--protocol");
    expect(firstArgs).toContain("http2");
    expect(firstOpts.env).toBeDefined();
    expect(firstOpts.env?.HTTP_PROXY).toBeUndefined();
    expect(firstOpts.env?.HTTPS_PROXY).toBeUndefined();
    expect(firstOpts.env?.ALL_PROXY).toBeUndefined();
    await tunnel.stop();

    process.env.C2C_TUNNEL_KEEP_PROXY = "1";
    const p2 = tunnel.start(48_765);
    second.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await expect(p2).resolves.toBe("https://c2c-demo.example.com");
    const [, , secondOpts] = spawnMock.mock.calls[1] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(secondOpts.env).toBeUndefined();
    await tunnel.stop();
  });

  it("auto-reconnects after an unexpected post-connection exit and cancels recovery on stop", async () => {
    vi.useFakeTimers();
    const first = new FakeCloudflaredProcess();
    first.kill.mockImplementation(() => {
      first.exit(0);
      return true;
    });
    const second = new FakeCloudflaredProcess();
    second.kill.mockImplementation(() => {
      second.exit(0);
      return true;
    });
    const children = [first, second];
    spawnMock.mockImplementation(() => children.shift() as unknown as ChildProcess);

    const stateEvents: Array<string | null> = [];
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-autoreconnect",
      hostname: "c2c-demo.example.com",
      binaryOverride: "fake-cloudflared",
      startTimeoutMs: 200,
      startupDeadlineMs: 1_000,
      retryBackoffMs: [10],
      maxAttempts: 2,
      stopWaitMs: 10,
      autoReconnect: true,
      reconnectBackoffMs: [25, 50],
      onStateChange: (url) => stateEvents.push(url),
    });

    const started = tunnel.start(48_765);
    await flushMicrotasks();
    first.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await expect(started).resolves.toBe("https://c2c-demo.example.com");
    expect(stateEvents).toEqual(["https://c2c-demo.example.com"]);

    // Runtime drop after initial connection must schedule an auto-reconnect.
    first.exit(1);
    await flushMicrotasks();
    expect(stateEvents).toEqual(["https://c2c-demo.example.com", null]);
    expect(tunnel.status()).toMatchObject({ running: false, connected: false, processRunning: false });

    await vi.advanceTimersByTimeAsync(24);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    second.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await flushMicrotasks();
    expect(tunnel.status()).toMatchObject({
      running: true,
      connected: true,
      processRunning: true,
      url: "https://c2c-demo.example.com",
    });
    expect(stateEvents).toEqual(["https://c2c-demo.example.com", null, "https://c2c-demo.example.com"]);

    // Intentional stop must NOT schedule a reconnect.
    second.kill.mockImplementation(() => {
      second.exit(0);
      return true;
    });
    await tunnel.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("stops auto-reconnect if a reconnect attempt hits a permanent credential failure", async () => {
    vi.useFakeTimers();
    const first = new FakeCloudflaredProcess();
    first.kill.mockImplementation(() => {
      first.exit(0);
      return true;
    });
    const second = new FakeCloudflaredProcess();
    second.kill.mockImplementation(() => {
      second.exit(0);
      return true;
    });
    const children = [first, second];
    spawnMock.mockImplementation(() => children.shift() as unknown as ChildProcess);

    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-perm-stop",
      hostname: "c2c-demo.example.com",
      binaryOverride: "fake-cloudflared",
      startTimeoutMs: 200,
      startupDeadlineMs: 1_000,
      stopWaitMs: 10,
      autoReconnect: true,
      reconnectBackoffMs: [15],
    });

    const started = tunnel.start(48_765);
    await flushMicrotasks();
    first.stderr.write("INF Registered tunnel connection connIndex=0\n");
    await expect(started).resolves.toBe("https://c2c-demo.example.com");

    first.exit(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(15);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    second.stderr.write("ERR HTTP 401 Unauthorized\n");
    second.exit(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("auto-starts Named Tunnel inside Bridge, restarts on persistent 1033, and respects manual stop", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-managed-named");
    dirs.push(root);
    write(root, "readme.txt", "managed named tunnel fixture\n");
    const workspace = new Workspace(root);
    const tunnelId = "44444444-4444-4444-4444-444444444444";

    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId,
      hostname: "c2c-demo.example.com",
      zone: "example.com",
    });
    process.env.TUNNEL_ORIGIN_CERT = write(root, "cert.pem", "fake cert");
    process.env.TUNNEL_CRED_FILE = write(
      root,
      "tunnel.json",
      JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "secret" })
    );

    const provider = new ManagedNamedTunnelStub();
    let edgeMode: "healthy" | "1033" = "healthy";
    const watchdogFetchImpl: typeof fetch = async () => {
      if (edgeMode === "1033") {
        return new Response("error 1033", {
          status: 530,
          headers: { server: "cloudflare", "cf-ray": "test-ray" },
        });
      }
      return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
    };

    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      tunnelProvider: provider,
      autoManageNamedTunnel: true,
      namedTunnelStartupDelayMs: 0,
      namedTunnelWatchdogIntervalMs: 30,
      watchdogFetchImpl,
    });

    try {
      await vi.waitFor(() => expect(provider.starts).toBe(1));
      expect(bridge.getPublicBaseUrl()).toBe("https://c2c-demo.example.com");

      edgeMode = "1033";
      await vi.waitFor(() => expect(provider.restarts).toBeGreaterThanOrEqual(1));
      edgeMode = "healthy";
      const restartsBeforeStop = provider.restarts;

      const stopRes = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/stop`, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(stopRes.status).toBe(200);
      edgeMode = "1033";
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(provider.starts).toBe(1);
      expect(provider.restarts).toBe(restartsBeforeStop);
    } finally {
      await bridge.close();
    }
  });

  it("cooperates with concurrent restoreWorkspace while Bridge-managed startup is in flight", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-managed-concurrent-restore");
    dirs.push(root);
    write(root, "readme.txt", "concurrent restore fixture\n");
    const workspace = new Workspace(root);
    const tunnelId = "55555555-5555-5555-5555-555555555555";

    writeTunnelState({
      workspaceId: workspace.id,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId,
      hostname: "c2c-demo.example.com",
      zone: "example.com",
    });
    process.env.TUNNEL_ORIGIN_CERT = write(root, "cert.pem", "fake cert");
    process.env.TUNNEL_CRED_FILE = write(
      root,
      "tunnel.json",
      JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "secret" })
    );
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48_765,
      publicUrl: "https://c2c-demo.example.com",
      mcpUrl: "https://c2c-demo.example.com/mcp",
    });

    const child = new FakeCloudflaredProcess();
    child.kill.mockImplementation(() => {
      child.exit(0);
      return true;
    });
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);

    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: `c2c-${workspace.id}`,
      hostname: "c2c-demo.example.com",
      binaryOverride: "fake-cloudflared",
      defaultProtocol: "http2",
    });

    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      tunnelProvider: tunnel,
      autoManageNamedTunnel: true,
      namedTunnelStartupDelayMs: 0,
      namedTunnelWatchdogIntervalMs: 0,
    });

    try {
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      expect(tunnel.status()).toMatchObject({ running: false, processRunning: true, connected: false });

      const restorePromise = restoreWorkspace(root, {
        fetchImpl: async () => new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 }),
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      child.stderr.write("INF Registered tunnel connection connIndex=0\n");

      const result = await restorePromise;
      expect(result).toMatchObject({
        ok: true,
        bridgeAction: "reused",
        tunnelAction: "started",
        reason: null,
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });

  it("retries transient ECONNRESET public health probes when retry delays are provided", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
      }
      return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
    };

    const single = await probePublicHealth("https://c2c-demo.example.com", async () => {
      throw Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(single).toMatchObject({ publicProbeStatus: "degraded", publicProbeError: "ECONNRESET" });

    const retried = await probePublicHealth("https://c2c-demo.example.com", fetchImpl, [1, 1]);
    expect(retried).toMatchObject({ publicProbeStatus: "healthy" });
    expect(calls).toBe(2);
  });
});
