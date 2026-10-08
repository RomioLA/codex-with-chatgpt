import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutostartService, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import { restoreRegisteredWorkspace } from "../src/autostart/restore.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { restoreWorkspace, type RecoveryAdminInfo, type RecoveryOptions } from "../src/process/recovery.js";
import { SERVICE_NAME, VERSION, type RuntimeState } from "../src/bridge/runtime.js";
import { CloudflaredNamedTunnel } from "../src/tunnel/cloudflared-named.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

const { spawnMock, findBridgeObservationMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  findBridgeObservationMock: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

// Keep the recovery flow real while supplying a healthy Bridge observation;
// this test never starts a Bridge process or opens a listener.
vi.mock("../src/bridge/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bridge/runtime.js")>();
  return { ...actual, findBridgeObservation: findBridgeObservationMock };
});

const NAMED_URL = "https://c2c-demo.example.com";
const TUNNEL_ID = "33333333-3333-3333-3333-333333333333";
const dirs: string[] = [];
const previousEnv = {
  C2C_STATE_DIR: process.env.C2C_STATE_DIR,
  TUNNEL_ORIGIN_CERT: process.env.TUNNEL_ORIGIN_CERT,
  TUNNEL_CRED_FILE: process.env.TUNNEL_CRED_FILE,
};

type ChildScript =
  | { kind: "dns"; line?: string }
  | { kind: "permanent"; line?: string }
  | { kind: "connected" };

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  exited = false;
  closed = false;
  readonly kill = vi.fn((signal?: NodeJS.Signals) => {
    this.finish(null, signal ?? "SIGTERM");
    return true;
  });

  exit(code: number): void {
    this.finish(code, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.stderr.end();
      this.closed = true;
      this.emit("close", code, signal);
    });
  }
}

class IsolatedAutostartAdapter implements AutostartTaskAdapter {
  install(_registration: AutostartRegistration): AutostartInstallResult {
    return { backend: "task_scheduler" };
  }

  remove(): void {}

  isInstalled(): boolean {
    return true;
  }
}

function fixture(name: string) {
  const stateDir = isolateStateDir();
  dirs.push(stateDir);
  const root = makeTmpDir(name);
  dirs.push(root);
  write(root, "readme.txt", "named retry recovery fixture\n");
  const workspace = new Workspace(root);

  writeTunnelState({
    workspaceId: workspace.id,
    preference: "named",
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
  writeLastEndpoint({ workspaceId: workspace.id, port: 48_765, publicUrl: NAMED_URL, mcpUrl: `${NAMED_URL}/mcp` });

  const runtime: RuntimeState = {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: process.pid,
    port: 48_765,
    adminToken: "test-admin-token",
    publicUrl: null,
    startedAt: new Date(0).toISOString(),
  };
  findBridgeObservationMock.mockResolvedValue({ state: "healthy", runtime });
  return { root, workspace, runtime, stateDir };
}

function namedTunnel(retryBackoffMs: readonly number[] = [2, 2]): CloudflaredNamedTunnel {
  return new CloudflaredNamedTunnel({
    tunnelName: "c2c-test",
    hostname: "c2c-demo.example.com",
    binaryOverride: "fake-cloudflared",
    startTimeoutMs: 100,
    startupDeadlineMs: 1_000,
    retryBackoffMs,
  });
}

function scriptChildren(scripts: ChildScript[]): FakeCloudflaredProcess[] {
  const children: FakeCloudflaredProcess[] = [];
  spawnMock.mockImplementation(() => {
    const script = scripts.shift();
    if (!script) throw new Error("Unexpected cloudflared spawn with no scripted child.");
    const child = new FakeCloudflaredProcess();
    children.push(child);
    setImmediate(() => {
      if (script.kind === "connected") {
        child.stderr.write("INF Registered tunnel connection connIndex=0\n");
        return;
      }
      const line = script.line ?? (script.kind === "dns"
        ? "ERR Failed to resolve edge address: lookup region1.v2.argotunnel.com: no such host"
        : "ERR Unable to load tunnel credentials: invalid credentials");
      child.stderr.write(`${line}\n`);
      setImmediate(() => child.exit(1));
    });
    return child as unknown as ChildProcess;
  });
  return children;
}

function healthyFetch(): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 }));
}

const resetFetch: typeof fetch = async () => {
  throw Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
};

