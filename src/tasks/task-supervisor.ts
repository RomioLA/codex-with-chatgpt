import { createHash, randomBytes } from "node:crypto";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import { isFullAccessExecutionJob, type ExecutionJob, type OutputStream } from "../execution/job-types.js";
import type { ExecutionSupervisor } from "../execution/supervisor.js";
import { readAuthorizationEpoch, readCurrentSessionGrant, readPermission } from "../permission/store.js";
import type { Scope } from "../auth/store.js";
import {
  BatchContractError,
  SnapshotRegistry,
} from "../workspace/batch.js";
import { batchRead } from "../workspace/batch-read.js";
import { batchSearch } from "../workspace/batch-search.js";
import { collectEvidence } from "../workspace/evidence.js";
import { gitDiff, gitRepositoryInfo, gitStatus, selectGitRepository } from "../workspace/git.js";
import type { Workspace } from "../workspace/manager.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { MAX_TASK_RESULTS_BYTES, TaskStore } from "./task-store.js";
import {
  TASK_SCHEMA_VERSION,
  canonicalizeTaskResult,
  taskPlanHash,
  validateTaskPlan,
  type JsonValue,
  type PersistentTask,
  type PersistentTaskPlan,
  type TaskDispatchJournalEntry,
  type TaskPlanStep,
  type TaskStepCheckpoint,
} from "./task-types.js";
import {
  bindTaskExecutionChild,
  checkpointTaskExecution,
  getTaskDispatchJournalEntry,
  observeTaskExecutionChild,
  prepareTaskExecutionDispatch,
} from "./task-journal.js";
import { isTerminalTaskState, transitionTask } from "./task-state-machine.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const CLIENT_ID_MAX_LENGTH = 200;
const FAILURE_REASON_MAX_LENGTH = 512;
const TERMINAL_EXECUTION_STATES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const SENSITIVE_PROPERTY = /^(?:authorization|access_token|refresh_token|client_secret|code_verifier|password|passwd|secret|api_key|api-key|apikey|code|token)$/i;

export type TaskSupervisorErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_NOT_FOUND_OR_NOT_OWNED"
  | "TASK_STORE_CORRUPT"
  | "TASK_ALREADY_ACTIVE"
  | "TASK_NOT_RUNNABLE"
  | "TASK_STATE_CONFLICT"
  | "TASK_WAITING_FOR_MODEL"
  | "TASK_OUTPUT_RESTRICTED"
  | "TASK_AUTHORIZATION_REVOKED"
  | "TASK_RUNTIME_RECOVERING"
  | "TASK_STORE_UNAVAILABLE"
  | "INVALID_TASK_INPUT"
  | "TASK_IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_SCOPE"
  | "FULL_ACCESS_REQUIRED"
  | "TASK_DEADLINE_EXCEEDED"
  | "DISPATCH_OUTCOME_UNKNOWN"
  | "CHILD_NOT_FOUND"
  | "CHILD_WAIT_FAILED"
  | "TASK_RESULT_REDACTION_BLOCKED"
  | "TASK_RESULT_TOO_LARGE"
  | "TASK_STEP_FAILED"
  | "TASK_ASSERTION_FAILED";

export class TaskSupervisorError extends Error {
  constructor(public readonly code: TaskSupervisorErrorCode, message: string) {
    super(message);
    this.name = "TaskSupervisorError";
  }
}

export interface CreatePersistentTaskInput {
  ownerClientId: string;
  idempotencyKey: string;
  scopes: readonly Scope[];
  plan: PersistentTaskPlan | unknown;
}

export interface TaskSupervisorOptions {
  snapshotRegistry?: SnapshotRegistry;
  now?: () => number;
  pollIntervalMs?: number;
  authorizationEpoch?: () => number | null;
  authorizationValid?: (task: PersistentTask) => boolean;
  executePureStep?: (task: PersistentTask, step: Exclude<TaskPlanStep, { kind: "execution" | "assertion" }>) => Promise<unknown>;
  requireRecovery?: boolean;
}

interface SanitizationFailure {
  code: "TASK_RESULT_REDACTION_BLOCKED" | "TASK_RESULT_TOO_LARGE";
}

function taskFailure(code: TaskSupervisorErrorCode, message: string): TaskSupervisorError {
  return new TaskSupervisorError(code, message);
}

function requiredScopesForPlan(plan: PersistentTaskPlan): Scope[] {
  const scopes = new Set<Scope>();
  for (const step of plan.steps) {
    switch (step.kind) {
      case "batch_read":
        scopes.add("workspace.read");
        break;
      case "batch_search":
        scopes.add("workspace.search");
        break;
      case "collect_evidence":
        if ((step.request.files?.length ?? 0) > 0) scopes.add("workspace.read");
        if ((step.request.searches?.length ?? 0) > 0) scopes.add("workspace.search");
        if ((step.request.repositories?.length ?? 0) > 0) scopes.add("git.read");
        if ((step.request.executionJobs?.length ?? 0) > 0) scopes.add("execution.jobs.read");
        break;
      case "git_read":
        scopes.add("git.read");
        break;
      case "execution":
        scopes.add("execution.run");
        break;
      case "assertion":
        break;
    }
  }
  return [...scopes].sort();
}

/** Derive the OAuth scopes a C2C task_create call must present for this plan. */
export function requiredScopesForTaskPlan(plan: unknown): Scope[] {
  return requiredScopesForPlan(validateTaskPlan(plan));
}

function sanitizeStructured(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new TypeError("Task result nesting exceeds its limit");
  if (typeof value === "string") {
    const result = sanitizeExecutionOutput(value);
    if (!result.allowed) throw taskFailure("TASK_RESULT_REDACTION_BLOCKED", "Task result contained blocked secret material");
    if (result.truncated) throw { code: "TASK_RESULT_TOO_LARGE" } satisfies SanitizationFailure;
    return result.text;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeStructured(item, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Task result must be plain JSON data");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    output[key] = SENSITIVE_PROPERTY.test(key) ? "[REDACTED]" : sanitizeStructured(child, depth + 1);
  }
  return output;
}

function makeFailureCheckpoint(stepId: string, at: string, code: string): TaskStepCheckpoint {
  const canonical = canonicalizeTaskResult({ error: code });
  return {
    stepId,
    completedAt: at,
    result: canonical.result,
    resultHash: canonical.resultHash,
    resultBytes: canonical.resultBytes,
  };
}

function sanitizedCheckpoint(value: unknown): Omit<TaskStepCheckpoint, "stepId" | "completedAt"> {
  let sanitized: unknown;
  try {
    sanitized = sanitizeStructured(value);
  } catch (error) {
    if (error instanceof TaskSupervisorError && error.code === "TASK_RESULT_REDACTION_BLOCKED") {
      throw { code: "TASK_RESULT_REDACTION_BLOCKED" } satisfies SanitizationFailure;
    }
    throw error;
  }
  try {
    return canonicalizeTaskResult(sanitized);
  } catch {
    throw { code: "TASK_RESULT_TOO_LARGE" } satisfies SanitizationFailure;
  }
}

function assertionValue(root: JsonValue, pointer: string): { exists: boolean; value?: JsonValue } {
  if (pointer === "") return { exists: true, value: root };
  let value: JsonValue | undefined = root;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(part)) return { exists: false };
      const index = Number(part);
      if (index >= value.length) return { exists: false };
      value = value[index];
    } else if (value !== null && typeof value === "object") {
      if (!Object.prototype.hasOwnProperty.call(value, part)) return { exists: false };
      value = value[part];
    } else {
      return { exists: false };
    }
  }
  return value === undefined ? { exists: false } : { exists: true, value };
}

