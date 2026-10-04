import { afterEach, describe, expect, it } from "vitest";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { startBridge } from "../src/bridge/server.js";
import { findBridgeObservation, writeRuntimeState } from "../src/bridge/runtime.js";
import { stopBridge } from "../src/process/daemon.js";
import { collectRuntimeDiagnostics, restoreWorkspace } from "../src/process/recovery.js";
import { readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { AuthStore } from "../src/auth/store.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

const dirs: string[] = [];
const previousEnv = {
  C2C_STATE_DIR: process.env.C2C_STATE_DIR,
  TUNNEL_ORIGIN_CERT: process.env.TUNNEL_ORIGIN_CERT,
  TUNNEL_CRED_FILE: process.env.TUNNEL_CRED_FILE,
};
const TUNNEL_ID = "33333333-3333-3333-3333-333333333333";
const NAMED_URL = "https://c2c-demo.example.com";
const QUICK_URL = "https://new-random-words.trycloudflare.com";

class FakeTunnel implements TunnelProvider {
  running = false;
  starts = 0;
  failStart = false;
  url: string | null = null;

  constructor(readonly name: "cloudflare-named" | "cloudflare-quick", private readonly nextUrl: string) {}

  async start(): Promise<string> {
    this.starts += 1;
    if (this.failStart) throw new Error("fake tunnel start failure");
    this.running = true;
    this.url = this.nextUrl;
    return this.nextUrl;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.url = null;
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start(0);
  }

  status(): TunnelStatus {
    return { running: this.running, url: this.url, provider: this.name };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return { provider: this.name, binaryFound: true, binaryPath: "fake-cloudflared", running: this.running, url: this.url, problems: [] };
  }
}

function makeWorkspace(name: string): { root: string; workspace: Workspace } {
  const root = makeTmpDir(name);
  write(root, "readme.txt", "isolated recovery fixture\n");
  return { root, workspace: new Workspace(root) };
}

function setNamedPreference(workspaceId: string): void {
  writeTunnelState({
    workspaceId,
    preference: "named",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-named",
    tunnelName: `c2c-${workspaceId}`,
    tunnelId: TUNNEL_ID,
    hostname: "c2c-demo.example.com",
    zone: "example.com",
  });
}

function setConnector(workspaceId: string, publicUrl: string, mcpUrl = `${publicUrl}/mcp`): void {
  writeLastEndpoint({ workspaceId, port: 48765, publicUrl, mcpUrl });
}

function setValidCredentialFiles(root: string): void {
  const cert = write(root, "cert.pem", "fake certificate marker");
  const credential = write(root, "tunnel.json", JSON.stringify({ TunnelID: TUNNEL_ID, TunnelSecret: "test-secret" }));
  process.env.TUNNEL_ORIGIN_CERT = cert;
  process.env.TUNNEL_CRED_FILE = credential;
}

const healthyFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  for (const key of Object.keys(previousEnv) as Array<keyof typeof previousEnv>) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("workspace runtime recovery", () => {
  it("reuses a healthy bridge and restores a configured named tunnel idempotently", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-named");
    setNamedPreference(workspace.id);
    setValidCredentialFiles(root);
    setConnector(workspace.id, NAMED_URL);
    setPermission(workspace.id, "level1");

    const auth = new AuthStore(workspace.id);
    const client = auth.registerClient({ redirectUris: ["http://127.0.0.1/callback"] });
    const issued = auth.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    const bridgeTunnel = new FakeTunnel("cloudflare-named", NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: bridgeTunnel });
    try {
      const first = await restoreWorkspace(root, { fetchImpl: healthyFetch });
      const second = await restoreWorkspace(root, { fetchImpl: healthyFetch });

      expect(first.ok).toBe(true);
      expect(first.bridgeAction).toBe("reused");
      expect(first.tunnelAction).toBe("started");
      expect(second.tunnelAction).toBe("reused");
      expect(bridgeTunnel.starts).toBe(1);
      expect(readPermission(workspace.id)).toBe("level1");
      expect(bridge.pairing.hasActiveSession()).toBe(false);
      expect(bridge.authStore.verifyAccessToken(issued.accessToken).ok).toBe(true);
      expect(bridge.authStore.tokenCount()).toBe(2);
      expect(new AuthStore(workspace.id).verifyAccessToken(issued.accessToken).ok).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it("restores a stopped bridge and its persisted Named Tunnel without duplicating either", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-stopped-named");
    setNamedPreference(workspace.id);
    setValidCredentialFiles(root);
    setConnector(workspace.id, NAMED_URL);
    setPermission(workspace.id, "readonly");
    const auth = new AuthStore(workspace.id);
    const client = auth.registerClient({ redirectUris: ["http://127.0.0.1/callback"] });
    const issued = auth.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    const provider = new FakeTunnel("cloudflare-named", NAMED_URL);
    const bridges: Awaited<ReturnType<typeof startBridge>>[] = [];
    const ensureBridgeImpl = async (workspaceRoot: string) => {
      const current = await findBridgeObservation(workspace.id);
      if (current.state === "healthy") return { runtime: current.runtime, spawned: false };
      if (current.state === "unknown") throw new Error(current.reason);
      const bridge = await startBridge({ workspaceRoot, port: 0, tunnelProvider: provider });
      bridges.push(bridge);
      const started = await findBridgeObservation(workspace.id);
      if (started.state !== "healthy") throw new Error("Test Bridge did not become healthy.");
      return { runtime: started.runtime, spawned: true };
    };

    try {
      const first = await restoreWorkspace(root, { ensureBridgeImpl, fetchImpl: healthyFetch });
      const second = await restoreWorkspace(root, { ensureBridgeImpl, fetchImpl: healthyFetch });

      expect(first).toMatchObject({ ok: true, bridgeAction: "started", tunnelAction: "started" });
      expect(second).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "reused" });
      expect(provider.starts).toBe(1);
      expect(bridges).toHaveLength(1);
      expect(first.diagnostics.configuredHostname).toBe("c2c-demo.example.com");
      expect(first.diagnostics.currentPublicUrl).toBe(NAMED_URL);
      expect(first.diagnostics.connectorEndpointMatchesCurrent).toBe(true);
      expect(first.diagnostics.endpointStable).toBe(true);
      expect(readPermission(workspace.id)).toBe("readonly");
      expect(new AuthStore(workspace.id).verifyAccessToken(issued.accessToken).ok).toBe(true);
      expect(new AuthStore(workspace.id).tokenCount()).toBe(2);
      expect(bridges[0].pairing.hasActiveSession()).toBe(false);
    } finally {
      for (const bridge of bridges) await bridge.close();
    }
  });

  it("stops before spawning the named tunnel when its credential file is missing", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-no-credential");
    setNamedPreference(workspace.id);
    process.env.TUNNEL_ORIGIN_CERT = write(root, "cert.pem", "fake certificate marker");
    process.env.TUNNEL_CRED_FILE = `${root}/missing-tunnel.json`;
    const provider = new FakeTunnel("cloudflare-named", NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: provider });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("credentialsMissing");
      expect(result.diagnostics.tunnel.namedCredentialStatus).toBe("missing_credentials");
      expect(provider.starts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("reports invalid named credentials without falling back to Quick Tunnel", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-invalid-credential");
    setNamedPreference(workspace.id);
    process.env.TUNNEL_ORIGIN_CERT = write(root, "cert.pem", "fake certificate marker");
    process.env.TUNNEL_CRED_FILE = write(root, "tunnel.json", "not json");
    const provider = new FakeTunnel("cloudflare-named", NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: provider });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("namedCredentialsInvalid");
      expect(result.diagnostics.tunnel.provider).toBe("cloudflare-named");
      expect(provider.starts).toBe(0);
    } finally {
      await bridge.close();
    }
  });

  it("reports a named tunnel startup failure without falling back to Quick Tunnel", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-named-failure");
    setNamedPreference(workspace.id);
    setValidCredentialFiles(root);
    setConnector(workspace.id, NAMED_URL);
    const provider = new FakeTunnel("cloudflare-named", NAMED_URL);
    provider.failStart = true;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: provider });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });
      expect(result.reason).toBe("namedRecoveryFailed");
      expect(result.diagnostics.tunnel.provider).toBe("cloudflare-named");
      expect(result.diagnostics.currentPublicUrl).toBeNull();
      expect(provider.starts).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it("reports an unavailable configured named hostname as action needed", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-hostname-unavailable");
    setNamedPreference(workspace.id);
    setValidCredentialFiles(root);
    setConnector(workspace.id, NAMED_URL);
    const provider = new FakeTunnel("cloudflare-named", NAMED_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: provider });
    try {
      const unavailable: typeof fetch = async () => new Response("unavailable", { status: 503 });
      const result = await restoreWorkspace(root, { fetchImpl: unavailable });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("hostnameUnavailable");
      expect(result.diagnostics.configuredHostname).toBe("c2c-demo.example.com");
      expect(provider.starts).toBe(1);
      expect(provider.name).toBe("cloudflare-named");
    } finally {
      await bridge.close();
    }
  });

  it("reports Quick Tunnel as unstable and flags a changed connector endpoint", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-quick");
    writeTunnelState({ workspaceId: workspace.id, preference: "quick", provider: "cloudflare-quick" });
    setConnector(workspace.id, "https://old.trycloudflare.com");
    const provider = new FakeTunnel("cloudflare-quick", QUICK_URL);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: provider });
    try {
      const result = await restoreWorkspace(root, { fetchImpl: healthyFetch });
      expect(result.reason).toBe("connectorEndpointChanged");
      expect(result.diagnostics.endpointStable).toBe(false);
      expect(result.diagnostics.restartSafeConnector).toBe(false);
      expect(result.diagnostics.connectorEndpointMatchesCurrent).toBe(false);
      expect(result.diagnostics.connectorEndpointHealthy).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("restarts a bridge with stale runtime state and then reuses it", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-stale-runtime");
    writeRuntimeState({
      service: "c2c-bridge",
      version: "test",
      workspaceId: workspace.id,
      workspaceRoot: root,
      pid: 999_999_999,
      port: 1,
      adminToken: "stale-test-token",
      publicUrl: null,
      startedAt: new Date(0).toISOString(),
    });

    const first = await restoreWorkspace(root);
    const second = await restoreWorkspace(root);
    try {
      expect(first.ok).toBe(true);
      expect(first.bridgeAction).toBe("started");
      expect(second.ok).toBe(true);
      expect(second.bridgeAction).toBe("reused");
    } finally {
      await stopBridge(root);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if ((await findBridgeObservation(workspace.id)).state === "stopped") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect((await findBridgeObservation(workspace.id)).state).toBe("stopped");
    }
  });

  it("exposes the required diagnostics fields without serializing token contents", async () => {
    dirs.push(isolateStateDir());
    const { root, workspace } = makeWorkspace("restore-diagnostics");
    const auth = new AuthStore(workspace.id);
    const client = auth.registerClient({ redirectUris: ["http://127.0.0.1/callback"] });
    const tokens = auth.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    setConnector(workspace.id, NAMED_URL);
    const result = await collectRuntimeDiagnostics(root);

    expect(result.workspace).toEqual({ path: workspace.root, id: workspace.id });
    expect(result.bridge.status).toBe("stopped");
    expect(result.permission).toBe("readonly");
    expect(result.tunnelPreference).toBe("unset");
    expect(result.tunnel.status).toBe("stopped");
    expect(result.configuredHostname).toBeNull();
    expect(result.currentPublicUrl).toBeNull();
    expect(result.connectorEndpoint).toBe(`${NAMED_URL}/mcp`);
    expect(result.connectorEndpointMatchesCurrent).toBeNull();
    expect(result.connectorEndpointHealthy).toBeNull();
    expect(result.endpointStable).toBe(false);
    expect(result.restartSafeConnector).toBe(false);
    expect(result.oauth.tokenCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(result)).not.toContain(tokens.refreshToken ?? "");
  });
});
