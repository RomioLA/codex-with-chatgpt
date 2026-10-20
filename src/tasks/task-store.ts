import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_SCOPES, type Scope } from "../auth/store.js";
import { durableAtomicReplace as defaultAtomicReplace } from "../execution/atomic-replace.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { canonicalJson, CanonicalJsonLimitError } from "../shared/canonical-json.js";
import { canTransitionTask } from "./task-state-machine.js";
import {
  TASK_DISPATCH_PHASES,
  TASK_MAX_CHECKPOINT_BYTES,
  TASK_MAX_EXECUTION_STEPS,
  TASK_MAX_PLAN_BYTES,
  TASK_MAX_STEPS,
  canonicalizeTaskResult,
  createChildIdempotencyKey,
  isTaskState,
  taskPlanHash,
  validateTaskPlan,
  type ObservedExecutionOutcome,
  type PersistentTask,
  type TaskDispatchJournalEntry,
  type TaskStepCheckpoint,
  type TaskState,
} from "./task-types.js";
import { isPermissionMode } from "../permission/mode.js";

export const MAX_TASKS_PER_WORKSPACE = 32;
export const MAX_TASK_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_TASK_RESULTS_BYTES = 1024 * 1024;

const WORKSPACE_ID_PATTERN = /^[a-f0-9]{12}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CHILD_JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const CLIENT_ID_MAX_LENGTH = 200;
const TEXT_MAX_LENGTH = 512;
const TERMINAL_EXECUTION_STATES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;

interface PersistedTasks {
  version: 1;
  workspaceId: string;
  tasks: PersistentTask[];
}

export interface TaskStoreCorruption {
  code: "TASK_STORE_CORRUPT";
  reason:
    | "read_failed"
    | "store_too_large"
    | "invalid_json"
    | "unsupported_schema"
    | "workspace_mismatch"
    | "invalid_record"
    | "duplicate_task_id"
    | "duplicate_idempotency_key"
    | "duplicate_child_job_id"
    | "too_many_tasks"
    | "write_failed";
}

export type TaskStoreAtomicReplace = (source: string, destination: string, expectedNewHash: string) => void | ReturnType<typeof defaultAtomicReplace>;
type TaskStoreTempWrite = (fd: number, serialized: string) => void;
type TaskStoreTempFlush = (fd: number) => void;

interface TaskStoreOptions {
  directory?: string;
  atomicReplace?: TaskStoreAtomicReplace;
  writeTemp?: TaskStoreTempWrite;
  flushTemp?: TaskStoreTempFlush;
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validNullableHash(value: unknown): value is string | null {
  return value === null || typeof value === "string" && HASH_PATTERN.test(value);
}

function detached<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function compareTasks(left: PersistentTask, right: PersistentTask): number {
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}

function compareRecentTasks(left: PersistentTask, right: PersistentTask): number {
  const byUpdated = right.updatedAt < left.updatedAt ? -1 : right.updatedAt > left.updatedAt ? 1 : 0;
  if (byUpdated !== 0) return byUpdated;
  const byCreated = right.createdAt < left.createdAt ? -1 : right.createdAt > left.createdAt ? 1 : 0;
  return byCreated !== 0 ? byCreated : compareTasks(left, right);
}

function validateTaskRecord(value: unknown, workspaceId: string): PersistentTask {
  try {
    value = JSON.parse(canonicalJson(value, { maxBytes: MAX_TASK_STORE_BYTES })) as unknown;
  } catch {
    throw new TypeError("Task record must be bounded plain JSON data");
  }
  if (!ownRecord(value) || !hasExactKeys(value, [
    "taskId", "schemaVersion", "workspaceId", "ownerClientId", "idempotencyKeyHash", "authBinding",
    "plan", "planHash", "state", "createdAt", "updatedAt", "deadlineAt", "currentStep", "stepStates",
    "dispatchJournal", "checkpoints", "failureReason", "waitingReason",
  ])) throw new TypeError("Invalid Task record fields");

  if (typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId) || value.schemaVersion !== 1 ||
      value.workspaceId !== workspaceId || typeof value.ownerClientId !== "string" ||
      value.ownerClientId.length < 1 || value.ownerClientId.length > CLIENT_ID_MAX_LENGTH || value.ownerClientId.includes("\0") ||
      typeof value.idempotencyKeyHash !== "string" || !HASH_PATTERN.test(value.idempotencyKeyHash) ||
      !isTaskState(value.state) || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) ||
      !validTimestamp(value.deadlineAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
      Date.parse(value.deadlineAt) < Date.parse(value.createdAt)) {
    throw new TypeError("Invalid Task identity, state, or timestamps");
  }