function evaluateAssertion(task: PersistentTask, step: Extract<TaskPlanStep, { kind: "assertion" }>): boolean {
  const source = task.checkpoints.find((checkpoint) => checkpoint.stepId === step.sourceStepId);
  if (!source) return false;
  const selected = assertionValue(source.result, step.jsonPointer);
  switch (step.operator) {
    case "exists":
      return selected.exists;
    case "equals":
      return selected.exists && canonicalJson(selected.value) === canonicalJson(step.expected);
    case "not_equals":
      return !selected.exists || canonicalJson(selected.value) !== canonicalJson(step.expected);
    case "status_equals":
      return selected.exists && typeof selected.value === "string" && selected.value === step.expected;
    case "count_at_least": {
      if (!selected.exists || selected.value === null) return false;
      const count = Array.isArray(selected.value)
        ? selected.value.length
        : typeof selected.value === "string"
          ? Array.from(selected.value).length
          : typeof selected.value === "object"
            ? Object.keys(selected.value).length
            : -1;
      return count >= step.count!;
    }
  }
}

function stepScopeCheck(task: PersistentTask, required: readonly Scope[]): void {
  if (!required.every((scope) => task.authBinding.requiredScopes.includes(scope))) {
    throw taskFailure("INSUFFICIENT_SCOPE", "Task authorization binding lacks a required scope");
  }
}

function changedStepState(task: PersistentTask, stepId: string, state: "pending" | "running" | "succeeded" | "failed") {
  return task.stepStates.map((item) => item.stepId === stepId ? { ...item, stepId, state } : item);
}

function terminalJob(job: ExecutionJob): boolean {
  return TERMINAL_EXECUTION_STATES.has(job.state);
}

function isFullAccessTaskChild(job: ExecutionJob, task: PersistentTask, key: string): boolean {
  return isFullAccessExecutionJob(job) && job.workspaceId === task.workspaceId && job.oauthClientId === task.ownerClientId &&
    job.idempotencyKeyHash === createHash("sha256").update(key, "utf8").digest("hex");
}

type PreparedChildLookup =
  | { kind: "trusted_absent" }
  | { kind: "found"; job: ExecutionJob }
  | { kind: "unknown"; reason: string }
  | { kind: "conflict" };

function isTransientReadFailure(error: unknown): boolean {
  if (error instanceof BatchContractError && error.code === "SOURCE_CHANGED") return true;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "SOURCE_CHANGED" || code === "EAGAIN" || code === "EBUSY" || code === "ETIMEDOUT";
}

function checkpointBytes(task: PersistentTask): number {
  return task.checkpoints.reduce((total, checkpoint) => total + checkpoint.resultBytes, 0);
}

export class TaskSupervisor {
  readonly snapshotRegistry: SnapshotRegistry;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly authorizationEpoch: () => number | null;
  private readonly authorizationValid: ((task: PersistentTask) => boolean) | null;
  private readonly pureStepExecutor: TaskSupervisorOptions["executePureStep"];
  private readonly activeRuns = new Map<string, Promise<PersistentTask>>();
  private accepting = true;
  private recoveryComplete = true;
  private runtimeUnavailable: string | null = null;

