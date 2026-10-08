import os from "node:os";
import { getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import { inspectPath } from "./filesystem.js";
import { selectProcesses, buildProcessTree, normalizeProcess } from "./process.js";
import { resolveHostname } from "./network.js";
import { windowsProvider } from "./windows.js";
import { type ObservationProvider, type QueryInput, type TreeInput, type ListenerInput, type FieldStatuses } from "./types.js";

export class HostObservation {
  constructor(private readonly workspace: Workspace, private readonly provider: ObservationProvider = windowsProvider) {}
  async context() {
    const identity = await this.provider.context();
    const fieldStatus: FieldStatuses = {};
    const fields: Record<string, unknown> = {};
    for (const field of ["userName", "userSid", "sessionId", "isElevated", "isPackaged", "packageIdentity"]) {
      fieldStatus[field] = identity[field] == null ? "UNAVAILABLE" : "AVAILABLE";
      fields[field] = identity[field] ?? null;
    }
    if (identity.isPackaged === false) fieldStatus.packageIdentity = "NOT_SUPPORTED";
    return { platform: process.platform, osVersion: os.release(), architecture: process.arch,
      processArchitecture: process.arch, osArchitecture: os.machine(), ...fields,
      effectiveStateRoot: getStateDir(), observationHostPid: process.pid,
      fieldStatus, unavailableFields: Object.keys(fieldStatus).filter(k => fieldStatus[k] !== "AVAILABLE"),
      capturedAt: new Date().toISOString() };
  }
  async processes(input: QueryInput) {
    // PID existence must be observed before applying additional predicates.
    const snapshot = await this.provider.processes(input.pid === undefined
      ? { parentPid: input.parentPid, name: input.name } : { pid: input.pid });
    const result = selectProcesses(snapshot.processes, input);
    return { ...result, processExited: snapshot.truncated && result.processExited ? null : result.processExited,
      truncated: result.truncated || snapshot.truncated, partial: result.partial || snapshot.truncated,
      evidence: "non-atomic CIM snapshot; unavailable fields are not proof of process exit", capturedAt: new Date().toISOString() };
  }
  async tree(input: TreeInput) {
    const snapshot = await this.provider.processes();
    const result = buildProcessTree(snapshot.processes, input);
    return { ...result, processExited: snapshot.truncated && result.processExited ? null : result.processExited,
      truncated: result.truncated || snapshot.truncated, partial: result.partial || snapshot.truncated,
      evidence: "non-atomic CIM snapshot; parent identity checked against start time", capturedAt: new Date().toISOString() };
  }
  async listeners(input: ListenerInput) {
    const snapshot = await this.provider.listeners(input);
    let processes: Awaited<ReturnType<ObservationProvider["processes"]>> | null = null;
    try { processes = await this.provider.processes(); } catch { /* retain listeners without association */ }
    const byPid = new Map(processes?.processes.map(p => [p.pid, normalizeProcess(p)]) ?? []);
    const matches = snapshot.listeners.filter(row =>
      (input.pid === undefined || row.pid === input.pid) && (input.port === undefined || row.localPort === input.port) &&
      (input.protocol === undefined || row.protocol === input.protocol) && (input.address === undefined || row.localAddress === input.address));
    const capturedAt = new Date().toISOString();
    return { listeners: matches.slice(0, input.limit).map(row => {
      const p = byPid.get(row.pid);
      // A separate process snapshot cannot establish ownership across PID reuse.
      return { ...row, processName: p?.name ?? null, processKey: p?.processKey ?? null,
        associationStatus: p ? "SNAPSHOT_UNVERIFIED" : "UNAVAILABLE_OR_EXITED",
        fieldStatus: { processName: p ? "AVAILABLE" : "UNAVAILABLE", processKey: p?.processKey ? "AVAILABLE" : "UNAVAILABLE" }, capturedAt };
    }), truncated: snapshot.truncated || matches.length > input.limit,
      partial: Object.values(snapshot.fieldStatus).some(s => s !== "AVAILABLE") || !processes || matches.some(row => !byPid.has(row.pid)),
      fieldStatus: snapshot.fieldStatus, capturedAt };
  }
  async network() {
    const result = await this.provider.network();
    const adapters = result.adapters as { fieldStatus?: FieldStatuses; truncated?: boolean }[];
    return { ...result, truncated: Boolean(result.truncated) || adapters.some(a => a.truncated),
      partial: Object.entries(result.fieldStatus as FieldStatuses).some(([key, s]) => key !== "internetReachable" && s !== "AVAILABLE") ||
      adapters.some(a => Object.values(a.fieldStatus ?? {}).some(s => s !== "AVAILABLE")), capturedAt: new Date().toISOString() };
  }
  dns(hostname: string) { return resolveHostname(hostname); }
  path(requested: string) { return inspectPath(this.workspace, requested, this.provider); }
}
