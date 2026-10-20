import type { Scope } from "../auth/store.js";
import type { FullAccessCommandInput } from "../execution/full-access-command.js";
import type { ExecutionJobState } from "../execution/job-types.js";
import { CanonicalJsonLimitError, canonicalJson, canonicalSha256 } from "../shared/canonical-json.js";
import type { BatchReadRequest } from "../workspace/batch-read.js";
import type { BatchSearchRequest } from "../workspace/batch-search.js";
import type { EvidenceRequest } from "../workspace/evidence.js";
import type { DiffMode } from "../workspace/git.js";
import type { PermissionMode } from "../permission/mode.js";

export const TASK_SCHEMA_VERSION = 1 as const;

export const TASK_STATES = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_MODEL",
  "CANCELLING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STEP_STATES = ["pending", "running", "succeeded", "failed"] as const;
export type TaskStepStatus = (typeof TASK_STEP_STATES)[number];

export const TASK_DISPATCH_PHASES = ["PREPARED", "CHILD_BOUND", "OBSERVED", "CHECKPOINTED"] as const;
export type TaskDispatchPhase = (typeof TASK_DISPATCH_PHASES)[number];

export const TASK_MAX_STEPS = 16;
export const TASK_MAX_EXECUTION_STEPS = 8;
export const TASK_MAX_PLAN_BYTES = 256 * 1024;
export const TASK_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
export const TASK_MIN_EXECUTION_TIMEOUT_SECONDS = 1;
export const TASK_MAX_EXECUTION_TIMEOUT_SECONDS = 3600;
export const TASK_MAX_CHECKPOINT_BYTES = 1024 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface PersistentTaskPlan {
  version: 1;
  maxDurationMs: number;
  /** Permit one persisted retry for transient pure/read-only steps only. */
  retryReadOnlyOnce?: boolean;
  steps: TaskPlanStep[];
}

export interface BatchReadTaskStep {
  stepId: string;
  kind: "batch_read";
  request: Omit<BatchReadRequest, "cursor">;
}

export interface BatchSearchTaskStep {
  stepId: string;
  kind: "batch_search";
  request: Omit<BatchSearchRequest, "cursor">;
}

export interface CollectEvidenceTaskStep {
  stepId: string;
  kind: "collect_evidence";
  request: Omit<EvidenceRequest, "cursor">;
}

export interface GitReadTaskStep {
  stepId: string;
  kind: "git_read";
  operation: "info" | "status" | "diff";
  repositoryPath: string;
  diffPath?: string;
  diffMode?: DiffMode;
}

export interface ExecutionTaskStep {
  stepId: string;
  kind: "execution";
  command: FullAccessCommandInput;
  timeoutSeconds: number;
  repositoryPath?: string;
}

export type TaskAssertionOperator = "exists" | "equals" | "not_equals" | "count_at_least" | "status_equals";

export interface AssertionTaskStep {
  stepId: string;
  kind: "assertion";
  sourceStepId: string;
  jsonPointer: string;
  operator: TaskAssertionOperator;
  expected?: JsonValue;
  count?: number;
}

export type TaskPlanStep =
  | BatchReadTaskStep
  | BatchSearchTaskStep
  | CollectEvidenceTaskStep
  | GitReadTaskStep
  | ExecutionTaskStep
  | AssertionTaskStep;

export interface TaskAuthBinding {
  workspaceId: string;
  sessionIdentityFingerprint: string | null;
  grantId: string | null;
  permissionMode: PermissionMode;
  requiredScopes: Scope[];
  /** Monotonic workspace authorization version captured when the Task is created. */
  authorizationEpoch?: number;
}

export interface TaskStepState {
  stepId: string;
  state: TaskStepStatus;
  /** Number of pure-step attempts durably started; command steps remain at zero. */
  attemptCount?: number;
}

export type ObservedExecutionTerminalState = Exclude<ExecutionJobState, "queued" | "running" | "cancelling">;

