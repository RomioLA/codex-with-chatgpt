import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutostartService, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import { restoreRegisteredWorkspace } from "../src/autostart/restore.js";
import { startBridge } from "../src/bridge/server.js";
import { AuthStore } from "../src/auth/store.js";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import { restoreWorkspace, type RestoreResult } from "../src/process/recovery.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

class IsolatedAutostartAdapter implements AutostartTaskAdapter {
  readonly installed = new Set<string>();

  install(registration: AutostartRegistration): AutostartInstallResult {
    this.installed.add(registration.taskName);
    return { backend: "task_scheduler" };
  }

  remove(registration: AutostartRegistration): void {
    this.installed.delete(registration.taskName);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.installed.has(registration.taskName);
  }
}

class ConnectedNamedTunnel implements TunnelProvider {
  starts = 0;
  restarts = 0;

  constructor(readonly name: "cloudflare-named", readonly publicUrl: string) {}

  async start(): Promise<string> {
    this.starts += 1;
    return this.publicUrl;
  }

  async stop(): Promise<void> {}

  async restart(): Promise<string> {
    this.restarts += 1;
    return this.publicUrl;
  }

  status(): TunnelStatus {
    return {
      running: true,
      url: this.publicUrl,
      provider: this.name,
      processRunning: true,
      connected: true,
    };
  }

  getPublicUrl(): string {
    return this.publicUrl;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake-cloudflared",
      running: true,
      url: this.publicUrl,
      problems: [],
    };
  }
}

const previousStateDir = process.env.C2C_STATE_DIR;
const previousOriginCert = process.env.TUNNEL_ORIGIN_CERT;
const previousCredentialFile = process.env.TUNNEL_CRED_FILE;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousOriginCert === undefined) delete process.env.TUNNEL_ORIGIN_CERT;
  else process.env.TUNNEL_ORIGIN_CERT = previousOriginCert;
  if (previousCredentialFile === undefined) delete process.env.TUNNEL_CRED_FILE;
  else process.env.TUNNEL_CRED_FILE = previousCredentialFile;
});

