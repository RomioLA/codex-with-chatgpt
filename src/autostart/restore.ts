import fs from "node:fs";
import path from "node:path";
import { AutostartService } from "./registration.js";
import { restoreWorkspace, type RestoreResult } from "../process/recovery.js";
import { Workspace } from "../workspace/manager.js";

export interface AutostartRestoreOutcome {
  status: "ignored" | "workspace_missing" | "started" | "failed";
  result?: RestoreResult;
  detail?: string;
}

export type RestoreAuthority = (workspaceRoot: string) => Promise<RestoreResult>;

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function recordMissing(service: AutostartService, workspaceId: string, workspaceRoot: string, message: string): AutostartRestoreOutcome {
  service.recordRun(workspaceId, workspaceRoot, { status: "workspace_missing", message });
  return { status: "workspace_missing", detail: message };
}

/** Run the formal runtime recovery authority for one validated per-workspace registration. */
export async function restoreRegisteredWorkspace(
  service: AutostartService,
  workspaceId: string,
  workspacePath: string,
  restore: RestoreAuthority = restoreWorkspace
): Promise<AutostartRestoreOutcome> {
  const registration = service.getRegistrationById(workspaceId);
  const resolvedPath = path.resolve(workspacePath);
  if (!registration || !samePath(registration.workspaceRoot, resolvedPath)) return { status: "ignored" };

  let directory = false;
  try {
    directory = fs.statSync(registration.workspaceRoot).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    return recordMissing(service, workspaceId, registration.workspaceRoot, `Registered workspace no longer exists: ${registration.workspaceRoot}`);
  }

  let workspace: Workspace;
  try {
    workspace = new Workspace(registration.workspaceRoot);
  } catch (error) {
    return recordMissing(service, workspaceId, registration.workspaceRoot, (error as Error).message);
  }
  if (workspace.id !== workspaceId) {
    return recordMissing(service, workspaceId, registration.workspaceRoot, "Registered workspace path now resolves to a different workspace.");
  }

  try {
    const result = await restore(workspace.root);
    const status = result.ok ? "started" : "failed";
    const message = result.ok
      ? `Bridge ${result.bridgeAction}; tunnel ${result.tunnelAction}.`
      : [result.reason ?? "restore_failed", result.detail].filter(Boolean).join(": ");
    service.recordRun(workspaceId, registration.workspaceRoot, { status, message });
    return { status, result, ...(!result.ok && result.detail ? { detail: result.detail } : {}) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    service.recordRun(workspaceId, registration.workspaceRoot, { status: "failed", message: detail });
    return { status: "failed", detail };
  }
}