  constructor(
    readonly workspace: Workspace,
    readonly store: TaskStore,
    readonly executionSupervisor: ExecutionSupervisor,
    options: TaskSupervisorOptions = {},
  ) {
    if (workspace.id !== store.workspaceId || workspace.id !== executionSupervisor.workspace.id) {
      throw new TypeError("TaskSupervisor dependencies must share a Workspace ID");
    }
    this.snapshotRegistry = options.snapshotRegistry ?? new SnapshotRegistry();
    this.now = options.now ?? Date.now;
    this.authorizationEpoch = options.authorizationEpoch ?? (() => readAuthorizationEpoch(workspace.id));
    this.authorizationValid = options.authorizationValid ?? null;
    this.pureStepExecutor = options.executePureStep;
    this.recoveryComplete = !(options.requireRecovery ?? false);
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 5 || this.pollIntervalMs > 1000) {
      throw new TypeError("pollIntervalMs must be an integer in 5..1000");
    }
  }

  create(input: CreatePersistentTaskInput): { task: PersistentTask; duplicate: boolean } {
    if (!this.recoveryComplete) throw taskFailure("TASK_RUNTIME_RECOVERING", "Task runtime recovery has not completed");
    if (this.runtimeUnavailable) throw taskFailure("TASK_STORE_UNAVAILABLE", "Task runtime is unavailable");
    if (!this.accepting || this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task runtime is not accepting new work");
    if (!input || typeof input !== "object" || typeof input.ownerClientId !== "string" ||
        input.ownerClientId.length < 1 || input.ownerClientId.length > CLIENT_ID_MAX_LENGTH ||
        !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) || !Array.isArray(input.scopes)) {
      throw taskFailure("INVALID_TASK_INPUT", "Task owner, idempotency key, or scope set is invalid");
    }
    const plan = validateTaskPlan(input.plan);
    const planHash = taskPlanHash(plan);
    const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey, "utf8").digest("hex");
    const validScopes = new Set<Scope>(input.scopes);
    const requiredScopes = requiredScopesForPlan(plan);
    if (!requiredScopes.every((scope) => validScopes.has(scope))) {
      throw taskFailure("INSUFFICIENT_SCOPE", "The caller does not hold all scopes required by this Task plan");
    }
    const executionPlan = plan.steps.some((step) => step.kind === "execution");
    const currentGrant = readCurrentSessionGrant(this.workspace.id);
    const permissionMode = readPermission(this.workspace.id);
    const authorizationEpoch = this.authorizationEpoch();
    if (authorizationEpoch === null) {
      throw taskFailure("TASK_AUTHORIZATION_REVOKED", "Current workspace authorization state cannot be verified");
    }
    if (executionPlan && (!currentGrant || permissionMode !== "level2")) {
      throw taskFailure("FULL_ACCESS_REQUIRED", "An active Full Access session grant is required for execution steps");
    }
    const duplicate = this.store.findIdempotent(input.ownerClientId, idempotencyKeyHash);
    if (duplicate) {
      if (duplicate.planHash !== planHash) throw new Error("IDEMPOTENCY_CONFLICT");
      return { task: duplicate, duplicate: true };
    }
    const createdAt = new Date(this.now()).toISOString();
    const deadlineAt = new Date(Date.parse(createdAt) + plan.maxDurationMs).toISOString();
    const task: PersistentTask = {
      taskId: randomBytes(24).toString("base64url"),
      schemaVersion: TASK_SCHEMA_VERSION,
      workspaceId: this.workspace.id,
      ownerClientId: input.ownerClientId,
      idempotencyKeyHash,
      authBinding: {
        workspaceId: this.workspace.id,
        sessionIdentityFingerprint: currentGrant?.identityFingerprint ?? null,
        grantId: currentGrant?.grantId ?? null,
        permissionMode,
        requiredScopes,
        authorizationEpoch,
      },
      plan,
      planHash,
      state: "QUEUED",
      createdAt,
      updatedAt: createdAt,
      deadlineAt,
      currentStep: plan.steps.length === 0 ? null : 0,
      stepStates: plan.steps.map((step) => ({ stepId: step.stepId, state: "pending" as const, attemptCount: 0 })),
      dispatchJournal: [],
      checkpoints: [],
      failureReason: null,
      waitingReason: null,
    };
    return this.store.create(task);
  }

  get(taskId: string, ownerClientId: string): PersistentTask | null {
    if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store is corrupt; execution is disabled");
    const task = this.store.get(taskId);
    return task?.ownerClientId === ownerClientId ? task : null;
  }

  get recoveryReady(): boolean { return this.recoveryComplete; }
  get unavailableReason(): string | null { return this.runtimeUnavailable; }

  list(ownerClientId: string): PersistentTask[] {
    if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store is corrupt; Task operations are disabled");
    return this.store.listForClient(ownerClientId);
  }

  get apiAvailable(): boolean {
    return this.recoveryComplete && this.runtimeUnavailable === null && !this.store.corruption &&
      !this.executionSupervisor.store.corruption && this.accepting;
  }

  /** Reconcile persisted tasks before Bridge starts accepting Task API requests. */
  async recover(): Promise<void> {
    if (this.recoveryComplete) return;
    if (this.store.corruption) {
      this.runtimeUnavailable = `TASK_STORE_CORRUPT:${this.store.corruption.reason}`;
      this.recoveryComplete = true;
      return;
    }
    if (this.executionSupervisor.store.corruption) {
      this.runtimeUnavailable = `EXECUTION_STORE_CORRUPT:${this.executionSupervisor.store.corruption.reason}`;
      this.recoveryComplete = true;
      return;
    }
    try {
      for (const task of this.store.listAll()) {
        if (isTerminalTaskState(task.state) || task.state === "WAITING_FOR_MODEL") continue;
        try {
          await this.reconcileStartupTask(task);
        } catch {
          if (this.store.corruption || this.executionSupervisor.store.corruption) {
            this.runtimeUnavailable = "STORE_CORRUPT_DURING_RECOVERY";
            break;
          }
          const latest = this.store.get(task.taskId);
          if (latest && (latest.state === "QUEUED" || latest.state === "RUNNING")) {
            this.waitForModel(latest, "RECOVERY_RECONCILIATION_FAILED");
          }
        }
      }
      if (!this.runtimeUnavailable) {
        this.recoveryComplete = true;
        for (const task of this.store.listAll()) {
          if (task.state === "CANCELLING") {
            void this.cancel(task.taskId, task.ownerClientId).catch(() => undefined);
          } else if (task.state === "QUEUED" || task.state === "RUNNING") {
            void this.run(task.taskId, task.ownerClientId).catch(() => undefined);
          }
        }
        return;
      }
    } catch {
      this.runtimeUnavailable ??= "TASK_STORE_UNAVAILABLE_DURING_RECOVERY";
    }
    this.recoveryComplete = true;
  }

  private async reconcileStartupTask(task: PersistentTask): Promise<void> {
    if (task.state === "CANCELLING") return;
    if (!this.authorizationIsCurrent(task)) {
      const currentStep = task.currentStep === null ? undefined : task.plan.steps[task.currentStep];
      if (currentStep?.kind === "execution") {
        const journal = getTaskDispatchJournalEntry(task, currentStep.stepId);
        if (journal?.phase === "PREPARED") {
          const lookup = await this.lookupPreparedChild(task, currentStep, journal.childIdempotencyKey);
          if (lookup.kind === "unknown") {
            this.waitForModel(task, lookup.reason);
            return;
          }
          if (lookup.kind === "conflict") {
            this.waitForModel(task, "CONFLICTING_CHILD_RECORDS");
            return;
          }
          if (lookup.kind === "found") {
            task = bindTaskExecutionChild(task, currentStep.stepId, lookup.job.jobId, this.isoNow());
            this.store.replace(task);
            if (lookup.job.state === "interrupted") {
              this.waitForModel(task, "CHILD_OUTCOME_UNKNOWN");
              return;
            }
          } else {
            this.stopForAuthorization(task);
            return;
          }
        }
        const refreshedJournal = getTaskDispatchJournalEntry(task, currentStep.stepId);
        if (refreshedJournal?.phase === "CHILD_BOUND") {
          const child = this.executionSupervisor.getForClient(refreshedJournal.childJobId!, task.ownerClientId);
          if (!child) {
            this.waitForModel(task, "CHILD_NOT_FOUND");
            return;
          }
          task = transitionTask(task, "CANCELLING", {}, this.isoNow());
          this.store.replace(task);
          return;
        }
      }
      this.stopForAuthorization(task);
      return;
    }

    if (task.state !== "RUNNING" || task.currentStep === null) return;
    const step = task.plan.steps[task.currentStep];
    if (!step) {
      this.waitForModel(task, "INVALID_CURRENT_STEP");
      return;
    }
    if (step.kind !== "execution") {
      const stepState = task.stepStates.find((item) => item.stepId === step.stepId);
      if (stepState?.state === "running" &&
          (!task.plan.retryReadOnlyOnce || (stepState.attemptCount ?? 0) !== 1)) {
        this.waitForModel(task, "PURE_STEP_OUTCOME_UNKNOWN");
      }
      return;
    }

    const journal = getTaskDispatchJournalEntry(task, step.stepId);
    if (!journal || journal.phase === "CHECKPOINTED") return;
    if (journal.phase === "PREPARED") {
      const lookup = await this.lookupPreparedChild(task, step, journal.childIdempotencyKey);
      if (lookup.kind === "unknown") {
        this.waitForModel(task, lookup.reason);
        return;
      }
      if (lookup.kind === "conflict") {
        this.waitForModel(task, "CONFLICTING_CHILD_RECORDS");
        return;
      }
      if (lookup.kind === "trusted_absent") return;
      task = bindTaskExecutionChild(task, step.stepId, lookup.job.jobId, this.isoNow());
      this.store.replace(task);
      if (lookup.job.state === "interrupted") {
        this.waitForModel(task, "CHILD_OUTCOME_UNKNOWN");
        return;
      }
      if (terminalJob(lookup.job)) {
        const observed = observeTaskExecutionChild(task, step.stepId, {
          state: lookup.job.state as Extract<ExecutionJob["state"], "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted">,
          exitCode: lookup.job.exitCode,
          failureCode: lookup.job.failureCode,
          finishedAt: lookup.job.finishedAt,
        }, this.isoNow());
        this.store.replace(observed);
        this.checkpointObservedChild(observed, step.stepId, getTaskDispatchJournalEntry(observed, step.stepId)!);
      }
      return;
    }
    if (journal.phase === "CHILD_BOUND") {
      const child = this.executionSupervisor.getForClient(journal.childJobId!, task.ownerClientId);
      if (!child) {
        this.waitForModel(task, "CHILD_NOT_FOUND");
        return;
      }
      if (child.state === "interrupted") {
        this.waitForModel(task, child.failureCode ?? "CHILD_OUTCOME_UNKNOWN");
        return;
      }
      if (terminalJob(child)) {
        const observed = observeTaskExecutionChild(task, step.stepId, {
          state: child.state as Extract<ExecutionJob["state"], "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted">,
          exitCode: child.exitCode,
          failureCode: child.failureCode,
          finishedAt: child.finishedAt,
        }, this.isoNow());
        this.store.replace(observed);
        this.checkpointObservedChild(observed, step.stepId, getTaskDispatchJournalEntry(observed, step.stepId)!);
      }
      return;
    }
    if (journal.phase === "OBSERVED") this.checkpointObservedChild(task, step.stepId, journal);
  }

  private authorizationIsCurrent(task: PersistentTask): boolean {
    if (task.workspaceId !== this.workspace.id || task.authBinding.workspaceId !== this.workspace.id ||
        task.authBinding.authorizationEpoch === undefined || this.authorizationEpoch() !== task.authBinding.authorizationEpoch ||
        readPermission(this.workspace.id) !== task.authBinding.permissionMode) return false;
    if (this.authorizationValid) {
      try { if (!this.authorizationValid(task)) return false; }
      catch { return false; }
    }
    const hasExecution = task.plan.steps.some((step) => step.kind === "execution");
    if (!hasExecution) return true;
    if (task.authBinding.permissionMode !== "level2" || task.authBinding.sessionIdentityFingerprint === null || task.authBinding.grantId === null) return false;
    const current = readCurrentSessionGrant(this.workspace.id);
    return current !== null && current.identityFingerprint === task.authBinding.sessionIdentityFingerprint &&
      current.grantId === task.authBinding.grantId;
  }

  private waitForModel(task: PersistentTask, reason: string): PersistentTask {
    if (task.state === "WAITING_FOR_MODEL") return task;
    if (task.state !== "QUEUED" && task.state !== "RUNNING") return task;
    const stepId = task.currentStep === null ? undefined : task.plan.steps[task.currentStep]?.stepId;
    const stepStates = stepId ? changedStepState(task, stepId, "failed") : task.stepStates;
    const next = transitionTask(task, "WAITING_FOR_MODEL", {
      stepStates,
      failureReason: null,
      waitingReason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
    }, this.isoNow());
    this.store.replace(next);
    return next;
  }

  private stopForAuthorization(task: PersistentTask): PersistentTask {
    if (task.state !== "QUEUED" && task.state !== "RUNNING") return task;
    const stepId = task.currentStep === null ? undefined : task.plan.steps[task.currentStep]?.stepId;
    if (!stepId) {
      const failed = transitionTask(task, "FAILED", {
        failureReason: "AUTHORIZATION_REVOKED",
        waitingReason: null,
      }, this.isoNow());
      this.store.replace(failed);
      return failed;
    }
    return this.failRunningTask(task, stepId, "AUTHORIZATION_REVOKED");
  }

  run(taskId: string, ownerClientId: string): Promise<PersistentTask> {
    if (!this.recoveryComplete) return Promise.reject(taskFailure("TASK_RUNTIME_RECOVERING", "Task runtime recovery has not completed"));
    if (this.runtimeUnavailable) return Promise.reject(taskFailure("TASK_STORE_UNAVAILABLE", "Task runtime is unavailable"));
    if (!this.accepting) return Promise.reject(taskFailure("TASK_NOT_RUNNABLE", "TaskSupervisor is shutting down"));
    const existingTask = this.get(taskId, ownerClientId);
    if (!existingTask) return Promise.reject(taskFailure("TASK_NOT_FOUND", "Task does not exist for this owner"));
    const existing = this.activeRuns.get(taskId);
    if (existing) return existing;
    const operation = Promise.resolve().then(() => this.runInternal(taskId, ownerClientId));
    const tracked = operation.finally(() => {
      if (this.activeRuns.get(taskId) === tracked) this.activeRuns.delete(taskId);
    });
    this.activeRuns.set(taskId, tracked);
    return tracked;
  }

  async shutdown(): Promise<void> {
    this.accepting = false;
    await Promise.allSettled([...this.activeRuns.values()]);
  }

  private async runInternal(taskId: string, ownerClientId: string): Promise<PersistentTask> {
    if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store is corrupt; execution is disabled");
    let task = this.store.get(taskId);
    if (!task || task.ownerClientId !== ownerClientId) throw taskFailure("TASK_NOT_FOUND", "Task does not exist for this owner");
    if (isTerminalTaskState(task.state)) return task;
    if (task.state !== "QUEUED" && task.state !== "RUNNING") {
      throw taskFailure("TASK_NOT_RUNNABLE", `Task state ${task.state} cannot be run`);
    }
    if (!this.authorizationIsCurrent(task)) return this.stopForAuthorization(task);

    if (task.state === "QUEUED") {
      if (task.plan.steps.length === 0) {
        task = transitionTask(task, "COMPLETED", { currentStep: null }, this.isoNow());
        this.store.replace(task);
        return task;
      }
      task = transitionTask(task, "RUNNING", { currentStep: 0 }, this.isoNow());
      this.store.replace(task);
    }

    while (task.state === "RUNNING") {
      const authoritative = this.store.get(taskId);
      if (!authoritative) throw taskFailure("TASK_NOT_FOUND", "Task disappeared during execution");
      task = authoritative;
      if (task.state !== "RUNNING") return task;
      if (!this.authorizationIsCurrent(task)) return this.stopForAuthorization(task);
      if (task.currentStep === null || task.currentStep < 0 || task.currentStep > task.plan.steps.length) {
        throw taskFailure("TASK_NOT_RUNNABLE", "Task current step is invalid");
      }
      if (task.currentStep === task.plan.steps.length) {
        task = transitionTask(task, "COMPLETED", { currentStep: null }, this.isoNow());
        this.store.replace(task);
        return task;
      }

      const step = task.plan.steps[task.currentStep];
      if (!step) throw taskFailure("TASK_NOT_RUNNABLE", "Task current step is missing");
      if (Date.parse(this.isoNow()) >= Date.parse(task.deadlineAt)) {
        task = this.failRunningTask(task, step.stepId, "TASK_DEADLINE_EXCEEDED");
        return task;
      }

      if (step.kind === "execution") {
        task = await this.runExecutionStep(task, step);
      } else {
        task = await this.runPureStep(task, step);
      }
      if (task.state !== "RUNNING") return task;
    }
    return task;
  }

  private async runPureStep(task: PersistentTask, step: Exclude<TaskPlanStep, { kind: "execution" }>): Promise<PersistentTask> {
    try {
      stepScopeCheck(task, requiredScopesForPlan({ version: 1, maxDurationMs: task.plan.maxDurationMs, steps: [step] }));
    } catch (error) {
      return this.failRunningTask(task, step.stepId, error instanceof TaskSupervisorError ? error.code : "INSUFFICIENT_SCOPE");
    }
    const authoritative = this.store.get(task.taskId);
    if (!authoritative) throw taskFailure("TASK_NOT_FOUND", "Task disappeared before a pure step");
    task = authoritative;
    if (task.state === "CANCELLING") return this.finishCancellation(task);
    if (task.state !== "RUNNING") return task;
    if (!this.authorizationIsCurrent(task)) return this.stopForAuthorization(task);

    const currentStepState = task.stepStates.find((item) => item.stepId === step.stepId);
    if (!currentStepState) throw taskFailure("TASK_NOT_RUNNABLE", "Pure Task step state is missing");
    let attemptCount = currentStepState.attemptCount ?? 0;
    if (currentStepState.state === "pending") {
      attemptCount = 1;
    } else if (currentStepState.state === "running") {
      if (attemptCount !== 1 || !task.plan.retryReadOnlyOnce) {
        return this.waitForModel(task, "PURE_STEP_OUTCOME_UNKNOWN");
      }
      attemptCount = 2;
    } else {
      throw taskFailure("TASK_NOT_RUNNABLE", "Pure Task step is not pending or running");
    }
    task = {
      ...task,
      currentStep: task.plan.steps.findIndex((item) => item.stepId === step.stepId),
      stepStates: task.stepStates.map((item) => item.stepId === step.stepId
        ? { ...item, state: "running" as const, attemptCount }
        : item),
      updatedAt: this.isoNow(),
    };
    this.store.replace(task);

    let result: unknown;
    let success = true;
    let failureCode: string | null = null;
    let transientFailure = false;
    try {
      if (step.kind === "assertion") {
        success = evaluateAssertion(task, step);
        result = { passed: success, sourceStepId: step.sourceStepId, operator: step.operator };
        if (!success) failureCode = "TASK_ASSERTION_FAILED";
      } else {
        result = await this.executePureDomainStep(task, step);
      }
    } catch (error) {
      success = false;
      failureCode = error instanceof TaskSupervisorError ? error.code : "TASK_STEP_FAILED";
      transientFailure = isTransientReadFailure(error);
      result = { error: failureCode };
    }

    let latest = this.store.get(task.taskId);
    if (!latest) throw taskFailure("TASK_NOT_FOUND", "Task disappeared after a pure step");
    if (latest.state === "CANCELLING") return this.checkpointPureResult(latest, step.stepId, result, success, failureCode, true);
    if (latest.state !== "RUNNING") return latest;
    if (!this.authorizationIsCurrent(latest)) return this.stopForAuthorization(latest);

    if (!success && transientFailure && task.plan.retryReadOnlyOnce && attemptCount === 1) {
      attemptCount = 2;
      latest = {
        ...latest,
        stepStates: latest.stepStates.map((item) => item.stepId === step.stepId
          ? { ...item, state: "running" as const, attemptCount }
          : item),
        updatedAt: this.isoNow(),
      };
      this.store.replace(latest);
      try {
        if (step.kind === "assertion") {
          success = evaluateAssertion(latest, step);
          result = { passed: success, sourceStepId: step.sourceStepId, operator: step.operator };
          failureCode = success ? null : "TASK_ASSERTION_FAILED";
        } else {
          result = await this.executePureDomainStep(latest, step);
          success = true;
          failureCode = null;
        }
      } catch (error) {
        success = false;
        failureCode = error instanceof TaskSupervisorError ? error.code : "TASK_STEP_FAILED";
        result = { error: failureCode };
      }
      latest = this.store.get(task.taskId);
      if (!latest) throw taskFailure("TASK_NOT_FOUND", "Task disappeared after a read-only retry");
      if (latest.state === "CANCELLING") return this.checkpointPureResult(latest, step.stepId, result, success, failureCode, true);
      if (latest.state !== "RUNNING") return latest;
      if (!this.authorizationIsCurrent(latest)) return this.stopForAuthorization(latest);
    }

    return this.checkpointPureResult(latest, step.stepId, result, success, failureCode, false);
  }

  private checkpointPureResult(
    task: PersistentTask,
    stepId: string,
    result: unknown,
    success: boolean,
    failureCode: string | null,
    cancelled: boolean,
  ): PersistentTask {

    const at = this.isoNow();
    let canonical: Omit<TaskStepCheckpoint, "stepId" | "completedAt">;
    try {
      canonical = sanitizedCheckpoint(result);
    } catch (error) {
      success = false;
      failureCode = (error as SanitizationFailure).code ?? "TASK_RESULT_TOO_LARGE";
      canonical = makeFailureCheckpoint(stepId, at, failureCode);
    }
    let persistCheckpoint = true;
    if (checkpointBytes(task) + canonical.resultBytes > MAX_TASK_RESULTS_BYTES) {
      success = false;
      failureCode = "TASK_RESULT_TOO_LARGE";
      canonical = makeFailureCheckpoint(stepId, at, failureCode);
      persistCheckpoint = checkpointBytes(task) + canonical.resultBytes <= MAX_TASK_RESULTS_BYTES;
    }
    const index = task.plan.steps.findIndex((item) => item.stepId === stepId);
    const completedAtDeadline = Date.parse(at) >= Date.parse(task.deadlineAt);
    const stepSucceeded = success && persistCheckpoint;
    const nextStep = stepSucceeded ? index + 1 : index;
    const checkpoint: TaskStepCheckpoint = { stepId, completedAt: at, ...canonical };
    let next: PersistentTask = {
      ...task,
      updatedAt: at,
      currentStep: nextStep,
      stepStates: changedStepState(task, stepId, stepSucceeded ? "succeeded" : "failed"),
      checkpoints: persistCheckpoint ? [...task.checkpoints, checkpoint] : task.checkpoints,
    };
    if (!cancelled) {
      if (!stepSucceeded) {
        next = transitionTask(next, "FAILED", {
          failureReason: failureCode ?? "TASK_STEP_FAILED",
          waitingReason: null,
        }, at);
      } else if (nextStep === task.plan.steps.length && !completedAtDeadline) {
        next = transitionTask(next, "COMPLETED", { currentStep: null }, at);
      } else if (completedAtDeadline) {
        next = transitionTask(next, "FAILED", {
          currentStep: nextStep === task.plan.steps.length ? null : nextStep,
          failureReason: "TASK_DEADLINE_EXCEEDED",
          waitingReason: null,
        }, at);
      }
    }
    if (cancelled) {
      next = transitionTask(next, "CANCELLED", { currentStep: next.currentStep }, at);
    }
    this.store.replace(next);
    return next;
  }

  private async executePureDomainStep(task: PersistentTask, step: Exclude<TaskPlanStep, { kind: "execution" }>): Promise<unknown> {
    if (step.kind !== "assertion" && this.pureStepExecutor) return this.pureStepExecutor(task, step);
    const ownerId = task.ownerClientId;
    switch (step.kind) {
      case "batch_read":
        return batchRead(this.workspace, step.request, { ownerId, registry: this.snapshotRegistry });
      case "batch_search":
        return batchSearch(this.workspace, step.request, { ownerId, registry: this.snapshotRegistry });
      case "collect_evidence":
        return collectEvidence(this.workspace, step.request, {
          ownerId,
          registry: this.snapshotRegistry,
          executionSupervisor: this.executionSupervisor,
        });
      case "git_read": {
        const selection = selectGitRepository(this.workspace, step.repositoryPath);
        if (step.operation === "info") return gitRepositoryInfo(selection);
        if (step.operation === "status") return gitStatus(selection.target);
        return gitDiff(selection.target, { mode: step.diffMode }, step.diffPath);
      }
      case "assertion":
        return { passed: evaluateAssertion(task, step), sourceStepId: step.sourceStepId, operator: step.operator };
    }
  }

  private async runExecutionStep(task: PersistentTask, step: Extract<TaskPlanStep, { kind: "execution" }>): Promise<PersistentTask> {
    try {
      stepScopeCheck(task, ["execution.run"]);
    } catch (error) {
      return this.failRunningTask(task, step.stepId, error instanceof TaskSupervisorError ? error.code : "INSUFFICIENT_SCOPE");
    }
    let latest = this.store.get(task.taskId);
    if (!latest) throw taskFailure("TASK_NOT_FOUND", "Task disappeared before execution dispatch");
    if (latest.state === "CANCELLING") return this.finishCancellation(latest);
    if (latest.state !== "RUNNING") return latest;
    task = latest;

    let prior = getTaskDispatchJournalEntry(task, step.stepId);
    if (prior && prior.phase === "CHILD_BOUND") return this.observeBoundChild(task, step.stepId, prior);
    if (prior && prior.phase === "OBSERVED") return this.checkpointObservedChild(task, step.stepId, prior);
    if (prior && prior.phase === "CHECKPOINTED") {
      throw taskFailure("TASK_NOT_RUNNABLE", "A checkpointed execution journal cannot be the current step");
    }

    if (prior?.phase === "PREPARED") {
      const lookup = await this.lookupPreparedChild(task, step, prior.childIdempotencyKey);
      latest = this.store.get(task.taskId);
      if (!latest) throw taskFailure("TASK_NOT_FOUND", "Task disappeared during dispatch reconciliation");
      if (lookup.kind === "unknown") {
        return this.waitForModel(latest, lookup.reason);
      }
      if (lookup.kind === "conflict") {
        return this.waitForModel(latest, "CONFLICTING_CHILD_RECORDS");
      }
      if (lookup.kind === "found") {
        const currentEntry = getTaskDispatchJournalEntry(latest, step.stepId);
        let bound = latest;
        if (currentEntry?.phase === "PREPARED") {
          bound = bindTaskExecutionChild(latest, step.stepId, lookup.job.jobId, this.isoNow());
          this.store.replace(bound);
        } else if (currentEntry?.childJobId !== lookup.job.jobId) {
          return this.waitForModel(latest, "CONFLICTING_CHILD_RECORDS");
        }
        const entry = getTaskDispatchJournalEntry(bound, step.stepId)!;
        if (lookup.job.state === "interrupted") return this.interruptUnknownDispatch(bound, step.stepId, "CHILD_OUTCOME_UNKNOWN");
        if (bound.state === "CANCELLING") return this.cancelBoundChild(bound, entry);
        if (!this.authorizationIsCurrent(bound)) return this.cancelForRevocation(bound, entry);
        return this.observeBoundChild(bound, step.stepId, entry);
      }
      task = latest;
      prior = getTaskDispatchJournalEntry(task, step.stepId);
      if (!prior || prior.phase !== "PREPARED") throw taskFailure("TASK_STATE_CONFLICT", "Prepared dispatch changed during reconciliation");
      if (task.state === "CANCELLING") return this.finishCancellation(task);
      if (task.state !== "RUNNING") return task;
    }

    try {
      if (!this.authorizationIsCurrent(task)) return this.stopForAuthorization(task);
      this.assertExecutionBinding(task);
    } catch (error) {
      return this.failRunningTask(task, step.stepId, error instanceof TaskSupervisorError ? error.code : "FULL_ACCESS_REQUIRED");
    }
    if (!prior) {
      const prepared = prepareTaskExecutionDispatch(task, step.stepId, 1, this.isoNow());
      this.store.replace(prepared.task);
      task = prepared.task;
      prior = prepared.entry;
    }

    let started: Awaited<ReturnType<ExecutionSupervisor["startFullAccess"]>>;
    try {
      started = await this.executionSupervisor.startFullAccess(
        this.fullAccessInput(task, step, prior.childIdempotencyKey),
        this.assertExecutionBinding(task),
        () => {
          const current = this.store.get(task.taskId);
          return current?.state === "RUNNING" && this.authorizationIsCurrent(current);
        },
      );
    } catch {
      if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store became corrupt during child dispatch");
      latest = this.store.get(task.taskId);
      if (latest?.state === "CANCELLING") return this.finishCancellation(latest);
      return this.waitForModel(latest ?? task, "DISPATCH_OUTCOME_UNKNOWN");
    }
    latest = this.store.get(task.taskId);
    if (!latest) throw taskFailure("TASK_NOT_FOUND", "Task disappeared after child dispatch");
    if (!started.ok) {
      if (latest.state === "CANCELLING") return this.finishCancellation(latest);
      if (!this.authorizationIsCurrent(latest)) return this.stopForAuthorization(latest);
      if (started.error === "TASK_STATE_CONFLICT" || started.error === "IDEMPOTENCY_CONFLICT" || started.error === "STORE_CORRUPT") {
        return this.waitForModel(latest, started.error === "IDEMPOTENCY_CONFLICT" ? "CONFLICTING_CHILD_RECORDS" : "DISPATCH_OUTCOME_UNKNOWN");
      }
      return this.failRunningTask(latest, step.stepId, started.error);
    }

    const latestEntry = getTaskDispatchJournalEntry(latest, step.stepId);
    let bound = latest;
    if (latestEntry?.phase === "PREPARED") {
      bound = bindTaskExecutionChild(latest, step.stepId, started.job.jobId, this.isoNow());
      this.store.replace(bound);
    } else if (latestEntry?.childJobId !== started.job.jobId) {
      return this.waitForModel(latest, "DISPATCH_JOURNAL_CONFLICT");
    }
    const entry = getTaskDispatchJournalEntry(bound, step.stepId)!;
    if (bound.state === "CANCELLING") return this.cancelBoundChild(bound, entry);
    if (!this.authorizationIsCurrent(bound)) return this.cancelForRevocation(bound, entry);
    return this.observeBoundChild(bound, step.stepId, entry);
  }

  private fullAccessInput(
    task: PersistentTask,
    step: Extract<TaskPlanStep, { kind: "execution" }>,
    idempotencyKey: string,
  ) {
    return {
      ...step.command,
      timeoutSeconds: step.timeoutSeconds,
      idempotencyKey,
      oauthClientId: task.ownerClientId,
      scopes: task.authBinding.requiredScopes,
      ...(step.repositoryPath === undefined ? {} : { repositoryPath: step.repositoryPath }),
    };
  }

  private async lookupPreparedChild(
    task: PersistentTask,
    step: Extract<TaskPlanStep, { kind: "execution" }>,
    key: string,
  ): Promise<PreparedChildLookup> {
    if (this.executionSupervisor.store.corruption) return { kind: "unknown", reason: "CHILD_STORE_UNAVAILABLE" };
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const lookup = this.executionSupervisor.store.lookupIdempotentForReconciliation(task.ownerClientId, keyHash);
    if (lookup.kind === "unknown") return { kind: "unknown", reason: lookup.reason };
    if (lookup.kind === "conflict") return { kind: "conflict" };
    if (lookup.kind === "trusted_absent") return { kind: "trusted_absent" };
    const candidate = lookup.job;
    const verified = await this.executionSupervisor.lookupFullAccessIdempotent(this.fullAccessInput(task, step, key), candidate);
    if (!verified.ok) return verified.error === "IDEMPOTENCY_CONFLICT"
      ? { kind: "conflict" }
      : { kind: "unknown", reason: "DISPATCH_LOOKUP_UNAVAILABLE" };
    if (!verified.job || verified.job.jobId !== candidate.jobId || !isFullAccessTaskChild(verified.job, task, key)) {
      return { kind: "conflict" };
    }
    return { kind: "found", job: verified.job };
  }

  private assertExecutionBinding(task: PersistentTask): { identityFingerprint: string; grantId: string } {
    if (!this.authorizationIsCurrent(task) || task.authBinding.permissionMode !== "level2" || task.authBinding.sessionIdentityFingerprint === null ||
        task.authBinding.grantId === null || readPermission(this.workspace.id) !== "level2") {
      throw taskFailure("FULL_ACCESS_REQUIRED", "Task does not have a current Full Access authorization binding");
    }
    const current = readCurrentSessionGrant(this.workspace.id);
    if (!current || current.identityFingerprint !== task.authBinding.sessionIdentityFingerprint || current.grantId !== task.authBinding.grantId) {
      throw taskFailure("FULL_ACCESS_REQUIRED", "The Full Access grant bound to this Task is no longer current");
    }
    return { identityFingerprint: current.identityFingerprint, grantId: current.grantId };
  }

  async cancel(taskId: string, ownerClientId: string): Promise<PersistentTask> {
    if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store is corrupt; cancellation is unavailable");
    let task = this.get(taskId, ownerClientId);
    if (!task) throw taskFailure("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client");
    if (isTerminalTaskState(task.state)) return task;
    if (task.state !== "CANCELLING") {
      task = transitionTask(task, "CANCELLING", {}, this.isoNow());
      this.store.replace(task);
    }

    if (task.currentStep !== null) {
      const step = task.plan.steps[task.currentStep];
      if (step?.kind === "execution") {
        const journal = getTaskDispatchJournalEntry(task, step.stepId);
        if (journal?.phase === "PREPARED") {
          const lookup = await this.lookupPreparedChild(task, step, journal.childIdempotencyKey);
          task = this.store.get(taskId) ?? task;
          if (lookup.kind === "unknown") {
            return this.interruptUnknownDispatch(task, step.stepId, lookup.reason);
          }
          if (lookup.kind === "conflict") {
            return this.interruptUnknownDispatch(task, step.stepId, "CONFLICTING_CHILD_RECORDS");
          }
          if (lookup.kind === "found") {
            const currentJournal = getTaskDispatchJournalEntry(task, step.stepId);
            if (currentJournal?.phase === "PREPARED") {
              task = bindTaskExecutionChild(task, step.stepId, lookup.job.jobId, this.isoNow());
              this.store.replace(task);
            } else if (currentJournal?.childJobId !== lookup.job.jobId) {
              return this.interruptUnknownDispatch(task, step.stepId, "CONFLICTING_CHILD_RECORDS");
            }
            const bound = getTaskDispatchJournalEntry(task, step.stepId)!;
            return this.cancelBoundChild(task, bound);
          }
        } else if (journal?.phase === "CHILD_BOUND") {
          return this.cancelBoundChild(task, journal);
        } else if (journal?.phase === "OBSERVED") {
          return this.checkpointObservedChild(task, step.stepId, journal);
        }
      }
    }

    const active = this.activeRuns.get(taskId);
    if (active) {
      await active.catch(() => undefined);
      task = this.store.get(taskId) ?? task;
      if (isTerminalTaskState(task.state)) return task;
    }
    return this.finishCancellation(task);
  }

  private finishCancellation(task: PersistentTask): PersistentTask {
    if (task.state !== "CANCELLING") return task;
    const stepId = task.currentStep === null ? undefined : task.plan.steps[task.currentStep]?.stepId;
    const stepState = stepId ? task.stepStates.find((item) => item.stepId === stepId) : undefined;
    const stepStates = stepId && stepState && (stepState.state === "pending" || stepState.state === "running")
      ? changedStepState(task, stepId, "failed")
      : task.stepStates;
    const next = transitionTask(task, "CANCELLED", { stepStates }, this.isoNow());
    this.store.replace(next);
    return next;
  }

  private async cancelForRevocation(task: PersistentTask, entry: TaskDispatchJournalEntry): Promise<PersistentTask> {
    const latest = this.store.get(task.taskId);
    if (!latest) return this.interruptUnknownDispatch(task, entry.stepId, "TASK_MISSING_DURING_REVOCATION");
    task = latest;
    if (task.state === "RUNNING" || task.state === "QUEUED") {
      task = transitionTask(task, "CANCELLING", {}, this.isoNow());
      this.store.replace(task);
    }
    return this.cancelBoundChild(task, entry);
  }

  private async cancelBoundChild(task: PersistentTask, entry: TaskDispatchJournalEntry): Promise<PersistentTask> {
    if (!entry.childJobId) return this.interruptUnknownDispatch(task, entry.stepId, "CHILD_NOT_FOUND");
    let cancelRequested = false;
    let deadline: number | null = null;
    for (;;) {
      if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store became corrupt during cancellation");
      const current = this.store.get(task.taskId);
      if (!current) return this.interruptUnknownDispatch(task, entry.stepId, "TASK_MISSING_DURING_CANCELLATION");
      task = current;
      if (isTerminalTaskState(task.state)) return task;
      const job = this.executionSupervisor.getForClient(entry.childJobId, task.ownerClientId);
      if (!job) return this.interruptUnknownDispatch(task, entry.stepId, "CHILD_NOT_FOUND");
      if (deadline === null) deadline = Date.parse(job.startedAt ?? job.createdAt) + job.timeoutSeconds * 1000 + 30_000;
      if (terminalJob(job)) {
        if (job.state === "interrupted") return this.interruptUnknownDispatch(task, entry.stepId, job.failureCode ?? "CHILD_OUTCOME_UNKNOWN");
        const journal = getTaskDispatchJournalEntry(task, entry.stepId);
        if (journal?.phase === "CHILD_BOUND") {
          const observed = observeTaskExecutionChild(task, entry.stepId, {
            state: job.state as Extract<ExecutionJob["state"], "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted">,
            exitCode: job.exitCode,
            failureCode: job.failureCode,
            finishedAt: job.finishedAt,
          }, this.isoNow());
          this.store.replace(observed);
          task = observed;
        }
        const observedEntry = getTaskDispatchJournalEntry(task, entry.stepId);
        if (observedEntry?.phase === "OBSERVED") return this.checkpointObservedChild(task, entry.stepId, observedEntry);
        return this.finishCancellation(task);
      }
      if (!cancelRequested) {
        cancelRequested = true;
        this.executionSupervisor.cancel(entry.childJobId, task.ownerClientId);
      }
      if (deadline !== null && this.now() >= deadline) {
        return this.interruptUnknownDispatch(task, entry.stepId, "CHILD_TERMINATION_UNCONFIRMED");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  readOutput(
    taskId: string,
    ownerClientId: string,
    stepId: string,
    stream: OutputStream,
    offset: number,
    maxBytes: number,
  ) {
    const task = this.get(taskId, ownerClientId);
    if (!task) throw taskFailure("TASK_NOT_FOUND_OR_NOT_OWNED", "Task was not found or is not owned by this client");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024) {
      throw taskFailure("TASK_OUTPUT_RESTRICTED", "Task output page parameters are invalid");
    }
    const entry = task.dispatchJournal.find((candidate) => candidate.stepId === stepId);
    if (!entry?.childJobId) throw taskFailure("TASK_OUTPUT_RESTRICTED", "No execution output is available for this Task step");
    const child = this.executionSupervisor.getForClient(entry.childJobId, ownerClientId);
    if (!child || child.workspaceId !== this.workspace.id || !isFullAccessExecutionJob(child)) {
      throw taskFailure("TASK_OUTPUT_RESTRICTED", "Task output is unavailable for this owner and step");
    }
    const result = this.executionSupervisor.readOutputForClient(entry.childJobId, ownerClientId, stream, offset, maxBytes);
    if (!result.ok) throw taskFailure("TASK_OUTPUT_RESTRICTED", "Task output is unavailable for this owner and step");
    return {
      taskId,
      stepId,
      jobId: entry.childJobId,
      stream: result.stream,
      offset: result.offset,
      nextOffset: result.nextOffset,
      oldestAvailableOffset: result.oldestAvailableOffset,
      eof: result.eof,
      truncated: result.truncated,
      text: result.text,
    };
  }

  private async observeBoundChild(
    task: PersistentTask,
    stepId: string,
    entry: TaskDispatchJournalEntry,
  ): Promise<PersistentTask> {
    if (!entry.childJobId) return this.interruptUnknownDispatch(task, stepId);
    const taskDeadline = Date.parse(task.deadlineAt);
    let deadlineCancelRequested = false;
    let taskCancelRequested = task.state === "CANCELLING";
    let terminalWaitDeadline: number | null = null;
    for (;;) {
      if (this.store.corruption) throw taskFailure("TASK_STORE_CORRUPT", "Task store became corrupt while a child was running");
      const authoritative = this.store.get(task.taskId);
      if (!authoritative) return this.interruptUnknownDispatch(task, stepId, "TASK_MISSING_DURING_CHILD_OBSERVATION");
      task = authoritative;
      if (isTerminalTaskState(task.state)) return task;
      if (task.state === "CANCELLING") taskCancelRequested = true;
      if (task.state === "RUNNING" && !this.authorizationIsCurrent(task)) {
        task = transitionTask(task, "CANCELLING", {}, this.isoNow());
        this.store.replace(task);
        taskCancelRequested = true;
      }

      const job = this.executionSupervisor.getForClient(entry.childJobId, task.ownerClientId);
      if (!job) return this.interruptUnknownDispatch(task, stepId, "CHILD_NOT_FOUND");
      if (terminalWaitDeadline === null) {
        const childEnd = Date.parse(job.startedAt ?? job.createdAt) + job.timeoutSeconds * 1000;
        terminalWaitDeadline = Math.max(taskDeadline, childEnd) + 30_000;
      }
      if (terminalJob(job)) {
        if (job.state === "interrupted") {
          return this.interruptUnknownDispatch(task, stepId, job.failureCode ?? "CHILD_OUTCOME_UNKNOWN");
        }
        const observed = observeTaskExecutionChild(task, stepId, {
          state: job.state as Extract<ExecutionJob["state"], "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted">,
          exitCode: job.exitCode,
          failureCode: job.failureCode,
          finishedAt: job.finishedAt,
        }, this.isoNow());
        this.store.replace(observed);
        const journal = getTaskDispatchJournalEntry(observed, stepId);
        if (!journal) throw taskFailure("TASK_NOT_RUNNABLE", "Observed child journal disappeared");
        return this.checkpointObservedChild(observed, stepId, journal);
      }
      if (taskCancelRequested && !deadlineCancelRequested) {
        deadlineCancelRequested = true;
        this.executionSupervisor.cancel(entry.childJobId, task.ownerClientId);
      }
      if (this.now() >= taskDeadline && !deadlineCancelRequested) {
        deadlineCancelRequested = true;
        this.executionSupervisor.cancel(entry.childJobId, task.ownerClientId);
      }
      if (terminalWaitDeadline !== null && this.now() >= terminalWaitDeadline) {
        return this.interruptUnknownDispatch(task, stepId, "CHILD_WAIT_FAILED");
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  private checkpointObservedChild(
    task: PersistentTask,
    stepId: string,
    entry: TaskDispatchJournalEntry,
  ): PersistentTask {
    const authoritative = this.store.get(task.taskId);
    if (!authoritative) throw taskFailure("TASK_NOT_FOUND", "Task disappeared before child checkpoint");
    task = authoritative;
    if (isTerminalTaskState(task.state)) return task;
    if (task.state !== "RUNNING" && task.state !== "CANCELLING") return task;
    const currentEntry = getTaskDispatchJournalEntry(task, stepId);
    if (currentEntry?.phase === "CHECKPOINTED") return task;
    if (!currentEntry || currentEntry.phase !== "OBSERVED") {
      throw taskFailure("TASK_NOT_RUNNABLE", "Child observation changed before checkpoint");
    }
    entry = currentEntry;
    if (entry.phase !== "OBSERVED" || !entry.observed) throw taskFailure("TASK_NOT_RUNNABLE", "Child outcome is not durably observed");
    const outcome = entry.observed;
    if (outcome.state === "interrupted") {
      return this.interruptUnknownDispatch(task, stepId, outcome.failureCode ?? "CHILD_OUTCOME_UNKNOWN");
    }
    const childSucceeded = outcome.state === "succeeded" && outcome.exitCode === 0;
    const deadlineExceeded = this.now() >= Date.parse(task.deadlineAt) &&
      (outcome.finishedAt === null || Date.parse(outcome.finishedAt) > Date.parse(task.deadlineAt));
    const success = childSucceeded && !deadlineExceeded;
    const result = {
      childJobId: entry.childJobId,
      state: outcome.state,
      exitCode: outcome.exitCode,
      failureCode: outcome.failureCode,
      finishedAt: outcome.finishedAt,
      ...(deadlineExceeded ? { deadlineExceeded: true } : {}),
    };
    const bounded = canonicalizeTaskResult(result);
    if (checkpointBytes(task) + bounded.resultBytes > MAX_TASK_RESULTS_BYTES) {
      const index = task.plan.steps.findIndex((step) => step.stepId === stepId);
      const patch = {
        currentStep: index,
        stepStates: changedStepState(task, stepId, "failed"),
      };
      const stopped = task.state === "CANCELLING"
        ? transitionTask(task, "CANCELLED", patch, this.isoNow())
        : task.state === "RUNNING"
          ? transitionTask(task, "FAILED", { ...patch, failureReason: "TASK_RESULT_TOO_LARGE", waitingReason: null }, this.isoNow())
          : task;
      this.store.replace(stopped);
      return stopped;
    }
    const cancellationPending = task.state === "CANCELLING";
    let next = checkpointTaskExecution(task, stepId, result, this.isoNow(), outcome.state === "succeeded");
    if (!success && outcome.state === "succeeded") {
      next = {
        ...next,
        stepStates: changedStepState(next, stepId, "succeeded"),
      };
    }
    if (cancellationPending) {
      next = transitionTask(next, "CANCELLED", { currentStep: next.currentStep }, this.isoNow());
    } else if (!success && next.state === "RUNNING") {
      next = transitionTask(next, "FAILED", {
        failureReason: deadlineExceeded ? "TASK_DEADLINE_EXCEEDED" : outcome.failureCode ?? `CHILD_${outcome.state.toUpperCase()}`,
        waitingReason: null,
      }, this.isoNow());
    } else if (success && next.state === "RUNNING" && (next.currentStep === task.plan.steps.length || next.currentStep === null)) {
      next = transitionTask(next, "COMPLETED", { currentStep: null }, this.isoNow());
    }
    this.store.replace(next);
    return next;
  }

  private interruptUnknownDispatch(task: PersistentTask, stepId: string, reason = "DISPATCH_OUTCOME_UNKNOWN"): PersistentTask {
    const at = this.isoNow();
    const index = task.plan.steps.findIndex((step) => step.stepId === stepId);
    let next: PersistentTask;
    if (task.state === "CANCELLING") {
      next = transitionTask(task, "INTERRUPTED", {
        currentStep: index,
        stepStates: changedStepState(task, stepId, "failed"),
        failureReason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
        waitingReason: null,
      }, at);
    } else if (task.state === "QUEUED" || task.state === "RUNNING") {
      next = transitionTask(task, "WAITING_FOR_MODEL", {
        currentStep: index,
        stepStates: changedStepState(task, stepId, "failed"),
        failureReason: null,
        waitingReason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
      }, at);
    } else {
      return task;
    }
    this.store.replace(next);
    return next;
  }

  private failRunningTask(task: PersistentTask, stepId: string, reason: string): PersistentTask {
    const at = this.isoNow();
    const index = task.plan.steps.findIndex((step) => step.stepId === stepId);
    const stepState = task.stepStates.find((item) => item.stepId === stepId)?.state;
    const states = stepState === "running" ? changedStepState(task, stepId, "failed") : task.stepStates;
    const next = transitionTask(task, "FAILED", {
      currentStep: index,
      stepStates: states,
      failureReason: reason.slice(0, FAILURE_REASON_MAX_LENGTH),
      waitingReason: null,
    }, at);
    this.store.replace(next);
    return next;
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}
