import { canonicalJson } from "../shared/canonical-json.js";
import {
  TASK_DISPATCH_PHASES,
  canonicalizeTaskResult,
  createChildIdempotencyKey,
  type ObservedExecutionOutcome,
  type PersistentTask,
  type TaskDispatchJournalEntry,
  type TaskStepCheckpoint,
  type TaskStepState,
} from "./task-types.js";

export type TaskJournalErrorCode =
  | "INVALID_TASK"
  | "INVALID_STEP"
  | "INVALID_ATTEMPT"
  | "JOURNAL_CONFLICT"
  | "INVALID_CHILD_JOB_ID"
  | "INVALID_OUTCOME"
  | "INVALID_CHECKPOINT";

export class TaskJournalError extends Error {
  constructor(public readonly code: TaskJournalErrorCode, message: string) {
    super(message);
    this.name = "TaskJournalError";
  }
}

export interface PreparedTaskExecutionDispatch {
  task: PersistentTask;
  entry: TaskDispatchJournalEntry;
}

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Matches ExecutionJobStore's persisted jobId validator. */
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const DISPATCH_PHASES = new Set<string>(TASK_DISPATCH_PHASES);

function fail(code: TaskJournalErrorCode, message: string): never {
  throw new TaskJournalError(code, message);
}

function cloneTask(task: PersistentTask): PersistentTask {
  try {
    return JSON.parse(canonicalJson(task)) as PersistentTask;
  } catch (error) {
    fail("INVALID_TASK", `Task must be canonical plain JSON data: ${(error as Error).message}`);
  }
}

function validateStepId(stepId: string): void {
  if (typeof stepId !== "string" || !STEP_ID_PATTERN.test(stepId)) {
    fail("INVALID_STEP", "stepId must match the stable task step ID pattern");
  }
}

function assertTaskPlan(task: PersistentTask): void {
  if (!task || typeof task !== "object" || !task.plan || !Array.isArray(task.plan.steps)) {
    fail("INVALID_TASK", "Task plan steps are missing");
  }
}

function validateAt(at: string): void {
  if (typeof at !== "string" || at.length === 0 || at.includes("\0")) {
    fail("INVALID_TASK", "at must be a non-empty timestamp string");
  }
}

function findStepIndex(task: PersistentTask, stepId: string): number {
  assertTaskPlan(task);
  validateStepId(stepId);
  const matches = task.plan.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step?.stepId === stepId);
  if (matches.length !== 1) fail("INVALID_STEP", "stepId must identify exactly one plan step");
  return matches[0]!.index;
}

function findStepStateIndex(task: PersistentTask, stepId: string): number {
  if (!Array.isArray(task.stepStates)) fail("INVALID_TASK", "Task step states are missing");
  const matches = task.stepStates
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step?.stepId === stepId);
  if (matches.length !== 1) fail("INVALID_TASK", "Task must have exactly one step state for each addressed step");
  return matches[0]!.index;
}

function validateJournalEntry(task: PersistentTask, entry: TaskDispatchJournalEntry): void {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      !STEP_ID_PATTERN.test(entry.stepId) || !Number.isSafeInteger(entry.attempt) || entry.attempt < 1 ||
      !DISPATCH_PHASES.has(entry.phase) ||
      entry.childIdempotencyKey !== createChildIdempotencyKey(task.taskId, entry.stepId, entry.attempt)) {
    fail("INVALID_TASK", "Task dispatch journal entry is invalid");
  }
  if (entry.childJobId !== undefined && (typeof entry.childJobId !== "string" || !JOB_ID_PATTERN.test(entry.childJobId))) {
    fail("INVALID_TASK", "Task dispatch journal childJobId is invalid");
  }
  if (entry.observed !== undefined) cloneOutcome(entry.observed);

  if (entry.phase === "PREPARED" && (entry.childJobId !== undefined || entry.observed !== undefined)) {
    fail("INVALID_TASK", "PREPARED journal entry cannot include a child or observed outcome");
  }
  if (entry.phase === "CHILD_BOUND" && (!entry.childJobId || entry.observed !== undefined)) {
    fail("INVALID_TASK", "CHILD_BOUND journal entry requires only a child job reference");
  }
  if ((entry.phase === "OBSERVED" || entry.phase === "CHECKPOINTED") && (!entry.childJobId || !entry.observed)) {
    fail("INVALID_TASK", `${entry.phase} journal entry requires a bound child and observed terminal outcome`);
  }
}

function findJournalIndex(task: PersistentTask, stepId: string): number {
  if (!Array.isArray(task.dispatchJournal)) fail("INVALID_TASK", "Task dispatch journal is missing");
  for (const entry of task.dispatchJournal) validateJournalEntry(task, entry);
  const matches = task.dispatchJournal
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.stepId === stepId);
  if (matches.length !== 1) fail("JOURNAL_CONFLICT", "Expected exactly one dispatch journal entry for this step");
  return matches[0]!.index;
}

