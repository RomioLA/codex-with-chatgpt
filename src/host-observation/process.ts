import { redactCommandLine } from "./redaction.js";
import { ObservationError, type RawProcess, type ProcessRecord, type QueryInput, type TreeInput } from "./types.js";

export function normalizeProcess(raw: RawProcess): ProcessRecord {
  const fieldStatus = { ...raw.fieldStatus };
  for (const key of ["pid", "parentPid", "name", "exePath", "commandLine", "sessionId", "startTime"] as const) {
    fieldStatus[key] ??= raw[key] == null ? "UNAVAILABLE" : "AVAILABLE";
  }
  const processKey = raw.startTime ? `${raw.pid}@${raw.startTime}` : null;
  fieldStatus.processKey = processKey ? "AVAILABLE" : "UNAVAILABLE";
  // Redact BEFORE truncating: a long quoted secret must not become a leaked prefix.
  const safe = raw.commandLine === null ? null : redactCommandLine(raw.commandLine);
  return { ...raw, processKey, commandLine: safe === null ? null : safe.slice(0, 8192), fieldStatus };
}

export function selectProcesses(snapshot: RawProcess[], input: QueryInput) {
  // Filter commandContains against the safe representation, never a secret-search oracle.
  const matches = snapshot.map(normalizeProcess).filter(p =>
    (input.pid === undefined || p.pid === input.pid) &&
    (input.parentPid === undefined || p.parentPid === input.parentPid) &&
    (input.name === undefined || p.name.toLowerCase() === input.name.toLowerCase()) &&
    (input.exePath === undefined || p.exePath?.toLowerCase() === input.exePath.toLowerCase()) &&
    (input.sessionId === undefined || p.sessionId === input.sessionId) &&
    (input.commandContains === undefined || p.commandLine?.toLowerCase().includes(input.commandContains.toLowerCase())));
  return { processes: matches.slice(0, input.limit), truncated: matches.length > input.limit,
    processExited: input.pid !== undefined && !snapshot.some(p => p.pid === input.pid),
    partial: matches.some(p => Object.values(p.fieldStatus).some(s => s !== "AVAILABLE")) };
}

export function buildProcessTree(snapshot: RawProcess[], input: TreeInput) {
  const byPid = new Map(snapshot.map(p => [p.pid, normalizeProcess(p)]));
  const root = byPid.get(input.pid);
  const result: { process: ProcessRecord; depth: number; relation: string }[] = [];
  const issues: { pid: number; reason: string }[] = [];
  let truncated = false, missingParent = false;
  if (!root) return { nodes: result, issues, partial: true, truncated, missingParent, processExited: true };
  if (input.processKey && root.processKey !== input.processKey) {
    throw new ObservationError("STALE_PROCESS_IDENTITY", "PID no longer matches the requested process identity");
  }
  const seen = new Set<number>();
  function add(p: ProcessRecord, depth: number, relation: string) {
    if (seen.has(p.pid)) return false;
    if (result.length >= input.limit) { truncated = true; return false; }
    seen.add(p.pid); result.push({ process: p, depth, relation }); return true;
  }
  function parentOf(child: ProcessRecord) {
    if (!child.parentPid) return undefined;
    const parent = byPid.get(child.parentPid);
    if (!parent) { missingParent = true; issues.push({ pid: child.parentPid, reason: "PARENT_MISSING_OR_EXITED" }); return undefined; }
    if (!parent.startTime || !child.startTime) {
      issues.push({ pid: child.pid, reason: "EDGE_IDENTITY_UNVERIFIED" }); return undefined;
    }
    if (Date.parse(parent.startTime) > Date.parse(child.startTime)) {
      issues.push({ pid: parent.pid, reason: "PARENT_PID_REUSED" }); return undefined;
    }
    return parent;
  }
  add(root, 0, "root");
  if (input.direction !== "children") {
    let current = root;
    for (let depth = 1; depth <= input.depth; depth++) {
      const parent = parentOf(current);
      if (!parent) break;
      if (!add(parent, depth, "ancestor")) break;
      current = parent;
      if (depth === input.depth && parent.parentPid) truncated = true;
    }
  }
  if (input.direction !== "ancestors") {
    const queue = [{ p: root, depth: 0 }];
    for (let i = 0; i < queue.length && result.length <= input.limit; i++) {
      const { p, depth } = queue[i];
      for (const child of byPid.values()) {
        if (child.parentPid !== p.pid || child.pid === p.pid) continue;
        const verified = parentOf(child);
        if (!verified || verified.pid !== p.pid) continue;
        if (depth >= input.depth) { truncated = true; continue; }
        if (add(child, depth + 1, "child")) queue.push({ p: child, depth: depth + 1 });
      }
    }
  }
  return { nodes: result, issues, truncated, missingParent, processExited: false,
    partial: issues.length > 0 || result.some(n => Object.values(n.process.fieldStatus).some(s => s !== "AVAILABLE")) };
}
