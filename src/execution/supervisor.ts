import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readPermission } from "../permission/store.js";
import type { Workspace } from "../workspace/manager.js";
import type { ExecutionJob, ExecutionKind, OutputStream, PackageManager } from "./job-types.js";
import { isExecutionKind } from "./job-types.js";
import { checkExecutionPermission } from "./permission.js";
import { resolveRepositoryIdentity, RepositoryIdentityError, type RepositoryIdentity } from "./repository-identity.js";
import { findTrustedCommand, CommandNotApprovedError, type TrustedCommand } from "./trusted-registry.js";
import { ExecutionJobStore, MAX_JOBS_PER_WORKSPACE, type ReadJobOutputResult } from "./job-store.js";
import { transitionExecutionJob } from "./state-machine.js";
import { WindowsNativeExecutionRunner, type NativeRunnerHandle } from "./native-runner.js";
import { StreamingSanitizer } from "./stream-sanitize.js";

export const MAX_EXECUTION_TIMEOUT_SECONDS = 3600;
export const MAX_GLOBAL_EXECUTIONS = 2;
export const MAX_WORKSPACE_EXECUTIONS = 2;
export const MAX_REPOSITORY_EXECUTIONS = 1;
export const EXECUTION_CANCEL_GRACE_MS = 10_000;
export const EXECUTION_PERMISSION_POLL_MS = 250;

interface StartExecutionInput {
  repositoryPath: string;
  kind: ExecutionKind;
  target: string;
  timeoutSeconds: number;
  idempotencyKey: string;
  oauthClientId: string;
  scopes: readonly string[];
}

export type ExecutionServiceErrorCode =
  | "INVALID_ARGUMENTS"
  | "INSUFFICIENT_SCOPE"
  | "EXECUTION_PERMISSION_DENIED"
  | "COMMAND_NOT_APPROVED"
  | "INVALID_REPOSITORY"
  | "REPOSITORY_IDENTITY_CHANGED"
  | "REPARSE_POINT"
  | "EXECUTABLE_UNAVAILABLE"
  | "EXECUTION_HELPER_UNAVAILABLE"
  | "JOB_STORE_FULL"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "CANCEL_NOT_ALLOWED"
  | "SUPERVISOR_CLOSING";

export type StartExecutionResult =
  | { ok: true; job: ExecutionJob; duplicate: boolean }
  | { ok: false; error: ExecutionServiceErrorCode };

export type CancelExecutionResult =
  | { ok: true; job: ExecutionJob }
  | { ok: false; error: "NOT_FOUND" | "CANCEL_NOT_ALLOWED" };

export interface ExecutionRunner {
  start(request: {
    jobId: string;
    repository: RepositoryIdentity;
    trustedCommand: TrustedCommand;
    timeoutSeconds: number;
    stateDirectory: string;
  }, callbacks: {
    onOutput: (stream: OutputStream, data: Buffer) => void;
    onDiagnostic?: (message: string) => void;
  }): NativeRunnerHandle;
}

interface ActiveExecution {
  handle: NativeRunnerHandle;
  intent: "cancelled" | "timed_out" | null;
  workspaceSlot: string;
  timeoutTimer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
  sanitizers: Record<OutputStream, StreamingSanitizer>;
  decoders: Record<OutputStream, StringDecoder>;
  finished: Promise<void>;
}

const supervisors = new Set<ExecutionSupervisor>();
const globalSlots = new Map<string, { workspaceId: string; repositoryIdentity: string }>();

function scheduleAll(): void {
  for (const supervisor of supervisors) supervisor.schedule();
}

function validTarget(kind: ExecutionKind, target: string): boolean {
  if (typeof target !== "string" || target.length < 1 || target.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(target)) {
    return false;
  }
  if (kind === "test" || kind === "build" || kind === "lint" || kind === "typecheck") return target === kind;
  return true;
}

function fixedManager(value: unknown): value is PackageManager {
  return value === "npm" || value === "pnpm";
}

function cleanCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/.test(value) ? value : "EXECUTION_FAILED";
}

export class ExecutionSupervisor {
  readonly store: ExecutionJobStore;
  private readonly runner: ExecutionRunner;
  private readonly active = new Map<string, ActiveExecution>();
  private accepting = true;
  private closed = false;
  private readonly permissionTimer: NodeJS.Timeout;