/** Return a detached validated dispatch entry for the step, or null if no attempt has been prepared. */
export function getTaskDispatchJournalEntry(
  task: PersistentTask,
  stepId: string,
): TaskDispatchJournalEntry | null {
  assertTaskPlan(task);
  const stepIndex = findStepIndex(task, stepId);
  if (task.plan.steps[stepIndex]?.kind !== "execution") fail("INVALID_STEP", "Journal entry must refer to an execution step");
  if (!Array.isArray(task.dispatchJournal)) fail("INVALID_TASK", "Task dispatch journal is missing");
  for (const entry of task.dispatchJournal) validateJournalEntry(task, entry);
  const matches = task.dispatchJournal.filter((entry) => entry.stepId === stepId);
  if (matches.length > 1) fail("JOURNAL_CONFLICT", "A step cannot have more than one dispatch journal entry");
  if (matches.length === 0) return null;
  try {
    return JSON.parse(canonicalJson(matches[0])) as TaskDispatchJournalEntry;
  } catch (error) {
    fail("INVALID_TASK", `Task dispatch journal entry is not canonical JSON: ${(error as Error).message}`);
  }
}

function cloneOutcome(value: unknown): ObservedExecutionOutcome {
  let outcome: unknown;
  try {
    outcome = JSON.parse(canonicalJson(value));
  } catch (error) {
    fail("INVALID_OUTCOME", `Observed outcome must be plain JSON: ${(error as Error).message}`);
  }
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    fail("INVALID_OUTCOME", "Observed outcome must be an object");
  }
  const record = outcome as Record<string, unknown>;
  const allowed = new Set(["state", "exitCode", "failureCode", "finishedAt"]);
  if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
    fail("INVALID_OUTCOME", "Observed outcome contains missing or unsupported fields");
  }
  if (typeof record.state !== "string" || !TERMINAL_JOB_STATES.has(record.state) ||
      (record.exitCode !== null && (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode))) ||
      (record.failureCode !== null && typeof record.failureCode !== "string") ||
      (record.finishedAt !== null && typeof record.finishedAt !== "string")) {
    fail("INVALID_OUTCOME", "Observed outcome must contain a terminal job state and valid terminal details");
  }
  return outcome as ObservedExecutionOutcome;
}

function updateTask(task: PersistentTask, at: string): PersistentTask {
  const next = cloneTask(task);
  next.updatedAt = at;
  return next;
}

/** Persist the deterministic dispatch intent before attempting to create or reconnect a child job. */
export function prepareTaskExecutionDispatch(
  task: PersistentTask,
  stepId: string,
  attempt: number,
  at = new Date().toISOString(),
): PreparedTaskExecutionDispatch {
  validateAt(at);
  if (!task || task.state !== "RUNNING") fail("JOURNAL_CONFLICT", "Execution dispatch requires a RUNNING task");
  if (!Number.isSafeInteger(attempt) || attempt !== 1) {
    fail("INVALID_ATTEMPT", "attempt must be 1; automatic execution retries are disabled");
  }

  const stepIndex = findStepIndex(task, stepId);
  if (!Number.isSafeInteger(task.currentStep) || task.currentStep !== stepIndex) {
    fail("INVALID_STEP", "currentStep must point to the requested execution step");
  }
  if (task.plan.steps[stepIndex]?.kind !== "execution") {
    fail("INVALID_STEP", "Only execution steps can have child dispatch journals");
  }
  if (!Array.isArray(task.dispatchJournal)) fail("INVALID_TASK", "Task dispatch journal is missing");
  for (const entry of task.dispatchJournal) validateJournalEntry(task, entry);
  if (task.dispatchJournal.some((entry) => entry.stepId === stepId)) {
    fail("JOURNAL_CONFLICT", "This execution step already has a dispatch journal entry");
  }
  if (task.dispatchJournal.some((entry) => entry.phase !== "CHECKPOINTED")) {
    fail("JOURNAL_CONFLICT", "A Task may have at most one uncheckpointed execution dispatch");
  }

  const stateIndex = findStepStateIndex(task, stepId);
  if (task.stepStates[stateIndex]?.state !== "pending") {
    fail("JOURNAL_CONFLICT", "Execution step must be pending before dispatch preparation");
  }

  const entry: TaskDispatchJournalEntry = {
    stepId,
    attempt,
    childIdempotencyKey: createChildIdempotencyKey(task.taskId, stepId, attempt),
    phase: "PREPARED",
  };
  const next = updateTask(task, at);
  next.dispatchJournal.push({ ...entry });
  next.stepStates[stateIndex] = { stepId, state: "running" } satisfies TaskStepState;
  return { task: next, entry: { ...entry } };
}

