import fs from "node:fs";
import path from "node:path";

export type LaunchBreadcrumbStage =
  | "node_started"
  | "node_exited"
  | "restore_entered"
  | "restore_completed"
  | "restore_failed"
  | "restore_ignored";

interface LaunchContext {
  workspaceId: string;
  logFile: string;
  diagnosticsDirectory: string;
}

const WORKSPACE_ID_PATTERN = /^[a-f0-9]{12}$/i;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function launchArguments(): { workspaceId: string } | null {
  const args = process.argv.slice(2);
  if (
    args.length !== 6
    || args[0] !== "autostart"
    || args[1] !== "restore"
    || args[2] !== "--workspace-id"
    || !WORKSPACE_ID_PATTERN.test(args[3])
    || args[4] !== "--workspace"
    || !path.isAbsolute(args[5])
  ) return null;
  return { workspaceId: args[3] };
}

function resolveContext(workspaceId: string): LaunchContext | null {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) return null;
  const configuredStateDir = process.env.C2C_STATE_DIR;
  if (!configuredStateDir || !path.isAbsolute(configuredStateDir)) return null;

  const stateDir = path.resolve(configuredStateDir);
  if (!samePath(configuredStateDir, stateDir)) return null;
  const diagnosticsDirectory = path.resolve(stateDir, "autostart", "diagnostics");
  const logFile = path.resolve(diagnosticsDirectory, `${workspaceId}.launch.log`);
  const relativeLogPath = path.relative(stateDir, logFile);
  if (
    !relativeLogPath
    || relativeLogPath === ".."
    || relativeLogPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeLogPath)
  ) return null;

  return { workspaceId, diagnosticsDirectory, logFile };
}

function append(context: LaunchContext, stage: LaunchBreadcrumbStage, exitCode: number | null = null): void {
  try {
    fs.mkdirSync(context.diagnosticsDirectory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(context.logFile, `${JSON.stringify({
      stage,
      workspaceId: context.workspaceId,
      checkedAt: new Date().toISOString(),
      pid: process.pid,
      exitCode,
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Breadcrumbs are diagnostic only and must never affect startup recovery.
  }
}

/** Best-effort record for the current, validated C2C autostart invocation. */
export function recordLaunchBreadcrumb(
  stage: LaunchBreadcrumbStage,
  workspaceId: string,
  exitCode: number | null = null
): void {
  const args = launchArguments();
  if (!args || args.workspaceId.toLowerCase() !== workspaceId.toLowerCase()) return;
  const context = resolveContext(args.workspaceId);
  if (!context) return;
  append(context, stage, exitCode);
}

function isExplicitPreload(): boolean {
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const argument = process.execArgv[index];
    const value = argument === "--import" ? process.execArgv[index + 1] : argument.startsWith("--import=") ? argument.slice("--import=".length) : "";
    if (value === import.meta.url) return true;
  }
  return false;
}

const initialArguments = isExplicitPreload() ? launchArguments() : null;
const initialContext = initialArguments ? resolveContext(initialArguments.workspaceId) : null;
if (initialContext) {
  append(initialContext, "node_started");
  process.once("exit", (exitCode) => append(initialContext, "node_exited", exitCode));
}
