import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readCurrentSessionGrant, readPermission, readPermissionStatus } from "../permission/store.js";
import type { Workspace } from "../workspace/manager.js";
import type { ExecutionJob, ExecutionKind, FullAccessExecutionJob, OutputStream, PackageManager, RepositoryExecutionAuthorization, RepositoryExecutionJob } from "./job-types.js";
import { isExecutionKind, isFullAccessExecutionJob } from "./job-types.js";
import { checkExecutionPermission } from "./permission.js";
import { beginEventLoopTraceSpan, isEventLoopTraceEnabled } from "../diagnostics/event-loop-trace.js";
import { resolveRepositoryIdentity, RepositoryIdentityError, type RepositoryIdentity } from "./repository-identity.js";
import { findTrustedCommand, CommandNotApprovedError, type TrustedCommand } from "./trusted-registry.js";
import { ExecutionJobStore, MAX_JOBS_PER_WORKSPACE, type ReadJobOutputResult } from "./job-store.js";
import { transitionExecutionJob } from "./state-machine.js";
import { NativeRunnerOutputError, WindowsNativeExecutionRunner, type NativeRunnerHandle, type NativeRunnerRequest } from "./native-runner.js";
import { ExecutionTempOwner } from "./execution-temp.js";
import { StreamingSanitizer } from "./stream-sanitize.js";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import type { GenericCommand } from "./helper-protocol.js";
import { consumeLevel3Request, resolveConsumedLevel3Request, isLevel3Enabled, getLevel3Request, completeLevel3Request } from "./level3-approval.js";
import { createGitJobPlan, resolveGitJobPlan, readGitJobPlan, archiveGitJobPlan } from "./git-job-plan.js";
import { jobCanBeArchived } from "./record-archive.js";
import { hasGitReviewHold, requireGitReview } from "./git-review-hold.js";
import { verifyGitPostconditions } from "../git-write/planner.js";
import { confirmGitWriteState, listGitRepositoryApprovals, type GitWriteOperation } from "../git-write/index.js";
import { acquireRepositoryWriteLock } from "./repository-write-lock.js";
import { resolveFullAccessCommand, verifyFullAccessCommand, type FullAccessCommandInput } from "./full-access-command.js";

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

type StartFullAccessInput = FullAccessCommandInput & {
  repositoryPath?: string;
  timeoutSeconds: number;
  idempotencyKey: string;
  oauthClientId: string;
  scopes: readonly string[];
};

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
  | "STORE_CORRUPT"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "CANCEL_NOT_ALLOWED"
  | "SUPERVISOR_CLOSING";

export type StartExecutionResult<T extends ExecutionJob = ExecutionJob> =
  | { ok: true; job: T; duplicate: boolean }
  | { ok: false; error: string };

export type CancelExecutionResult =
  | { ok: true; job: ExecutionJob }
  | { ok: false; error: "NOT_FOUND" | "CANCEL_NOT_ALLOWED" | "STORE_CORRUPT" };

export interface ExecutionRunner {
  start(request: NativeRunnerRequest, callbacks: {
    onOutput: (stream: OutputStream, data: Buffer) => void | Promise<void>;
    onDiagnostic?: (message: string) => void;
  }): NativeRunnerHandle;
}

interface ActiveExecution {
  handle: NativeRunnerHandle;
  intent: "cancelled" | "timed_out" | null;
  workspaceSlot: string;
  slotReservation: GlobalSlotReservation;
  timeoutTimer: NodeJS.Timeout;
  graceTimer: NodeJS.Timeout | null;
  sanitizers: Record<OutputStream, StreamingSanitizer>;
  decoders: Record<OutputStream, StringDecoder>;
  finished: Promise<void>;
  releaseWriteLock?: () => void;
  treeConfirmed?: boolean;
  tempCleanupConfirmed: boolean;
  outputTail: Promise<void>;
  outputFailure: unknown | null;
  outputClosed: boolean;
  outputFinalization: Promise<void> | null;
}

interface GlobalSlotReservation {
  workspaceId: string;
  repositoryIdentity: string | null;
}

const supervisors = new Set<ExecutionSupervisor>();
const globalSlots = new Map<string, GlobalSlotReservation>();

function releaseGlobalSlot(key: string, reservation: GlobalSlotReservation): boolean {
  if (globalSlots.get(key) !== reservation) {
    return false;
  }
  globalSlots.delete(key);
  return true;
}

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

function jobRepositoryIdentity(job: ExecutionJob): string | null {
  return isFullAccessExecutionJob(job) ? job.repositoryScope?.identity ?? null : job.repositoryIdentity;
}