  if (!ownRecord(value.authBinding) || !hasExactKeys(value.authBinding, [
    "workspaceId", "sessionIdentityFingerprint", "grantId", "permissionMode", "requiredScopes",
  ], ["authorizationEpoch"]) || value.authBinding.workspaceId !== workspaceId ||
      !validNullableHash(value.authBinding.sessionIdentityFingerprint) || !validNullableHash(value.authBinding.grantId) ||
      !isPermissionMode(value.authBinding.permissionMode) || !Array.isArray(value.authBinding.requiredScopes) ||
      value.authBinding.requiredScopes.length > SUPPORTED_SCOPES.length ||
      !value.authBinding.requiredScopes.every((scope) => typeof scope === "string" && (SUPPORTED_SCOPES as readonly string[]).includes(scope)) ||
      new Set(value.authBinding.requiredScopes).size !== value.authBinding.requiredScopes.length ||
      value.authBinding.authorizationEpoch !== undefined &&
        (!Number.isSafeInteger(value.authBinding.authorizationEpoch) || Number(value.authBinding.authorizationEpoch) < 0)) {
    throw new TypeError("Invalid Task authorization binding");
  }

  const plan = validateTaskPlan(value.plan);
  if (typeof value.planHash !== "string" || !HASH_PATTERN.test(value.planHash) || value.planHash !== taskPlanHash(plan)) {
    throw new TypeError("Invalid Task plan hash");
  }
  const planBytes = Buffer.byteLength(canonicalJson(plan), "utf8");
  if (planBytes > TASK_MAX_PLAN_BYTES) throw new TypeError("Task plan exceeds its canonical byte limit");
  if (Date.parse(value.deadlineAt) !== Date.parse(value.createdAt) + plan.maxDurationMs) {
    throw new TypeError("Task deadline does not match its plan duration");
  }

  const steps = plan.steps;
  const stepIndex = new Map(steps.map((step, index) => [step.stepId, index]));
  if (value.currentStep !== null && (!Number.isSafeInteger(value.currentStep) || Number(value.currentStep) < 0 || Number(value.currentStep) >= steps.length)) {
    throw new TypeError("Invalid Task current step");
  }
  if (!Array.isArray(value.stepStates) || value.stepStates.length !== steps.length) {
    throw new TypeError("Invalid Task step state list");
  }
  const stepStates = value.stepStates as unknown[];
  const validStepStatuses = ["pending", "running", "succeeded", "failed"];
  for (let index = 0; index < stepStates.length; index += 1) {
    const state = stepStates[index];
    if (!ownRecord(state) || !hasExactKeys(state, ["stepId", "state"], ["attemptCount"]) ||
        state.stepId !== steps[index]?.stepId || !validStepStatuses.includes(String(state.state)) ||
        state.attemptCount !== undefined && (!Number.isSafeInteger(state.attemptCount) || Number(state.attemptCount) < 0 || Number(state.attemptCount) > 2) ||
        steps[index]?.kind === "execution" && (state.attemptCount ?? 0) !== 0) {
      throw new TypeError("Invalid Task step state");
    }
  }

