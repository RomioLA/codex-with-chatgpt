import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutostartService, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import { recordLaunchBreadcrumb } from "../src/autostart/launch-breadcrumb.js";
import { restoreRegisteredWorkspace } from "../src/autostart/restore.js";
import type { RestoreResult } from "../src/process/recovery.js";
import { makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

class BreadcrumbAutostartAdapter implements AutostartTaskAdapter {
  private readonly installed = new Set<string>();

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

const originalArgv = [...process.argv];
const originalStateDir = process.env.C2C_STATE_DIR;
const originalAdminToken = process.env.C2C_ADMIN_TOKEN;

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  if (originalAdminToken === undefined) delete process.env.C2C_ADMIN_TOKEN;
  else process.env.C2C_ADMIN_TOKEN = originalAdminToken;
  vi.restoreAllMocks();
});

function fixture() {
  const stateDir = makeTmpDir("autostart-breadcrumb-state");
  const workspaceRoot = makeTmpDir("autostart-breadcrumb-workspace");
  const workspace = new Workspace(workspaceRoot);
  const service = new AutostartService(new BreadcrumbAutostartAdapter(), stateDir, "win32");
  service.enable(workspaceRoot);
  return { stateDir, workspaceRoot, workspace, service };
}

function setLaunchContext(stateDir: string, workspaceId: string, workspaceRoot: string): void {
  process.env.C2C_STATE_DIR = stateDir;
  process.argv = [
    process.execPath,
    "C:\\fake\\dist\\cli\\index.js",
    "autostart",
    "restore",
    "--workspace-id",
    workspaceId,
    "--workspace",
    workspaceRoot,
  ];
}

function logPath(stateDir: string, workspaceId: string): string {
  return path.join(stateDir, "autostart", "diagnostics", `${workspaceId}.launch.log`);
}