export class ExecutionSupervisor {
  readonly store: ExecutionJobStore;
  private readonly runner: ExecutionRunner;
  private readonly tempOwner: ExecutionTempOwner;
  private readonly logger: Logger;
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
      logger?: Logger;
    } = {}
  ) {
    this.logger = options.logger ?? nullLogger;
    this.store = options.store ?? new ExecutionJobStore(workspace.id);
    this.tempOwner = new ExecutionTempOwner(this.store.directory, workspace.id);
    if (!this.store.corruption) {
      const records = this.store.listAll().flatMap((job) => job.tempOwnership
        ? [{ jobId: job.jobId, ownership: job.tempOwnership }]
        : []);
      const recovery = this.tempOwner.reconcileStaleTemps(records);
      if (recovery.skipped > 0) {
        this.logger.warn("Execution temp recovery preserved unknown or unverified directories", {
          workspaceId: workspace.id,
          skipped: recovery.skipped,
        });
      }
    }
    this.runner = options.runner ?? new WindowsNativeExecutionRunner();
    this.permissionPollMs = options.permissionPollMs ?? EXECUTION_PERMISSION_POLL_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? EXECUTION_CANCEL_GRACE_MS;
    this.now = options.now ?? Date.now;
    if (!this.store.corruption) {
      for (const job of this.store.listAll()) {
        if (job.authorization && (job.authorization.type === "git" && !job.gitResult || job.state === "interrupted" && !job.gitResult)) this.auditControlledCompletion(job.jobId);
        try { archiveGitJobPlan(this.workspace, job); } catch { /* preserve uncertain or unverified plans */ }
      }
    }
    supervisors.add(this);
    this.permissionTimer = setInterval(() => this.reconcilePermission(), this.permissionPollMs);
    this.permissionTimer.unref?.();
  }

  private readonly permissionPollMs: number;
  private readonly cancelGraceMs: number;
  private readonly now: () => number;

  private controlledGate(scopes: readonly string[], scope: string, clientId: string, idempotencyKey: string): string | null {
    if (!this.accepting) return "SUPERVISOR_CLOSING";
    if (this.store.corruption) return "STORE_CORRUPT";
    if (!Array.isArray(scopes) || !scopes.includes(scope)) return "INSUFFICIENT_SCOPE";
    if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > 200 ||
        typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) return "INVALID_ARGUMENTS";
    if (readPermission(this.workspace.id) === "readonly") return "EXECUTION_PERMISSION_DENIED";
    return null;
  }

  startLevel3(input: { requestId: string; digest: string; oauthClientId: string; scopes: readonly string[]; idempotencyKey: string }): StartExecutionResult<RepositoryExecutionJob> {
    const denied = this.controlledGate(input.scopes, "execution.level3", input.oauthClientId, input.idempotencyKey);
    if (denied) return { ok: false, error: denied };
    const hash = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const previous = this.store.findIdempotent(input.oauthClientId, hash);
    if (previous) {
      if (!isFullAccessExecutionJob(previous) && previous.authorization?.type === "level3" &&
          previous.authorization.requestId === input.requestId && previous.authorization.digest === input.digest) {
        return { ok: true, job: previous, duplicate: true };
      }
      return { ok: false, error: "IDEMPOTENCY_CONFLICT" };
    }
    try {
      this.store.prepareCapacity();
      const authorization = consumeLevel3Request(this.workspace, input.requestId, input.oauthClientId, input.digest);
      return this.enqueueControlled(authorization.repository, { type: "level3", requestId: input.requestId, digest: input.digest },
        authorization.request.spec.timeoutSeconds, hash, input.oauthClientId);
    } catch (error) { return { ok: false, error: cleanCode((error as Error).message) }; }
  }

  startGitWrite(input: { repositoryPath: string; operation: GitWriteOperation; timeoutSeconds: number; oauthClientId: string; scopes: readonly string[]; idempotencyKey: string }): StartExecutionResult<RepositoryExecutionJob> {
    const denied = this.controlledGate(input.scopes, "git.write", input.oauthClientId, input.idempotencyKey);
    if (denied) return { ok: false, error: denied };
    if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_EXECUTION_TIMEOUT_SECONDS) return { ok: false, error: "INVALID_ARGUMENTS" };
    const hash = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const previous = this.store.findIdempotent(input.oauthClientId, hash);
    if (previous) {
      try {
        if (isFullAccessExecutionJob(previous) || previous.authorization?.type !== "git") throw new Error("IDEMPOTENCY_CONFLICT");
        const old = readGitJobPlan(this.workspace, previous.authorization.requestId, previous.authorization.digest);
        const original = { ...old.operation };
        if (input.operation.expectedStatusHash === undefined) delete original.expectedStatusHash;
        const comparable = (operation: GitWriteOperation) => JSON.stringify(operation, Object.keys(operation).sort());
        if (resolveRepositoryIdentity(this.workspace, input.repositoryPath).identity !== old.repository.identity ||
            comparable(original) !== comparable(input.operation) || previous.timeoutSeconds !== input.timeoutSeconds) throw new Error("IDEMPOTENCY_CONFLICT");
        return { ok: true, job: previous, duplicate: true };
      } catch { return { ok: false, error: "IDEMPOTENCY_CONFLICT" }; }
    }
    try {
      this.store.prepareCapacity();
      if (hasGitReviewHold(this.workspace, input.repositoryPath)) return { ok: false, error: "GIT_REVIEW_REQUIRED" };
      const created = createGitJobPlan(this.workspace, input.repositoryPath, input.operation);
      return this.enqueueControlled(created.plan.repository, { type: "git", requestId: created.requestId, digest: created.digest }, input.timeoutSeconds, hash, input.oauthClientId);
    } catch (error) { return { ok: false, error: cleanCode((error as Error).message) }; }
  }

  private enqueueControlled(repository: RepositoryIdentity, authorization: RepositoryExecutionAuthorization, timeoutSeconds: number, idempotencyKeyHash: string, oauthClientId: string): StartExecutionResult<RepositoryExecutionJob> {
    const job: RepositoryExecutionJob = {
      jobId: randomBytes(24).toString("base64url"), workspaceId: this.workspace.id,
      executionContext: "repository",
      repositoryIdentity: repository.identity, repositoryPath: repository.workspaceRelativePath, oauthClientId,
      recipe: { kind: "package_script", target: "v13", packageManager: "npm", scriptHash: authorization.digest }, authorization,
      state: "queued", createdAt: new Date(this.now()).toISOString(), startedAt: null, finishedAt: null, timeoutSeconds,
      idempotencyKeyHash, tempOwnership: null, exitCode: null, failureCode: null,
      stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    };
    try { this.store.create(job); } catch (error) { return { ok: false, error: cleanCode((error as Error).message) }; }
    this.logger.info("Controlled execution authorized", { workspaceId: this.workspace.id, jobId: job.jobId, oauthClientId, capability: authorization.type, requestId: authorization.requestId, digest: authorization.digest });
    this.schedule();
    return { ok: true, job: (this.store.get(job.jobId) as RepositoryExecutionJob | null) ?? job, duplicate: false };
  }

  start(input: StartExecutionInput): StartExecutionResult<RepositoryExecutionJob> {
    if (!this.accepting) return { ok: false, error: "SUPERVISOR_CLOSING" };
    if (this.store.corruption) return { ok: false, error: "STORE_CORRUPT" };
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
      const sameRequest = !isFullAccessExecutionJob(duplicate) && duplicate.repositoryIdentity === repository.identity &&
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
    const job: RepositoryExecutionJob = {
      jobId: randomBytes(24).toString("base64url"),
      workspaceId: this.workspace.id,
      executionContext: "repository",
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
      tempOwnership: null,
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
    return { ok: true, job: (this.store.get(job.jobId) as RepositoryExecutionJob | null) ?? job, duplicate: false };
  }

  private currentFullAccessGrant(): { identityFingerprint: string; grantId: string } | null {
    try {
      const permission = readPermissionStatus(this.workspace.id);
      if (permission.effectiveMode !== "level2" || !permission.sessionElevation.active) return null;
      return readCurrentSessionGrant(this.workspace.id);
    } catch {
      return null;
    }
  }

  private hasCurrentFullAccessGrant(job: FullAccessExecutionJob): boolean {
    const current = this.currentFullAccessGrant();
    return current !== null && current.identityFingerprint === job.authorization.sessionGrantFingerprint &&
      current.grantId === job.authorization.sessionGrantId;
  }

  async startFullAccess(
    input: StartFullAccessInput,
    expectedGrant?: { identityFingerprint: string; grantId: string },
    beforeCreate?: () => boolean,
  ): Promise<StartExecutionResult<FullAccessExecutionJob>> {
    if (!this.accepting) return { ok: false, error: "SUPERVISOR_CLOSING" };
    if (this.store.corruption) return { ok: false, error: "STORE_CORRUPT" };
    if (!input || typeof input !== "object" ||
        !["program", "powershell", "cmd"].includes(input.engine) ||
        !Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_EXECUTION_TIMEOUT_SECONDS ||
        typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey) ||
        typeof input.oauthClientId !== "string" || input.oauthClientId.length < 1 || input.oauthClientId.length > 200 ||
        (input.repositoryPath !== undefined && (typeof input.repositoryPath !== "string" ||
          input.repositoryPath.length < 1 || input.repositoryPath.length > 32767))) {
      return { ok: false, error: "INVALID_ARGUMENTS" };
    }
    if (!Array.isArray(input.scopes) || !input.scopes.includes("execution.run")) {
      return { ok: false, error: "INSUFFICIENT_SCOPE" };
    }
    if (expectedGrant !== undefined &&
        (typeof expectedGrant.identityFingerprint !== "string" || expectedGrant.identityFingerprint.length === 0 ||
         typeof expectedGrant.grantId !== "string" || expectedGrant.grantId.length === 0)) {
      return { ok: false, error: "FULL_ACCESS_REQUIRED" };
    }
    const sessionGrant = this.currentFullAccessGrant();
    if (!sessionGrant || expectedGrant &&
        (sessionGrant.identityFingerprint !== expectedGrant.identityFingerprint || sessionGrant.grantId !== expectedGrant.grantId)) {
      return { ok: false, error: "FULL_ACCESS_REQUIRED" };
    }

    let command;
    try {
      command = await resolveFullAccessCommand(input, this.workspace.root);
    } catch (error) {
      return { ok: false, error: cleanCode((error as Error).message) };
    }
    let repositoryScope: { identity: string; path: string } | undefined;
    if (input.repositoryPath !== undefined) {
      try {
        const repository = resolveRepositoryIdentity(this.workspace, input.repositoryPath);
        repositoryScope = { identity: repository.identity, path: repository.canonicalPath };
      } catch (error) {
        if (error instanceof RepositoryIdentityError) {
          return { ok: false, error: error.code === "REPARSE_POINT" ? "REPARSE_POINT" : "INVALID_REPOSITORY" };
        }
        return { ok: false, error: cleanCode((error as Error).message) };
      }
    }
    const idempotencyKeyHash = createHash("sha256").update(input.idempotencyKey, "utf8").digest("hex");
    const requestMaterial = repositoryScope
      ? { command, timeoutSeconds: input.timeoutSeconds, repositoryScope }
      : { command, timeoutSeconds: input.timeoutSeconds };
    const requestHash = createHash("sha256").update(JSON.stringify(requestMaterial), "utf8").digest("hex");
    const previous = this.store.findIdempotent(input.oauthClientId, idempotencyKeyHash);
    if (previous) {
      const sameRequest = isFullAccessExecutionJob(previous) &&
        previous.authorization.requestHash === requestHash && previous.timeoutSeconds === input.timeoutSeconds;
      return sameRequest
        ? { ok: true, job: previous, duplicate: true }
        : { ok: false, error: "IDEMPOTENCY_CONFLICT" };
    }

    // Persistent Task cancellation/revocation may race asynchronous command
    // validation above. Re-read its authoritative state at the last point
    // before a new child job becomes durable and eligible for dispatch.
    if (beforeCreate && !beforeCreate()) return { ok: false, error: "TASK_STATE_CONFLICT" };

    try { this.store.prepareCapacity(); } catch (error) {
      return { ok: false, error: cleanCode((error as Error).message) };
    }
    const job: FullAccessExecutionJob = {
      jobId: randomBytes(24).toString("base64url"),
      workspaceId: this.workspace.id,
      oauthClientId: input.oauthClientId,
      executionContext: "host",
      repositoryIdentity: null,
      repositoryPath: null,
      recipe: null,
      authorization: {
        type: "full_access",
        permissionMode: "level2",
        sessionGrantFingerprint: sessionGrant.identityFingerprint,
        sessionGrantId: sessionGrant.grantId,
        requestHash,
      },
      fullAccessCommand: command,
      ...(repositoryScope ? { repositoryScope } : {}),
      state: "queued",
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      timeoutSeconds: input.timeoutSeconds,
      idempotencyKeyHash,
      tempOwnership: null,
      exitCode: null,
      failureCode: null,
      stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    };
    try { this.store.create(job); } catch (error) {
      return { ok: false, error: cleanCode((error as Error).message) };
    }
    this.logger.info("Full Access execution queued", {
      workspaceId: this.workspace.id,
      jobId: job.jobId,
      oauthClientId: input.oauthClientId,
      engine: command.engine,
      executable: command.executable,
      cwd: command.cwd,
      requestHash,
    });
    this.schedule();
    return { ok: true, job: (this.store.get(job.jobId) as FullAccessExecutionJob | null) ?? job, duplicate: false };
  }

  /** Resolve the active/archive idempotency namespace without starting a child. */
  async lookupFullAccessIdempotent(
    input: StartFullAccessInput,
    candidate?: ExecutionJob | null,
  ): Promise<{ ok: true; job: FullAccessExecutionJob | null } | { ok: false; error: string }> {
    if (this.store.corruption) return { ok: false, error: "STORE_CORRUPT" };
    if (!input || typeof input !== "object" ||
        !["program", "powershell", "cmd"].includes(input.engine) ||
        !Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > MAX_EXECUTION_TIMEOUT_SECONDS ||
        typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/.test(input.idempotencyKey) ||
        typeof input.oauthClientId !== "string" || input.oauthClientId.length < 1 || input.oauthClientId.length > 200 ||
        !Array.isArray(input.scopes) || !input.scopes.includes("execution.run") ||
        (input.repositoryPath !== undefined && (typeof input.repositoryPath !== "string" || input.repositoryPath.length < 1 || input.repositoryPath.length > 32767))) {
      return { ok: false, error: "INVALID_ARGUMENTS" };
    }
    let command;
    try { command = await resolveFullAccessCommand(input, this.workspace.root); }
    catch (error) { return { ok: false, error: cleanCode((error as Error).message) }; }
    let repositoryScope: { identity: string; path: string } | undefined;
    if (input.repositoryPath !== undefined) {
      try {
        const repository = resolveRepositoryIdentity(this.workspace, input.repositoryPath);
        repositoryScope = { identity: repository.identity, path: repository.canonicalPath };
      } catch (error) {
        if (error instanceof RepositoryIdentityError) {
          return { ok: false, error: error.code === "REPARSE_POINT" ? "REPARSE_POINT" : "INVALID_REPOSITORY" };
        }
        return { ok: false, error: cleanCode((error as Error).message) };
      }
    }
    const keyHash = createHash("sha256").update(input.idempotencyKey, "utf8").digest("hex");
    let previous: ExecutionJob | null;
    if (candidate !== undefined) {
      previous = candidate;
      if (previous && (previous.workspaceId !== this.workspace.id || previous.oauthClientId !== input.oauthClientId ||
          previous.idempotencyKeyHash !== keyHash)) return { ok: false, error: "IDEMPOTENCY_CONFLICT" };
    } else {
      try { previous = this.store.findIdempotent(input.oauthClientId, keyHash); }
      catch (error) { return { ok: false, error: cleanCode((error as Error).message) }; }
    }
    if (!previous) return { ok: true, job: null };
    const requestMaterial = repositoryScope
      ? { command, timeoutSeconds: input.timeoutSeconds, repositoryScope }
      : { command, timeoutSeconds: input.timeoutSeconds };
    const requestHash = createHash("sha256").update(JSON.stringify(requestMaterial), "utf8").digest("hex");
    if (!isFullAccessExecutionJob(previous) || previous.authorization.requestHash !== requestHash ||
        previous.timeoutSeconds !== input.timeoutSeconds) {
      return { ok: false, error: "IDEMPOTENCY_CONFLICT" };
    }
    return { ok: true, job: previous };
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
    if (this.store.corruption) return { ok: false, error: "STORE_CORRUPT" };
    const job = this.getForClient(jobId, clientId);
    if (!job) return { ok: false, error: "NOT_FOUND" };
    if (job.state === "queued") {
      const cancelled = transitionExecutionJob(job, "cancelled", { failureCode: "CANCELLED_BEFORE_START" });
      this.store.replace(cancelled);
      this.auditControlledCompletion(jobId);
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
      const busyRepositories = new Set([...globalSlots.values()]
        .flatMap((slot) => slot.repositoryIdentity === null ? [] : [slot.repositoryIdentity]));
      const next = this.allQueuedOldestFirst().find((job) => {
        const repositoryIdentity = jobRepositoryIdentity(job);
        return repositoryIdentity === null || !busyRepositories.has(repositoryIdentity);
      });
      if (!next) break;
      const workspaceSlot = `${this.workspace.id}:${next.jobId}`;
      if (globalSlots.has(workspaceSlot)) break;
      const slotReservation: GlobalSlotReservation = {
        workspaceId: this.workspace.id,
        repositoryIdentity: jobRepositoryIdentity(next),
      };
      globalSlots.set(workspaceSlot, slotReservation);
      void this.startQueued(next, workspaceSlot, slotReservation).catch((error: unknown) => {
        try {
          const current = this.store.get(next.jobId);
          if (current?.state === "queued" || (current?.state === "running" && !this.active.has(next.jobId))) {
            this.store.replace(transitionExecutionJob(current, "failed", { failureCode: cleanCode((error as Error).message) }));
            if (!isFullAccessExecutionJob(current)) this.auditControlledCompletion(current.jobId);
          }
        } catch (persistError) {
          this.logger.error("Failed to persist queued execution failure", {
            workspaceId: this.workspace.id,
            jobId: next.jobId,
            startupFailureCode: cleanCode((error as Error).message),
            persistenceFailureCode: cleanCode((persistError as Error).message),
          });
        } finally {
          releaseGlobalSlot(workspaceSlot, slotReservation);
          try {
            scheduleAll();
          } catch (scheduleError) {
            this.logger.error("Failed to schedule after queued execution cleanup", {
              workspaceId: this.workspace.id,
              jobId: next.jobId,
              failureCode: cleanCode((scheduleError as Error).message),
            });
          }
        }
      });
    }
  }

  private allQueuedOldestFirst(): ExecutionJob[] {
    return this.store.listAll(MAX_JOBS_PER_WORKSPACE)
      .filter((job) => job.state === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async startQueued(job: ExecutionJob, workspaceSlot: string, slotReservation: GlobalSlotReservation): Promise<void> {
    const permission = readPermission(this.workspace.id);
    if (permission === "readonly") {
      releaseGlobalSlot(workspaceSlot, slotReservation);
      this.cancelQueuedForDowngrade();
      return;
    }
    let repository: RepositoryIdentity | undefined;
    let trustedCommand: TrustedCommand | undefined;
    let genericCommand: GenericCommand | undefined;
    let releaseWriteLock: (() => void) | undefined;
    try {
      if (isFullAccessExecutionJob(job)) {
        const queuedFullAccessJob = job;
        const initialGrantValid = this.hasCurrentFullAccessGrant(queuedFullAccessJob);
        if (!initialGrantValid) throw new Error("FULL_ACCESS_REQUIRED");
        await verifyFullAccessCommand(queuedFullAccessJob.fullAccessCommand);
        const current = this.store.get(queuedFullAccessJob.jobId);
        if (!current || current.state !== "queued" || !isFullAccessExecutionJob(current)) {
          releaseGlobalSlot(workspaceSlot, slotReservation);
          scheduleAll();
          return;
        }
        job = current;
        const finalGrantValid = this.hasCurrentFullAccessGrant(job);
        if (!finalGrantValid) throw new Error("FULL_ACCESS_REQUIRED");
        if (job.repositoryScope) {
          repository = resolveRepositoryIdentity(this.workspace, job.repositoryScope.path);
          if (repository.identity !== job.repositoryScope.identity) throw new RepositoryIdentityError("PATH_CHANGED");
          releaseWriteLock = acquireRepositoryWriteLock(repository, job.jobId);
        }
      } else {
        repository = resolveRepositoryIdentity(this.workspace, job.repositoryPath);
        if (repository.identity !== job.repositoryIdentity) throw new RepositoryIdentityError("PATH_CHANGED");
        if (job.authorization) {
          releaseWriteLock = acquireRepositoryWriteLock(repository, job.jobId);
          if (job.authorization.type === "git" && hasGitReviewHold(this.workspace, job.repositoryPath)) throw new Error("GIT_REVIEW_REQUIRED");
          const resolved = job.authorization.type === "level3"
            ? resolveConsumedLevel3Request(this.workspace, job.authorization.requestId, job.oauthClientId, job.authorization.digest)
            : resolveGitJobPlan(this.workspace, job.authorization.requestId, job.authorization.digest);
          if (resolved.repository.identity !== repository.identity) throw new RepositoryIdentityError("PATH_CHANGED");
          genericCommand = resolved.genericCommand;
          trustedCommand = { workspaceId: this.workspace.id, repositoryIdentity: repository.identity,
            canonicalRepositoryPath: repository.canonicalPath, kind: "package_script", target: "v13", packageManager: "npm",
            scriptHash: job.authorization.digest, packageJsonHash: job.authorization.digest, approvedAt: job.createdAt, approvalSource: "local-cli" };
        } else trustedCommand = findTrustedCommand({
          workspaceId: this.workspace.id,
          repositoryIdentity: repository.identity,
          canonicalRepositoryPath: repository.canonicalPath,
          kind: job.recipe.kind,
          target: job.recipe.target,
        });
      }
    } catch (error) {
      releaseWriteLock?.();
      releaseGlobalSlot(workspaceSlot, slotReservation);
      const current = this.store.get(job.jobId);
      if (current?.state === "queued") {
        const failedJobIsFullAccess = isFullAccessExecutionJob(current);
        const failureCode = error instanceof RepositoryIdentityError
          ? error.code === "REPARSE_POINT" ? "REPARSE_POINT" : "REPOSITORY_IDENTITY_CHANGED"
          : failedJobIsFullAccess || current.authorization ? cleanCode((error as Error).message) : "COMMAND_NOT_APPROVED";
        const failed = transitionExecutionJob(current, "failed", { failureCode });
        this.store.replace(failed);
        if (!failedJobIsFullAccess) this.auditControlledCompletion(current.jobId);
      }
      scheduleAll();
      return;
    }

    const fullAccessJob = isFullAccessExecutionJob(job);
    let running: ExecutionJob;
    try {
      running = transitionExecutionJob(job, "running", { failureCode: null });
      this.store.replace(running);
    } catch (error) {
      releaseWriteLock?.();
      throw error;
    }
    const sanitizers = { stdout: new StreamingSanitizer(), stderr: new StreamingSanitizer() };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let active!: ActiveExecution;
    try {
      const tempLease = this.tempOwner.create(job.jobId);
      this.store.replace({ ...running, tempOwnership: {
        rootFileIdentity: tempLease.rootFileIdentity,
        directoryFileIdentity: tempLease.directoryFileIdentity,
        nonce: tempLease.nonce,
        createdAtMs: tempLease.createdAtMs,
      } });
      const runnerRequest: NativeRunnerRequest = isFullAccessExecutionJob(job) ? {
        jobId: job.jobId,
        timeoutSeconds: job.timeoutSeconds,
        stateDirectory: this.store.directory,
        tempLease,
        fullAccess: {
          workspaceId: job.workspaceId,
          oauthClientId: job.oauthClientId,
          permissionMode: job.authorization.permissionMode,
          sessionGrantFingerprint: job.authorization.sessionGrantFingerprint,
          sessionGrantId: job.authorization.sessionGrantId ?? "",
          idempotencyKeyHash: job.idempotencyKeyHash,
          requestHash: job.authorization.requestHash,
          command: job.fullAccessCommand,
        },
      } : {
        jobId: job.jobId,
        repository: repository!,
        trustedCommand: trustedCommand!,
        timeoutSeconds: job.timeoutSeconds,
        stateDirectory: this.store.directory,
        tempLease,
        ...(genericCommand ? { genericCommand } : {}),
      };
      const handle = this.runner.start(runnerRequest, {
        onOutput: (stream, data) => this.onOutput(job.jobId, stream, data, active),
        onDiagnostic: (message) => this.logger.warn("Execution helper diagnostic", {
          workspaceId: this.workspace.id,
          jobId: job.jobId,
          message,
        }),
      });
      const timeoutTimer = setTimeout(() => this.requestTermination(job.jobId, active, "timed_out"), job.timeoutSeconds * 1000 + 1000);
      timeoutTimer.unref?.();
      active = {
        handle,
        intent: null,
        workspaceSlot,
        slotReservation,
        timeoutTimer,
        graceTimer: null,
        sanitizers,
        decoders,
        finished: Promise.resolve(),
        outputTail: Promise.resolve(),
        outputFailure: null,
        outputClosed: false,
        outputFinalization: null,
        tempCleanupConfirmed: false,
        releaseWriteLock,
        treeConfirmed: false,
      };
      this.active.set(job.jobId, active);
      active.finished = handle.completion
        .then(async (completion) => {
          active.treeConfirmed = completion.result.outcome !== 3;
          active.tempCleanupConfirmed = completion.tempCleanupConfirmed === true;
          await this.completeJob(job.jobId, active, completion.result, completion.tempCleanupConfirmed === true);
        })
        .catch((error: unknown) => {
          if (error instanceof NativeRunnerOutputError) {
            active.treeConfirmed = error.helperResult.outcome !== 3;
            active.tempCleanupConfirmed = error.tempCleanupConfirmed;
          }
          return this.failUnconfirmed(job.jobId, active,
            error instanceof Error && error.message === "OUTPUT_PERSISTENCE_FAILED" ? "OUTPUT_PERSISTENCE_FAILED" : "HELPER_UNCONFIRMED");
        })
        .finally(() => this.releaseActive(job.jobId, active));
    } catch (error) {
      releaseWriteLock?.();
      const failed = transitionExecutionJob(this.store.get(job.jobId) ?? running, "failed", {
        failureCode: cleanCode((error as Error).message === "EXECUTION_HELPER_UNAVAILABLE"
          ? "EXECUTION_HELPER_UNAVAILABLE"
          : (error as Error).message === "EXECUTABLE_UNAVAILABLE"
            ? "EXECUTABLE_UNAVAILABLE"
            : "HELPER_START_FAILED"),
      });
      this.store.replace(failed);
      if (!fullAccessJob) this.auditControlledCompletion(job.jobId);
      releaseGlobalSlot(workspaceSlot, slotReservation);
      scheduleAll();
    }
  }

  private onOutput(jobId: string, stream: OutputStream, data: Buffer, active: ActiveExecution): Promise<void> {
    if (!active || this.store.get(jobId)?.state === "interrupted") return Promise.resolve();
    if (active.outputClosed) return Promise.reject(new Error("OUTPUT_PERSISTENCE_FAILED"));
    const operation = active.outputTail.then(async () => {
      if (active.outputFailure) throw active.outputFailure;
      await this.acceptOutput(jobId, stream, data, active);
    });
    active.outputTail = operation.then(() => undefined, (error: unknown) => {
      if (active.outputFailure === null) active.outputFailure = error;
    });
    return operation;
  }

  private async acceptOutput(jobId: string, stream: OutputStream, data: Buffer, active: ActiveExecution): Promise<void> {
    if (this.store.get(jobId)?.authorization && data.includes(0)) {
      // Generic programs can emit UTF-16 or binary data. Do not pass NUL-
      // interleaved secrets around the UTF-8 text sanitizer.
      this.store.markOutputRestricted(jobId, stream, "non_text_output");
      return;
    }
    const text = active.decoders[stream].write(data);
    if (!text) return;
    const safe = active.sanitizers[stream].push(text);
    if (safe) await this.store.appendSanitized(jobId, stream, safe);
    const reason = active.sanitizers[stream].restrictedReason;
    if (reason) this.store.markOutputRestricted(jobId, stream, reason);
  }

  private async finishSanitizers(jobId: string, active: ActiveExecution): Promise<void> {
    for (const stream of ["stdout", "stderr"] as const) {
      const tail = active.decoders[stream].end();
      if (tail) {
        const safeTail = active.sanitizers[stream].push(tail);
        if (safeTail) await this.store.appendSanitized(jobId, stream, safeTail);
      }
      const safe = active.sanitizers[stream].finish();
      if (safe) await this.store.appendSanitized(jobId, stream, safe);
      const reason = active.sanitizers[stream].restrictedReason;
      if (reason) this.store.markOutputRestricted(jobId, stream, reason);
    }
  }

  private finalizeOutput(jobId: string, active: ActiveExecution): Promise<void> {
    if (active.outputFinalization) return active.outputFinalization;
    active.outputClosed = true;
    active.outputFinalization = (async () => {
      await active.outputTail;
      if (active.outputFailure) throw active.outputFailure;
      await this.finishSanitizers(jobId, active);
      await this.store.flushOutput(jobId);
    })();
    return active.outputFinalization;
  }

  private async completeJob(jobId: string, active: ActiveExecution, result: { outcome: 0 | 1 | 2 | 3 | 4 | 5; exitCode: number; win32Error: number }, tempCleanupConfirmed: boolean): Promise<void> {
    await this.finalizeOutput(jobId, active);
    const job = this.store.get(jobId);
    if (!job || job.state === "interrupted" || job.finishedAt) return;
    let terminal: ExecutionJob["state"];
    let failureCode: string | null = null;
    let exitCode: number | null = result.outcome === 0 ? result.exitCode : null;
    if (result.outcome === 3) {
      terminal = "interrupted";
      failureCode = "HELPER_CLEANUP_UNCONFIRMED";
      exitCode = null;
    } else if (result.outcome === 4) {
      terminal = "failed";
      failureCode = "AUTHORIZATION_REVOKED";
      exitCode = null;
    } else if (result.outcome === 5) {
      terminal = "failed";
      failureCode = "GIT_STATE_CHANGED";
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
    const final = transitionExecutionJob({
      ...job,
      tempOwnership: tempCleanupConfirmed ? null : job.tempOwnership,
    }, terminal, { exitCode, failureCode });
    this.store.replace(final);
    if (isFullAccessExecutionJob(final)) {
      this.logger.info("Full Access execution finished", {
        workspaceId: final.workspaceId,
        jobId: final.jobId,
        oauthClientId: final.oauthClientId,
        state: final.state,
        exitCode: final.exitCode,
        failureCode: final.failureCode,
      });
    }
  }

  private async failUnconfirmed(jobId: string, active: ActiveExecution, code: string): Promise<void> {
    try {
      await this.finalizeOutput(jobId, active);
    } catch (error) {
      if (error instanceof Error && error.message === "OUTPUT_PERSISTENCE_FAILED") code = "OUTPUT_PERSISTENCE_FAILED";
    }
    const job = this.store.get(jobId);
    if (!job || job.finishedAt) return;
    this.store.replace(transitionExecutionJob({
      ...job,
      tempOwnership: active.tempCleanupConfirmed ? null : job.tempOwnership,
    }, "interrupted", { exitCode: null, failureCode: cleanCode(code) }));
  }

  private async interruptAfterOutput(jobId: string, active: ActiveExecution, code: string): Promise<void> {
    let failureCode = code;
    try {
      await this.finalizeOutput(jobId, active);
    } catch {
      failureCode = "OUTPUT_PERSISTENCE_FAILED";
    }
    const job = this.store.get(jobId);
    if (!job || job.finishedAt) return;
    this.store.replace(transitionExecutionJob(job, "interrupted", { failureCode }));
  }

  private releaseActive(jobId: string, active: ActiveExecution): void {
    clearTimeout(active.timeoutTimer);
    if (active.graceTimer) clearTimeout(active.graceTimer);
    if (this.active.get(jobId) === active) this.active.delete(jobId);
    releaseGlobalSlot(active.workspaceSlot, active.slotReservation);
    this.auditControlledCompletion(jobId);
    if (active.treeConfirmed) active.releaseWriteLock?.();
    scheduleAll();
  }

  private auditControlledCompletion(jobId: string): void {
    const job = this.store.get(jobId);
    if (!job?.authorization || isFullAccessExecutionJob(job)) return;
    try {
      if (job.authorization.type === "level3") {
        completeLevel3Request(this.workspace.id, job.authorization.requestId, job.oauthClientId, job.state === "succeeded" ? "completed" : "failed", jobCanBeArchived(job));
      } else {
        const plan = readGitJobPlan(this.workspace, job.authorization.requestId, job.authorization.digest);
        const confirmed = confirmGitWriteState(this.workspace, job.repositoryPath, plan.before);
        const network = ["push", "fetch", "pull_ff_only"].includes(plan.operation.kind);
        const remoteOutcome = !network ? "not_applicable" : !job.startedAt ? "not_attempted" : job.state === "succeeded" ? "reported_success" : "unknown";
        let integrity: "verified" | "unexpected" | "not_verified" = "not_verified";
        if (job.state === "succeeded") {
          try { integrity = verifyGitPostconditions(this.workspace, job.repositoryPath, plan) ? "verified" : "unexpected"; } catch { integrity = "unexpected"; }
        }
        const final = integrity === "unexpected" ? { ...job, state: "failed" as const, failureCode: "GIT_POSTCONDITION_UNTRUSTED" } : job;
        const partial = integrity === "unexpected" || job.state !== "succeeded" && (confirmed.state !== "confirmed" || remoteOutcome === "unknown");
        this.store.replace({ ...final, gitResult: { confirmation: confirmed.state, integrity,
          confirmationScope: "local_repository", remoteOutcome,
          partialSuccessPossible: partial,
          headBefore: plan.before.head, headAfter: "after" in confirmed ? confirmed.after.head : null,
          branchBefore: plan.before.branch, branchAfter: "after" in confirmed ? confirmed.after.branch : null } });
        if (job.startedAt && (final.state !== "succeeded" || partial)) requireGitReview(this.workspace, job.repositoryPath, jobId, final.failureCode ?? "GIT_RESULT_UNCERTAIN", plan.before);
      }
    } catch {
      if (job.authorization.type === "git") this.store.replace({ ...job, gitResult: { confirmation: "unavailable", confirmationScope: "local_repository",
        remoteOutcome: job.startedAt ? "unknown" : "not_attempted", partialSuccessPossible: !!job.startedAt,
        headBefore: null, headAfter: null, branchBefore: null, branchAfter: null } });
      if (job.authorization.type === "git" && job.startedAt) {
        try { const plan = readGitJobPlan(this.workspace, job.authorization.requestId, job.authorization.digest); requireGitReview(this.workspace, job.repositoryPath, jobId, "GIT_RESULT_UNAVAILABLE", plan.before); } catch { /* corrupt/missing authority already denies planning */ }
      }
    }
    this.logger.info("Controlled execution finished", { workspaceId: this.workspace.id, jobId, oauthClientId: job.oauthClientId,
      capability: job.authorization.type, state: job.state, exitCode: job.exitCode, failureCode: job.failureCode });
    try { const final = this.store.get(jobId); if (final) archiveGitJobPlan(this.workspace, final); } catch { /* no automatic cleanup of unknown evidence */ }
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
      void this.interruptAfterOutput(jobId, active, "TREE_TERMINATION_UNCONFIRMED")
        .catch(() => this.logger.error("Failed to persist execution interruption after output flush", { workspaceId: this.workspace.id, jobId }));
    }, this.cancelGraceMs);
    active.graceTimer.unref?.();
  }

  private cancelQueuedForDowngrade(): void {
    for (const job of this.queuedJobs()) {
      this.store.replace(transitionExecutionJob(job, "cancelled", { failureCode: "PERMISSION_DOWNGRADED" }));
      this.auditControlledCompletion(job.jobId);
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
    const span = isEventLoopTraceEnabled() ? beginEventLoopTraceSpan("permission_poll", {}, true) : null;
    let resultCategory: "success" | "failure" = "success";
    try {
      if (readPermission(this.workspace.id) === "readonly") this.cancelQueuedForDowngrade();
      for (const job of this.store.listAll()) {
        if ((job.state !== "queued" && job.state !== "running") ||
            (!job.authorization && !isFullAccessExecutionJob(job))) continue;
        let authorized = false;
        try {
          if (isFullAccessExecutionJob(job)) authorized = this.hasCurrentFullAccessGrant(job);
          else if (job.authorization) authorized = job.authorization.type === "level3"
              ? isLevel3Enabled(this.workspace.id) && ["consumed", "launching"].includes(getLevel3Request(this.workspace.id, job.authorization.requestId)?.status ?? "")
              : listGitRepositoryApprovals(this.workspace.id).some((approval) => approval.repositoryIdentity === job.repositoryIdentity);
        } catch { /* corrupt or revoked authority fails closed */ }
        if (!authorized) this.cancel(job.jobId, job.oauthClientId);
      }
    } catch (error) {
      resultCategory = "failure";
      throw error;
    } finally {
      span?.({ resultCategory });
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.accepting = false;
    for (const job of this.queuedJobs()) {
      this.store.replace(transitionExecutionJob(job, "cancelled", { failureCode: "BRIDGE_SHUTDOWN" }));
      this.auditControlledCompletion(job.jobId);
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
        await this.interruptAfterOutput(jobId, active, "SHUTDOWN_UNCONFIRMED");
      }
    }
    if (!this.store.corruption) {
      try {
        const records = this.store.listAll().flatMap((job) => job.tempOwnership
          ? [{ jobId: job.jobId, ownership: job.tempOwnership }]
          : []);
        const recovery = this.tempOwner.reconcileStaleTemps(records, new Set(this.active.keys()));
        if (recovery.skipped > 0) {
          this.logger.warn("Execution temp cleanup preserved unknown or unverified directories", {
            workspaceId: this.workspace.id,
            skipped: recovery.skipped,
          });
        }
      } catch {
        /* unknown or replaced temp roots are preserved for conservative recovery */
      }
    }
    clearInterval(this.permissionTimer);
    this.closed = true;
    supervisors.delete(this);
  }
}
