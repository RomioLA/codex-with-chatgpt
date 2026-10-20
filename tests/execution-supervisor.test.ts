import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { acquireRepositoryWriteLock } from "../src/execution/repository-write-lock.js";
import * as fullAccessCommand from "../src/execution/full-access-command.js";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import type { ExecutionJob, OutputStream } from "../src/execution/job-types.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import { setPermission } from "../src/permission/store.js";
import { makeGitRepo, makeTmpDir, write, isolateStateDir } from "./helpers.js";

interface CapturedRun {
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  completion: Promise<NativeRunnerCompletion>;
  resolve: (value: NativeRunnerCompletion) => void;
  cancelCount: number;
  abandonCount: number;
}

class ControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, CapturedRun>();

  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { callbacks, completion, resolve, cancelCount: 0, abandonCount: 0 });
    const run = this.runs.get(request.jobId)!;
    return {
      completion,
      cancel: () => { run.cancelCount += 1; },
      abandon: () => { run.abandonCount += 1; },
    };
  }

  async emit(jobId: string, stream: OutputStream, value: string): Promise<void> {
    await this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(value, "utf8"));
  }

  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"], exitCode = 0): void {
    this.runs.get(jobId)?.resolve({
      result: { outcome, exitCode, win32Error: 0 },
      helperExitCode: 0,
    });
  }
}

let workspace: Workspace;
let supervisor: ExecutionSupervisor;
let runner: ControlledRunner;

function startInput(overrides: Partial<Parameters<ExecutionSupervisor["start"]>[0]> = {}) {
  return {
    repositoryPath: ".",
    kind: "test" as const,
    target: "test",
    timeoutSeconds: 30,
    idempotencyKey: "test-key-0123456789",
    oauthClientId: "execution-test-client",
    scopes: ["execution.run"],
    ...overrides,
  };
}

function fullAccessInput(overrides: Partial<Parameters<ExecutionSupervisor["startFullAccess"]>[0]> = {}) {
  return {
    engine: "program" as const,
    executable: process.execPath,
    args: [],
    cwd: workspace.root,
    timeoutSeconds: 30,
    idempotencyKey: "full-access-test-0123456789",
    oauthClientId: "execution-test-client",
    scopes: ["execution.run"],
    ...overrides,
  };
}

async function waitForState(jobId: string, expected: ExecutionJob["state"]): Promise<ExecutionJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = supervisor.store.get(jobId);
    if (job?.state === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const actual = supervisor.store.get(jobId)?.state;
  throw new Error(`Timed out waiting for ${expected}; current state is ${actual ?? "missing"}`);
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function acquireRepositoryLockWhenAvailable(repository: ReturnType<typeof resolveRepositoryIdentity>, jobId: string): Promise<() => void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return acquireRepositoryWriteLock(repository, jobId);
    } catch (error) {
      if ((error as Error).message !== "REPOSITORY_BUSY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for repository lock release");
}

beforeEach(() => {
  isolateStateDir();
  const root = makeTmpDir("execution-supervisor");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 1" } }));
  workspace = new Workspace(root);
  setPermission(workspace.id, "level1");
  runner = new ControlledRunner();
  supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000, cancelGraceMs: 5_000 });
});

afterEach(async () => {
  for (const job of supervisor.store.listAll()) {
    if (job.state === "running" || job.state === "cancelling") runner.finish(job.jobId, 1);
  }
  await supervisor.shutdown();
});

function approveTestRecipe(): void {
  const repository = resolveRepositoryIdentity(workspace, ".");
  approveTrustedCommand({
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "test",
    target: "test",
    packageManager: "npm",
    localApproval: true,
  });
}

