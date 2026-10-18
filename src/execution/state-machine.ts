import type { ExecutionJob, ExecutionJobState } from "./job-types.js";

const TERMINAL = new Set<ExecutionJobState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

const ALLOWED: Record<ExecutionJobState, readonly ExecutionJobState[]> = {
  queued: ["running", "failed", "cancelled", "interrupted"],
  running: ["cancelling", "succeeded", "failed", "cancelled", "timed_out", "interrupted"],
  cancelling: ["cancelled", "timed_out", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  interrupted: [],
};

export function isTerminalExecutionState(state: ExecutionJobState): boolean {
  return TERMINAL.has(state);
}

export function canTransitionExecutionState(from: ExecutionJobState, to: ExecutionJobState): boolean {
  return ALLOWED[from].includes(to);
}

export function transitionExecutionJob<T extends ExecutionJob>(
  job: T,
  state: ExecutionJobState,
  patch: Partial<T> = {},
  at = new Date().toISOString()
): T {
  if (!canTransitionExecutionState(job.state, state)) {
    throw new Error(`Invalid execution job transition: ${job.state} -> ${state}`);
  }
  const next = { ...job, ...patch, state } as T;
  if (state === "running" && next.startedAt === null) next.startedAt = at;
  if (TERMINAL.has(state) && next.finishedAt === null) next.finishedAt = at;
  return next;
}
