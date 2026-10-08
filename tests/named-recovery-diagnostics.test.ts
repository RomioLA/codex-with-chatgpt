import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeInstanceLockFile } from "../src/bridge/instance-lock.js";
import { startBridge } from "../src/bridge/server.js";
import { findBridgeObservation, readRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { adminFetch } from "../src/process/daemon.js";
import { restoreWorkspace, type RecoveryAdminInfo, type RecoveryOptions } from "../src/process/recovery.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const NAMED_URL = "https://c2c-demo.example.com";
const QUICK_URL = "https://random-words.trycloudflare.com";
const TUNNEL_ID = "33333333-3333-3333-3333-333333333333";
const dirs: string[] = [];
const previousEnv = {
  C2C_STATE_DIR: process.env.C2C_STATE_DIR,
  TUNNEL_ORIGIN_CERT: process.env.TUNNEL_ORIGIN_CERT,
  TUNNEL_CRED_FILE: process.env.TUNNEL_CRED_FILE,
};

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

class RecoveryTunnel implements TunnelProvider {
  starts = 0;
  stops = 0;
  restarts = 0;
  statusOverrides: Partial<TunnelStatus> = {};
  running: boolean;
  url: string | null;
  connectOnStart = true;

  constructor(
    readonly name: "cloudflare-named" | "cloudflare-quick",
    initiallyRunning = false,
    initialUrl: string | null = null,
    private readonly startUrl: string | null = name === "cloudflare-named" ? NAMED_URL : QUICK_URL
  ) {
    this.running = initiallyRunning;
    this.url = initiallyRunning ? initialUrl ?? startUrl : null;
  }

  async start(): Promise<string> {
    this.starts += 1;
    this.running = this.connectOnStart;
    this.url = this.connectOnStart ? this.startUrl : null;
    if (!this.startUrl) return "";
    return this.startUrl;
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
    this.url = null;
  }

  async restart(): Promise<string> {
    this.restarts += 1;
    return this.start();
  }

  status(): TunnelStatus {
    return {
      running: this.running,
      url: this.running ? this.url : null,
      provider: this.name,
      processRunning: this.running,
      connected: this.running,
      ...this.statusOverrides,
    };
  }

  getPublicUrl(): string | null {
    return this.running ? this.url : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake-cloudflared",
      running: this.running,
      url: this.running ? this.url : null,
      problems: [],
    };
  }
}

function fixture(name: string, preference: "named" | "quick" = "named") {
  const stateDir = isolateStateDir();
  dirs.push(stateDir);
  const root = makeTmpDir(name);
  dirs.push(root);
  write(root, "readme.txt", "isolated restore fixture\n");
  const workspace = new Workspace(root);

  if (preference === "named") {
    writeTunnelState({
      workspaceId: workspace.id,
      preference,
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: `c2c-${workspace.id}`,
      tunnelId: TUNNEL_ID,
      hostname: "c2c-demo.example.com",
      zone: "example.com",
    });
    process.env.TUNNEL_ORIGIN_CERT = write(root, "cert.pem", "fake certificate marker");
    process.env.TUNNEL_CRED_FILE = write(
      root,
      "tunnel.json",
      JSON.stringify({ TunnelID: TUNNEL_ID, TunnelSecret: "test-secret" })
    );
    writeLastEndpoint({ workspaceId: workspace.id, port: 48765, publicUrl: NAMED_URL, mcpUrl: `${NAMED_URL}/mcp` });
  } else {
    writeTunnelState({ workspaceId: workspace.id, preference, provider: "cloudflare-quick" });
    writeLastEndpoint({ workspaceId: workspace.id, port: 48765, publicUrl: QUICK_URL, mcpUrl: `${QUICK_URL}/mcp` });
  }
  return { root, workspace, stateDir };
}

function namedTunnel(timeoutMs = 60_000): CloudflaredNamedTunnel {
  return new CloudflaredNamedTunnel({
    tunnelName: "c2c-test",
    hostname: "c2c-demo.example.com",
    binaryOverride: "fake-cloudflared",
    startTimeoutMs: timeoutMs,
  });
}

