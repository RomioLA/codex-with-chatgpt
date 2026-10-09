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

export function transitionExecutionJob(
  job: ExecutionJob,
  state: ExecutionJobState,
  patch: Partial<ExecutionJob> = {},
  at = new Date().toISOString()
): ExecutionJob {
  if (!canTransitionExecutionState(job.state, state)) {
    throw new Error(`Invalid execution job transition: ${job.state} -> ${state}`);
  }
  const next: ExecutionJob = { ...job, ...patch, state };
  if (state === "running" && next.startedAt === null) next.startedAt = at;
  if (TERMINAL.has(state) && next.finishedAt === null) next.finishedAt = at;
  return next;
}
