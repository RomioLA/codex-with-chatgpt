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

type RestoreBreadcrumbStage = "restore_entered" | "restore_completed" | "restore_failed" | "restore_ignored";

async function recordBreadcrumb(stage: RestoreBreadcrumbStage, workspaceId: string): Promise<void> {
  try {
    const breadcrumb = await import("./launch-breadcrumb.js");
    breadcrumb.recordLaunchBreadcrumb(stage, workspaceId);
  } catch {
    // An absent or unwritable diagnostic asset must not affect restore behavior.
  }
}

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
  await recordBreadcrumb("restore_entered", workspaceId);
  let finalStage: RestoreBreadcrumbStage = "restore_failed";
  try {
    const registration = service.getRegistrationById(workspaceId);
    const resolvedPath = path.resolve(workspacePath);
    if (!registration || !samePath(registration.workspaceRoot, resolvedPath)) {
      finalStage = "restore_ignored";
      return { status: "ignored" };
    }

    let directory = false;
    try {
      directory = fs.statSync(registration.workspaceRoot).isDirectory();
    } catch {
      directory = false;
    }
    if (!directory) {
      const outcome = recordMissing(service, workspaceId, registration.workspaceRoot, `Registered workspace no longer exists: ${registration.workspaceRoot}`);
      finalStage = "restore_failed";
      return outcome;
    }

    let workspace: Workspace;
    try {
      workspace = new Workspace(registration.workspaceRoot);
    } catch (error) {
      const outcome = recordMissing(service, workspaceId, registration.workspaceRoot, (error as Error).message);
      finalStage = "restore_failed";
      return outcome;
    }
    if (workspace.id !== workspaceId) {
      const outcome = recordMissing(service, workspaceId, registration.workspaceRoot, "Registered workspace path now resolves to a different workspace.");
      finalStage = "restore_failed";
      return outcome;
    }

    try {
      const result = await restore(workspace.root);
      const status = result.ok ? "started" : "failed";
      const probe = result.diagnostics.publicProbe;
      const probeMessage = probe.publicProbeStatus === "degraded"
        ? ` PUBLIC_SELF_PROBE=DEGRADED cause=${probe.publicProbeError ?? "unavailable"} checkedAt=${probe.checkedAt ?? "unknown"}`
        : "";
      const message = result.ok
        ? `Bridge ${result.bridgeAction}; tunnel ${result.tunnelAction}.${probeMessage}`
        : [result.reason ?? "restore_failed", result.detail].filter(Boolean).join(": ");
      service.recordRun(workspaceId, registration.workspaceRoot, { status, message });
      finalStage = result.ok ? "restore_completed" : "restore_failed";
      return { status, result, ...(!result.ok && result.detail ? { detail: result.detail } : {}) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      service.recordRun(workspaceId, registration.workspaceRoot, { status: "failed", message: detail });
      finalStage = "restore_failed";
      return { status: "failed", detail };
    }
  } finally {
    await recordBreadcrumb(finalStage, workspaceId);
  }
}