function startFakeTunnelProcess(tunnel: CloudflaredNamedTunnel, child: FakeCloudflaredProcess): Promise<string> {
  spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
  return tunnel.start(48_765);
}

function announceNamedConnection(child: FakeCloudflaredProcess): void {
  child.stderr.write("INF Registered tunnel connection connIndex=0\n");
}

const healthyFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });

const resetFetch: typeof fetch = async () => {
  const error = Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
  throw error;
};

const unavailableFetch: typeof fetch = async () => new Response("unavailable", { status: 503 });

function adminInfo(runtime: RuntimeState, workspace: Workspace, tunnel: TunnelStatus): RecoveryAdminInfo {
  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceRoot: workspace.root,
    port: runtime.port,
    publicUrl: tunnel.url,
    tunnel,
    tokenCount: 0,
    pairingActive: false,
    pid: runtime.pid,
    startedAt: runtime.startedAt,
    permissionMode: "readonly",
  };
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

describe("Named Tunnel recovery diagnostics", () => {
  it("keeps a connected Named Tunnel running when the public self-probe gets ECONNRESET", async () => {
    const { root, workspace } = fixture("named-probe-degraded");
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    announceNamedConnection(child);
    await expect(starting).resolves.toBe(NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const runtimeBefore = readRuntimeState(workspace.id);
      const lockBefore = fs.readFileSync(bridgeInstanceLockFile(workspace.id), "utf8");
      const before = await findBridgeObservation(workspace.id);
      expect(before.state).toBe("healthy");

      const probeFetch = vi.fn(resetFetch);
      const result = await restoreWorkspace(root, { fetchImpl: probeFetch });
      const after = await findBridgeObservation(workspace.id);

      expect(result).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "reused", reason: null });
      expect(result.diagnostics.publicProbe.publicProbeStatus).toBe("degraded");
      expect(result.diagnostics.publicProbe.publicProbeError).toBe("ECONNRESET");
      expect(result.diagnostics.publicProbe.checkedAt).toEqual(expect.any(String));
      expect(result.diagnostics.recovery).toMatchObject({ status: "healthy", reason: null });
      expect(tunnel.status()).toMatchObject({ running: true, connected: true, processRunning: true, url: NAMED_URL });
      expect(probeFetch).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
      expect(after).toMatchObject({ state: "healthy", runtime: before.runtime });
      expect(readRuntimeState(workspace.id)).toEqual(runtimeBefore);
      expect(fs.readFileSync(bridgeInstanceLockFile(workspace.id), "utf8")).toBe(lockBefore);
      expect(JSON.stringify(result)).not.toContain("test-secret");
      await expect(startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel })).rejects.toThrow(/refusing to start another Bridge/i);
    } finally {
      await bridge.close();
    }
  });

  it("reports a passing public self-probe as healthy and reuses the connected tunnel", async () => {
    const { root, workspace } = fixture("named-probe-healthy");
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    announceNamedConnection(child);
    await expect(starting).resolves.toBe(NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "reused", reason: null });
      expect(result.diagnostics.publicProbe.publicProbeStatus).toBe("healthy");
      expect(result.diagnostics.recovery).toMatchObject({ status: "healthy", reason: null });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });

  it("fails closed for an existing Named Tunnel process that has not connected and does not spawn another", async () => {
    const { root, workspace } = fixture("named-process-unconfirmed");
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    void starting.catch(() => undefined);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(tunnel.status()).toMatchObject({ running: false, processRunning: true, connected: false, url: null });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      child.exitCode = 1;
      child.exit(1);
      await starting.catch(() => undefined);
      await bridge.close();
    }
  });

  it("turns a Named Tunnel start timeout into a hard recovery failure through the real admin route", async () => {
    const { root } = fixture("named-start-timeout");
    const child = new FakeCloudflaredProcess();
    spawnMock.mockImplementationOnce(() => child as unknown as ChildProcess);
    const tunnel = namedTunnel(35);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      await bridge.close();
    }
  });

  it("turns a pre-connection child exit into a hard recovery failure through the real admin route", async () => {
    const { root } = fixture("named-start-exits-early");
    const child = new FakeCloudflaredProcess();
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => {
        child.exitCode = 1;
        child.exit(1);
      });
      return child as unknown as ChildProcess;
    });
    const tunnel = namedTunnel();
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });

  it("fails after the real start route returns a URL if the following admin info is still disconnected", async () => {
    const { root, workspace } = fixture("named-start-disconnected");
    const tunnel = new RecoveryTunnel("cloudflare-named", false);
    tunnel.connectOnStart = false;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(tunnel.starts).toBe(1);
      expect(tunnel.status()).toMatchObject({ running: false, connected: false, url: null });
    } finally {
      await bridge.close();
    }
  });

  it("fails when the Named start response contains no public URL", async () => {
    const { root } = fixture("named-start-no-url");
    const tunnel = new RecoveryTunnel("cloudflare-named", false, null, "");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(tunnel.starts).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it("fails closed for a legacy disconnected Named status whose process state is unknown", async () => {
    const { root, workspace } = fixture("named-legacy-process-unknown");
    const tunnel = new RecoveryTunnel("cloudflare-named");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const routes: string[] = [];
    try {
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("healthy");
      if (observation.state !== "healthy") throw new Error("Test Bridge did not become healthy.");
      const legacyTunnelStatus: TunnelStatus = { running: false, url: null, provider: "cloudflare-named" };
      const adminFetchImpl: NonNullable<RecoveryOptions["adminFetchImpl"]> = async <T = unknown>(
        runtime,
        method,
        route
      ): Promise<T> => {
        routes.push(`${method} ${route}`);
        if (method === "GET" && route === "/admin/info") {
          return adminInfo(runtime, workspace, legacyTunnelStatus) as T;
        }
        throw new Error(`Unexpected admin request ${method} ${route}`);
      };

      const result = await restoreWorkspace(root, { adminFetchImpl, fetchImpl: healthyFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedStateUnverified");
      expect(result.tunnelAction).toBe("failed");
      expect(routes.filter((route) => route === "POST /admin/tunnel/start")).toHaveLength(0);
      expect(tunnel.starts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("keeps a healthy stable URL in the connector while reporting public-probe degradation", async () => {
    const { root, workspace } = fixture("named-endpoint-mismatch");
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: 48765,
      publicUrl: "https://old.example.com",
      mcpUrl: "https://old.example.com/mcp",
    });
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    announceNamedConnection(child);
    await expect(starting).resolves.toBe(NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: resetFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("connectorEndpointChanged");
      expect(result.tunnelAction).toBe("failed");
      expect(result.diagnostics.publicProbe.publicProbeStatus).toBe("degraded");
      expect(result.diagnostics.connectorEndpointMatchesCurrent).toBe(false);
      expect(tunnel.status()).toMatchObject({ running: true, connected: true, url: NAMED_URL });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });

  it("keeps Quick Tunnel probe failures hard-failing and restarts through the Bridge admin route", async () => {
    const { root } = fixture("quick-probe-hard-failure", "quick");
    const tunnel = new RecoveryTunnel("cloudflare-quick", true, QUICK_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: unavailableFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("quickTunnelFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(tunnel.restarts).toBe(1);
      expect(tunnel.starts).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it.each([
    ["userinfo", "https://user:secret@c2c-demo.example.com"],
    ["explicit port", "https://c2c-demo.example.com:8443"],
    ["path", "https://c2c-demo.example.com/mcp"],
    ["query", "https://c2c-demo.example.com?token=value"],
    ["fragment", "https://c2c-demo.example.com#fragment"],
    ["other host", "https://other.example.com"],
  ])("rejects a Named start URL containing %s", async (_caseName, unsafeUrl) => {
    const { root } = fixture(`named-invalid-url-${_caseName}`);
    const tunnel = new RecoveryTunnel("cloudflare-named", false, null, unsafeUrl);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const probeFetch = vi.fn(healthyFetch);
    try {
      const result = await restoreWorkspace(root, { fetchImpl: probeFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(probeFetch).not.toHaveBeenCalled();
      expect(tunnel.starts, JSON.stringify({ result, tunnel: tunnel.status() })).toBe(1);
      expect(tunnel.restarts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it.each([
    ["running conflicts with processRunning=false", { processRunning: false }],
    ["running conflicts with connected=false", { connected: false }],
  ])("fails closed and skips the public probe when %s", async (_caseName, overrides) => {
    const { root } = fixture(`named-status-conflict-${_caseName}`);
    const tunnel = new RecoveryTunnel("cloudflare-named", true, NAMED_URL);
    tunnel.statusOverrides = overrides;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const probeFetch = vi.fn(healthyFetch);
    try {
      const result = await restoreWorkspace(root, { fetchImpl: probeFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).not.toBeNull();
      expect(result.tunnelAction).toBe("failed");
      expect(probeFetch).not.toHaveBeenCalled();
      expect(tunnel.starts).toBe(0);
      expect(tunnel.restarts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("fails closed when authenticated Bridge admin info identifies another runtime", async () => {
    const { root } = fixture("named-admin-identity-mismatch");
    const tunnel = new RecoveryTunnel("cloudflare-named", true, NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const routes: string[] = [];
    const probeFetch = vi.fn(healthyFetch);
    const adminFetchImpl: NonNullable<RecoveryOptions["adminFetchImpl"]> = async <T = unknown>(
      runtime,
      method,
      route,
      timeoutMs
    ): Promise<T> => {
      routes.push(`${method} ${route}`);
      const info = await adminFetch<RecoveryAdminInfo>(runtime, method, route, timeoutMs);
      if (method === "GET" && route === "/admin/info") {
        return { ...info, workspaceId: "ffffffffffff" } as T;
      }
      return info as T;
    };
    try {
      const result = await restoreWorkspace(root, { adminFetchImpl, fetchImpl: probeFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).not.toBeNull();
      expect(result.tunnelAction).toBe("failed");
      expect(probeFetch).not.toHaveBeenCalled();
      expect(routes.filter((route) => route === "POST /admin/tunnel/start")).toHaveLength(0);
      expect(tunnel.starts).toBe(0);
      expect(tunnel.restarts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("does not downgrade a Named Tunnel that exits during the public self-probe", async () => {
    const { root } = fixture("named-exits-during-probe");
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    announceNamedConnection(child);
    await expect(starting).resolves.toBe(NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const probeFetch = vi.fn(async () => {
      child.exitCode = 1;
      child.exit(1);
      throw Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
    }) as typeof fetch;
    try {
      const result = await restoreWorkspace(root, { fetchImpl: probeFetch });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.tunnelAction).toBe("failed");
      expect(probeFetch).toHaveBeenCalledTimes(1);
      expect(tunnel.status()).toMatchObject({ running: false, processRunning: false, connected: false, url: null });
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.close();
    }
  });
});

describe("Cloudflared Named Tunnel start failures", () => {
  it("times out before connection while the killed child awaits its exit event", async () => {
    vi.useFakeTimers();
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel(25);
    const starting = startFakeTunnelProcess(tunnel, child);
    const rejected = expect(starting).rejects.toThrow(/category=timeout/);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, processRunning: true, connected: false, url: null });
  });

  it("fails when cloudflared exits before establishing a connection", async () => {
    const child = new FakeCloudflaredProcess();
    const tunnel = namedTunnel();
    const starting = startFakeTunnelProcess(tunnel, child);
    child.exitCode = 1;
    child.exit(1);

    await expect(starting).rejects.toThrow(/category=unknown/);
    expect(tunnel.status()).toMatchObject({ running: false, processRunning: false, connected: false, url: null });
  });
});