  constructor(
    readonly workspace: Workspace,
    options: {
      store?: ExecutionJobStore;
      runner?: ExecutionRunner;
      permissionPollMs?: number;
      cancelGraceMs?: number;
      now?: () => number;
    } = {}
  ) {
    this.store = options.store ?? new ExecutionJobStore(workspace.id);
    this.runner = options.runner ?? new WindowsNativeExecutionRunner();
    this.permissionPollMs = options.permissionPollMs ?? EXECUTION_PERMISSION_POLL_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? EXECUTION_CANCEL_GRACE_MS;
    this.now = options.now ?? Date.now;
    supervisors.add(this);
    this.permissionTimer = setInterval(() => this.reconcilePermission(), this.permissionPollMs);
    this.permissionTimer.unref?.();
  }

  private readonly permissionPollMs: number;
  private readonly cancelGraceMs: number;
  private readonly now: () => number;

  start(input: StartExecutionInput): StartExecutionResult {
    if (!this.accepting) return { ok: false, error: "SUPERVISOR_CLOSING" };
    if (!input || typeof input !== "object" || !isExecutionKind(input.kind) || !validTarget(input.kind, input.target)) {
      return { ok: false, error: "INVALID_ARGUMENTS" };
    }
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_EXECUTION_TIMEOUT_SECONDS) {
      return { ok: false, error: "INVALID_ARGUMENTS" };
    }
    if (
      typeof input.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey) ||
      typeof input.oauthClientId !== "string" || input.oauthClientId.length < 1 || input.oauthClientId.length > 200
    ) return { ok: false, error: "INVALID_ARGUMENTS" };

    if (!Array.isArray(input.scopes) || !input.scopes.includes("execution.run")) {
      return { ok: false, error: "INSUFFICIENT_SCOPE" };
    }
    const permissionMode = readPermission(this.workspace.id);
    if (permissionMode === "readonly") return { ok: false, error: "EXECUTION_PERMISSION_DENIED" };

    let repository: RepositoryIdentity;
    try {
      repository = resolveRepositoryIdentity(this.workspace, input.repositoryPath);
    } catch (error) {
      if (error instanceof RepositoryIdentityError) {
        if (error.code === "REPARSE_POINT") return { ok: false, error: "REPARSE_POINT" };
        return { ok: false, error: "INVALID_REPOSITORY" };
      }
      return { ok: false, error: "INVALID_REPOSITORY" };
    }

    const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey, "utf8").digest("hex");
    const duplicate = this.store.findIdempotent(input.oauthClientId, idempotencyKeyHash);
    if (duplicate) {
      const sameRequest = duplicate.repositoryIdentity === repository.identity &&
        duplicate.recipe.kind === input.kind &&
        duplicate.recipe.target === input.target &&
        duplicate.timeoutSeconds === input.timeoutSeconds;
      return sameRequest
        ? { ok: true, job: duplicate, duplicate: true }
        : { ok: false, error: "IDEMPOTENCY_CONFLICT" };
    }

    let trustedCommand: TrustedCommand;
    try {
      trustedCommand = findTrustedCommand({
        workspaceId: this.workspace.id,
        repositoryIdentity: repository.identity,
        canonicalRepositoryPath: repository.canonicalPath,
        kind: input.kind,
        target: input.target,
      });
    } catch (error) {
      if (error instanceof CommandNotApprovedError) return { ok: false, error: "COMMAND_NOT_APPROVED" };
      return { ok: false, error: "COMMAND_NOT_APPROVED" };
    }
    if (!fixedManager(trustedCommand.packageManager)) return { ok: false, error: "COMMAND_NOT_APPROVED" };
    if (!checkExecutionPermission({ mode: permissionMode, scopes: input.scopes, action: "start", hasTrustedCommand: true })) {
      return { ok: false, error: "EXECUTION_PERMISSION_DENIED" };
    }

    const now = new Date(this.now()).toISOString();
    const job: ExecutionJob = {
      jobId: randomBytes(24).toString("base64url"),
      workspaceId: this.workspace.id,
      repositoryIdentity: repository.identity,
      repositoryPath: repository.workspaceRelativePath,
      oauthClientId: input.oauthClientId,
      recipe: {
        kind: trustedCommand.kind,
        target: trustedCommand.target,
        packageManager: trustedCommand.packageManager,
        scriptHash: trustedCommand.scriptHash,
      },
      state: "queued",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      timeoutSeconds: input.timeoutSeconds,
      idempotencyKeyHash,
      exitCode: null,
      failureCode: null,
      stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    };
    try {
      this.store.create(job);
    } catch (error) {
      return { ok: false, error: (error as Error).message === "JOB_STORE_FULL" ? "JOB_STORE_FULL" : "INVALID_ARGUMENTS" };
    }
    this.schedule();
    return { ok: true, job: this.store.get(job.jobId) ?? job, duplicate: false };
  }

  getForClient(jobId: string, clientId: string): ExecutionJob | null {
    const job = this.store.get(jobId);
    return job?.oauthClientId === clientId ? job : null;
  }

  listForClient(clientId: string, limit = MAX_JOBS_PER_WORKSPACE): ExecutionJob[] {
    return this.store.listForClient(clientId, limit);
  }

  readOutputForClient(
    jobId: string,
    clientId: string,
    stream: OutputStream,
    offset = 0,
    maxBytes?: number
  ): ReadJobOutputResult {
    if (!this.getForClient(jobId, clientId)) return { ok: false, error: "NOT_FOUND" };
    return this.store.readOutput(jobId, stream, offset, maxBytes);
  }

  cancel(jobId: string, clientId: string): CancelExecutionResult {
    const job = this.getForClient(jobId, clientId);
    if (!job) return { ok: false, error: "NOT_FOUND" };
    if (job.state === "queued") {
      const cancelled = transitionExecutionJob(job, "cancelled", { failureCode: "CANCELLED_BEFORE_START" });
      this.store.replace(cancelled);
      scheduleAll();
      return { ok: true, job: cancelled };
    }
    if (job.state === "running") {
      const active = this.active.get(jobId);
      if (!active) return { ok: false, error: "CANCEL_NOT_ALLOWED" };
      active.intent = "cancelled";
      this.store.replace(transitionExecutionJob(job, "cancelling"));
      active.handle.cancel();
      this.armCancelGrace(jobId, active);
      return { ok: true, job: this.store.get(jobId)! };
    }
    if (job.state === "cancelling") return { ok: true, job };
    return { ok: false, error: "CANCEL_NOT_ALLOWED" };
  }

  schedule(): void {
    if (this.closed || !this.accepting) return;
    if (readPermission(this.workspace.id) === "readonly") {
      this.cancelQueuedForDowngrade();
      return;
    }
    while (globalSlots.size < MAX_GLOBAL_EXECUTIONS) {
      const workspaceActive = [...globalSlots.values()].filter((slot) => slot.workspaceId === this.workspace.id).length;
      if (workspaceActive >= MAX_WORKSPACE_EXECUTIONS) break;
      const busyRepositories = new Set([...globalSlots.values()].map((slot) => slot.repositoryIdentity));
      const next = this.allQueuedOldestFirst().find((job) => !busyRepositories.has(job.repositoryIdentity));
      if (!next) break;
      const workspaceSlot = `${this.workspace.id}:${next.jobId}`;
      if (globalSlots.has(workspaceSlot)) break;
      globalSlots.set(workspaceSlot, { workspaceId: this.workspace.id, repositoryIdentity: next.repositoryIdentity });
      this.startQueued(next, workspaceSlot);
    }
  }

  private allQueuedOldestFirst(): ExecutionJob[] {
    return this.store.listAll(MAX_JOBS_PER_WORKSPACE)
      .filter((job) => job.state === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private startQueued(job: ExecutionJob, workspaceSlot: string): void {
    const permission = readPermission(this.workspace.id);
    if (permission === "readonly") {
      globalSlots.delete(workspaceSlot);
      this.cancelQueuedForDowngrade();
      return;
    }
    let repository: RepositoryIdentity;
    let trustedCommand: TrustedCommand;
    try {
      repository = resolveRepositoryIdentity(this.workspace, job.repositoryPath);
      if (repository.identity !== job.repositoryIdentity) throw new RepositoryIdentityError("PATH_CHANGED");
      trustedCommand = findTrustedCommand({
        workspaceId: this.workspace.id,
        repositoryIdentity: repository.identity,
        canonicalRepositoryPath: repository.canonicalPath,
        kind: job.recipe.kind,
        target: job.recipe.target,
      });
    } catch (error) {
      globalSlots.delete(workspaceSlot);
      const failureCode = error instanceof RepositoryIdentityError
        ? error.code === "REPARSE_POINT" ? "REPARSE_POINT" : "REPOSITORY_IDENTITY_CHANGED"
        : "COMMAND_NOT_APPROVED";
      const failed = transitionExecutionJob(job, "failed", { failureCode });
      this.store.replace(failed);
      scheduleAll();
      return;
    }

    const running = transitionExecutionJob(job, "running", { failureCode: null });
    this.store.replace(running);
    const sanitizers = { stdout: new StreamingSanitizer(), stderr: new StreamingSanitizer() };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let active!: ActiveExecution;
    try {
      const handle = this.runner.start({
        jobId: job.jobId,
        repository,
        trustedCommand,
        timeoutSeconds: job.timeoutSeconds,
        stateDirectory: this.store.directory,
      }, {
        onOutput: (stream, data) => this.onOutput(job.jobId, stream, data, active),
      });
      const timeoutTimer = setTimeout(() => this.requestTermination(job.jobId, active, "timed_out"), job.timeoutSeconds * 1000 + 1000);
      timeoutTimer.unref?.();
      active = {
        handle,
        intent: null,
        workspaceSlot,
        timeoutTimer,
        graceTimer: null,
        sanitizers,
        decoders,
        finished: Promise.resolve(),
      };
      this.active.set(job.jobId, active);
      active.finished = handle.completion
        .then((completion) => this.completeJob(job.jobId, active, completion.result))
        .catch(() => this.failUnconfirmed(job.jobId, active, "HELPER_UNCONFIRMED"))
        .finally(() => this.releaseActive(job.jobId, active));
    } catch (error) {
      const failed = transitionExecutionJob(this.store.get(job.jobId) ?? running, "failed", {
        failureCode: cleanCode((error as Error).message === "EXECUTION_HELPER_UNAVAILABLE"
          ? "EXECUTION_HELPER_UNAVAILABLE"
          : (error as Error).message === "EXECUTABLE_UNAVAILABLE"
            ? "EXECUTABLE_UNAVAILABLE"
            : "HELPER_START_FAILED"),
      });
      this.store.replace(failed);
      globalSlots.delete(workspaceSlot);
      scheduleAll();
    }
  }

  private onOutput(jobId: string, stream: OutputStream, data: Buffer, active: ActiveExecution): void {
    if (!active || this.store.get(jobId)?.state === "interrupted") return;
    const text = active.decoders[stream].write(data);
    if (!text) return;
    const safe = active.sanitizers[stream].push(text);
    if (safe) this.store.appendSanitized(jobId, stream, safe);
    const reason = active.sanitizers[stream].restrictedReason;
    if (reason) this.store.markOutputRestricted(jobId, stream, reason);
  }

  private finishSanitizers(jobId: string, active: ActiveExecution): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = active.decoders[stream].end();
      if (tail) {
        const safeTail = active.sanitizers[stream].push(tail);
        if (safeTail) this.store.appendSanitized(jobId, stream, safeTail);
      }
      const safe = active.sanitizers[stream].finish();
      if (safe) this.store.appendSanitized(jobId, stream, safe);
      const reason = active.sanitizers[stream].restrictedReason;
      if (reason) this.store.markOutputRestricted(jobId, stream, reason);
    }
  }

  private completeJob(jobId: string, active: ActiveExecution, result: { outcome: 0 | 1 | 2 | 3; exitCode: number; win32Error: number }): void {
    this.finishSanitizers(jobId, active);
    const job = this.store.get(jobId);
    if (!job || job.state === "interrupted" || job.finishedAt) return;
    let terminal: ExecutionJob["state"];
    let failureCode: string | null = null;
    let exitCode: number | null = result.outcome === 0 ? result.exitCode : null;
    if (result.outcome === 3) {
      terminal = "interrupted";
      failureCode = "HELPER_CLEANUP_UNCONFIRMED";
      exitCode = null;
    } else if (result.outcome === 2 || active.intent === "timed_out") {
      terminal = "timed_out";
      failureCode = "TIMEOUT";
      exitCode = null;
    } else if (result.outcome === 1 || active.intent === "cancelled") {
      terminal = "cancelled";
      failureCode = "CANCELLED";
      exitCode = null;
    } else if (result.exitCode === 0) {
      terminal = "succeeded";
    } else {
      terminal = "failed";
      failureCode = "NONZERO_EXIT";
    }
    this.store.replace(transitionExecutionJob(job, terminal, { exitCode, failureCode }));
  }

  private failUnconfirmed(jobId: string, active: ActiveExecution, code: string): void {
    this.finishSanitizers(jobId, active);
    const job = this.store.get(jobId);
    if (!job || job.finishedAt) return;
    this.store.replace(transitionExecutionJob(job, "interrupted", { exitCode: null, failureCode: cleanCode(code) }));
  }

  private releaseActive(jobId: string, active: ActiveExecution): void {
    clearTimeout(active.timeoutTimer);
    if (active.graceTimer) clearTimeout(active.graceTimer);
    if (this.active.get(jobId) === active) this.active.delete(jobId);
    globalSlots.delete(active.workspaceSlot);
    scheduleAll();
  }

  private requestTermination(jobId: string, active: ActiveExecution, intent: "cancelled" | "timed_out"): void {
    const job = this.store.get(jobId);
    if (!job || job.finishedAt || this.active.get(jobId) !== active) return;
    if (job.state === "running") {
      active.intent = intent;
      this.store.replace(transitionExecutionJob(job, "cancelling"));
      active.handle.cancel();
      this.armCancelGrace(jobId, active);
      return;
    }
    if (job.state === "cancelling" && intent === "timed_out") active.intent = "timed_out";
  }

  private armCancelGrace(jobId: string, active: ActiveExecution): void {
    if (active.graceTimer) return;
    active.graceTimer = setTimeout(() => {
      const job = this.store.get(jobId);
      if (!job || job.finishedAt || this.active.get(jobId) !== active) return;
      active.handle.abandon(); // EOF delegates cleanup to the per-job helper.
      this.store.replace(transitionExecutionJob(job, "interrupted", {
        failureCode: "TREE_TERMINATION_UNCONFIRMED",
      }));
    }, this.cancelGraceMs);
    active.graceTimer.unref?.();
  }

  private cancelQueuedForDowngrade(): void {
    for (const job of this.queuedJobs()) {
      this.store.replace(transitionExecutionJob(job, "cancelled", { failureCode: "PERMISSION_DOWNGRADED" }));
    }
    for (const [jobId, active] of this.active) {
      if (active.intent) continue;
      const job = this.store.get(jobId);
      if (job?.state === "running") this.requestTermination(jobId, active, "cancelled");
    }
  }

  private queuedJobs(): ExecutionJob[] {
    return this.allQueuedOldestFirst();
  }

  reconcilePermission(): void {
    if (this.closed) return;
    if (readPermission(this.workspace.id) === "readonly") this.cancelQueuedForDowngrade();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    for (const job of this.queuedJobs()) {
      this.store.replace(transitionExecutionJob(job, "cancelled", { failureCode: "BRIDGE_SHUTDOWN" }));
    }
    const pending: Promise<void>[] = [];
    for (const [jobId, active] of this.active) {
      const job = this.store.get(jobId);
      if (job?.state === "running") this.requestTermination(jobId, active, "cancelled");
      pending.push(active.finished);
    }
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, this.cancelGraceMs + 1000);
      timeoutHandle.unref?.();
    });
    await Promise.race([Promise.allSettled(pending).then(() => undefined), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    for (const [jobId, active] of this.active) {
      const job = this.store.get(jobId);
      if (job && !job.finishedAt) {
        active.handle.abandon();
        this.store.replace(transitionExecutionJob(job, "interrupted", { failureCode: "SHUTDOWN_UNCONFIRMED" }));
      }
    }
    clearInterval(this.permissionTimer);
    this.closed = true;
    supervisors.delete(this);
  }
}
