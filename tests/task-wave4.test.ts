import path from "node:path";
import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { ExecutionJobStore, JOB_RETENTION_MS } from "../src/execution/job-store.js";
import { archivedIdempotencyKey, archiveRecord, DEFAULT_ARCHIVE_RECORD_OPERATIONS, readArchivedRecord } from "../src/execution/record-archive.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import type { NativeRunnerCompletion, NativeRunnerHandle, NativeRunnerRequest } from "../src/execution/native-runner.js";
import { atomicReplace as replaceFileAtomic } from "../src/execution/atomic-replace.js";
import { readAuthorizationEpoch, readCurrentSessionGrant, setPermission } from "../src/permission/store.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { TaskSupervisor } from "../src/tasks/task-supervisor.js";
import {
  bindTaskExecutionChild,
  checkpointTaskExecution,
  observeTaskExecutionChild,
  prepareTaskExecutionDispatch,
} from "../src/tasks/task-journal.js";
import { transitionTask } from "../src/tasks/task-state-machine.js";
import { canonicalizeTaskResult, createChildIdempotencyKey, type PersistentTaskPlan } from "../src/tasks/task-types.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

interface ControlledRun {
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  resolve: (value: NativeRunnerCompletion) => void;
}

class ControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, ControlledRun>();
  start(request: NativeRunnerRequest, callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { callbacks, resolve });
    return { completion, cancel: () => undefined, abandon: () => undefined };
  }
  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"] = 0, exitCode = 0): void {
    this.runs.get(jobId)?.resolve({ result: { outcome, exitCode, win32Error: 0 }, helperExitCode: 0, tempCleanupConfirmed: true });
  }
}

let workspace: Workspace;
let runner: ControlledRunner;
let executionSupervisor: ExecutionSupervisor;
let taskStore: TaskStore;
let taskSupervisor: TaskSupervisor;
let extraTaskSupervisors: TaskSupervisor[];
let extraExecutionSupervisors: ExecutionSupervisor[];
let nextKey = 0;

function storeAt(directory = path.join(makeTmpDir("wave4-task-store"), "tasks")): TaskStore {
  return new TaskStore(workspace.id, {
    directory,
    atomicReplace(source, destination, expectedNewHash) {
      replaceFileAtomic(source, destination, { expectedNewHash });
    },
  });
}

function executionPlan(stepIds = ["command"]): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: 60_000,
    steps: stepIds.map((stepId) => ({
      stepId,
      kind: "execution" as const,
      command: { engine: "program" as const, executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: workspace.root },
      timeoutSeconds: 30,
    })),
  };
}

function readThenAssertPlan(): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: 60_000,
    steps: [
      { stepId: "read", kind: "batch_read", request: { items: [{ id: "hello", path: "hello.txt" }] } },
      { stepId: "assert", kind: "assertion", sourceStepId: "read", jsonPointer: "/value", operator: "equals", expected: "ok" },
    ],
  };
}

function nextTimestamp(task: { updatedAt: string }, ms = 10): string {
  return new Date(Date.parse(task.updatedAt) + ms).toISOString();
}

function createExecutionTask(plan = executionPlan()) {
  return taskSupervisor.create({
    ownerClientId: "wave4-task-owner",
    idempotencyKey: `wave4-task-idempotency-${++nextKey}`.padEnd(24, "0"),
    scopes: ["execution.run"],
    plan,
  }).task;
}

function createReadTask(plan: PersistentTaskPlan, supervisor = taskSupervisor) {
  return supervisor.create({
    ownerClientId: "wave4-read-owner",
    idempotencyKey: `wave4-read-idempotency-${++nextKey}`.padEnd(24, "0"),
    scopes: ["workspace.read"],
    plan,
  }).task;
}

async function persistPreparedAndStartChild(task: ReturnType<typeof createExecutionTask>, stepId = "command") {
  const stepIndex = task.plan.steps.findIndex((step) => step.stepId === stepId);
  const step = task.plan.steps[stepIndex];
  if (!step || step.kind !== "execution") throw new Error("TEST_STEP_NOT_EXECUTION");
  const running = transitionTask(task, "RUNNING", { currentStep: stepIndex }, nextTimestamp(task));
  taskStore.replace(running);
  const prepared = prepareTaskExecutionDispatch(running, stepId, 1, nextTimestamp(running));
  taskStore.replace(prepared.task);
  const grant = readCurrentSessionGrant(workspace.id)!;
  const started = await executionSupervisor.startFullAccess({
    ...step.command,
    timeoutSeconds: step.timeoutSeconds,
    idempotencyKey: prepared.entry.childIdempotencyKey,
    oauthClientId: task.ownerClientId,
    scopes: task.authBinding.requiredScopes,
    ...(step.repositoryPath === undefined ? {} : { repositoryPath: step.repositoryPath }),
  }, grant);
  if (!started.ok) throw new Error(started.error);
  try {
    await waitUntil(() => runner.runs.has(started.job.jobId));
  } catch {
    const current = executionSupervisor.store.get(started.job.jobId);
    throw new Error(`TEST_CHILD_START_TIMEOUT:${current?.state ?? "MISSING"}:${current?.failureCode ?? "NONE"}`);
  }
  return { prepared, started };
}

