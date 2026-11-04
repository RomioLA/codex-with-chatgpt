import path from "node:path";
import { queryWindowsProcessIdentity, type WindowsProcessIdentity } from "../host-observation/windows.js";

export type BridgeProcessOwner = "bridge" | "unrelated" | "missing" | "unknown";

/**
 * Classify only what the process metadata proves. A live non-Node PID cannot be
 * the Bridge; a Node PID is considered a Bridge only when its command line
 * matches this workspace's C2C serve entry. Ambiguous metadata stays unknown.
 */
export function classifyBridgeProcessIdentity(
  identity: WindowsProcessIdentity,
  workspaceRoot: string,
): BridgeProcessOwner {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.found !== true) {
    return identity?.found === false ? "missing" : "unknown";
  }
  const executable = identity.exePath || identity.name;
  if (typeof executable !== "string" || !executable.trim()) return "unknown";
  if (path.win32.basename(executable).toLowerCase() !== "node.exe") return "unrelated";
  if (typeof identity.commandLine !== "string" || !identity.commandLine.trim()) return "unknown";

  let normalizedRoot: string;
  try {
    normalizedRoot = path.win32.normalize(workspaceRoot.replaceAll("/", "\\")).toLowerCase();
  } catch {
    return "unknown";
  }
  if (!path.win32.isAbsolute(normalizedRoot) || normalizedRoot === ".") return "unknown";

  const commandLine = identity.commandLine.replaceAll("/", "\\").toLowerCase();
  const hasC2cEntry = commandLine.includes("\\dist\\cli\\index.js") ||
    commandLine.includes("\\src\\cli\\index.ts") ||
    commandLine.includes("\\bin\\c2c.js");
  const hasServe = /(?:^|[\s"'])serve(?:$|[\s"'])/i.test(commandLine);
  const hasWorkspaceFlag = /(?:^|\s)--workspace(?:$|\s|=)/i.test(commandLine);
  const hasWorkspaceRoot = commandLine.includes(normalizedRoot);

  if (hasC2cEntry && hasServe && hasWorkspaceFlag) {
    return hasWorkspaceRoot ? "bridge" : "unrelated";
  }
  if (!hasC2cEntry && hasServe && hasWorkspaceFlag && hasWorkspaceRoot) return "unknown";
  if (hasC2cEntry && hasServe) return "unknown";
  return "unrelated";
}

/** Read-only Windows process identity probe. Unsupported or inaccessible data fails closed. */
export async function observeBridgeProcessOwner(
  pid: number,
  workspaceRoot: string,
): Promise<BridgeProcessOwner> {
  if (process.platform !== "win32") return "unknown";
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    const identity = await queryWindowsProcessIdentity(pid);
    if (identity.pid !== pid) return "unknown";
    return classifyBridgeProcessIdentity(identity, workspaceRoot);
  } catch {
    return "unknown";
  }
}
