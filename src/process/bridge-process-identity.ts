import path from "node:path";
import { ObservationError } from "../host-observation/types.js";
import { queryWindowsProcessIdentity, type WindowsProcessIdentity } from "../host-observation/windows.js";

export type BridgeProcessOwner = "bridge" | "unrelated" | "missing" | "unknown";

let cachedOwnWindowsProcessStartTime: string | undefined;
let ownWindowsProcessStartTimeUnsupported = false;
let inFlightOwnWindowsProcessStartTime: Promise<string | null> | null = null;

/**
 * Query and cache the current process's Windows creation timestamp.
 * Only permanent platform/host unsupported states cache `null`; transient
 * query busy/timeout errors remain retryable.
 */
export async function readOwnWindowsProcessStartTime(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  if (cachedOwnWindowsProcessStartTime !== undefined) return cachedOwnWindowsProcessStartTime;
  if (ownWindowsProcessStartTimeUnsupported) return null;
  if (inFlightOwnWindowsProcessStartTime) return inFlightOwnWindowsProcessStartTime;

  inFlightOwnWindowsProcessStartTime = (async () => {
    try {
      const identity = await queryWindowsProcessIdentity(process.pid);
      if (identity.found === true && identity.pid === process.pid && typeof identity.startTime === "string") {
        const trimmed = identity.startTime.trim();
        if (trimmed.length > 0 && trimmed.length <= 64) {
          cachedOwnWindowsProcessStartTime = trimmed;
          return trimmed;
        }
      }
      return null;
    } catch (error) {
      if (error instanceof ObservationError && error.code === "NOT_SUPPORTED") {
        ownWindowsProcessStartTimeUnsupported = true;
      }
      return null;
    } finally {
      inFlightOwnWindowsProcessStartTime = null;
    }
  })();

  return inFlightOwnWindowsProcessStartTime;
}

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
 * Classify only what the process metadata proves. When `expectedStartTime` is
 * present, OS process creation time establishes whether a live PID is the same
 * OS process regardless of path aliases (e.g. Windows junctions). For legacy
 * records without `expectedStartTime`, C2C entries with differing or unverified
 * `--workspace` strings stay `"unknown"` rather than risking a false `"unrelated"`.
 */
export function classifyBridgeProcessIdentity(
  identity: WindowsProcessIdentity,
  workspaceRoot: string,
  options?: { expectedStartTime?: string | null },
): BridgeProcessOwner {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.found !== true) {
    return identity?.found === false ? "missing" : "unknown";
  }

  const expectedStartTime = typeof options?.expectedStartTime === "string"
    ? options.expectedStartTime.trim()
    : "";
  if (expectedStartTime.length > 0) {
    if (typeof identity.startTime === "string" && identity.startTime.trim().length > 0) {
      return identity.startTime.trim() === expectedStartTime ? "bridge" : "unrelated";
    }
    const executable = identity.exePath || identity.name;
    if (
      typeof executable === "string" &&
      executable.trim() &&
      path.win32.basename(executable).toLowerCase() !== "node.exe"
    ) {
      return "unrelated";
    }
    return "unknown";
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

  if (hasC2cEntry) {
    if (hasServe && workspaceArg.kind === "found" && path.win32.isAbsolute(workspaceArg.value)) {
      let normalizedArg: string;
      try {
        normalizedArg = normalizeWinPath(workspaceArg.value);
      } catch {
        return "unknown";
      }
      if (normalizedArg === normalizedRoot) return "bridge";
    }
    return "unknown";
  }

  if (hasServe && workspaceArg.kind !== "missing") {
    return "unknown";
  }
  return "unrelated";
}

/** Read-only Windows process identity probe. Unsupported or inaccessible data fails closed. */
export async function observeBridgeProcessOwner(
  pid: number,
  workspaceRoot: string,
  expectedStartTime?: string | null,
): Promise<BridgeProcessOwner> {
  if (process.platform !== "win32") return "unknown";
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    const identity = await queryWindowsProcessIdentity(pid);
    if (identity.pid !== pid) return "unknown";
    return classifyBridgeProcessIdentity(identity, workspaceRoot, { expectedStartTime });
  } catch {
    return "unknown";
  }
}