function recoveryOptions(
  runtime: RuntimeState,
  workspace: Workspace,
  tunnel: CloudflaredNamedTunnel,
  fetchImpl: typeof fetch = healthyFetch
) {
  const ensureBridgeImpl = vi.fn(async (workspaceRoot: string) => {
    expect(workspaceRoot).toBe(workspace.root);
    return { runtime, spawned: false };
  });
  const startErrors: string[] = [];
  const routes: string[] = [];
  const adminFetchImpl: NonNullable<RecoveryOptions["adminFetchImpl"]> = async <T = unknown>(
    activeRuntime,
    method,
    route
  ): Promise<T> => {
    routes.push(`${method} ${route}`);
    if (method === "POST" && route === "/admin/tunnel/start") {
      try {
        return { url: await tunnel.start(activeRuntime.port) } as T;
      } catch (error) {
        startErrors.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    if (method === "GET" && route === "/admin/info") {
      const status = tunnel.status();
      const info: RecoveryAdminInfo = {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceRoot: workspace.root,
        port: runtime.port,
        publicUrl: status.url,
        tunnel: status,
        tokenCount: 0,
        pairingActive: false,
        pid: runtime.pid,
        startedAt: runtime.startedAt,
        permissionMode: "readonly",
      };
      return info as T;
    }
    throw new Error(`Unexpected admin request ${method} ${route}`);
  };
  return { ensureBridgeImpl, adminFetchImpl, startErrors, routes, fetchImpl };
}

afterEach(() => {
  spawnMock.mockReset();
  findBridgeObservationMock.mockReset();
  while (dirs.length) cleanup(dirs.pop()!);
  for (const key of Object.keys(previousEnv) as Array<keyof typeof previousEnv>) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Named Tunnel DNS retry through runtime recovery", () => {
  it("recovers after the first DNS failure, reuses the healthy Bridge, and treats a failed public probe as degraded", async () => {
    const { root, workspace, runtime } = fixture("named-retry-first-dns");
    const children = scriptChildren([{ kind: "dns" }, { kind: "connected" }]);
    const tunnel = namedTunnel([1]);
    const options = recoveryOptions(runtime, workspace, tunnel, resetFetch);
    const autostart = new AutostartService(new IsolatedAutostartAdapter(), process.env.C2C_STATE_DIR!, "win32");
    autostart.enable(root);

    const outcome = await restoreRegisteredWorkspace(autostart, workspace.id, root, async (workspaceRoot) =>
      restoreWorkspace(workspaceRoot, {
        ensureBridgeImpl: options.ensureBridgeImpl,
        adminFetchImpl: options.adminFetchImpl,
        fetchImpl: options.fetchImpl,
      })
    );

    expect(outcome.status).toBe("started");
    expect(outcome.result).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "started", reason: null });
    expect(outcome.result?.diagnostics.publicProbe).toMatchObject({ publicProbeStatus: "degraded", publicProbeError: "ECONNRESET" });
    expect(autostart.status(root).lastRunStatus).toBe("started");
    expect(autostart.status(root).lastRunMessage).toMatch(/degraded.*ECONNRESET/i);
    expect(options.ensureBridgeImpl).toHaveBeenCalledTimes(1);
    expect(options.routes.filter((route) => route === "POST /admin/tunnel/start")).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(children.filter((child) => !child.exited)).toHaveLength(1);
    expect(children[0]?.closed).toBe(true);
    expect(tunnel.status()).toMatchObject({ running: true, connected: true, processRunning: true, url: NAMED_URL });
    expect(spawnMock).toHaveBeenLastCalledWith(
      "fake-cloudflared",
      expect.arrayContaining(["run", "c2c-test"]),
      expect.objectContaining({ windowsHide: true })
    );
    expect(JSON.stringify(outcome)).not.toContain("test-secret");
    await tunnel.stop();
    expect(children.every((child) => child.closed)).toBe(true);
  });

  it("retries multiple transient DNS failures before a later child connects", async () => {
    const { root, workspace, runtime } = fixture("named-retry-multiple-dns");
    const children = scriptChildren([{ kind: "dns" }, { kind: "dns" }, { kind: "connected" }]);
    const tunnel = namedTunnel([1, 2]);
    const options = recoveryOptions(runtime, workspace, tunnel);

    const result = await restoreWorkspace(root, {
      ensureBridgeImpl: options.ensureBridgeImpl,
      adminFetchImpl: options.adminFetchImpl,
      fetchImpl: options.fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "started", reason: null });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(children.filter((child) => !child.exited)).toHaveLength(1);
    expect(children.slice(0, 2).every((child) => child.closed)).toBe(true);
    expect(result.diagnostics.recovery).toMatchObject({ status: "healthy", reason: null });
    await tunnel.stop();
    expect(children.every((child) => child.closed)).toBe(true);
  });

  it("fails after DNS retries are exhausted and preserves safe retry diagnostics in recovery and autostart", async () => {
    const { root, workspace, runtime } = fixture("named-retry-exhausted");
    const children = scriptChildren([{ kind: "dns" }, { kind: "dns" }, { kind: "dns" }]);
    const tunnel = namedTunnel([1, 2]);
    const options = recoveryOptions(runtime, workspace, tunnel);
    const autostart = new AutostartService(new IsolatedAutostartAdapter(), process.env.C2C_STATE_DIR!, "win32");
    autostart.enable(root);

    const outcome = await restoreRegisteredWorkspace(autostart, workspace.id, root, async (workspaceRoot) =>
      restoreWorkspace(workspaceRoot, {
        ensureBridgeImpl: options.ensureBridgeImpl,
        adminFetchImpl: options.adminFetchImpl,
        fetchImpl: options.fetchImpl,
      })
    );

    expect(outcome.status).toBe("failed");
    expect(outcome.result).toMatchObject({ ok: false, bridgeAction: "reused", tunnelAction: "failed", reason: "namedRecoveryFailed" });
    expect(outcome.result?.detail).toMatch(/Named tunnel startup exhausted: attempts=3; category=dns_unavailable/i);
    expect(outcome.result?.diagnostics.recovery).toMatchObject({ status: "actionNeeded", reason: "namedRecoveryFailed" });
    expect(outcome.result?.diagnostics.tunnel).toMatchObject({ detail: expect.stringMatching(/Named tunnel startup exhausted: attempts=3; category=dns_unavailable/i) });
    expect(options.startErrors).toHaveLength(1);
    expect(options.startErrors[0]).toMatch(/Named tunnel startup exhausted: attempts=3; category=dns_unavailable/i);
    expect(autostart.status(root).lastRunStatus).toBe("failed");
    expect(autostart.status(root).lastRunMessage).toMatch(/Named tunnel startup exhausted: attempts=3; category=dns_unavailable/i);
    expect(autostart.status(root).lastRunMessage).not.toContain("region1.v2.argotunnel.com");
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(children.every((child) => child.exited)).toBe(true);
    expect(children.every((child) => child.closed)).toBe(true);
    expect(tunnel.status()).toMatchObject({ running: false, connected: false, processRunning: false });
    expect(JSON.stringify(outcome)).not.toContain("test-secret");
  });

  it("does not retry a permanent pre-connection failure", async () => {
    const { root, workspace, runtime } = fixture("named-retry-permanent");
    const children = scriptChildren([{ kind: "permanent" }, { kind: "connected" }]);
    const tunnel = namedTunnel([1, 2]);
    const options = recoveryOptions(runtime, workspace, tunnel);

    const result = await restoreWorkspace(root, {
      ensureBridgeImpl: options.ensureBridgeImpl,
      adminFetchImpl: options.adminFetchImpl,
      fetchImpl: options.fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("namedRecoveryFailed");
    expect(result.tunnelAction).toBe("failed");
    expect(result.detail).toMatch(/category=permanent/);
    expect(options.startErrors).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);
    expect(children[0]?.closed).toBe(true);
    expect(tunnel.status()).toMatchObject({ running: false, connected: false, processRunning: false });
  });

  it("does not expose a raw Named Tunnel status detail through recovery diagnostics", async () => {
    const { root, workspace, runtime } = fixture("named-retry-raw-detail");
    const children = scriptChildren([{ kind: "connected" }]);
    const tunnel = namedTunnel([1]);
    const starting = tunnel.start(runtime.port);
    await expect(starting).resolves.toBe(NAMED_URL);
    const realStatus = tunnel.status.bind(tunnel);
    vi.spyOn(tunnel, "status").mockImplementation(() => ({
      ...realStatus(),
      detail: "raw-cloudflared-secret-token=do-not-leak",
    }));
    const options = recoveryOptions(runtime, workspace, tunnel);

    const result = await restoreWorkspace(root, {
      ensureBridgeImpl: options.ensureBridgeImpl,
      adminFetchImpl: options.adminFetchImpl,
      fetchImpl: options.fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, tunnelAction: "reused", reason: null });
    expect(result.diagnostics.tunnel.detail).toBeUndefined();
    expect(result.detail).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("raw-cloudflared-secret-token");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await tunnel.stop();
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[0]?.closed).toBe(true);
  });
});