async function createArchivedPreparedChild() {
  const task = createExecutionTask();
  const { prepared, started } = await persistPreparedAndStartChild(task);
  runner.finish(started.job.jobId, 0, 0);
  await waitUntil(() => executionSupervisor.store.get(started.job.jobId)?.state === "succeeded");
  const terminal = executionSupervisor.store.get(started.job.jobId);
  if (!terminal) throw new Error("TEST_ARCHIVED_CHILD_DISAPPEARED");
  executionSupervisor.store.replace({
    ...terminal,
    createdAt: new Date(Date.now() - JOB_RETENTION_MS - 1).toISOString(),
  });
  executionSupervisor.store.prepareCapacity();
  const archived = executionSupervisor.store.get(started.job.jobId);
  if (!archived) throw new Error("TEST_ARCHIVED_CHILD_MISSING");
  return {
    task,
    prepared,
    started,
    archived,
    taskDirectory: taskStore.directory,
    jobDirectory: executionSupervisor.store.directory,
  };
}

async function recreateTaskRuntime(taskDirectory: string, jobDirectory: string) {
  await taskSupervisor.shutdown();
  await executionSupervisor.shutdown();
  const reloadedJobs = new ExecutionJobStore(workspace.id, { directory: jobDirectory });
  const restartedExecution = new ExecutionSupervisor(workspace, {
    store: reloadedJobs,
    runner,
    permissionPollMs: 60_000,
  });
  extraExecutionSupervisors.push(restartedExecution);
  const reloadedTasks = storeAt(taskDirectory);
  const restartedTasks = new TaskSupervisor(workspace, reloadedTasks, restartedExecution, {
    requireRecovery: true,
    pollIntervalMs: 5,
  });
  extraTaskSupervisors.push(restartedTasks);
  return { reloadedJobs, reloadedTasks, restartedTasks };
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("TASK_WAVE4_TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  isolateStateDir();
  const root = makeTmpDir("task-wave4-workspace");
  makeGitRepo(root);
  write(root, "hello.txt", "read-only content\n");
  workspace = new Workspace(root);
  setPermission(workspace.id, "level2");
  runner = new ControlledRunner();
  executionSupervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000, cancelGraceMs: 100 });
  taskStore = storeAt(path.join(makeTmpDir("wave4-primary-store"), "tasks"));
  taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor, { pollIntervalMs: 5 });
  extraTaskSupervisors = [];
  extraExecutionSupervisors = [];
  nextKey = 0;
});

afterEach(async () => {
  for (const job of executionSupervisor.store.listAll()) {
    if (["queued", "running", "cancelling"].includes(job.state)) runner.finish(job.jobId, 1, 1);
  }
  for (const supervisor of extraExecutionSupervisors) {
    for (const job of supervisor.store.listAll()) {
      if (["queued", "running", "cancelling"].includes(job.state)) runner.finish(job.jobId, 1, 1);
    }
  }
  await Promise.allSettled([
    executionSupervisor.shutdown(),
    ...extraExecutionSupervisors.map((supervisor) => supervisor.shutdown()),
  ]);
  await Promise.allSettled([
    taskSupervisor.shutdown(),
    ...extraTaskSupervisors.map((supervisor) => supervisor.shutdown()),
  ]);
});

