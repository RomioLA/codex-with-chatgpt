import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

export interface AutostartRegistration {
  workspaceId: string;
  workspaceRoot: string;
  taskName: string;
  updatedAt: string;
  backend?: "task_scheduler" | "registry_run";
  /** Durable intent published before changing the Run authority. */
  pendingBackend?: "registry_run";
  /** Identifies the namespace from which the Run backup was captured. */
  runAuthority?: "host_user";
  /** Private caller-view cleanup intent, retained while a migration is pending. */
  legacyRunValueCaptured?: boolean;
  legacyRunValue?: string | null;
  legacyRunValueKind?: "String" | "ExpandString" | null;
  previousRunValueCaptured?: boolean;
  previousRunValue?: string | null;
  previousRunValueKind?: "String" | "ExpandString" | null;
  lastRunAt?: string;
  lastRunStatus?: "started" | "failed" | "workspace_missing";
  lastRunMessage?: string;
}

export interface AutostartInstallResult {
  backend: NonNullable<AutostartRegistration["backend"]>;
  pendingBackend?: "registry_run";
  runAuthority?: "host_user";
  legacyRunValueCaptured?: boolean;
  legacyRunValue?: string | null;
  legacyRunValueKind?: "String" | "ExpandString" | null;
  previousRunValueCaptured?: boolean;
  previousRunValue?: string | null;
  previousRunValueKind?: "String" | "ExpandString" | null;
  /** Restore the pre-install OS/filesystem state if registration persistence fails. */
  rollback?: () => void;
  /** Finish authority cleanup before publishing a stable pending backend. */
  commit?: () => void;
}

export interface AutostartInstallContext {
  persistTransition(registration: AutostartRegistration): void;
}

export interface AutostartTaskAdapter {
  install(registration: AutostartRegistration, context?: AutostartInstallContext): AutostartInstallResult;
  remove(registration: AutostartRegistration): void;
  isInstalled(registration: AutostartRegistration): boolean;
  getAuthorityState?(registration: AutostartRegistration): { taskPresent: boolean; runPresent: boolean };
}

export interface AutostartStatus {
  enabled: boolean;
  workspace: string;
  workspaceExists: boolean;
  taskName: string | null;
  taskInstalled: boolean;
  backend: AutostartRegistration["backend"] | null;
  backendInstalled: boolean;
  registrationState: "not_registered" | "enabled" | "task_missing" | "workspace_missing" | "transition_pending" | "authority_conflict";
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
  if (!value || value.workspaceId !== workspaceId || typeof value.workspaceRoot !== "string"
    || value.taskName !== taskNameForWorkspace(workspaceId)
    || (value.backend !== undefined && value.backend !== "task_scheduler" && value.backend !== "registry_run")
    || (value.pendingBackend !== undefined && value.pendingBackend !== "registry_run")
    || (value.runAuthority !== undefined && value.runAuthority !== "host_user")
    || (value.legacyRunValueCaptured !== undefined && typeof value.legacyRunValueCaptured !== "boolean")
    || (value.legacyRunValue !== undefined && value.legacyRunValue !== null && typeof value.legacyRunValue !== "string")
    || (value.legacyRunValueKind !== undefined && value.legacyRunValueKind !== null && value.legacyRunValueKind !== "String" && value.legacyRunValueKind !== "ExpandString")) {
    return null;
  }
  return value;
}