describe("ExecutionSupervisor", () => {
  it("requires an existing level2 grant and does not promote readonly or level1", async () => {
    setPermission(workspace.id, "readonly");
    expect(await supervisor.startFullAccess(fullAccessInput({ idempotencyKey: "full-access-readonly-0001" })))
      .toEqual({ ok: false, error: "FULL_ACCESS_REQUIRED" });
    setPermission(workspace.id, "level1");
    expect(await supervisor.startFullAccess(fullAccessInput({ idempotencyKey: "full-access-level1-00001" })))
      .toEqual({ ok: false, error: "FULL_ACCESS_REQUIRED" });
    expect(runner.runs.size).toBe(0);
  });

  it("creates repo-independent Full Access jobs and keeps idempotency and output protection", async () => {
    setPermission(workspace.id, "level2");
    const hostCwd = makeTmpDir("full-access-outside-workspace");
    const input = fullAccessInput({ cwd: hostCwd });
    const started = await supervisor.startFullAccess(input);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const jobId = started.job.jobId;
    const running = await waitForState(jobId, "running");
    expect(running).toMatchObject({
      executionContext: "host",
      repositoryIdentity: null,
      repositoryPath: null,
      recipe: null,
      authorization: { type: "full_access", permissionMode: "level2" },
      fullAccessCommand: { engine: "program", cwd: hostCwd },
    });
    expect(runner.runs.get(jobId)).toBeDefined();

    const repository = resolveRepositoryIdentity(workspace, ".");
    const unscopedProbeRelease = acquireRepositoryWriteLock(repository, "unscoped-full-access-probe");
    unscopedProbeRelease();
    expect(started.job.authorization.requestHash).toBe(createHash("sha256")
      .update(JSON.stringify({ command: started.job.fullAccessCommand, timeoutSeconds: input.timeoutSeconds }), "utf8")
      .digest("hex"));

    const duplicate = await supervisor.startFullAccess(input);
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, job: { jobId } });
    expect(await supervisor.startFullAccess({ ...input, args: ["different"] }))
      .toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });

    await runner.runs.get(jobId)!.callbacks.onOutput("stdout", Buffer.from("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"));
    await runner.runs.get(jobId)!.callbacks.onOutput("stderr", Buffer.from("-----BEGIN "));
    await runner.runs.get(jobId)!.callbacks.onOutput("stderr", Buffer.from("RSA PRIVATE KEY-----\nsecret\n"));
    runner.finish(jobId, 0);
    await waitForState(jobId, "succeeded");
    const stdout = supervisor.readOutputForClient(jobId, "execution-test-client", "stdout");
    expect(stdout.ok).toBe(true);
    if (stdout.ok) {
      expect(stdout.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(stdout.text).toContain("[REDACTED]");
    }
    expect(supervisor.readOutputForClient(jobId, "execution-test-client", "stderr"))
      .toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
  });

  it("locks scoped Full Access jobs, persists the scope, and releases the lock after completion or cancellation", async () => {
    setPermission(workspace.id, "level2");
    const repository = resolveRepositoryIdentity(workspace, ".");
    const firstKey = "full-access-scope-first-0001";
    const firstInput = fullAccessInput({
      idempotencyKey: firstKey,
      repositoryPath: ".",
    });
    const first = await supervisor.startFullAccess(firstInput);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const firstRunning = await waitForState(first.job.jobId, "running");
    const scope = { identity: repository.identity, path: repository.canonicalPath };
    expect(firstRunning).toMatchObject({ repositoryScope: scope });
    expect(first.job.authorization.requestHash).toBe(createHash("sha256")
      .update(JSON.stringify({
        command: first.job.fullAccessCommand,
        timeoutSeconds: first.job.timeoutSeconds,
        repositoryScope: scope,
      }), "utf8")
      .digest("hex"));
    expect(await supervisor.startFullAccess(firstInput))
      .toMatchObject({ ok: true, duplicate: true, job: { jobId: first.job.jobId } });
    expect(await supervisor.startFullAccess(fullAccessInput({ idempotencyKey: firstKey })))
      .toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
    expect(() => acquireRepositoryWriteLock(repository, "scoped-full-access-probe"))
      .toThrow("REPOSITORY_BUSY");

    approveTestRecipe();
    const controlled = supervisor.start(startInput({ idempotencyKey: "scoped-controlled-job-0001" }));
    expect(controlled.ok).toBe(true);
    if (!controlled.ok) throw new Error(controlled.error);
    expect(controlled.job.state).toBe("queued");

    const second = await supervisor.startFullAccess(fullAccessInput({
      idempotencyKey: "full-access-scope-second-0001",
      repositoryPath: ".",
    }));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);
    expect(second.job.state).toBe("queued");
    expect(runner.runs.size).toBe(1);

    runner.finish(first.job.jobId, 0);
    await waitForState(first.job.jobId, "succeeded");
    await waitForState(controlled.job.jobId, "running");
    const afterSuccessRelease = await acquireRepositoryLockWhenAvailable(repository, "after-scoped-success-probe");
    afterSuccessRelease();

    runner.finish(controlled.job.jobId, 0);
    await waitForState(controlled.job.jobId, "succeeded");
    await waitForState(second.job.jobId, "running");
    expect(() => acquireRepositoryWriteLock(repository, "second-scoped-full-access-probe"))
      .toThrow("REPOSITORY_BUSY");

    const cancellation = supervisor.cancel(second.job.jobId, "execution-test-client");
    expect(cancellation.ok).toBe(true);
    if (!cancellation.ok) throw new Error(cancellation.error);
    expect(cancellation.job.state).toBe("cancelling");
    runner.finish(second.job.jobId, 1);
    await waitForState(second.job.jobId, "cancelled");
    const afterCancelRelease = await acquireRepositoryLockWhenAvailable(repository, "after-scoped-cancel-probe");
    afterCancelRelease();

    const reloaded = new ExecutionJobStore(workspace.id, { directory: supervisor.store.directory });
    expect(reloaded.corruption).toBeNull();
    expect(reloaded.get(second.job.jobId)).toMatchObject({ repositoryScope: scope });
  });

  it("fails scoped Full Access closed when the repository lock is already held", async () => {
    setPermission(workspace.id, "level2");
    const repository = resolveRepositoryIdentity(workspace, ".");
    const externalRelease = acquireRepositoryWriteLock(repository, "external-lock-owner");
    try {
      const started = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-scope-busy-0001",
        repositoryPath: ".",
      }));
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      const failed = await waitForState(started.job.jobId, "failed");
      expect(failed.failureCode).toBe("REPOSITORY_BUSY");
      expect(runner.runs.size).toBe(0);
    } finally {
      externalRelease();
    }
  });

  it("releases a scoped repository lock when persisting the running transition fails", async () => {
    setPermission(workspace.id, "level2");
    const repository = resolveRepositoryIdentity(workspace, ".");
    const storePersistence = supervisor.store as unknown as { persist: () => void };
    const originalPersist = storePersistence.persist.bind(supervisor.store);
    let failedJobId: string | undefined;
    let runningPersistFailed = false;
    const persistenceSpy = vi.spyOn(storePersistence, "persist").mockImplementation(() => {
      const runningScoped = supervisor.store.listAll().some((job) => job.jobId === failedJobId && job.state === "running" &&
        "repositoryScope" in job && job.repositoryScope !== undefined);
      if (runningScoped && !runningPersistFailed) {
        runningPersistFailed = true;
        throw new Error("INJECTED_STORE_WRITE_FAILURE");
      }
      originalPersist();
    });
    try {
      const started = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-scope-write-failure-0001",
        repositoryPath: ".",
      }));
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      failedJobId = started.job.jobId;
      const failed = await waitForState(started.job.jobId, "failed");
      expect(failed.failureCode).toBe("INJECTED_STORE_WRITE_FAILURE");
      expect(runner.runs.size).toBe(0);

      const release = await acquireRepositoryLockWhenAvailable(repository, "after-scoped-write-failure-probe");
      release();
      const following = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-scope-after-write-failure-0001",
        repositoryPath: ".",
      }));
      expect(following.ok).toBe(true);
      if (!following.ok) throw new Error(following.error);
      await waitForState(following.job.jobId, "running");
      expect(runner.runs.has(started.job.jobId)).toBe(false);
      expect(runner.runs.has(following.job.jobId)).toBe(true);
      runner.finish(following.job.jobId, 0);
      await waitForState(following.job.jobId, "succeeded");
    } finally {
      persistenceSpy.mockRestore();
    }
  });

  it("releases its slot and lets the next scoped job run when RUNNING and FAILED persistence both fail", async () => {
    setPermission(workspace.id, "level2");
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const verifyRealCommand = fullAccessCommand.verifyFullAccessCommand.bind(fullAccessCommand);
    let holdNextVerification = false;
    const verifySpy = vi.spyOn(fullAccessCommand, "verifyFullAccessCommand").mockImplementation(async (command) => {
      if (holdNextVerification) {
        holdNextVerification = false;
        await verificationGate;
      }
      return verifyRealCommand(command);
    });
    let persistenceSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const occupying = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-slot-cleanup-occupy-0001",
      }));
      expect(occupying.ok).toBe(true);
      if (!occupying.ok) throw new Error(occupying.error);
      await waitForState(occupying.job.jobId, "running");

      holdNextVerification = true;
      const failing = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-slot-cleanup-fail-0001",
        repositoryPath: ".",
      }));
      expect(failing.ok).toBe(true);
      if (!failing.ok) throw new Error(failing.error);
      await waitUntil(() => verifySpy.mock.calls.length >= 2);

      const following = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-slot-cleanup-follow-0001",
        repositoryPath: ".",
      }));
      expect(following.ok).toBe(true);
      if (!following.ok) throw new Error(following.error);

      const storePersistence = supervisor.store as unknown as { persist: () => void };
      const originalPersist = storePersistence.persist.bind(supervisor.store);
      let failingWrites = 0;
      persistenceSpy = vi.spyOn(storePersistence, "persist").mockImplementation(() => {
        const job = supervisor.store.get(failing.job.jobId);
        if (failingWrites < 2 && (job?.state === "running" || job?.state === "failed")) {
          failingWrites += 1;
          throw new Error("INJECTED_RUNNING_AND_FAILED_PERSIST_FAILURE");
        }
        originalPersist();
      });

      releaseVerification();
      await waitForState(following.job.jobId, "running");
      expect(supervisor.store.get(failing.job.jobId)?.state).toBe("failed");
      expect(failingWrites).toBe(2);
      expect(runner.runs.has(failing.job.jobId)).toBe(false);
      expect(runner.runs.has(following.job.jobId)).toBe(true);
      expect(runner.runs.size).toBe(2);

      runner.finish(occupying.job.jobId, 0);
      runner.finish(following.job.jobId, 0);
      await waitForState(occupying.job.jobId, "succeeded");
      await waitForState(following.job.jobId, "succeeded");
      const afterRelease = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-slot-cleanup-after-0001",
        repositoryPath: ".",
      }));
      expect(afterRelease.ok).toBe(true);
      if (!afterRelease.ok) throw new Error(afterRelease.error);
      await waitForState(afterRelease.job.jobId, "running");
      expect(runner.runs.has(afterRelease.job.jobId)).toBe(true);
      runner.finish(afterRelease.job.jobId, 0);
      await waitForState(afterRelease.job.jobId, "succeeded");
    } finally {
      releaseVerification();
      persistenceSpy?.mockRestore();
      verifySpy.mockRestore();
    }
  });

  it("cancels a queued or running Full Access job when its level2 session grant is revoked", async () => {
    setPermission(workspace.id, "level2");
    const started = await supervisor.startFullAccess(fullAccessInput({
      idempotencyKey: "full-access-revocation-0001",
    }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await waitForState(started.job.jobId, "running");
    setPermission(workspace.id, "level1");
    supervisor.reconcilePermission();
    expect(runner.runs.get(started.job.jobId)?.cancelCount).toBe(1);
    expect(supervisor.store.get(started.job.jobId)?.state).toBe("cancelling");
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");
  });

  it("does not start a queued Full Access job cancelled while command verification is pending", async () => {
    setPermission(workspace.id, "level2");
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let holdFirstVerification = true;
    const verifySpy = vi.spyOn(fullAccessCommand, "verifyFullAccessCommand").mockImplementation(async () => {
      if (holdFirstVerification) {
        holdFirstVerification = false;
        await verificationGate;
      }
    });
    try {
      const cancelled = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-cancel-during-verify-0001",
        repositoryPath: ".",
      }));
      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) throw new Error(cancelled.error);
      await waitUntil(() => verifySpy.mock.calls.length > 0);
      expect(supervisor.store.get(cancelled.job.jobId)?.state).toBe("queued");

      expect(supervisor.cancel(cancelled.job.jobId, cancelled.job.oauthClientId)).toMatchObject({
        ok: true,
        job: { state: "cancelled" },
      });
      const following = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-after-cancel-verify-0001",
        repositoryPath: ".",
      }));
      expect(following.ok).toBe(true);
      if (!following.ok) throw new Error(following.error);

      releaseVerification();
      await waitUntil(() => supervisor.store.get(cancelled.job.jobId)?.state !== "cancelled" ||
        supervisor.store.get(following.job.jobId)?.state === "running");
      expect(supervisor.store.get(cancelled.job.jobId)?.state).toBe("cancelled");
      expect(runner.runs.has(cancelled.job.jobId)).toBe(false);
      await waitForState(following.job.jobId, "running");
      expect(runner.runs.has(following.job.jobId)).toBe(true);
    } finally {
      releaseVerification();
      verifySpy.mockRestore();
    }
  });

  it.each([
    ["validation rejects after cancellation", "cancel-then-reject"],
    ["validation reject and cancellation settle in the same turn", "reject-then-cancel"],
  ] as const)("preserves a queued cancellation when %s", async (_label, order) => {
    setPermission(workspace.id, "level2");
    const occupying = await supervisor.startFullAccess(fullAccessInput({
      idempotencyKey: `full-access-cancel-reject-occupy-${order}-0001`,
    }));
    expect(occupying.ok).toBe(true);
    if (!occupying.ok) throw new Error(occupying.error);
    await waitForState(occupying.job.jobId, "running");

    let rejectVerification!: (error: Error) => void;
    const verificationGate = new Promise<void>((_resolve, reject) => { rejectVerification = reject; });
    let signalVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { signalVerificationStarted = resolve; });
    const verifyRealCommand = fullAccessCommand.verifyFullAccessCommand.bind(fullAccessCommand);
    let holdNextVerification = true;
    const verifySpy = vi.spyOn(fullAccessCommand, "verifyFullAccessCommand").mockImplementation(async (command) => {
      if (holdNextVerification) {
        holdNextVerification = false;
        signalVerificationStarted();
        await verificationGate;
      }
      return verifyRealCommand(command);
    });

    try {
      const cancelled = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: `full-access-cancel-reject-target-${order}-0001`,
        repositoryPath: ".",
      }));
      expect(cancelled.ok).toBe(true);
      if (!cancelled.ok) throw new Error(cancelled.error);
      await verificationStarted;

      if (order === "reject-then-cancel") rejectVerification(new Error("INJECTED_VALIDATION_REJECT"));
      const cancellation = supervisor.cancel(cancelled.job.jobId, cancelled.job.oauthClientId);
      expect(cancellation).toMatchObject({ ok: true, job: { state: "cancelled", failureCode: "CANCELLED_BEFORE_START" } });
      const cancelledSnapshot = supervisor.store.get(cancelled.job.jobId)!;
      if (order === "cancel-then-reject") rejectVerification(new Error("INJECTED_VALIDATION_REJECT"));

      const repository = resolveRepositoryIdentity(workspace, ".");
      const lockProbeRelease = acquireRepositoryWriteLock(repository, `cancelled-lock-probe-${order}`);
      lockProbeRelease();

      const following = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: `full-access-cancel-reject-follow-${order}-0001`,
        repositoryPath: ".",
      }));
      expect(following.ok).toBe(true);
      if (!following.ok) throw new Error(following.error);

      await waitForState(following.job.jobId, "running");
      const finalCancelled = supervisor.store.get(cancelled.job.jobId);
      expect(finalCancelled).toMatchObject({
        state: "cancelled",
        failureCode: cancelledSnapshot.failureCode,
        finishedAt: cancelledSnapshot.finishedAt,
      });
      expect(runner.runs.has(cancelled.job.jobId)).toBe(false);
      expect(runner.runs.has(following.job.jobId)).toBe(true);

      runner.finish(following.job.jobId, 0);
      await waitForState(following.job.jobId, "succeeded");
      const afterRelease = await acquireRepositoryLockWhenAvailable(repository, `cancelled-lock-after-${order}`);
      afterRelease();

      runner.finish(occupying.job.jobId, 0);
      await waitForState(occupying.job.jobId, "succeeded");
    } finally {
      rejectVerification(new Error("TEST_CLEANUP"));
      verifySpy.mockRestore();
    }
  });

  it("still fails a queued Full Access job when command verification rejects without cancellation", async () => {
    setPermission(workspace.id, "level2");
    const occupying = await supervisor.startFullAccess(fullAccessInput({
      idempotencyKey: "full-access-validation-reject-occupy-0001",
    }));
    expect(occupying.ok).toBe(true);
    if (!occupying.ok) throw new Error(occupying.error);
    await waitForState(occupying.job.jobId, "running");

    let rejectVerification!: (error: Error) => void;
    const verificationGate = new Promise<void>((_resolve, reject) => { rejectVerification = reject; });
    let signalVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => { signalVerificationStarted = resolve; });
    const verifyRealCommand = fullAccessCommand.verifyFullAccessCommand.bind(fullAccessCommand);
    let holdNextVerification = true;
    const verifySpy = vi.spyOn(fullAccessCommand, "verifyFullAccessCommand").mockImplementation(async (command) => {
      if (holdNextVerification) {
        holdNextVerification = false;
        signalVerificationStarted();
        await verificationGate;
      }
      return verifyRealCommand(command);
    });

    try {
      const failing = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-validation-reject-target-0001",
        repositoryPath: ".",
      }));
      expect(failing.ok).toBe(true);
      if (!failing.ok) throw new Error(failing.error);
      await verificationStarted;
      const following = await supervisor.startFullAccess(fullAccessInput({
        idempotencyKey: "full-access-validation-reject-follow-0001",
        repositoryPath: ".",
      }));
      expect(following.ok).toBe(true);
      if (!following.ok) throw new Error(following.error);

      rejectVerification(new Error("INJECTED_VALIDATION_REJECT"));
      const failed = await waitForState(failing.job.jobId, "failed");
      expect(failed.failureCode).toBe("INJECTED_VALIDATION_REJECT");
      expect(runner.runs.has(failing.job.jobId)).toBe(false);
      await waitForState(following.job.jobId, "running");
      expect(runner.runs.has(following.job.jobId)).toBe(true);

      runner.finish(following.job.jobId, 0);
      await waitForState(following.job.jobId, "succeeded");
      const repository = resolveRepositoryIdentity(workspace, ".");
      const afterRelease = await acquireRepositoryLockWhenAvailable(repository, "validation-reject-lock-probe");
      afterRelease();

      runner.finish(occupying.job.jobId, 0);
      await waitForState(occupying.job.jobId, "succeeded");
    } finally {
      rejectVerification(new Error("TEST_CLEANUP"));
      verifySpy.mockRestore();
    }
  });

  it("requires local trust, scopes idempotency by client, and prevents cross-client ownership", async () => {
    const input = startInput();
    expect(supervisor.start(input)).toEqual({ ok: false, error: "COMMAND_NOT_APPROVED" });
    approveTestRecipe();

    const started = supervisor.start(input);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    expect(started.job.state).toBe("running");
    expect(supervisor.start(input)).toMatchObject({ ok: true, duplicate: true, job: { jobId: started.job.jobId } });
    expect(supervisor.start(startInput({ timeoutSeconds: 29 }))).toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
    expect(supervisor.getForClient(started.job.jobId, "another-client")).toBeNull();
    expect(supervisor.listForClient("another-client")).toEqual([]);

    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");
  });

  it("flushes stdout and stderr tails before completing a job", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-complete-0123456" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stdout", "stdout-final-fragment");
    await runner.emit(started.job.jobId, "stderr", "stderr-final-fragment");

    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");

    expect(supervisor.store.readOutput(started.job.jobId, "stdout")).toMatchObject({ ok: true, eof: true, text: "stdout-final-fragment" });
    expect(supervisor.store.readOutput(started.job.jobId, "stderr")).toMatchObject({ ok: true, eof: true, text: "stderr-final-fragment" });
  });

  it("waits for an in-flight output callback and flushes it before completion", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-racing-output-0123" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const payload = "p".repeat(512 * 1024);
    const outputPending = runner.emit(started.job.jobId, "stdout", payload);
    runner.finish(started.job.jobId, 0, 0);

    await waitForState(started.job.jobId, "succeeded");
    await outputPending;
    expect(supervisor.store.get(started.job.jobId)?.stdout.totalBytes).toBe(payload.length);
    expect(supervisor.store.readOutput(started.job.jobId, "stdout", 0)).toMatchObject({
      ok: true,
      text: "p".repeat(64 * 1024),
    });
    expect(supervisor.store.readOutput(started.job.jobId, "stdout", payload.length - 32, 32)).toMatchObject({
      ok: true,
      eof: true,
      text: "p".repeat(32),
    });
  });

  it("flushes accepted output when a running job is cancelled", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-cancel-0123456" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stdout", "cancel-final-fragment");

    expect(supervisor.cancel(started.job.jobId, "execution-test-client").ok).toBe(true);
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");

    expect(supervisor.store.readOutput(started.job.jobId, "stdout")).toMatchObject({ ok: true, eof: true, text: "cancel-final-fragment" });
  });

  it("flushes accepted output before shutdown completes", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-shutdown-012345" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stderr", "shutdown-final-fragment");

    const shuttingDown = supervisor.shutdown();
    runner.finish(started.job.jobId, 1);
    await shuttingDown;

    expect(supervisor.store.readOutput(started.job.jobId, "stderr")).toMatchObject({ ok: true, eof: true, text: "shutdown-final-fragment" });
  });

  it("rejects a package script after its approved content changes", () => {
    approveTestRecipe();
    const root = workspace.root;
    write(root, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 2" } }));
    expect(supervisor.start(startInput({ idempotencyKey: "changed-key-0123456789" }))).toEqual({
      ok: false,
      error: "COMMAND_NOT_APPROVED",
    });
  });

  it("runs a separately approved nested repository and rejects a junction path", async () => {
    const nested = path.join(workspace.root, "nested-project");
    fs.mkdirSync(nested);
    makeGitRepo(nested);
    write(nested, "package.json", JSON.stringify({ name: "nested-fixture", scripts: { test: "node -e 1" } }));
    const repository = resolveRepositoryIdentity(workspace, "nested-project");
    approveTrustedCommand({
      workspaceId: workspace.id,
      repositoryIdentity: repository.identity,
      canonicalRepositoryPath: repository.canonicalPath,
      kind: "test",
      target: "test",
      packageManager: "npm",
      localApproval: true,
    });

    const started = supervisor.start(startInput({ repositoryPath: "nested-project" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");

    fs.symlinkSync(nested, path.join(workspace.root, "nested-alias"), "junction");
    expect(supervisor.start(startInput({ repositoryPath: "nested-alias", idempotencyKey: "junction-key-0123456789" }))).toEqual({
      ok: false,
      error: "REPARSE_POINT",
    });
  });

  it("does not preserve trust when a different repository replaces the approved path", () => {
    approveTestRecipe();
    const originalPath = workspace.root;
    fs.renameSync(originalPath, `${originalPath}-preserved`);
    fs.mkdirSync(originalPath);
    makeGitRepo(originalPath);
    write(originalPath, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 1" } }));

    expect(supervisor.start(startInput({ idempotencyKey: "replacement-key-012345" }))).toEqual({
      ok: false,
      error: "COMMAND_NOT_APPROVED",
    });
  });

  it("stops starts after permission downgrade and reconciles a running job through cancellation", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    setPermission(workspace.id, "readonly");
    supervisor.reconcilePermission();
    expect(runner.runs.get(started.job.jobId)?.cancelCount).toBe(1);
    expect(supervisor.start(startInput({ idempotencyKey: "readonly-key-0123456" }))).toEqual({
      ok: false,
      error: "EXECUTION_PERMISSION_DENIED",
    });
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");
  });

  it("lets a timeout win when it races a pending client cancellation", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ timeoutSeconds: 1 }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    expect(supervisor.cancel(started.job.jobId, "execution-test-client").ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "timed_out");
  });
});