function recordsFor(file: string): Array<Record<string, unknown>> {
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function restoreResult(ok: boolean): RestoreResult {
  return {
    ok,
    bridgeAction: "reused",
    tunnelAction: "notConfigured",
    diagnostics: { publicProbe: { publicProbeStatus: "notChecked", checkedAt: null } } as RestoreResult["diagnostics"],
    reason: ok ? null : "bridgeRecoveryFailed",
    ...(!ok ? { detail: "isolated failure" } : {}),
  };
}

describe("autostart launch breadcrumbs", () => {
  it("records successful restore stages without secrets or raw invocation data", async () => {
    const f = fixture();
    setLaunchContext(f.stateDir, f.workspace.id, f.workspaceRoot);
    process.env.C2C_ADMIN_TOKEN = "breadcrumb-secret-sentinel";
    const restore = vi.fn(async () => restoreResult(true));

    const outcome = await restoreRegisteredWorkspace(f.service, f.workspace.id, f.workspaceRoot, restore);

    expect(outcome.status).toBe("started");
    expect(restore).toHaveBeenCalledWith(f.workspace.root);
    const records = recordsFor(logPath(f.stateDir, f.workspace.id));
    expect(records.map((record) => record.stage)).toEqual(["restore_entered", "restore_completed"]);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(["checkedAt", "exitCode", "pid", "stage", "workspaceId"]);
      expect(record.workspaceId).toBe(f.workspace.id);
      expect(record.pid).toBe(process.pid);
      expect(record.exitCode).toBeNull();
      expect(record.checkedAt).toEqual(expect.any(String));
    }
    expect(JSON.stringify(records)).not.toContain("breadcrumb-secret-sentinel");
    expect(JSON.stringify(records)).not.toContain(f.workspaceRoot);
  });

  it("records a failed restore result", async () => {
    const f = fixture();
    setLaunchContext(f.stateDir, f.workspace.id, f.workspaceRoot);

    const outcome = await restoreRegisteredWorkspace(f.service, f.workspace.id, f.workspaceRoot, async () => restoreResult(false));

    expect(outcome.status).toBe("failed");
    expect(recordsFor(logPath(f.stateDir, f.workspace.id)).map((record) => record.stage)).toEqual(["restore_entered", "restore_failed"]);
  });

  it("records restore authority exceptions as failed", async () => {
    const f = fixture();
    setLaunchContext(f.stateDir, f.workspace.id, f.workspaceRoot);

    const outcome = await restoreRegisteredWorkspace(f.service, f.workspace.id, f.workspaceRoot, async () => {
      throw new Error("isolated authority failure");
    });

    expect(outcome).toMatchObject({ status: "failed", detail: "isolated authority failure" });
    expect(recordsFor(logPath(f.stateDir, f.workspace.id)).map((record) => record.stage)).toEqual(["restore_entered", "restore_failed"]);
  });

  it("records ignored mismatched workspace paths only under the requested workspace ID", async () => {
    const f = fixture();
    const otherRoot = makeTmpDir("autostart-breadcrumb-other-workspace");
    const otherWorkspace = new Workspace(otherRoot);
    f.service.enable(otherRoot);
    setLaunchContext(f.stateDir, f.workspace.id, otherRoot);
    const restore = vi.fn(async () => restoreResult(true));

    const outcome = await restoreRegisteredWorkspace(f.service, f.workspace.id, otherRoot, restore);

    expect(outcome.status).toBe("ignored");
    expect(restore).not.toHaveBeenCalled();
    expect(recordsFor(logPath(f.stateDir, f.workspace.id)).map((record) => record.stage)).toEqual(["restore_entered", "restore_ignored"]);
    expect(fs.existsSync(logPath(f.stateDir, otherWorkspace.id))).toBe(false);
  });

  it("keeps restore successful when breadcrumb writes fail", async () => {
    const f = fixture();
    setLaunchContext(f.stateDir, f.workspace.id, f.workspaceRoot);
    const brokenLogPath = logPath(f.stateDir, f.workspace.id);
    fs.mkdirSync(brokenLogPath, { recursive: true });
    const restore = vi.fn(async () => restoreResult(true));

    const outcome = await restoreRegisteredWorkspace(f.service, f.workspace.id, f.workspaceRoot, restore);

    expect(outcome.status).toBe("started");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(f.service.status(f.workspaceRoot).lastRunStatus).toBe("started");
  });

  it("rejects noncanonical state paths and malformed restore arguments", () => {
    const f = fixture();
    setLaunchContext(f.stateDir, f.workspace.id, f.workspaceRoot);
    process.env.C2C_STATE_DIR = `${f.stateDir}${path.sep}..${path.sep}noncanonical-state`;
    recordLaunchBreadcrumb("restore_entered", f.workspace.id);
    expect(fs.existsSync(logPath(f.stateDir, f.workspace.id))).toBe(false);

    setLaunchContext(f.stateDir, "not-a-workspace", f.workspaceRoot);
    recordLaunchBreadcrumb("restore_entered", "not-a-workspace");
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "diagnostics", "not-a-workspace.launch.log"))).toBe(false);
  });

  it("records Node startup and CLI import failure before app code", () => {
    const f = fixture();
    const helper = path.resolve("dist", "autostart", "launch-breadcrumb.js");
    expect(fs.existsSync(helper), "build the current source before this test").toBe(true);
    const fakeCli = path.join(makeTmpDir("autostart-breadcrumb-fake-cli"), "index.mjs");
    fs.writeFileSync(fakeCli, "import './missing-cli-import.mjs';\n");
    const token = "preload-secret-sentinel";

    const child = spawnSync(process.execPath, [
      "--import",
      pathToFileURL(helper).href,
      fakeCli,
      "autostart",
      "restore",
      "--workspace-id",
      f.workspace.id,
      "--workspace",
      f.workspaceRoot,
    ], {
      env: { ...process.env, C2C_STATE_DIR: f.stateDir, C2C_ADMIN_TOKEN: token },
      windowsHide: true,
      timeout: 10_000,
      encoding: "utf8",
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    const records = recordsFor(logPath(f.stateDir, f.workspace.id));
    expect(records.map((record) => record.stage)).toEqual(["node_started", "node_exited"]);
    expect(records[1].exitCode).toBe(1);
    expect(JSON.stringify(records)).not.toContain(token);
    expect(JSON.stringify(records)).not.toContain("missing-cli-import");
  });
});
