import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_ID_PATTERN = /^[a-f0-9]{12}$/i;
const ENVIRONMENT_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/i;

export interface TaskLaunchPayload {
  version: 1;
  stateDir: string;
  workspaceId: string;
  workspaceRoot: string;
  environment: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isAbsoluteWindowsPath(value: string): boolean {
  return path.win32.isAbsolute(value);
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

export function parseTaskLaunchPayload(encoded: string): TaskLaunchPayload {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Invalid task launch payload encoding.");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("Invalid task launch payload encoding.");

  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "environment,stateDir,version,workspaceId,workspaceRoot"
    || value.version !== 1
    || typeof value.stateDir !== "string"
    || !isAbsoluteWindowsPath(value.stateDir)
    || typeof value.workspaceId !== "string"
    || !WORKSPACE_ID_PATTERN.test(value.workspaceId)
    || typeof value.workspaceRoot !== "string"
    || !isAbsoluteWindowsPath(value.workspaceRoot)
    || !isRecord(value.environment)) {
    throw new Error("Invalid task launch payload.");
  }

  const environment: Record<string, string> = {};
  for (const [name, item] of Object.entries(value.environment)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || typeof item !== "string" || item.includes("\0")) {
      throw new Error("Invalid task launch environment.");
    }
    if (name.toUpperCase() !== "C2C_STATE_DIR") environment[name] = item;
  }

  return {
    version: 1,
    stateDir: path.win32.resolve(value.stateDir),
    workspaceId: value.workspaceId,
    workspaceRoot: path.win32.resolve(value.workspaceRoot),
    environment,
  };
}

function requireRegularRuntimeFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !sameWindowsPath(fs.realpathSync.native(file), file)) {
    throw new Error("The protected C2C runtime contains an invalid autostart file.");
  }
}

async function runTaskLauncher(): Promise<void> {
  try {
    if (process.argv.length !== 3) throw new Error("Invalid task launch arguments.");
    const payload = parseTaskLaunchPayload(process.argv[2]!);
    const launcherDirectory = path.dirname(fileURLToPath(import.meta.url));
    const runtimeRoot = path.win32.resolve(launcherDirectory, "..", "..");
    const nodePath = path.win32.join(runtimeRoot, "node", "node.exe");
    const cliPath = path.win32.join(runtimeRoot, "dist", "cli", "index.js");
    const breadcrumbPath = path.win32.join(runtimeRoot, "dist", "autostart", "launch-breadcrumb.js");

    if (!sameWindowsPath(process.execPath, nodePath)) throw new Error("The C2C runtime Node identity does not match.");
    for (const file of [cliPath, breadcrumbPath]) requireRegularRuntimeFile(file);

    for (const [name, value] of Object.entries(payload.environment)) process.env[name] = value;
    process.env.C2C_STATE_DIR = payload.stateDir;
    process.argv = [
      process.execPath,
      cliPath,
      "autostart",
      "restore",
      "--workspace-id",
      payload.workspaceId,
      "--workspace",
      payload.workspaceRoot,
    ];

    const breadcrumbUrl = pathToFileURL(breadcrumbPath).href;
    process.execArgv.push("--import", breadcrumbUrl);
    await import(breadcrumbUrl);
    await import(pathToFileURL(cliPath).href);
  } catch {
    process.stderr.write("C2C Scheduled Task startup failed.\n");
    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1];
if (invokedFile && sameWindowsPath(fileURLToPath(import.meta.url), invokedFile)) {
  void runTaskLauncher();
}