describe("Task restart, retry, authorization, and cancellation", () => {
  it("resumes after a durable pure-step checkpoint loaded from a recreated TaskStore", async () => {
    const task = createReadTask(readThenAssertPlan());
    const running = transitionTask(task, "RUNNING", { currentStep: 0 }, task.updatedAt);
    const value = canonicalizeTaskResult({ value: "ok" });
    const checkpointAt = running.updatedAt;
    const checkpointed = {
      ...running,
      currentStep: 1,
      stepStates: [
        { stepId: "read", state: "succeeded" as const, attemptCount: 1 },
        { stepId: "assert", state: "pending" as const, attemptCount: 0 },
      ],
      checkpoints: [{ stepId: "read", completedAt: checkpointAt, ...value }],
      updatedAt: checkpointAt,
    };
    taskStore.replace(checkpointed);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    await waitUntil(() => ["COMPLETED", "FAILED", "WAITING_FOR_MODEL"].includes(reloaded.get(task.taskId)?.state ?? ""));
    expect(reloaded.get(task.taskId)?.state).toBe("COMPLETED");
    expect(reloaded.get(task.taskId)?.checkpoints[0]?.result).toEqual({ value: "ok" });
    expect(executionSupervisor.store.listAll()).toHaveLength(0);
  });

  it("recovers PREPARED with no child and dispatches exactly the same persisted child key", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 });
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1);
    taskStore.replace(prepared.task);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();
    fs.mkdirSync(path.join(executionSupervisor.store.directory, ".archive", "jobs"), { recursive: true });

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true, pollIntervalMs: 5 });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    const resumed = restarted.run(task.taskId, task.ownerClientId);
    await waitUntil(() => reloaded.get(task.taskId)?.dispatchJournal[0]?.phase === "CHILD_BOUND" ||
      ["FAILED", "WAITING_FOR_MODEL", "INTERRUPTED"].includes(reloaded.get(task.taskId)?.state ?? ""));
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.phase, JSON.stringify({
      task: reloaded.get(task.taskId),
      jobs: executionSupervisor.store.listAll(),
      runIds: [...runner.runs.keys()],
    })).toBe("CHILD_BOUND");
    const child = executionSupervisor.store.listAll();
    expect(child).toHaveLength(1);
    expect(child[0]?.idempotencyKeyHash).toBe(createHash("sha256").update(prepared.entry.childIdempotencyKey).digest("hex"));
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.childJobId).toBe(child[0]?.jobId);

    await waitUntil(() => runner.runs.has(child[0]!.jobId));
    runner.finish(child[0]!.jobId);
    expect((await resumed).state).toBe("COMPLETED");
  });

  it("reconciles PREPARED with a matching persisted job without creating a duplicate", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 });
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1);
    taskStore.replace(prepared.task);
    const grant = readCurrentSessionGrant(workspace.id)!;
    const started = await executionSupervisor.startFullAccess({
      ...executionPlan().steps[0]!.command,
      timeoutSeconds: 30,
      idempotencyKey: prepared.entry.childIdempotencyKey,
      oauthClientId: task.ownerClientId,
      scopes: task.authBinding.requiredScopes,
    }, grant);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    const directory = taskStore.directory;
    await taskSupervisor.shutdown();
    fs.mkdirSync(path.join(executionSupervisor.store.directory, ".archive", "jobs"), { recursive: true });
    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true, pollIntervalMs: 5 });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    await waitUntil(() => reloaded.get(task.taskId)?.dispatchJournal[0]?.phase === "CHILD_BOUND");
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.childJobId).toBe(started.job.jobId);
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
    await waitUntil(() => runner.runs.has(started.job.jobId));
    runner.finish(started.job.jobId);
    await waitUntil(() => reloaded.get(task.taskId)?.state === "COMPLETED");
  });

  it("reuses an archived PREPARED child record when its idempotency pointer is missing", async () => {
    const fixture = await createArchivedPreparedChild();
    const keyHash = createHash("sha256").update(fixture.prepared.entry.childIdempotencyKey).digest("hex");
    const pointerKey = archivedIdempotencyKey(fixture.task.ownerClientId, keyHash);
    const pointer = path.join(fixture.jobDirectory, ".archive", "idempotency", pointerKey.slice(0, 2), `${pointerKey}.json`);
    const isolatedPointer = `${pointer}.isolated`;
    await taskSupervisor.shutdown();
    await executionSupervisor.shutdown();
    fs.renameSync(pointer, isolatedPointer);

    try {
      const reloadedJobs = new ExecutionJobStore(workspace.id, { directory: fixture.jobDirectory });
      const restartedExecution = new ExecutionSupervisor(workspace, { store: reloadedJobs, runner, permissionPollMs: 60_000 });
      extraExecutionSupervisors.push(restartedExecution);
      const reloadedTasks = storeAt(fixture.taskDirectory);
      const restartedTasks = new TaskSupervisor(workspace, reloadedTasks, restartedExecution, { requireRecovery: true });
      extraTaskSupervisors.push(restartedTasks);
      await restartedTasks.recover();

      const recovered = reloadedTasks.get(fixture.task.taskId);
      expect(recovered?.state).toBe("COMPLETED");
      expect(recovered?.dispatchJournal[0]).toMatchObject({
        childJobId: fixture.started.job.jobId,
        childIdempotencyKey: fixture.prepared.entry.childIdempotencyKey,
        phase: "CHECKPOINTED",
      });
      expect(runner.runs.size).toBe(1);
      expect(reloadedJobs.listAll()).toHaveLength(0);
    } finally {
      fs.renameSync(isolatedPointer, pointer);
    }
  });

  for (const failurePoint of ["record", "pointer"] as const) {
  it(`recovers PREPARED when archive ${failurePoint} publish fails`, async () => {
    const taskDirectory = path.join(makeTmpDir("wave4-archive-publish-failure-task"), "tasks");
    const jobDirectory = makeTmpDir("wave4-archive-publish-failure-jobs");
    let failArchivePublish = false;
    const jobStore = new ExecutionJobStore(workspace.id, {
      directory: jobDirectory,
      archiveOperations: {
        ...DEFAULT_ARCHIVE_RECORD_OPERATIONS,
        publish(source, destination, expectedHash) {
          const failingDestination = failurePoint === "record"
            ? destination.includes(`${path.sep}jobs${path.sep}`)
            : destination.includes(`${path.sep}idempotency${path.sep}`);
          if (failArchivePublish && failingDestination) {
            throw new Error(failurePoint === "record" ? "INJECT_ARCHIVE_PUBLISH_FAILURE" : "INJECT_ARCHIVE_POINTER_PUBLISH_FAILURE");
          }
          DEFAULT_ARCHIVE_RECORD_OPERATIONS.publish(source, destination, expectedHash);
        },
      },
    });
    const persistentTasks = storeAt(taskDirectory);
    const archiveFailureExecution = new ExecutionSupervisor(workspace, {
      store: jobStore,
      runner,
      permissionPollMs: 60_000,
    });
    const archiveFailureTasks = new TaskSupervisor(workspace, persistentTasks, archiveFailureExecution);
    extraExecutionSupervisors.push(archiveFailureExecution);
    extraTaskSupervisors.push(archiveFailureTasks);

    const ownerClientId = "wave4-archive-publish-failure-owner";
    const plan = executionPlan();
    const created = archiveFailureTasks.create({
      ownerClientId,
      idempotencyKey: "wave4-archive-publish-failure-0001",
      scopes: ["execution.run"],
      plan,
    });
    const running = transitionTask(created.task, "RUNNING", { currentStep: 0 }, nextTimestamp(created.task));
    persistentTasks.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1, nextTimestamp(running));
    persistentTasks.replace(prepared.task);
    const grant = readCurrentSessionGrant(workspace.id)!;
    const started = await archiveFailureExecution.startFullAccess({
      ...plan.steps[0]!.command,
      timeoutSeconds: plan.steps[0]!.timeoutSeconds,
      idempotencyKey: prepared.entry.childIdempotencyKey,
      oauthClientId: ownerClientId,
      scopes: created.task.authBinding.requiredScopes,
    }, grant);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await waitUntil(() => runner.runs.has(started.job.jobId));
    runner.finish(started.job.jobId);
    await waitUntil(() => jobStore.get(started.job.jobId)?.state === "succeeded");

    const terminal = jobStore.get(started.job.jobId)!;
    failArchivePublish = true;
    expect(() => jobStore.replace({
      ...terminal,
      createdAt: new Date(Date.now() - JOB_RETENTION_MS - 1).toISOString(),
    })).toThrow(failurePoint === "record" ? "INJECT_ARCHIVE_PUBLISH_FAILURE" : "INJECT_ARCHIVE_POINTER_PUBLISH_FAILURE");
    failArchivePublish = false;
    if (failurePoint === "record") {
      expect(readArchivedRecord(jobDirectory, "jobs", started.job.jobId)).toBeNull();
    } else {
      expect(readArchivedRecord(jobDirectory, "jobs", started.job.jobId)).toMatchObject({ jobId: started.job.jobId });
      expect(readArchivedRecord(jobDirectory, "idempotency", archivedIdempotencyKey(
        ownerClientId,
        createHash("sha256").update(prepared.entry.childIdempotencyKey).digest("hex"),
      ))).toBeNull();
    }
    expect(jobStore.get(started.job.jobId)).toMatchObject({ jobId: started.job.jobId, state: "succeeded" });
    expect(jobStore.lookupIdempotentForReconciliation(ownerClientId,
      createHash("sha256").update(prepared.entry.childIdempotencyKey).digest("hex"))).toMatchObject({
      kind: "found",
      job: { jobId: started.job.jobId },
    });

    await archiveFailureTasks.shutdown();
    await archiveFailureExecution.shutdown();
    const reloadedTasks = storeAt(taskDirectory);
    const reloadedJobs = new ExecutionJobStore(workspace.id, { directory: jobDirectory });
    const restartedExecution = new ExecutionSupervisor(workspace, { store: reloadedJobs, runner, permissionPollMs: 60_000 });
    const restartedTasks = new TaskSupervisor(workspace, reloadedTasks, restartedExecution, { requireRecovery: true });
    extraExecutionSupervisors.push(restartedExecution);
    extraTaskSupervisors.push(restartedTasks);
    await restartedTasks.recover();

    expect(reloadedTasks.get(created.task.taskId)).toMatchObject({
      state: "COMPLETED",
      dispatchJournal: [{
        stepId: "command",
        childIdempotencyKey: prepared.entry.childIdempotencyKey,
        childJobId: started.job.jobId,
        phase: "CHECKPOINTED",
      }],
    });
    expect(reloadedJobs.listAll().map((job) => job.jobId)).toEqual([started.job.jobId]);
    expect(runner.runs.size).toBe(1);
  });
  }

  it("fails closed on corrupt archived child records without dispatching", async () => {
    const fixture = await createArchivedPreparedChild();
    const jobRecord = path.join(fixture.jobDirectory, ".archive", "jobs", fixture.started.job.jobId.slice(0, 2), `${fixture.started.job.jobId}.json`);
    fs.writeFileSync(jobRecord, "{corrupt archive record");
    const { reloadedTasks, restartedTasks } = await recreateTaskRuntime(fixture.taskDirectory, fixture.jobDirectory);
    await restartedTasks.recover();

    expect(reloadedTasks.get(fixture.task.taskId)).toMatchObject({
      state: "WAITING_FOR_MODEL",
      waitingReason: "ARCHIVE_CORRUPT",
    });
    expect(runner.runs.size).toBe(1);
  });

  it("fails closed when the authoritative archive catalog is incomplete", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 }, nextTimestamp(task));
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1, nextTimestamp(running));
    taskStore.replace(prepared.task);
    const taskDirectory = taskStore.directory;
    const jobDirectory = executionSupervisor.store.directory;
    expect(fs.existsSync(path.join(jobDirectory, ".archive", "jobs"))).toBe(false);

    const { reloadedJobs, reloadedTasks, restartedTasks } = await recreateTaskRuntime(taskDirectory, jobDirectory);
    await restartedTasks.recover();

    expect(reloadedTasks.get(task.taskId)).toMatchObject({
      state: "WAITING_FOR_MODEL",
      waitingReason: "ARCHIVE_DIRECTORY_MISSING",
      dispatchJournal: [{
        stepId: "command",
        childIdempotencyKey: prepared.entry.childIdempotencyKey,
        phase: "PREPARED",
      }],
    });
    expect(reloadedJobs.listAll()).toEqual([]);
    expect(runner.runs.size).toBe(0);
  });

  it("fails closed when duplicate archived children share a PREPARED key", async () => {
    const fixture = await createArchivedPreparedChild();
    const duplicate = { ...fixture.archived, jobId: randomBytes(24).toString("base64url") };
    archiveRecord(fixture.jobDirectory, "jobs", duplicate.jobId, duplicate);
    const { reloadedTasks, restartedTasks } = await recreateTaskRuntime(fixture.taskDirectory, fixture.jobDirectory);
    await restartedTasks.recover();

    expect(reloadedTasks.get(fixture.task.taskId)).toMatchObject({
      state: "WAITING_FOR_MODEL",
      waitingReason: "CONFLICTING_CHILD_RECORDS",
    });
    expect(runner.runs.size).toBe(1);
  });

  it("fails closed when an archive pointer targets a different owner and key", async () => {
    const fixture = await createArchivedPreparedChild();
    const keyHash = createHash("sha256").update(fixture.prepared.entry.childIdempotencyKey).digest("hex");
    const pointerKey = archivedIdempotencyKey(fixture.task.ownerClientId, keyHash);
    const pointer = path.join(fixture.jobDirectory, ".archive", "idempotency", pointerKey.slice(0, 2), `${pointerKey}.json`);
    const originalPointer = `${pointer}.original`;
    const misplacedPointer = `${pointer}.misplaced`;
    fs.renameSync(pointer, originalPointer);
    const unrelated = {
      ...fixture.archived,
      jobId: randomBytes(24).toString("base64url"),
      oauthClientId: "different-archive-owner",
      idempotencyKeyHash: "9".repeat(64),
    };
    archiveRecord(fixture.jobDirectory, "jobs", unrelated.jobId, unrelated);
    archiveRecord(fixture.jobDirectory, "idempotency", pointerKey, { workspaceId: workspace.id, jobId: unrelated.jobId });

    try {
      const { reloadedTasks, restartedTasks } = await recreateTaskRuntime(fixture.taskDirectory, fixture.jobDirectory);
      await restartedTasks.recover();
      expect(reloadedTasks.get(fixture.task.taskId)).toMatchObject({
        state: "WAITING_FOR_MODEL",
        waitingReason: "ARCHIVE_POINTER_MISMATCH",
      });
      expect(runner.runs.size).toBe(1);
    } finally {
      fs.renameSync(pointer, misplacedPointer);
      fs.renameSync(originalPointer, pointer);
    }
  });

  it("fails closed when an archive pointer targets a missing job record", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 }, nextTimestamp(task));
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1, nextTimestamp(running));
    taskStore.replace(prepared.task);
    const keyHash = createHash("sha256").update(prepared.entry.childIdempotencyKey).digest("hex");
    const jobDirectory = executionSupervisor.store.directory;
    fs.mkdirSync(path.join(jobDirectory, ".archive", "jobs"), { recursive: true });
    archiveRecord(jobDirectory, "idempotency", archivedIdempotencyKey(task.ownerClientId, keyHash), {
      workspaceId: workspace.id,
      jobId: randomBytes(24).toString("base64url"),
    });

    const { reloadedTasks, restartedTasks } = await recreateTaskRuntime(taskStore.directory, jobDirectory);
    await restartedTasks.recover();

    expect(reloadedTasks.get(task.taskId)).toMatchObject({
      state: "WAITING_FOR_MODEL",
      waitingReason: "ARCHIVE_POINTER_MISMATCH",
      dispatchJournal: [{
        stepId: "command",
        childIdempotencyKey: prepared.entry.childIdempotencyKey,
        phase: "PREPARED",
      }],
    });
    expect(runner.runs.size).toBe(0);
  });

  it("fails closed when multiple persisted child jobs share a PREPARED idempotency key", async () => {
    const task = createExecutionTask();
    const { started } = await persistPreparedAndStartChild(task);
    runner.finish(started.job.jobId, 0, 1);
    await waitUntil(() => executionSupervisor.store.get(started.job.jobId)?.state === "failed");
    const original = executionSupervisor.store.get(started.job.jobId)!;
    executionSupervisor.store.create({
      ...original,
      jobId: randomBytes(24).toString("base64url"),
    });

    const taskDirectory = taskStore.directory;
    const jobDirectory = executionSupervisor.store.directory;
    await taskSupervisor.shutdown();
    await executionSupervisor.shutdown();

    const reloadedJobs = new ExecutionJobStore(workspace.id, { directory: jobDirectory });
    const restartedExecution = new ExecutionSupervisor(workspace, { store: reloadedJobs, runner, permissionPollMs: 60_000 });
    extraExecutionSupervisors.push(restartedExecution);
    const reloadedTasks = storeAt(taskDirectory);
    const restartedTasks = new TaskSupervisor(workspace, reloadedTasks, restartedExecution, {
      requireRecovery: true,
      pollIntervalMs: 5,
    });
    extraTaskSupervisors.push(restartedTasks);
    await restartedTasks.recover();

    expect(reloadedTasks.get(task.taskId)?.state).toBe("WAITING_FOR_MODEL");
    expect(reloadedTasks.get(task.taskId)?.waitingReason).toBe("CONFLICTING_CHILD_RECORDS");
    expect(reloadedJobs.listAll()).toHaveLength(2);
    expect(runner.runs.size).toBe(1);
  });

  it("resumes a CHILD_BOUND running child after reloading TaskStore without creating another job", async () => {
    const task = createExecutionTask();
    const { started, prepared } = await persistPreparedAndStartChild(task);
    const bound = bindTaskExecutionChild(prepared.task, "command", started.job.jobId, nextTimestamp(prepared.task));
    taskStore.replace(bound);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true, pollIntervalMs: 5 });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    const resumed = restarted.run(task.taskId, task.ownerClientId);
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
    runner.finish(started.job.jobId);
    expect((await resumed).state).toBe("COMPLETED");
  });

  it("reconciles a CHILD_BOUND terminal record into OBSERVED and CHECKPOINTED without replay", async () => {
    const task = createExecutionTask();
    const { started, prepared } = await persistPreparedAndStartChild(task);
    const bound = bindTaskExecutionChild(prepared.task, "command", started.job.jobId, nextTimestamp(prepared.task));
    taskStore.replace(bound);
    runner.finish(started.job.jobId);
    await waitUntil(() => executionSupervisor.store.get(started.job.jobId)?.state === "succeeded");
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    expect(reloaded.get(task.taskId)?.state).toBe("COMPLETED");
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
  });

  it("uses the persisted OBSERVED terminal outcome to checkpoint after reload", async () => {
    const task = createExecutionTask();
    const { started, prepared } = await persistPreparedAndStartChild(task);
    const bound = bindTaskExecutionChild(prepared.task, "command", started.job.jobId, nextTimestamp(prepared.task));
    taskStore.replace(bound);
    runner.finish(started.job.jobId);
    await waitUntil(() => executionSupervisor.store.get(started.job.jobId)?.state === "succeeded");
    const child = executionSupervisor.store.get(started.job.jobId)!;
    const observed = observeTaskExecutionChild(bound, "command", {
      state: "succeeded",
      exitCode: child.exitCode,
      failureCode: child.failureCode,
      finishedAt: child.finishedAt,
    }, nextTimestamp(bound));
    taskStore.replace(observed);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    expect(reloaded.get(task.taskId)?.state).toBe("COMPLETED");
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
  });

  it("advances beyond CHECKPOINTED only after reloading the durable checkpoint", async () => {
    const plan: PersistentTaskPlan = {
      version: 1,
      maxDurationMs: 60_000,
      steps: [
        ...executionPlan().steps,
        { stepId: "assert", kind: "assertion", sourceStepId: "command", jsonPointer: "/state", operator: "status_equals", expected: "succeeded" },
      ],
    };
    const task = createExecutionTask(plan);
    const { started, prepared } = await persistPreparedAndStartChild(task);
    const bound = bindTaskExecutionChild(prepared.task, "command", started.job.jobId, nextTimestamp(prepared.task));
    taskStore.replace(bound);
    runner.finish(started.job.jobId);
    await waitUntil(() => executionSupervisor.store.get(started.job.jobId)?.state === "succeeded");
    const child = executionSupervisor.store.get(started.job.jobId)!;
    const observed = observeTaskExecutionChild(bound, "command", {
      state: "succeeded", exitCode: child.exitCode, failureCode: child.failureCode, finishedAt: child.finishedAt,
    }, nextTimestamp(bound));
    taskStore.replace(observed);
    const result = { childJobId: started.job.jobId, state: "succeeded", exitCode: 0, failureCode: null, finishedAt: child.finishedAt };
    const checkpointed = checkpointTaskExecution(observed, "command", result, nextTimestamp(observed), true);
    taskStore.replace(checkpointed);
    expect(taskStore.get(task.taskId)?.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    const resumed = restarted.run(task.taskId, task.ownerClientId);
    expect((await resumed).state).toBe("COMPLETED");
    expect(runner.runs.size).toBe(1);
  });

  it("leaves WAITING_FOR_MODEL unchanged on restart and fails closed on corrupt TaskStore", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 }, nextTimestamp(task));
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1, nextTimestamp(running));
    taskStore.replace(prepared.task);
    const waiting = transitionTask(prepared.task, "WAITING_FOR_MODEL", {
      stepStates: [{ stepId: "command", state: "failed" }],
      waitingReason: "UNKNOWN_EXECUTION_OUTCOME",
    }, nextTimestamp(prepared.task));
    taskStore.replace(waiting);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    expect(reloaded.get(task.taskId)?.state).toBe("WAITING_FOR_MODEL");
    expect(runner.runs.size).toBe(0);

    const corruptDirectory = path.join(makeTmpDir("wave4-corrupt-store"), "tasks");
    const initialCorruptStore = storeAt(corruptDirectory);
    fs.writeFileSync(path.join(corruptDirectory, "tasks.json"), "{corrupt", "utf8");
    const corrupt = new TaskStore(workspace.id, { directory: initialCorruptStore.directory });
    const failClosed = new TaskSupervisor(workspace, corrupt, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(failClosed);
    await failClosed.recover();
    expect(failClosed.recoveryReady).toBe(true);
    expect(failClosed.apiAvailable).toBe(false);
    expect(failClosed.unavailableReason).toContain("TASK_STORE_CORRUPT");
    expect(runner.runs.size).toBe(0);
  });

  it("does not replay a PREPARED command whose restarted JobStore reports interrupted", async () => {
    const task = createExecutionTask();
    const running = transitionTask(task, "RUNNING", { currentStep: 0 });
    taskStore.replace(running);
    const prepared = prepareTaskExecutionDispatch(running, "command", 1);
    taskStore.replace(prepared.task);
    const grant = readCurrentSessionGrant(workspace.id)!;
    const original = await executionSupervisor.startFullAccess({
      ...executionPlan().steps[0]!.command,
      timeoutSeconds: 30,
      idempotencyKey: prepared.entry.childIdempotencyKey,
      oauthClientId: task.ownerClientId,
      scopes: task.authBinding.requiredScopes,
    }, grant);
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error(original.error);
    await waitUntil(() => runner.runs.has(original.job.jobId));

    const restartedRunner = new ControlledRunner();
    fs.mkdirSync(path.join(executionSupervisor.store.directory, ".archive", "jobs"), { recursive: true });
    const reloadedJobs = new ExecutionJobStore(workspace.id);
    expect(reloadedJobs.get(original.job.jobId)?.state).toBe("interrupted");
    const restartedExecution = new ExecutionSupervisor(workspace, { store: reloadedJobs, runner: restartedRunner, permissionPollMs: 60_000 });
    extraExecutionSupervisors.push(restartedExecution);
    const reloadedTasks = storeAt(taskStore.directory);
    const restartedTasks = new TaskSupervisor(workspace, reloadedTasks, restartedExecution, { requireRecovery: true, pollIntervalMs: 5 });
    extraTaskSupervisors.push(restartedTasks);
    await restartedTasks.recover();

    expect(reloadedTasks.get(task.taskId)?.state).toBe("WAITING_FOR_MODEL");
    expect(reloadedTasks.get(task.taskId)?.waitingReason).toContain("CHILD_OUTCOME_UNKNOWN");
    expect(restartedRunner.runs.size).toBe(0);
    expect(reloadedJobs.listAll()).toHaveLength(1);
    runner.finish(original.job.jobId, 1, 1);
  });

  it("cancels queued Tasks idempotently and records CANCELLING before CANCELLED", async () => {
    const task = createExecutionTask();
    const cancelled = await taskSupervisor.cancel(task.taskId, task.ownerClientId);
    expect(cancelled.state).toBe("CANCELLED");
    expect(taskStore.get(task.taskId)?.state).toBe("CANCELLED");
    expect((await taskSupervisor.cancel(task.taskId, task.ownerClientId))).toEqual(cancelled);
    expect(runner.runs.size).toBe(0);
  });

  it("waits for running child termination and prevents the following step after cancellation", async () => {
    const task = createExecutionTask(executionPlan(["command", "second"]));
    const running = taskSupervisor.run(task.taskId, task.ownerClientId);
    await waitUntil(() => runner.runs.size === 1);
    await waitUntil(() => taskStore.get(task.taskId)?.dispatchJournal[0]?.phase === "CHILD_BOUND");
    const firstJobId = [...runner.runs.keys()][0]!;
    const cancelling = taskSupervisor.cancel(task.taskId, task.ownerClientId);
    await waitUntil(() => taskStore.get(task.taskId)?.state === "CANCELLING" &&
      executionSupervisor.store.get(firstJobId)?.state === "cancelling");
    runner.finish(firstJobId);
    expect((await cancelling).state).toBe("CANCELLED");
    expect((await running).state).toBe("CANCELLED");
    expect(taskStore.get(task.taskId)?.stepStates.map((step) => step.state)).toEqual(["failed", "pending"]);
    expect(runner.runs.size).toBe(1);
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
  });

  it("requests child cancellation after authorization revocation and blocks the next step", async () => {
    const task = createExecutionTask(executionPlan(["command", "second"]));
    const running = taskSupervisor.run(task.taskId, task.ownerClientId);
    await waitUntil(() => runner.runs.size === 1);
    await waitUntil(() => taskStore.get(task.taskId)?.dispatchJournal[0]?.phase === "CHILD_BOUND");
    const childJobId = [...runner.runs.keys()][0]!;

    setPermission(workspace.id, "readonly");
    await waitUntil(() => taskStore.get(task.taskId)?.state === "CANCELLING" &&
      executionSupervisor.store.get(childJobId)?.state === "cancelling");
    expect(runner.runs.size).toBe(1);

    runner.finish(childJobId, "cancelled");
    expect((await running).state).toBe("CANCELLED");
    expect(taskStore.get(task.taskId)?.stepStates.map((step) => step.state)).toEqual(["failed", "pending"]);
    expect(runner.runs.size).toBe(1);
  });

  it("revalidates authoritative state when cancel races an observed child checkpoint", async () => {
    const task = createExecutionTask(executionPlan(["command", "second"]));
    const supervisorInternals = taskSupervisor as unknown as {
      checkpointObservedChild: (...args: any[]) => Promise<any>;
    };
    const checkpointObservedChild = supervisorInternals.checkpointObservedChild.bind(taskSupervisor);
    let releaseCheckpoint!: () => void;
    let signalCheckpoint!: () => void;
    const blockedCheckpoint = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
    const checkpointEntered = new Promise<void>((resolve) => { signalCheckpoint = resolve; });
    let blockFirstCheckpoint = true;
    supervisorInternals.checkpointObservedChild = async (...args: any[]) => {
      if (blockFirstCheckpoint) {
        blockFirstCheckpoint = false;
        signalCheckpoint();
        await blockedCheckpoint;
      }
      return checkpointObservedChild(...args);
    };

    const running = taskSupervisor.run(task.taskId, task.ownerClientId).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitUntil(() => runner.runs.size === 1);
    const childJobId = [...runner.runs.keys()][0]!;
    runner.finish(childJobId);
    await checkpointEntered;
    expect(taskStore.get(task.taskId)?.dispatchJournal[0]?.phase).toBe("OBSERVED");

    const cancelled = await taskSupervisor.cancel(task.taskId, task.ownerClientId);
    expect(cancelled.state).toBe("CANCELLED");
    releaseCheckpoint();

    const runOutcome = await running;
    expect(runOutcome.ok).toBe(true);
    if (!runOutcome.ok) throw runOutcome.error;
    expect(runOutcome.result.state).toBe("CANCELLED");
    expect(taskStore.get(task.taskId)?.state).toBe("CANCELLED");
    expect(runner.runs.size).toBe(1);
  });

  it("retries a transient pure step once only when the immutable plan permits it", async () => {
    let attempts = 0;
    const plan: PersistentTaskPlan = {
      version: 1,
      maxDurationMs: 60_000,
      retryReadOnlyOnce: true,
      steps: [{ stepId: "read", kind: "batch_read", request: { items: [{ id: "hello", path: "hello.txt" }] } }],
    };
    const retryStore = storeAt(path.join(makeTmpDir("wave4-retry-store"), "tasks"));
    const retrySupervisor = new TaskSupervisor(workspace, retryStore, executionSupervisor, {
      pollIntervalMs: 5,
      executePureStep: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("changed while reading"), { code: "SOURCE_CHANGED" });
        return { ok: true };
      },
    });
    extraTaskSupervisors.push(retrySupervisor);
    const task = createReadTask(plan, retrySupervisor);
    const completed = await retrySupervisor.run(task.taskId, task.ownerClientId);
    expect(completed.state, JSON.stringify(completed)).toBe("COMPLETED");
    expect(attempts).toBe(2);
    expect(completed.stepStates[0]?.attemptCount).toBe(2);
  });

  it("keeps the persisted pure retry limit across a Bridge-style reload", async () => {
    const plan: PersistentTaskPlan = {
      version: 1,
      maxDurationMs: 60_000,
      retryReadOnlyOnce: true,
      steps: [{ stepId: "read", kind: "batch_read", request: { items: [{ id: "hello", path: "hello.txt" }] } }],
    };
    const task = createReadTask(plan);
    let running = transitionTask(task, "RUNNING", { currentStep: 0 });
    running = { ...running, stepStates: [{ stepId: "read", state: "running", attemptCount: 2 }] };
    taskStore.replace(running);
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();
    const reloaded = storeAt(directory);
    let calls = 0;
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, {
      requireRecovery: true,
      executePureStep: async () => { calls += 1; return { ok: true }; },
    });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();
    expect(reloaded.get(task.taskId)?.state).toBe("WAITING_FOR_MODEL");
    expect(calls).toBe(0);
  });

  it("persists workspace authorization epoch across revoke-all and local Full Access grant changes", () => {
    const authFile = path.join(makeTmpDir("wave4-auth-epoch"), "auth.json");
    const auth = new AuthStore(workspace.id, { file: authFile });
    auth.issueTokens({ clientId: "epoch-owner", scopes: ["execution.run"] });
    const initial = readAuthorizationEpoch(workspace.id)!;
    auth.revokeAll();
    const afterRevokeAll = readAuthorizationEpoch(workspace.id)!;
    expect(afterRevokeAll).toBe(initial + 1);
    const reloaded = new AuthStore(workspace.id, { file: authFile });
    reloaded.issueTokens({ clientId: "epoch-owner", scopes: ["execution.run"] });
    setPermission(workspace.id, "level1");
    const afterLocalRevoke = readAuthorizationEpoch(workspace.id)!;
    setPermission(workspace.id, "level2");
    expect(readAuthorizationEpoch(workspace.id)).toBe(afterLocalRevoke + 1);
  });

  it("stops a queued Task after revoke and does not revive it with a replacement grant", async () => {
    const task = createExecutionTask();
    setPermission(workspace.id, "level1");
    setPermission(workspace.id, "level2");
    const stopped = await taskSupervisor.run(task.taskId, task.ownerClientId);
    expect(stopped.state).toBe("FAILED");
    expect(stopped.failureReason).toBe("AUTHORIZATION_REVOKED");
    expect(executionSupervisor.store.listAll()).toHaveLength(0);
    expect(runner.runs.size).toBe(0);
  });

  it("keeps revoke-all and replacement grants effective after Task runtime restart", async () => {
    const task = createExecutionTask();
    const authFile = path.join(makeTmpDir("wave4-auth-restart"), "auth.json");
    const auth = new AuthStore(workspace.id, { file: authFile });
    auth.issueTokens({ clientId: task.ownerClientId, scopes: ["execution.run"] });
    const directory = taskStore.directory;
    await taskSupervisor.shutdown();

    auth.revokeAll();
    auth.issueTokens({ clientId: task.ownerClientId, scopes: ["execution.run"] });
    setPermission(workspace.id, "level1");
    setPermission(workspace.id, "level2");

    const reloaded = storeAt(directory);
    const restarted = new TaskSupervisor(workspace, reloaded, executionSupervisor, { requireRecovery: true });
    extraTaskSupervisors.push(restarted);
    await restarted.recover();

    expect(reloaded.get(task.taskId)?.state).toBe("FAILED");
    expect(reloaded.get(task.taskId)?.failureReason).toBe("AUTHORIZATION_REVOKED");
    expect(executionSupervisor.store.listAll()).toHaveLength(0);
    expect(runner.runs.size).toBe(0);
  });
});