  const running = stepStates.flatMap((state, index) => ownRecord(state) && state.state === "running" ? [index] : []);
  if (running.length > 1 || running.length === 1 && value.currentStep !== running[0]) {
    throw new TypeError("Impossible Task step state");
  }
  if (value.state === "QUEUED" && (value.currentStep !== (steps.length > 0 ? 0 : null) || stepStates.some((state) => !ownRecord(state) || state.state !== "pending" || (state.attemptCount ?? 0) !== 0) ||
      !Array.isArray(value.dispatchJournal) || value.dispatchJournal.length !== 0 ||
      !Array.isArray(value.checkpoints) || value.checkpoints.length !== 0)) {
    throw new TypeError("Queued Task contains execution progress");
  }
  if (value.state === "RUNNING" && (steps.length === 0 || value.currentStep === null)) {
    throw new TypeError("Running Task must identify its current step");
  }
  if (["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(String(value.state)) && running.length > 0) {
    throw new TypeError("Terminal Task contains a running step");
  }
  if (value.state === "COMPLETED" && (value.currentStep !== null ||
      stepStates.some((state) => !ownRecord(state) || state.state !== "succeeded"))) {
    throw new TypeError("Completed Task has incomplete steps");
  }

  if (value.failureReason !== null && (typeof value.failureReason !== "string" || value.failureReason.length > TEXT_MAX_LENGTH || value.failureReason.includes("\0")) ||
      value.waitingReason !== null && (typeof value.waitingReason !== "string" || value.waitingReason.length > TEXT_MAX_LENGTH || value.waitingReason.includes("\0"))) {
    throw new TypeError("Invalid Task reason");
  }
  if (value.state === "WAITING_FOR_MODEL" && (typeof value.waitingReason !== "string" || value.waitingReason.length === 0 || value.failureReason !== null)) {
    throw new TypeError("Waiting Task requires only a waiting reason");
  }
  if ((value.state === "FAILED" || value.state === "INTERRUPTED") && (typeof value.failureReason !== "string" || value.failureReason.length === 0 || value.waitingReason !== null)) {
    throw new TypeError("Failed or interrupted Task requires only a failure reason");
  }
  if (["QUEUED", "RUNNING", "CANCELLING", "COMPLETED", "CANCELLED"].includes(String(value.state)) &&
      (value.failureReason !== null || value.waitingReason !== null)) {
    throw new TypeError("Task state cannot contain a failure or waiting reason");
  }

  if (!Array.isArray(value.checkpoints) || value.checkpoints.length > TASK_MAX_STEPS) {
    throw new TypeError("Invalid Task checkpoint list");
  }
  const checkpointByStep = new Map<string, TaskStepCheckpoint>();
  let totalResultBytes = 0;
  let lastCheckpointStep = -1;
  for (const raw of value.checkpoints) {
    if (!ownRecord(raw) || !hasExactKeys(raw, ["stepId", "completedAt", "result", "resultHash", "resultBytes"]) ||
        typeof raw.stepId !== "string" || !stepIndex.has(raw.stepId) || !validTimestamp(raw.completedAt) ||
        Date.parse(raw.completedAt) < Date.parse(value.createdAt) || Date.parse(raw.completedAt) > Date.parse(value.updatedAt) ||
        typeof raw.resultHash !== "string" || !HASH_PATTERN.test(raw.resultHash) ||
        !Number.isSafeInteger(raw.resultBytes) || Number(raw.resultBytes) < 0) {
      throw new TypeError("Invalid Task checkpoint");
    }
    const checkpoint = canonicalizeTaskResult(raw.result);
    const checkpointStep = stepIndex.get(raw.stepId)!;
    const checkpointStatus = (stepStates[checkpointStep] as Record<string, unknown>).state;
    if (checkpoint.resultHash !== raw.resultHash || checkpoint.resultBytes !== raw.resultBytes || checkpointByStep.has(raw.stepId) ||
        checkpointStep <= lastCheckpointStep || checkpointStatus === "pending" || checkpointStatus === "running") {
      throw new TypeError("Task checkpoint hash, byte count, or step reference is invalid");
    }
    lastCheckpointStep = checkpointStep;
    totalResultBytes += checkpoint.resultBytes;
    if (!Number.isSafeInteger(totalResultBytes) || totalResultBytes > MAX_TASK_RESULTS_BYTES) {
      throw new TypeError("Task cumulative checkpoint results exceed their byte limit");
    }
    checkpointByStep.set(raw.stepId, raw as unknown as TaskStepCheckpoint);
  }
  for (let index = 0; index < stepStates.length; index += 1) {
    const state = (stepStates[index] as Record<string, unknown>).state;
    if (state === "succeeded" && !checkpointByStep.has(steps[index]!.stepId)) {
      throw new TypeError("Succeeded Task step is missing its checkpoint");
    }
  }
  if (value.state === "COMPLETED" && checkpointByStep.size !== steps.length) {
    throw new TypeError("Completed Task is missing a checkpoint");
  }

  const firstUnfinishedStep = stepStates.findIndex((state) => !ownRecord(state) || state.state !== "succeeded");
  if (firstUnfinishedStep === -1) {
    const completed = value.state === "COMPLETED" && value.currentStep === null;
    const deadlineFailed = value.state === "FAILED" && value.failureReason === "TASK_DEADLINE_EXCEEDED" &&
      value.currentStep === null && checkpointByStep.size === steps.length;
    const cancelledAfterAllSteps = value.state === "CANCELLED" && value.currentStep === null && checkpointByStep.size === steps.length;
    const emptyQueued = value.state === "QUEUED" && steps.length === 0 && value.currentStep === null;
    if (!completed && !deadlineFailed && !cancelledAfterAllSteps && !emptyQueued) {
      throw new TypeError("Task with no unfinished steps must be completed or deadline failed");
    }
  } else {
    if (value.currentStep !== firstUnfinishedStep) {
      throw new TypeError("Task current step must be its first unfinished step");
    }
    for (let index = firstUnfinishedStep + 1; index < stepStates.length; index += 1) {
      const state = stepStates[index] as Record<string, unknown>;
      if (state.state !== "pending" || checkpointByStep.has(steps[index]!.stepId)) {
        throw new TypeError("Task cannot advance past an unfinished step");
      }
    }
  }

  if (!Array.isArray(value.dispatchJournal) || value.dispatchJournal.length > TASK_MAX_EXECUTION_STEPS) {
    throw new TypeError("Invalid Task dispatch journal");
  }
  const journalSteps = new Set<string>();
  const childJobIds = new Set<string>();
  let lastJournalStep = -1;
  for (const raw of value.dispatchJournal) {
    if (!ownRecord(raw) || typeof raw.stepId !== "string" || !stepIndex.has(raw.stepId) || journalSteps.has(raw.stepId) ||
        steps[stepIndex.get(raw.stepId)!]?.kind !== "execution" || !Number.isSafeInteger(raw.attempt) || raw.attempt !== 1 ||
        typeof raw.childIdempotencyKey !== "string" || raw.childIdempotencyKey !== createChildIdempotencyKey(value.taskId, raw.stepId, 1) ||
        typeof raw.phase !== "string" || !(TASK_DISPATCH_PHASES as readonly string[]).includes(raw.phase)) {
      throw new TypeError("Invalid Task dispatch journal entry");
    }
    const journalStep = stepIndex.get(raw.stepId)!;
    if (journalStep <= lastJournalStep) throw new TypeError("Task dispatch journal is not in plan order");
    lastJournalStep = journalStep;
    const phase = raw.phase;
    const expectedKeys = phase === "PREPARED"
      ? ["stepId", "attempt", "childIdempotencyKey", "phase"]
      : phase === "CHILD_BOUND"
        ? ["stepId", "attempt", "childIdempotencyKey", "phase", "childJobId"]
        : ["stepId", "attempt", "childIdempotencyKey", "phase", "childJobId", "observed"];
    if (!hasExactKeys(raw, expectedKeys)) throw new TypeError("Invalid Task dispatch journal fields");
    if (phase !== "PREPARED") {
      if (typeof raw.childJobId !== "string" || !CHILD_JOB_ID_PATTERN.test(raw.childJobId) || childJobIds.has(raw.childJobId)) {
        throw new TypeError("Invalid or duplicate Task child job reference");
      }
      childJobIds.add(raw.childJobId);
    }
    if (phase === "OBSERVED" || phase === "CHECKPOINTED") {
      if (!validateObservedOutcome(raw.observed)) throw new TypeError("Invalid observed child outcome");
    }
    if (phase === "CHECKPOINTED") {
      const checkpointState = (stepStates[journalStep] as Record<string, unknown>).state;
      const observed = raw.observed as ObservedExecutionOutcome;
      const expectedStepState = observed.state === "succeeded" ? "succeeded" : "failed";
      if (!checkpointByStep.has(raw.stepId) || checkpointState !== expectedStepState) {
        throw new TypeError("Checkpointed child outcome does not match its Task checkpoint");
      }
    }
    if (phase !== "CHECKPOINTED") {
      const stepStatus = (stepStates[journalStep] as Record<string, unknown>).state;
      const noCheckpoint = !checkpointByStep.has(raw.stepId);
      const matchesCurrentStep = value.currentStep === journalStep;
      const unresolvedTerminal = (value.state === "FAILED" || value.state === "INTERRUPTED") &&
        stepStatus === "failed" && matchesCurrentStep && noCheckpoint &&
        typeof value.failureReason === "string" && value.failureReason.length > 0;
      const waitingForModel = value.state === "WAITING_FOR_MODEL" && stepStatus === "failed" &&
        matchesCurrentStep && noCheckpoint && typeof value.waitingReason === "string" && value.waitingReason.length > 0;
      const cancelledAfterReconciliation = value.state === "CANCELLED" && stepStatus === "failed" &&
        matchesCurrentStep && noCheckpoint && (phase === "PREPARED" || phase === "OBSERVED");
      const runningPhase = stepStatus === "running" && matchesCurrentStep && noCheckpoint;
      if (!unresolvedTerminal && !waitingForModel && !cancelledAfterReconciliation && !runningPhase) {
        throw new TypeError("Incomplete child journal must match the running current step or a failed unresolved terminal step");
      }
    }
    journalSteps.add(raw.stepId);
  }

  for (const checkpoint of checkpointByStep.values()) {
    const checkpointStep = steps[stepIndex.get(checkpoint.stepId)!]!;
    if (checkpointStep.kind === "execution") {
      const journal = value.dispatchJournal.find((entry) => ownRecord(entry) && entry.stepId === checkpoint.stepId);
      if (!ownRecord(journal) || journal.phase !== "CHECKPOINTED") {
        throw new TypeError("Execution checkpoint requires a CHECKPOINTED child journal");
      }
    }
  }

  const executionSteps = steps.filter((step) => step.kind === "execution");
  if (executionSteps.length > 0 && (value.authBinding.permissionMode !== "level2" ||
      value.authBinding.sessionIdentityFingerprint === null || value.authBinding.grantId === null ||
      !(value.authBinding.requiredScopes as Scope[]).includes("execution.run"))) {
    throw new TypeError("Execution Task lacks its Full Access authorization binding");
  }
  if (value.state === "COMPLETED" && value.failureReason !== null || value.state === "COMPLETED" && value.waitingReason !== null) {
    throw new TypeError("Completed Task contains a failure reason");
  }

  const normalizedAuthBinding = {
    ...value.authBinding,
    requiredScopes: [...value.authBinding.requiredScopes as Scope[]].sort(),
  };
  return detached({ ...value, authBinding: normalizedAuthBinding, plan } as unknown as PersistentTask);
}

function validateObservedOutcome(value: unknown): value is ObservedExecutionOutcome {
  return ownRecord(value) && hasExactKeys(value, ["state", "exitCode", "failureCode", "finishedAt"]) &&
    typeof value.state === "string" && TERMINAL_EXECUTION_STATES.includes(value.state as typeof TERMINAL_EXECUTION_STATES[number]) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    (value.failureCode === null || typeof value.failureCode === "string" && value.failureCode.length <= TEXT_MAX_LENGTH && !value.failureCode.includes("\0")) &&
    (value.finishedAt === null || validTimestamp(value.finishedAt));
}

function serializeAtomic(
  file: string,
  tasks: readonly PersistentTask[],
  workspaceId: string,
  atomicReplace: TaskStoreAtomicReplace,
  writeTemp: TaskStoreTempWrite,
  flushTemp: TaskStoreTempFlush,
): void {
  const envelope: PersistedTasks = {
    version: 1,
    workspaceId,
    tasks: [...tasks].sort(compareTasks),
  };
  let serialized: string;
  try {
    serialized = canonicalJson(envelope, { maxBytes: MAX_TASK_STORE_BYTES });
  } catch (error) {
    if (error instanceof CanonicalJsonLimitError) throw new Error("TASK_STORE_TOO_LARGE");
    throw error;
  }
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd: number | undefined;
  let published = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    writeTemp(fd, serialized);
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort where chmod has no effect */ }
    flushTemp(fd);
    fs.closeSync(fd);
    fd = undefined;
    const expectedNewHash = createHash("sha256").update(serialized, "utf8").digest("hex");
    atomicReplace(temporary, file, expectedNewHash);
    published = true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the write or flush error */ }
    }
    if (!published) {
      try { fs.unlinkSync(temporary); } catch { /* remove only this exact temporary path */ }
    }
  }
}

