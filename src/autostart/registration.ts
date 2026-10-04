import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

export interface AutostartRegistration {
  workspaceId: string;
  workspaceRoot: string;
  taskName: string;
  updatedAt: string;
  backend?: "task_scheduler" | "registry_run";
  previousRunValueCaptured?: boolean;
  previousRunValue?: string | null;
  previousRunValueKind?: "String" | "ExpandString" | null;
  lastRunAt?: string;
  lastRunStatus?: "started" | "failed" | "workspace_missing";
  lastRunMessage?: string;
}

export interface AutostartInstallResult {
  backend: NonNullable<AutostartRegistration["backend"]>;
  previousRunValueCaptured?: boolean;
  previousRunValue?: string | null;
  previousRunValueKind?: "String" | "ExpandString" | null;
}

export interface AutostartTaskAdapter {
  install(registration: AutostartRegistration): AutostartInstallResult;
  remove(registration: AutostartRegistration): void;
  isInstalled(registration: AutostartRegistration): boolean;
}

export interface AutostartStatus {
  enabled: boolean;
  workspace: string;
  workspaceExists: boolean;
  taskName: string | null;
  taskInstalled: boolean;
  backend: AutostartRegistration["backend"] | null;
  backendInstalled: boolean;
  registrationState: "not_registered" | "enabled" | "task_missing" | "workspace_missing";
  lastRunAt?: string;
  lastRunStatus?: AutostartRegistration["lastRunStatus"];
  lastRunMessage?: string;
}

export class AutostartUnsupportedError extends Error {
  constructor() {
    super("Windows autostart is unsupported on this platform.");
    this.name = "AutostartUnsupportedError";
  }
}

export function taskNameForWorkspace(workspaceId: string): string {
  return `C2C-Workspace-Autostart-${workspaceId}`;
}

function registrationsDir(stateDir: string): string {
  return path.join(stateDir, "autostart", "workspaces");
}

function registrationFile(stateDir: string, workspaceId: string): string {
  return path.join(registrationsDir(stateDir), `${workspaceId}.json`);
}

function readRegistration(stateDir: string, workspaceId: string): AutostartRegistration | null {
  if (!/^[a-f0-9]{12}$/i.test(workspaceId)) return null;
  const value = readJsonIfExists<AutostartRegistration>(registrationFile(stateDir, workspaceId));
  if (!value || value.workspaceId !== workspaceId || typeof value.workspaceRoot !== "string" || typeof value.taskName !== "string") {
    return null;
  }
  return value;
}

function writeRegistration(stateDir: string, registration: AutostartRegistration): void {
  writeSecureJson(registrationFile(stateDir, registration.workspaceId), registration);
}

function pathKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceRootOrResolved(input: string): string {
  try {
    return new Workspace(input).root;
  } catch {
    return path.resolve(input);
  }
}

export class AutostartService {
  constructor(
    private readonly tasks: AutostartTaskAdapter,
    private readonly stateDir = getStateDir(),
    private readonly platform: string = process.platform
  ) {}

  private assertSupported(): void {
    if (this.platform !== "win32") throw new AutostartUnsupportedError();
  }

  private allRegistrations(): AutostartRegistration[] {
    const dir = registrationsDir(this.stateDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => /^[a-f0-9]{12}\.json$/i.test(name))
      .map((name) => readRegistration(this.stateDir, name.slice(0, -5)))
      .filter((item): item is AutostartRegistration => item !== null);
  }

  getRegistrationById(workspaceId: string): AutostartRegistration | null {
    return readRegistration(this.stateDir, workspaceId);
  }

  getRegistrationForWorkspace(workspaceRoot: string): AutostartRegistration | null {
    const key = pathKey(workspaceRootOrResolved(workspaceRoot));
    return this.allRegistrations().find((item) => pathKey(item.workspaceRoot) === key) ?? null;
  }

