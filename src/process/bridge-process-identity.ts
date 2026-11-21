import path from "node:path";
import { queryWindowsProcessIdentity, type WindowsProcessIdentity } from "../host-observation/windows.js";

export type BridgeProcessOwner = "bridge" | "unrelated" | "missing" | "unknown";

export type WorkspaceArgExtraction =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  | { kind: "ambiguous" };

function tokenizeWindowsCommandLine(commandLine: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let inQuotes = false;
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      inToken = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inQuotes) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

export function extractWorkspaceArg(commandLine: string): WorkspaceArgExtraction {
  const tokens = tokenizeWindowsCommandLine(commandLine);
  if (!tokens) return { kind: "ambiguous" };

  let foundValue: string | undefined;
  let count = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();
    if (lower === "--workspace") {
      count += 1;
      if (count > 1 || i + 1 >= tokens.length) return { kind: "ambiguous" };
      const value = tokens[i + 1]!;
      if (!value.trim()) return { kind: "ambiguous" };
      foundValue = value;
      i += 1;
    } else if (lower.startsWith("--workspace=")) {
      count += 1;
      if (count > 1) return { kind: "ambiguous" };
      const value = token.slice("--workspace=".length);
      if (!value.trim()) return { kind: "ambiguous" };
      foundValue = value;
    }
  }

  if (count === 0) return { kind: "missing" };
  return { kind: "found", value: foundValue! };
}

function normalizeWinPath(p: string): string {
  let normalized = path.win32.normalize(p.replaceAll("/", "\\"));
  if (normalized.length > 3 && normalized.endsWith("\\")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

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
    normalizedRoot = normalizeWinPath(workspaceRoot);
  } catch {
    return "unknown";
  }
  if (!path.win32.isAbsolute(normalizedRoot) || normalizedRoot === ".") return "unknown";

  const commandLine = identity.commandLine.replaceAll("/", "\\").toLowerCase();
  const hasC2cEntry = commandLine.includes("\\dist\\cli\\index.js") ||
    commandLine.includes("\\src\\cli\\index.ts") ||
    commandLine.includes("\\bin\\c2c.js");
  const hasServe = /(?:^|[\s"'])serve(?:$|[\s"'])/i.test(commandLine);
  const workspaceArg = extractWorkspaceArg(identity.commandLine);

  if (hasC2cEntry && hasServe) {
    if (workspaceArg.kind !== "found") return "unknown";
    if (!path.win32.isAbsolute(workspaceArg.value)) return "unknown";
    let normalizedArg: string;
    try {
      normalizedArg = normalizeWinPath(workspaceArg.value);
    } catch {
      return "unknown";
    }
    return normalizedArg === normalizedRoot ? "bridge" : "unrelated";
  }
  if (!hasC2cEntry && hasServe && workspaceArg.kind !== "missing") {
    if (workspaceArg.kind === "ambiguous" || !path.win32.isAbsolute(workspaceArg.value)) return "unknown";
    try {
      if (normalizeWinPath(workspaceArg.value) === normalizedRoot) return "unknown";
    } catch {
      return "unknown";
    }
  }
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