function readBoundedFile(file: string): Buffer {
  const beforePath = fs.lstatSync(file, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error("TASK_STORE_READ_FAILED");
  if (beforePath.size > BigInt(MAX_TASK_STORE_BYTES)) throw new Error("TASK_STORE_TOO_LARGE");

  const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) throw new Error("TASK_STORE_READ_FAILED");
    if (before.size > BigInt(MAX_TASK_STORE_BYTES)) throw new Error("TASK_STORE_TOO_LARGE");
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(fd, bytes, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const extraByte = Buffer.allocUnsafe(1);
    if (fs.readSync(fd, extraByte, 0, 1, offset) > 0) throw new Error("TASK_STORE_TOO_LARGE");
    const afterHandle = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(file, { bigint: true });
    if (before.dev !== afterHandle.dev || before.ino !== afterHandle.ino || before.dev !== afterPath.dev || before.ino !== afterPath.ino ||
        before.size !== afterHandle.size || before.mtimeNs !== afterHandle.mtimeNs || before.ctimeNs !== afterHandle.ctimeNs) {
      throw new Error("TASK_STORE_READ_FAILED");
    }
    return offset === size ? bytes : bytes.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

export class TaskStore {
  readonly directory: string;
  corruption: TaskStoreCorruption | null = null;
  private readonly file: string;
  private readonly atomicReplace: TaskStoreAtomicReplace;
  private readonly writeTemp: TaskStoreTempWrite;
  private readonly flushTemp: TaskStoreTempFlush;
  private tasks = new Map<string, PersistentTask>();

  constructor(readonly workspaceId: string, options: TaskStoreOptions = {}) {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new TypeError("workspaceId must be a 12 character lowercase Workspace ID");
    if (options.atomicReplace !== undefined && typeof options.atomicReplace !== "function") {
      throw new TypeError("atomicReplace must be a synchronous function");
    }
    this.directory = options.directory ?? path.join(getStateDir(), "persistent-tasks", workspaceId);
    this.atomicReplace = options.atomicReplace ?? defaultAtomicReplace;
    this.writeTemp = options.writeTemp ?? ((fd, serialized) => fs.writeFileSync(fd, serialized, { encoding: "utf8" }));
    this.flushTemp = options.flushTemp ?? ((fd) => fs.fsyncSync(fd));
    ensureDir(this.directory);
    this.file = path.join(this.directory, "tasks.json");
    this.load();
  }

  private markCorrupt(reason: TaskStoreCorruption["reason"]): void {
    this.corruption = { code: "TASK_STORE_CORRUPT", reason };
    this.tasks.clear();
  }

  private load(): void {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(this.file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.markCorrupt("read_failed");
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      this.markCorrupt("read_failed");
      return;
    }
    if (stat.size > BigInt(MAX_TASK_STORE_BYTES)) {
      this.markCorrupt("store_too_large");
      return;
    }

    let bytes: Buffer;
    try {
      bytes = readBoundedFile(this.file);
    } catch (error) {
      this.markCorrupt((error as Error).message === "TASK_STORE_TOO_LARGE" ? "store_too_large" : "read_failed");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      this.markCorrupt("invalid_json");
      return;
    }
    if (!ownRecord(raw) || !hasExactKeys(raw, ["version", "workspaceId", "tasks"]) || raw.version !== 1 || !Array.isArray(raw.tasks)) {
      this.markCorrupt("unsupported_schema");
      return;
    }
    if (raw.workspaceId !== this.workspaceId) {
      this.markCorrupt("workspace_mismatch");
      return;
    }
    if (raw.tasks.length > MAX_TASKS_PER_WORKSPACE) {
      this.markCorrupt("too_many_tasks");
      return;
    }

    const loaded = new Map<string, PersistentTask>();
    const idempotencyKeys = new Set<string>();
    const childJobIds = new Set<string>();
    try {
      for (const value of raw.tasks) {
        const task = validateTaskRecord(value, this.workspaceId);
        if (loaded.has(task.taskId)) {
          this.markCorrupt("duplicate_task_id");
          return;
        }
        const idempotencyKey = `${task.ownerClientId}\0${task.idempotencyKeyHash}`;
        if (idempotencyKeys.has(idempotencyKey)) {
          this.markCorrupt("duplicate_idempotency_key");
          return;
        }
        idempotencyKeys.add(idempotencyKey);
        for (const entry of task.dispatchJournal) {
          if (!entry.childJobId) continue;
          if (childJobIds.has(entry.childJobId)) {
            this.markCorrupt("duplicate_child_job_id");
            return;
          }
          childJobIds.add(entry.childJobId);
        }
        loaded.set(task.taskId, task);
      }
    } catch {
      this.markCorrupt("invalid_record");
      return;
    }
    this.tasks = loaded;
  }

  private assertHealthy(): void {
    if (this.corruption) throw new Error("TASK_STORE_CORRUPT");
  }

  private persistThenCommit(next: Map<string, PersistentTask>): void {
    if (next.size > MAX_TASKS_PER_WORKSPACE) throw new Error("TASK_STORE_FULL");
    const idempotencyKeys = new Set<string>();
    const childJobIds = new Set<string>();
    for (const task of next.values()) {
      const idempotencyKey = `${task.ownerClientId}\0${task.idempotencyKeyHash}`;
      if (idempotencyKeys.has(idempotencyKey)) throw new Error("IDEMPOTENCY_CONFLICT");
      idempotencyKeys.add(idempotencyKey);
      for (const entry of task.dispatchJournal) {
        if (!entry.childJobId) continue;
        if (childJobIds.has(entry.childJobId)) throw new Error("TASK_CHILD_REFERENCE_CONFLICT");
        childJobIds.add(entry.childJobId);
      }
    }
    try {
      serializeAtomic(this.file, [...next.values()], this.workspaceId, this.atomicReplace, this.writeTemp, this.flushTemp);
    } catch (error) {
      if ((error as Error).message === "TASK_STORE_TOO_LARGE") throw error;
      this.markCorrupt("write_failed");
      throw error;
    }
    this.tasks = next;
  }

  get(taskId: string): PersistentTask | null {
    this.assertHealthy();
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) return null;
    const task = this.tasks.get(taskId);
    return task ? detached(task) : null;
  }

  create(task: PersistentTask): { task: PersistentTask; duplicate: boolean } {
    this.assertHealthy();
    const validated = validateTaskRecord(task, this.workspaceId);
    if (validated.state !== "QUEUED") throw new TypeError("New Tasks must start in QUEUED state");

    const existing = this.findIdempotentInternal(validated.ownerClientId, validated.idempotencyKeyHash);
    if (existing) {
      if (existing.planHash !== validated.planHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return { task: detached(existing), duplicate: true };
    }
    if (this.tasks.size >= MAX_TASKS_PER_WORKSPACE) throw new Error("TASK_STORE_FULL");
    if (this.tasks.has(validated.taskId)) throw new TypeError("Duplicate Task ID");
    const next = new Map(this.tasks);
    next.set(validated.taskId, validated);
    this.persistThenCommit(next);
    return { task: detached(validated), duplicate: false };
  }

  replace(task: PersistentTask): void {
    this.assertHealthy();
    const current = typeof task?.taskId === "string" ? this.tasks.get(task.taskId) : undefined;
    if (!current) throw new Error("TASK_NOT_FOUND");
    const validated = validateTaskRecord(task, this.workspaceId);
    if (validated.schemaVersion !== current.schemaVersion || validated.workspaceId !== current.workspaceId ||
        validated.ownerClientId !== current.ownerClientId || validated.idempotencyKeyHash !== current.idempotencyKeyHash ||
        validated.planHash !== current.planHash || canonicalJson(validated.plan) !== canonicalJson(current.plan) ||
        canonicalJson(validated.authBinding) !== canonicalJson(current.authBinding) || validated.createdAt !== current.createdAt ||
        validated.deadlineAt !== current.deadlineAt) {
      throw new TypeError("Task immutable fields cannot be replaced");
    }
    if (validated.state !== current.state && !canTransitionTask(current.state, validated.state)) {
      throw new Error("INVALID_TASK_TRANSITION");
    }
    if (Date.parse(validated.updatedAt) < Date.parse(current.updatedAt) ||
        current.currentStep !== null && validated.currentStep !== null && validated.currentStep < current.currentStep) {
      throw new TypeError("Task checkpoint timestamps and step index cannot move backwards");
    }
    const oldStepStates = new Map(current.stepStates.map((entry) => [entry.stepId, entry.state]));
    const stepRank: Record<PersistentTask["stepStates"][number]["state"], number> = {
      pending: 0,
      running: 1,
      succeeded: 2,
      failed: 2,
    };
    for (const entry of validated.stepStates) {
      const old = oldStepStates.get(entry.stepId);
      if (old && (stepRank[entry.state] < stepRank[old] || old === "succeeded" && entry.state !== "succeeded" ||
          old === "failed" && entry.state !== "failed")) {
        throw new TypeError("Task step state cannot move backwards");
      }
      const previousAttempts = current.stepStates.find((item) => item.stepId === entry.stepId)?.attemptCount ?? 0;
      if ((entry.attemptCount ?? 0) < previousAttempts) throw new TypeError("Task step attempt count cannot move backwards");
    }
    const checkpointById = new Map(validated.checkpoints.map((entry) => [entry.stepId, entry]));
    for (const checkpoint of current.checkpoints) {
      const nextCheckpoint = checkpointById.get(checkpoint.stepId);
      if (!nextCheckpoint || canonicalJson(checkpoint) !== canonicalJson(nextCheckpoint)) {
        throw new TypeError("Persisted Task checkpoints are immutable");
      }
    }
    const phaseRank = { PREPARED: 0, CHILD_BOUND: 1, OBSERVED: 2, CHECKPOINTED: 3 } as const;
    const journalByStep = new Map(validated.dispatchJournal.map((entry) => [entry.stepId, entry]));
    for (const previous of current.dispatchJournal) {
      const nextEntry = journalByStep.get(previous.stepId);
      if (!nextEntry || nextEntry.attempt !== previous.attempt || nextEntry.childIdempotencyKey !== previous.childIdempotencyKey ||
          phaseRank[nextEntry.phase] < phaseRank[previous.phase]) {
        throw new TypeError("Task dispatch journal cannot regress or be removed");
      }
      if (nextEntry.phase === previous.phase && canonicalJson(nextEntry) !== canonicalJson(previous)) {
        throw new TypeError("Task dispatch journal phase data is immutable");
      }
      if (previous.childJobId !== undefined && nextEntry.childJobId !== previous.childJobId) {
        throw new TypeError("Task child job reference is immutable");
      }
      if (previous.observed !== undefined && canonicalJson(previous.observed) !== canonicalJson(nextEntry.observed)) {
        throw new TypeError("Observed child outcome is immutable");
      }
    }
    const next = new Map(this.tasks);
    next.set(validated.taskId, validated);
    this.persistThenCommit(next);
  }

  private findIdempotentInternal(ownerClientId: string, idempotencyKeyHash: string): PersistentTask | null {
    for (const task of this.tasks.values()) {
      if (task.ownerClientId === ownerClientId && task.idempotencyKeyHash === idempotencyKeyHash) return task;
    }
    return null;
  }

  findIdempotent(ownerClientId: string, idempotencyKeyHash: string): PersistentTask | null {
    this.assertHealthy();
    if (typeof ownerClientId !== "string" || ownerClientId.length < 1 || ownerClientId.length > CLIENT_ID_MAX_LENGTH ||
        typeof idempotencyKeyHash !== "string" || !HASH_PATTERN.test(idempotencyKeyHash)) return null;
    const task = this.findIdempotentInternal(ownerClientId, idempotencyKeyHash);
    return task ? detached(task) : null;
  }

  listForClient(ownerClientId: string, limit = MAX_TASKS_PER_WORKSPACE): PersistentTask[] {
    this.assertHealthy();
    if (typeof ownerClientId !== "string" || ownerClientId.length < 1 || ownerClientId.length > CLIENT_ID_MAX_LENGTH) return [];
    const bounded = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_TASKS_PER_WORKSPACE, Math.floor(limit))) : MAX_TASKS_PER_WORKSPACE;
    return [...this.tasks.values()]
      .filter((task) => task.ownerClientId === ownerClientId)
      .sort(compareRecentTasks)
      .slice(0, bounded)
      .map(detached);
  }

  listAll(): PersistentTask[] {
    this.assertHealthy();
    return [...this.tasks.values()].sort(compareTasks).map(detached);
  }
}