  enable(workspacePath: string): AutostartStatus {
    this.assertSupported();
    const workspace = new Workspace(workspacePath);
    const previous = readRegistration(this.stateDir, workspace.id);
    const registration: AutostartRegistration = {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      taskName: taskNameForWorkspace(workspace.id),
      updatedAt: new Date().toISOString(),
      ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
      ...(previous?.lastRunStatus ? { lastRunStatus: previous.lastRunStatus } : {}),
      ...(previous?.lastRunMessage ? { lastRunMessage: previous.lastRunMessage } : {}),
      ...(previous?.backend ? { backend: previous.backend } : {}),
      ...(previous?.previousRunValueCaptured ? {
        previousRunValueCaptured: true,
        previousRunValue: previous.previousRunValue ?? null,
        previousRunValueKind: previous.previousRunValueKind ?? null,
      } : {}),
    };

    writeRegistration(this.stateDir, registration);
    let installResult: AutostartInstallResult | null = null;
    try {
      installResult = this.tasks.install(registration);
      writeRegistration(this.stateDir, {
        ...registration,
        ...installResult,
      });
    } catch (error) {
      const file = registrationFile(this.stateDir, workspace.id);
      if (installResult) {
        try { this.tasks.remove({ ...registration, ...installResult }); } catch { /* rollback is best-effort */ }
      }
      if (previous) writeRegistration(this.stateDir, previous);
      else if (fs.existsSync(file)) fs.unlinkSync(file);
      throw error;
    }
    return this.status(workspace.root);
  }

  disable(workspacePath: string): AutostartStatus {
    this.assertSupported();
    const resolvedRoot = workspaceRootOrResolved(workspacePath);
    const registration = this.getRegistrationForWorkspace(resolvedRoot);
    const workspaceId = registration?.workspaceId ?? (() => {
      try { return new Workspace(resolvedRoot).id; } catch { return null; }
    })();
    const taskName = registration?.taskName ?? (workspaceId ? taskNameForWorkspace(workspaceId) : null);

    if (registration) this.tasks.remove(registration);
    else if (taskName && workspaceId) {
      this.tasks.remove({
        workspaceId,
        workspaceRoot: resolvedRoot,
        taskName,
        updatedAt: new Date(0).toISOString(),
      });
    }
    if (registration) {
      const file = registrationFile(this.stateDir, registration.workspaceId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    return this.status(resolvedRoot);
  }

  status(workspacePath: string): AutostartStatus {
    this.assertSupported();
    const workspace = workspaceRootOrResolved(workspacePath);
    const registration = this.getRegistrationForWorkspace(workspace);
    const workspaceExists = fs.existsSync(workspace) && fs.statSync(workspace).isDirectory();
    const backendInstalled = registration ? this.tasks.isInstalled(registration) : false;
    const taskInstalled = backendInstalled && (registration?.backend ?? "task_scheduler") === "task_scheduler";
    const registrationState: AutostartStatus["registrationState"] = !registration
      ? "not_registered"
      : !workspaceExists
        ? "workspace_missing"
        : backendInstalled
          ? "enabled"
          : "task_missing";
    return {
      enabled: registrationState === "enabled",
      workspace: registration?.workspaceRoot ?? workspace,
      workspaceExists,
      taskName: registration?.taskName ?? null,
      taskInstalled,
      backend: registration?.backend ?? null,
      backendInstalled,
      registrationState,
      ...(registration?.lastRunAt ? { lastRunAt: registration.lastRunAt } : {}),
      ...(registration?.lastRunStatus ? { lastRunStatus: registration.lastRunStatus } : {}),
      ...(registration?.lastRunMessage ? { lastRunMessage: registration.lastRunMessage } : {}),
    };
  }

  list(): AutostartStatus[] {
    this.assertSupported();
    return this.allRegistrations().map((registration) => this.status(registration.workspaceRoot));
  }

  recordRun(
    workspaceId: string,
    workspaceRoot: string,
    result: { status: NonNullable<AutostartRegistration["lastRunStatus"]>; message?: string }
  ): void {
    const registration = readRegistration(this.stateDir, workspaceId);
    if (!registration || pathKey(registration.workspaceRoot) !== pathKey(workspaceRoot)) return;
    writeRegistration(this.stateDir, {
      ...registration,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: result.status,
      ...(result.message ? { lastRunMessage: result.message.slice(0, 2000) } : { lastRunMessage: "" }),
    });
  }
}