describe("Autostart to runtime recovery integration", () => {
  it("routes all registered workspaces through restore and preserves permission and auth state", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const roots = [
      makeTmpDir("autostart-restore-readonly"),
      makeTmpDir("autostart-restore-level1"),
      makeTmpDir("autostart-restore-level2"),
    ];
    dirs.push(...roots);
    const workspaces = roots.map((root) => new Workspace(root));
    const autostart = new AutostartService(new IsolatedAutostartAdapter(), stateDir, "win32");
    for (const root of roots) autostart.enable(root);
    const permissions = ["readonly", "level1", "level2"] as const;
    workspaces.forEach((workspace, index) => setPermission(workspace.id, permissions[index]));

    const auth = new AuthStore(workspaces[1].id);
    const client = auth.registerClient({ redirectUris: ["http://127.0.0.1/callback"] });
    const issued = auth.issueTokens({ clientId: client.clientId, scopes: ["workspace.read", "offline_access"] });
    const bridges = [];
    try {
      for (const root of roots) bridges.push(await startBridge({ workspaceRoot: root, port: 0 }));
      const firstPass = [];
      const secondPass = [];
      for (let index = 0; index < roots.length; index += 1) {
        firstPass.push(await restoreRegisteredWorkspace(autostart, workspaces[index].id, roots[index]));
      }
      for (let index = 0; index < roots.length; index += 1) {
        secondPass.push(await restoreRegisteredWorkspace(autostart, workspaces[index].id, roots[index]));
      }

      expect(firstPass.map((outcome) => outcome.result?.bridgeAction)).toEqual(["reused", "reused", "reused"]);
      expect(secondPass.map((outcome) => outcome.result?.bridgeAction)).toEqual(["reused", "reused", "reused"]);
      expect(firstPass.every((outcome) => outcome.status === "started" && outcome.result?.ok)).toBe(true);
      expect(secondPass.every((outcome) => outcome.status === "started" && outcome.result?.ok)).toBe(true);
      expect(roots.map((root) => autostart.status(root).lastRunStatus)).toEqual(["started", "started", "started"]);
      expect(workspaces.map((workspace) => readPermission(workspace.id))).toEqual(permissions);
      expect(new AuthStore(workspaces[1].id).verifyAccessToken(issued.accessToken).ok).toBe(true);
      expect(new AuthStore(workspaces[1].id).tokenCount()).toBe(2);
      expect(bridges.every((bridge) => !bridge.pairing.hasActiveSession())).toBe(true);
    } finally {
      for (const bridge of bridges) await bridge.close();
    }
  });

  it("isolates a moved workspace and continues restoring the next registration", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const first = makeTmpDir("autostart-moved-workspace");
    const second = makeTmpDir("autostart-surviving-workspace");
    dirs.push(first, second);
    const firstWorkspace = new Workspace(first);
    const secondWorkspace = new Workspace(second);
    const autostart = new AutostartService(new IsolatedAutostartAdapter(), stateDir, "win32");
    autostart.enable(first);
    autostart.enable(second);
    const moved = path.join(path.dirname(first), `${path.basename(first)}-moved`);
    fs.renameSync(first, moved);

    const restore = vi.fn(async (): Promise<RestoreResult> => ({
      ok: true,
      bridgeAction: "reused",
      tunnelAction: "notConfigured",
      diagnostics: { publicProbe: { publicProbeStatus: "notChecked", checkedAt: null } } as RestoreResult["diagnostics"],
      reason: null,
    }));
    const missing = await restoreRegisteredWorkspace(autostart, firstWorkspace.id, first, restore);
    const surviving = await restoreRegisteredWorkspace(autostart, secondWorkspace.id, second, restore);

    expect(missing.status).toBe("workspace_missing");
    expect(fs.existsSync(first)).toBe(false);
    expect(autostart.status(first).lastRunStatus).toBe("workspace_missing");
    expect(surviving.status).toBe("started");
    expect(autostart.status(second).lastRunStatus).toBe("started");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith(second);
  });

  it("records a successful degraded Named restore as started with a degraded probe message", async () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const root = makeTmpDir("autostart-named-probe-degraded");
    dirs.push(root);
    const workspace = new Workspace(root);
    const publicUrl = "https://c2c-demo.example.com";
    const tunnelId = "33333333-3333-3333-3333-333333333333";
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
    process.env.TUNNEL_ORIGIN_CERT = path.join(root, "cert.pem");
    fs.writeFileSync(process.env.TUNNEL_ORIGIN_CERT, "fake certificate marker");
    process.env.TUNNEL_CRED_FILE = path.join(root, "tunnel.json");
    fs.writeFileSync(process.env.TUNNEL_CRED_FILE, JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "test-secret" }));
    writeLastEndpoint({ workspaceId: workspace.id, port: 48765, publicUrl, mcpUrl: `${publicUrl}/mcp` });

    const autostart = new AutostartService(new IsolatedAutostartAdapter(), stateDir, "win32");
    autostart.enable(root);
    const tunnel = new ConnectedNamedTunnel("cloudflare-named", publicUrl);
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel });
    const resetFetch: typeof fetch = async () => {
      throw Object.assign(new Error("fetch failed: ECONNRESET"), { code: "ECONNRESET" });
    };
    try {
      const outcome = await restoreRegisteredWorkspace(autostart, workspace.id, root, async (workspaceRoot) =>
        restoreWorkspace(workspaceRoot, { fetchImpl: resetFetch })
      );

      const saved = autostart.status(root);
      expect(outcome.status).toBe("started");
      expect(outcome.result).toMatchObject({ ok: true, tunnelAction: "reused", reason: null });
      expect(outcome.result?.diagnostics.publicProbe.publicProbeStatus).toBe("degraded");
      expect(saved.lastRunStatus).toBe("started");
      expect(saved.lastRunMessage).toMatch(/degraded/i);
      expect(outcome.result?.diagnostics.publicProbe.publicProbeError).toBe("ECONNRESET");
      expect(outcome.result?.diagnostics.publicProbe.checkedAt).toEqual(expect.any(String));
      expect(saved.lastRunMessage).toContain(outcome.result?.diagnostics.publicProbe.publicProbeError);
      expect(saved.lastRunMessage).toContain(outcome.result?.diagnostics.publicProbe.checkedAt);
      expect(tunnel.starts).toBe(0);
      expect(tunnel.restarts).toBe(0);
    } finally {
      await bridge.close();
    }
  });
});