/** Bind the one child job discovered or created for a PREPARED step. */
export function bindTaskExecutionChild(
  task: PersistentTask,
  stepId: string,
  childJobId: string,
  at: string,
): PersistentTask {
  validateAt(at);
  validateStepId(stepId);
  if (typeof childJobId !== "string" || !JOB_ID_PATTERN.test(childJobId)) {
    fail("INVALID_CHILD_JOB_ID", "childJobId must match the existing Execution Job ID format");
  }
  const stepIndex = findStepIndex(task, stepId);
  if (task.plan.steps[stepIndex]?.kind !== "execution") fail("INVALID_STEP", "Journal entry must refer to an execution step");
  const journalIndex = findJournalIndex(task, stepId);
  const sourceEntry = task.dispatchJournal[journalIndex]!;
  if (sourceEntry.phase !== "PREPARED") fail("JOURNAL_CONFLICT", "Only PREPARED dispatches can bind a child job");

  const next = updateTask(task, at);
  next.dispatchJournal[journalIndex] = {
    ...next.dispatchJournal[journalIndex]!,
    phase: "CHILD_BOUND",
    childJobId,
  };
  return next;
}

/** Record a terminal observation for a bound child; running states cannot be checkpointed as outcomes. */
export function observeTaskExecutionChild(
  task: PersistentTask,
  stepId: string,
  outcome: ObservedExecutionOutcome,
  at: string,
): PersistentTask {
  validateAt(at);
  validateStepId(stepId);
  const observed = cloneOutcome(outcome);
  const stepIndex = findStepIndex(task, stepId);
  if (task.plan.steps[stepIndex]?.kind !== "execution") fail("INVALID_STEP", "Journal entry must refer to an execution step");
  const journalIndex = findJournalIndex(task, stepId);
  const sourceEntry = task.dispatchJournal[journalIndex]!;
  if (sourceEntry.phase !== "CHILD_BOUND" || !sourceEntry.childJobId) {
    fail("JOURNAL_CONFLICT", "Only CHILD_BOUND dispatches can record a terminal observation");
  }

  const next = updateTask(task, at);
  next.dispatchJournal[journalIndex] = {
    ...next.dispatchJournal[journalIndex]!,
    phase: "OBSERVED",
    observed,
  };
  return next;
}

/** Commit the observed step result and journal phase without changing Task.state. */
export function checkpointTaskExecution(
  task: PersistentTask,
  stepId: string,
  result: unknown,
  at: string,
  success: boolean,
): PersistentTask {
  validateAt(at);
  validateStepId(stepId);
  if (typeof success !== "boolean") fail("INVALID_CHECKPOINT", "success must be a boolean");
  const canonical = (() => {
    try {
      return canonicalizeTaskResult(result);
    } catch (error) {
      fail("INVALID_CHECKPOINT", (error as Error).message);
    }
  })();
  const stepIndex = findStepIndex(task, stepId);
  if (task.plan.steps[stepIndex]?.kind !== "execution") fail("INVALID_STEP", "Checkpoint must refer to an execution step");
  if (!Number.isSafeInteger(task.currentStep) || task.currentStep !== stepIndex) {
    fail("INVALID_STEP", "currentStep must point to the execution step being checkpointed");
  }
  const stateIndex = findStepStateIndex(task, stepId);
  if (task.stepStates[stateIndex]?.state !== "running") {
    fail("JOURNAL_CONFLICT", "Execution step must be running before checkpointing");
  }
  if (!Array.isArray(task.checkpoints) || task.checkpoints.some((checkpoint) => checkpoint.stepId === stepId)) {
    fail("JOURNAL_CONFLICT", "Execution step already has a checkpoint or checkpoint storage is invalid");
  }
  const journalIndex = findJournalIndex(task, stepId);
  const sourceEntry = task.dispatchJournal[journalIndex]!;
  if (sourceEntry.phase !== "OBSERVED" || !sourceEntry.childJobId || !sourceEntry.observed) {
    fail("JOURNAL_CONFLICT", "Only OBSERVED dispatches can be checkpointed");
  }
  if (success !== (sourceEntry.observed.state === "succeeded")) {
    fail("INVALID_CHECKPOINT", "success must match the observed child terminal state");
  }

  const checkpoint: TaskStepCheckpoint = {
    stepId,
    completedAt: at,
    result: canonical.result,
    resultHash: canonical.resultHash,
    resultBytes: canonical.resultBytes,
  };
  const next = updateTask(task, at);
  next.checkpoints.push(checkpoint);
  next.dispatchJournal[journalIndex] = {
    ...next.dispatchJournal[journalIndex]!,
    phase: "CHECKPOINTED",
  };
  next.stepStates[stateIndex] = { stepId, state: success ? "succeeded" : "failed" };
  if (success) next.currentStep = stepIndex + 1 < task.plan.steps.length ? stepIndex + 1 : null;
  return next;
}