export interface ObservedExecutionOutcome {
  state: ObservedExecutionTerminalState;
  exitCode: number | null;
  failureCode: string | null;
  finishedAt: string | null;
}

export interface TaskDispatchJournalEntry {
  stepId: string;
  attempt: number;
  childIdempotencyKey: string;
  phase: TaskDispatchPhase;
  childJobId?: string;
  observed?: ObservedExecutionOutcome;
}

export interface TaskStepCheckpoint {
  stepId: string;
  completedAt: string;
  result: JsonValue;
  resultHash: string;
  resultBytes: number;
}

export interface PersistentTask {
  taskId: string;
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  workspaceId: string;
  ownerClientId: string;
  idempotencyKeyHash: string;
  authBinding: TaskAuthBinding;
  plan: PersistentTaskPlan;
  planHash: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  /** Zero-based step index, or null when the task has no current step. */
  currentStep: number | null;
  stepStates: TaskStepState[];
  dispatchJournal: TaskDispatchJournalEntry[];
  checkpoints: TaskStepCheckpoint[];
  failureReason: string | null;
  waitingReason: string | null;
}

export type TaskPlanValidationCode = "INVALID_PLAN" | "PLAN_TOO_LARGE";

export class TaskPlanValidationError extends TypeError {
  constructor(public readonly code: TaskPlanValidationCode, message: string) {
    super(message);
    this.name = "TaskPlanValidationError";
  }
}

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const EXECUTION_TERMINAL_STATES: readonly ExecutionJobState[] = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const DIFF_MODES: readonly DiffMode[] = ["unstaged", "staged", "head"];

function invalid(path: string, detail: string): never {
  throw new TaskPlanValidationError("INVALID_PLAN", `${path}: ${detail}`);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "must be an object");
  return value as Record<string, unknown>;
}

function expectKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(path, `missing required field ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(path, `unsupported field ${key}`);
  }
}

function expectString(value: unknown, path: string, min = 0, max = 32_768): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\0")) {
    invalid(path, `must be a string of ${min}..${max} characters without NUL`);
  }
  return value;
}

function expectSafeInteger(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(path, `must be a safe integer in ${min}..${max}`);
  }
  return value;
}

function expectId(value: unknown, path: string): string {
  if (typeof value !== "string" || !STABLE_ID_PATTERN.test(value)) {
    invalid(path, "must match the stable ID pattern");
  }
  return value;
}

function expectArray(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, `must be an array with ${min}..${max} items`);
  }
  return value;
}

function expectHash(value: unknown, path: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) invalid(path, "must be a lowercase SHA-256 hex digest");
  return value;
}

function assertJsonPointer(value: unknown, path: string): string {
  const pointer = expectString(value, path, 0, 32_768);
  if (pointer === "") return pointer;
  if (!pointer.startsWith("/")) invalid(path, "must be an RFC 6901 JSON Pointer");
  for (const segment of pointer.slice(1).split("/")) {
    for (let index = 0; index < segment.length; index += 1) {
      if (segment[index] !== "~") continue;
      const escape = segment[index + 1];
      if (escape !== "0" && escape !== "1") invalid(path, "contains an invalid JSON Pointer escape");
      index += 1;
    }
  }
  return pointer;
}

function validateBatchReadRequest(value: unknown, path: string): void {
  const request = expectObject(value, path);
  expectKeys(request, path, ["items"], ["maxTotalBytes"]);
  const items = expectArray(request.items, `${path}.items`, 1, 16);
  if (request.maxTotalBytes !== undefined) expectSafeInteger(request.maxTotalBytes, `${path}.maxTotalBytes`, 4, 512 * 1024);
  const ids = new Set<string>();
  items.forEach((raw, index) => {
    const itemPath = `${path}.items[${index}]`;
    const item = expectObject(raw, itemPath);
    expectKeys(item, itemPath, ["id", "path"], ["startLine", "endLine", "offsetBytes", "expectedSourceHash", "maxBytes"]);
    const id = expectId(item.id, `${itemPath}.id`);
    if (ids.has(id)) invalid(`${itemPath}.id`, "must be unique within the request");
    ids.add(id);
    expectString(item.path, `${itemPath}.path`, 0, 32_768);
    const lineMode = item.startLine !== undefined || item.endLine !== undefined;
    const byteMode = item.offsetBytes !== undefined;
    if (lineMode && byteMode) invalid(itemPath, "cannot combine line range and byte offset");
    if (item.startLine !== undefined) expectSafeInteger(item.startLine, `${itemPath}.startLine`, 1);
    if (item.endLine !== undefined) expectSafeInteger(item.endLine, `${itemPath}.endLine`, 1);
    if (item.endLine !== undefined && item.startLine !== undefined && Number(item.endLine) < Number(item.startLine)) {
      invalid(`${itemPath}.endLine`, "must be greater than or equal to startLine");
    }
    if (item.offsetBytes !== undefined) expectSafeInteger(item.offsetBytes, `${itemPath}.offsetBytes`, 0);
    if (item.expectedSourceHash !== undefined) expectHash(item.expectedSourceHash, `${itemPath}.expectedSourceHash`);
    if (item.maxBytes !== undefined) expectSafeInteger(item.maxBytes, `${itemPath}.maxBytes`, 4, 64 * 1024);
  });
}

function validateBatchSearchRequest(value: unknown, path: string): void {
  const request = expectObject(value, path);
  expectKeys(request, path, ["queries"]);
  const queries = expectArray(request.queries, `${path}.queries`, 1, 8);
  const ids = new Set<string>();
  queries.forEach((raw, index) => {
    const queryPath = `${path}.queries[${index}]`;
    const query = expectObject(raw, queryPath);
    expectKeys(query, queryPath, ["id", "query", "mode"], ["paths", "glob", "max_matches"]);
    const id = expectId(query.id, `${queryPath}.id`);
    if (ids.has(id)) invalid(`${queryPath}.id`, "must be unique within the request");
    ids.add(id);
    expectString(query.query, `${queryPath}.query`, 0, 512);
    if (query.mode !== "literal" && query.mode !== "regex") invalid(`${queryPath}.mode`, "must be literal or regex");
    if (query.paths !== undefined) {
      expectArray(query.paths, `${queryPath}.paths`, 1, 16).forEach((itemPath, pathIndex) => {
        expectString(itemPath, `${queryPath}.paths[${pathIndex}]`, 0, 32_768);
      });
    }
    if (query.glob !== undefined) expectString(query.glob, `${queryPath}.glob`, 1, 512);
    if (query.max_matches !== undefined) expectSafeInteger(query.max_matches, `${queryPath}.max_matches`, 1, 50);
  });
}

function validateEvidenceRequest(value: unknown, path: string): void {
  const request = expectObject(value, path);
  expectKeys(request, path, [], ["files", "searches", "repositories", "executionJobs"]);
  const ids = new Set<string>();
  const useId = (value: unknown, field: string): void => {
    const id = expectId(value, field);
    if (ids.has(id)) invalid(field, "must be unique across evidence sections");
    ids.add(id);
  };

  if (request.files !== undefined) {
    expectArray(request.files, `${path}.files`, 0, 16).forEach((raw, index) => {
      const itemPath = `${path}.files[${index}]`;
      const item = expectObject(raw, itemPath);
      expectKeys(item, itemPath, ["id", "path", "ranges"]);
      useId(item.id, `${itemPath}.id`);
      expectString(item.path, `${itemPath}.path`, 1, 32_768);
      expectArray(item.ranges, `${itemPath}.ranges`, 1, 8).forEach((rawRange, rangeIndex) => {
        const rangePath = `${itemPath}.ranges[${rangeIndex}]`;
        const range = expectObject(rawRange, rangePath);
        expectKeys(range, rangePath, ["startLine"], ["endLine"]);
        const startLine = expectSafeInteger(range.startLine, `${rangePath}.startLine`, 1);
        if (range.endLine !== undefined) {
          const endLine = expectSafeInteger(range.endLine, `${rangePath}.endLine`, 1);
          if (endLine < startLine) invalid(`${rangePath}.endLine`, "must be greater than or equal to startLine");
        }
      });
    });
  }

  if (request.searches !== undefined) {
    expectArray(request.searches, `${path}.searches`, 0, 8).forEach((raw, index) => {
      const itemPath = `${path}.searches[${index}]`;
      const item = expectObject(raw, itemPath);
      expectKeys(item, itemPath, ["id", "query", "path"], ["glob", "limit"]);
      useId(item.id, `${itemPath}.id`);
      expectString(item.query, `${itemPath}.query`, 0, 512);
      expectString(item.path, `${itemPath}.path`, 1, 32_768);
      if (item.glob !== undefined) expectString(item.glob, `${itemPath}.glob`, 1, 512);
      if (item.limit !== undefined) expectSafeInteger(item.limit, `${itemPath}.limit`, 1, 50);
    });
  }

  if (request.repositories !== undefined) {
    expectArray(request.repositories, `${path}.repositories`, 0, 4).forEach((raw, index) => {
      const itemPath = `${path}.repositories[${index}]`;
      const item = expectObject(raw, itemPath);
      expectKeys(item, itemPath, ["id", "path"], ["diffPath", "diffMode"]);
      useId(item.id, `${itemPath}.id`);
      expectString(item.path, `${itemPath}.path`, 1, 32_768);
      if (item.diffPath !== undefined) expectString(item.diffPath, `${itemPath}.diffPath`, 1, 32_768);
      if (item.diffMode !== undefined && !DIFF_MODES.includes(item.diffMode as DiffMode)) {
        invalid(`${itemPath}.diffMode`, "must be unstaged, staged, or head");
      }
    });
  }

  if (request.executionJobs !== undefined) {
    expectArray(request.executionJobs, `${path}.executionJobs`, 0, 8).forEach((raw, index) => {
      const itemPath = `${path}.executionJobs[${index}]`;
      const item = expectObject(raw, itemPath);
      expectKeys(item, itemPath, ["id", "jobId"]);
      useId(item.id, `${itemPath}.id`);
      if (typeof item.jobId !== "string" || !JOB_ID_PATTERN.test(item.jobId)) {
        invalid(`${itemPath}.jobId`, "must match the existing Execution Job ID pattern");
      }
    });
  }
}

function validateGitReadStep(step: Record<string, unknown>, path: string): void {
  if (step.operation !== "info" && step.operation !== "status" && step.operation !== "diff") {
    invalid(`${path}.operation`, "must be info, status, or diff");
  }
  expectKeys(step, path, ["stepId", "kind", "operation", "repositoryPath"], ["diffPath", "diffMode"]);
  expectString(step.repositoryPath, `${path}.repositoryPath`, 1, 32_768);
  if (step.operation === "diff") {
    if (step.diffPath !== undefined) expectString(step.diffPath, `${path}.diffPath`, 1, 32_768);
    if (step.diffMode !== undefined && !DIFF_MODES.includes(step.diffMode as DiffMode)) {
      invalid(`${path}.diffMode`, "must be unstaged, staged, or head");
    }
  } else if (step.diffPath !== undefined || step.diffMode !== undefined) {
    invalid(path, "diffPath and diffMode are only valid for diff operations");
  }
}

function validateExecutionCommand(value: unknown, path: string): void {
  const command = expectObject(value, path);
  if (command.engine === "program") {
    expectKeys(command, path, ["engine", "executable", "args", "cwd"]);
    expectString(command.executable, `${path}.executable`, 1, 32_767);
    expectString(command.cwd, `${path}.cwd`, 1, 32_767);
    expectArray(command.args, `${path}.args`, 0, 256).forEach((arg, index) => {
      expectString(arg, `${path}.args[${index}]`, 0, 32_767);
    });
    return;
  }
  if (command.engine === "powershell" || command.engine === "cmd") {
    expectKeys(command, path, ["engine", "command", "cwd"]);
    expectString(command.command, `${path}.command`, 1, 32_767);
    expectString(command.cwd, `${path}.cwd`, 1, 32_767);
    return;
  }
  invalid(`${path}.engine`, "must be program, powershell, or cmd");
}

function validateAssertionStep(step: Record<string, unknown>, path: string, earlierStepIds: ReadonlySet<string>): void {
  const operator = step.operator;
  if (operator !== "exists" && operator !== "equals" && operator !== "not_equals" &&
      operator !== "count_at_least" && operator !== "status_equals") {
    invalid(`${path}.operator`, "is not a supported assertion operator");
  }
  expectKeys(step, path, ["stepId", "kind", "sourceStepId", "jsonPointer", "operator"], ["expected", "count"]);
  const sourceStepId = expectId(step.sourceStepId, `${path}.sourceStepId`);
  if (!earlierStepIds.has(sourceStepId)) invalid(`${path}.sourceStepId`, "must reference an earlier step");
  assertJsonPointer(step.jsonPointer, `${path}.jsonPointer`);

  const hasExpected = Object.prototype.hasOwnProperty.call(step, "expected");
  const hasCount = Object.prototype.hasOwnProperty.call(step, "count");
  if (operator === "exists") {
    if (hasExpected || hasCount) invalid(path, "exists does not accept expected or count");
  } else if (operator === "count_at_least") {
    if (!hasCount || hasExpected) invalid(path, "count_at_least requires count and does not accept expected");
    expectSafeInteger(step.count, `${path}.count`, 0);
  } else {
    if (!hasExpected || hasCount) invalid(path, `${operator} requires expected and does not accept count`);
    if (operator === "status_equals" && typeof step.expected !== "string") {
      invalid(`${path}.expected`, "status_equals requires a string value");
    }
  }
}

function validateTaskStep(value: unknown, path: string, earlierStepIds: ReadonlySet<string>): TaskPlanStep {
  const step = expectObject(value, path);
  const stepId = expectId(step.stepId, `${path}.stepId`);
  switch (step.kind) {
    case "batch_read":
      expectKeys(step, path, ["stepId", "kind", "request"]);
      validateBatchReadRequest(step.request, `${path}.request`);
      return step as unknown as BatchReadTaskStep;
    case "batch_search":
      expectKeys(step, path, ["stepId", "kind", "request"]);
      validateBatchSearchRequest(step.request, `${path}.request`);
      return step as unknown as BatchSearchTaskStep;
    case "collect_evidence":
      expectKeys(step, path, ["stepId", "kind", "request"]);
      validateEvidenceRequest(step.request, `${path}.request`);
      return step as unknown as CollectEvidenceTaskStep;
    case "git_read":
      validateGitReadStep(step, path);
      return step as unknown as GitReadTaskStep;
    case "execution":
      expectKeys(step, path, ["stepId", "kind", "command", "timeoutSeconds"], ["repositoryPath"]);
      validateExecutionCommand(step.command, `${path}.command`);
      expectSafeInteger(step.timeoutSeconds, `${path}.timeoutSeconds`, TASK_MIN_EXECUTION_TIMEOUT_SECONDS, TASK_MAX_EXECUTION_TIMEOUT_SECONDS);
      if (step.repositoryPath !== undefined) expectString(step.repositoryPath, `${path}.repositoryPath`, 1, 32_768);
      return step as unknown as ExecutionTaskStep;
    case "assertion":
      validateAssertionStep(step, path, earlierStepIds);
      return step as unknown as AssertionTaskStep;
    default:
      invalid(`${path}.kind`, "is not a supported task step");
  }
  return step as never;
}

/** Validate and return a detached JSON-safe plan with closed fields and bounded canonical UTF-8 size. */
export function validateTaskPlan(value: unknown): PersistentTaskPlan {
  let canonical: string;
  try {
    canonical = canonicalJson(value, { maxBytes: TASK_MAX_PLAN_BYTES });
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError) {
      throw new TaskPlanValidationError("PLAN_TOO_LARGE", `Plan exceeds ${TASK_MAX_PLAN_BYTES} canonical UTF-8 bytes`);
    }
    throw new TaskPlanValidationError("INVALID_PLAN", (error as Error).message || "Plan is not plain JSON data");
  }

  const detached = JSON.parse(canonical) as unknown;
  const plan = expectObject(detached, "plan");
  expectKeys(plan, "plan", ["version", "maxDurationMs", "steps"], ["retryReadOnlyOnce"]);
  if (plan.version !== 1) invalid("plan.version", "must equal 1");
  if (plan.retryReadOnlyOnce !== undefined && typeof plan.retryReadOnlyOnce !== "boolean") {
    invalid("plan.retryReadOnlyOnce", "must be a boolean");
  }
  expectSafeInteger(plan.maxDurationMs, "plan.maxDurationMs", 1, TASK_MAX_DURATION_MS);
  const rawSteps = expectArray(plan.steps, "plan.steps", 0, TASK_MAX_STEPS);
  const earlierStepIds = new Set<string>();
  let executionCount = 0;
  const steps = rawSteps.map((raw, index) => {
    const stepPath = `plan.steps[${index}]`;
    const step = validateTaskStep(raw, stepPath, earlierStepIds);
    if (earlierStepIds.has(step.stepId)) invalid(`${stepPath}.stepId`, "must be unique within the plan");
    earlierStepIds.add(step.stepId);
    if (step.kind === "execution" && ++executionCount > TASK_MAX_EXECUTION_STEPS) {
      invalid("plan.steps", `cannot contain more than ${TASK_MAX_EXECUTION_STEPS} execution steps`);
    }
    return step;
  });
  return {
    version: 1,
    maxDurationMs: plan.maxDurationMs as number,
    ...(plan.retryReadOnlyOnce === undefined ? {} : { retryReadOnlyOnce: plan.retryReadOnlyOnce as boolean }),
    steps,
  };
}

/** Stable SHA-256 over the validated canonical plan. */
export function taskPlanHash(plan: unknown): string {
  return canonicalSha256(validateTaskPlan(plan));
}

/** Derive the same child idempotency key for a task step attempt across restarts. */
export function createChildIdempotencyKey(taskId: string, stepId: string, attempt: number): string {
  if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(taskId)) {
    throw new TypeError("taskId must be a 16..128 character opaque identifier");
  }
  if (typeof stepId !== "string" || !STABLE_ID_PATTERN.test(stepId)) {
    throw new TypeError("stepId must match the stable ID pattern");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive safe integer");
  return `c2c-task-v1-${canonicalSha256(["c2c-task-child-v1", taskId, stepId, attempt])}`;
}

/** Canonicalize and bound a checkpoint result; hash and byte count cover the exact persisted JSON value. */
export function canonicalizeTaskResult(value: unknown): { result: JsonValue; resultHash: string; resultBytes: number } {
  let canonical: string;
  try {
    canonical = canonicalJson(value, { maxBytes: TASK_MAX_CHECKPOINT_BYTES });
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError) {
      throw new RangeError(`Task checkpoint result exceeds ${TASK_MAX_CHECKPOINT_BYTES} canonical UTF-8 bytes`);
    }
    throw error;
  }
  const result = JSON.parse(canonical) as JsonValue;
  return {
    result,
    resultHash: canonicalSha256(result),
    resultBytes: Buffer.byteLength(canonical, "utf8"),
  };
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}
