import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutostartService, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import { restoreRegisteredWorkspace } from "../src/autostart/restore.js";
import { startBridge } from "../src/bridge/server.js";
import { AuthStore } from "../src/auth/store.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import type { RestoreResult } from "../src/process/recovery.js";
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

const previousStateDir = process.env.C2C_STATE_DIR;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
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
      diagnostics: {} as RestoreResult["diagnostics"],
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
});
