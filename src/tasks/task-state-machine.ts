import {
  isTaskState,
  type PersistentTask,
  type TaskState,
} from "./task-types.js";

const ALLOWED: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ["RUNNING", "WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "INTERRUPTED"],
  RUNNING: ["WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "INTERRUPTED"],
  WAITING_FOR_MODEL: ["CANCELLING", "INTERRUPTED"],
  CANCELLING: ["CANCELLED", "INTERRUPTED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  INTERRUPTED: [],
};

export const TASK_TERMINAL_STATES: readonly TaskState[] = ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"];

export type TaskTransitionPatch = Partial<Pick<
  PersistentTask,
  "currentStep" | "stepStates" | "dispatchJournal" | "checkpoints" | "failureReason" | "waitingReason"
>>;

const PATCH_FIELDS = new Set([
  "currentStep",
  "stepStates",
  "dispatchJournal",
  "checkpoints",
  "failureReason",
  "waitingReason",
]);

export function canTransitionTask(from: unknown, to: unknown): boolean {
  return isTaskState(from) && isTaskState(to) && ALLOWED[from].includes(to);
}

function validatePatch(patch: TaskTransitionPatch): void {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch) ||
      (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) {
    throw new TypeError("Task transition patch must be a plain object");
  }
  for (const key of Object.keys(patch)) {
    if (!PATCH_FIELDS.has(key)) throw new TypeError(`Task transition patch cannot change ${key}`);
  }
  if (Object.getOwnPropertySymbols(patch).length > 0) throw new TypeError("Task transition patch cannot contain symbol keys");
  for (const key of Object.keys(patch)) {
    const descriptor = Object.getOwnPropertyDescriptor(patch, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Task transition patch cannot contain accessors or non-enumerable fields");
    }
  }
}

/** Apply a legal state transition and an allowlisted checkpoint patch atomically at the domain boundary. */
export function transitionTask(
  task: PersistentTask,
  state: TaskState,
  patch: TaskTransitionPatch = {},
  at = new Date().toISOString(),
): PersistentTask {
  if (!task || typeof task !== "object" || !isTaskState(task.state)) {
    throw new TypeError("Cannot transition a task with an invalid current state");
  }
  if (!canTransitionTask(task.state, state)) {
    throw new Error(`Invalid task transition: ${task.state} -> ${state}`);
  }
  validatePatch(patch);
  if (typeof at !== "string" || at.length === 0) throw new TypeError("Task transition timestamp must be a non-empty string");

  const next: PersistentTask = {
    ...task,
    ...patch,
    state,
    updatedAt: at,
  };
  return next;
}

export function isTerminalTaskState(state: unknown): boolean {
  return isTaskState(state) && TASK_TERMINAL_STATES.includes(state);
}