function writeRegistration(stateDir: string, registration: AutostartRegistration): void {
  const file = registrationFile(stateDir, registration.workspaceId);
  const directory = path.dirname(file);
  ensureDir(directory);
  const temporaryFile = path.join(directory, `.${registration.workspaceId}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryFile, file);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* retain the original persistence error */ }
    }
    try { fs.unlinkSync(temporaryFile); } catch { /* the temporary file may not have been created */ }
    throw error;
  }
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
    const resolved = workspaceRootOrResolved(workspaceRoot);
    const key = pathKey(resolved);
    try {
      const workspace = new Workspace(resolved);
      const registration = readRegistration(this.stateDir, workspace.id);
      return registration && pathKey(registration.workspaceRoot) === key ? registration : null;
    } catch {
      // A formerly registered workspace may have been moved or deleted.
    }
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
      ...(previous?.pendingBackend ? { pendingBackend: previous.pendingBackend } : {}),
      ...(previous?.runAuthority ? { runAuthority: previous.runAuthority } : {}),
      ...(previous?.legacyRunValueCaptured ? {
        legacyRunValueCaptured: true,
        legacyRunValue: previous.legacyRunValue ?? null,
        legacyRunValueKind: previous.legacyRunValueKind ?? null,
      } : {}),
      ...(previous?.previousRunValueCaptured ? {
        previousRunValueCaptured: true,
        previousRunValue: previous.previousRunValue ?? null,
        previousRunValueKind: previous.previousRunValueKind ?? null,
      } : {}),
    };

    let installResult: AutostartInstallResult | null = null;
    let registrationPublished = false;
    let transitionPublished = !!previous?.pendingBackend;
    try {
      installResult = this.tasks.install(registration, {
        persistTransition: (transition) => {
          if (transition.workspaceId !== workspace.id || transition.workspaceRoot !== workspace.root
            || transition.taskName !== registration.taskName || transition.pendingBackend !== "registry_run") {
            throw new Error("Invalid autostart backend transition.");
          }
          writeRegistration(this.stateDir, transition);
          transitionPublished = true;
        },
      });
      const { rollback: _rollback, commit: _commit, pendingBackend, ...persistedResult } = installResult;
      if (pendingBackend) {
        if (!transitionPublished) throw new Error("Autostart backend transition was not persisted.");
        if (!installResult.commit) throw new Error("Autostart backend transition has no authority cleanup.");
        // A crash or final publication failure leaves the durable intent. The next
        // enable/reconcile resumes cleanup instead of trusting the selected backend.
        installResult.commit();
      }
      const { pendingBackend: _pendingBackend, legacyRunValueCaptured: _oldLegacyCaptured,
        legacyRunValue: _oldLegacyValue, legacyRunValueKind: _oldLegacyKind, ...stableRegistration } = registration;
      const { legacyRunValueCaptured: _legacyCaptured, legacyRunValue: _legacyValue,
        legacyRunValueKind: _legacyKind, ...stableResult } = persistedResult;
      const stable = {
        ...stableRegistration,
        ...stableResult,
      };
      if (pendingBackend && !this.tasks.isInstalled(stable)) {
        throw new Error("Autostart backend transition did not establish a unique healthy authority.");
      }
      writeRegistration(this.stateDir, stable);
      registrationPublished = true;
      if (!pendingBackend) installResult.commit?.();
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (installResult) {
        try {
          if (installResult.rollback) installResult.rollback();
          else this.tasks.remove({ ...registration, ...installResult });
        } catch (rollbackError) {
          rollbackErrors.push(`autostart rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      // A pending journal stays pending after rollback: Task cleanup may already
      // have completed, so restoring old stable JSON could claim a missing Task.
      // Its intent allows the next enable to retry; it never reports healthy.
      if (registrationPublished && !transitionPublished) {
        const file = registrationFile(this.stateDir, workspace.id);
        try {
          if (previous) writeRegistration(this.stateDir, previous);
          else if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (rollbackError) {
          rollbackErrors.push(`registration rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
      if (rollbackErrors.length) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollbackErrors.join("; ")}`);
      }
      throw error;
    }
    return this.status(workspace.root);
  }

  reconcile(workspacePath: string): AutostartStatus {
    return this.enable(workspacePath);
  }

  disable(workspacePath: string): AutostartStatus {
    this.assertSupported();
    const resolvedRoot = workspaceRootOrResolved(workspacePath);
    const registration = this.getRegistrationForWorkspace(resolvedRoot);
    const workspaceId = registration?.workspaceId ?? (() => {
      try { return new Workspace(resolvedRoot).id; } catch { return null; }
    })();
    if (!workspaceId) {
      throw new Error("Cannot determine the workspace identity for autostart cleanup.");
    }
    const taskName = taskNameForWorkspace(workspaceId);

    if (registration) this.tasks.remove(registration);
    else {
      this.tasks.remove({
        workspaceId,
        workspaceRoot: resolvedRoot,
        taskName,
        updatedAt: new Date(0).toISOString(),
      });
    }
    const file = registrationFile(this.stateDir, workspaceId);
    try { fs.unlinkSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return this.status(resolvedRoot);
  }

  status(workspacePath: string): AutostartStatus {
    this.assertSupported();
    const workspace = workspaceRootOrResolved(workspacePath);
    const registration = this.getRegistrationForWorkspace(workspace);
    const workspaceExists = fs.existsSync(workspace) && fs.statSync(workspace).isDirectory();
    const authorities = registration ? this.tasks.getAuthorityState?.(registration) : undefined;
    const conflict = !!authorities?.taskPresent && !!authorities?.runPresent;
    const backendInstalled = registration && !registration.pendingBackend && !conflict ? this.tasks.isInstalled(registration) : false;
    const taskInstalled = authorities?.taskPresent
      ?? (backendInstalled && (registration?.backend ?? "task_scheduler") === "task_scheduler");
    const registrationState: AutostartStatus["registrationState"] = !registration
      ? "not_registered"
      : registration.pendingBackend
        ? "transition_pending"
        : conflict
          ? "authority_conflict"
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
