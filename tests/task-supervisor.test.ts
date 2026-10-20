import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { atomicReplace as replaceFileAtomic } from "../src/execution/atomic-replace.js";
import type { NativeRunnerCompletion, NativeRunnerHandle, NativeRunnerRequest } from "../src/execution/native-runner.js";
import type { OutputStream } from "../src/execution/job-types.js";
import { MAX_TASK_RESULTS_BYTES, TaskStore } from "../src/tasks/task-store.js";
import { TaskSupervisor } from "../src/tasks/task-supervisor.js";
import { canonicalizeTaskResult, type PersistentTaskPlan } from "../src/tasks/task-types.js";
import { setPermission } from "../src/permission/store.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

interface CapturedRun {
  request: NativeRunnerRequest;
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  completion: Promise<NativeRunnerCompletion>;
  resolve: (value: NativeRunnerCompletion) => void;
}

const TASK_OWNER = "task-test-client";

class ControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, CapturedRun>();
  beforeStart?: (request: NativeRunnerRequest) => void;

  start(request: NativeRunnerRequest, callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    this.beforeStart?.(request);
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { request, callbacks, completion, resolve });
    return {
      completion,
      cancel: () => undefined,
      abandon: () => undefined,
    };
  }

  finish(jobId: string, exitCode = 0, outcome: 0 | 1 | 2 | 3 | 4 | 5 = 0): void {
    this.runs.get(jobId)?.resolve({
      result: { outcome, exitCode, win32Error: 0 },
      helperExitCode: 0,
      tempCleanupConfirmed: true,
    });
  }

  async emit(jobId: string, stream: OutputStream, value: string): Promise<void> {
    await this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(value, "utf8"));
  }
}

let workspace: Workspace;
let runner: ControlledRunner;
let executionSupervisor: ExecutionSupervisor;
let taskStore: TaskStore;
let taskSupervisor: TaskSupervisor;
let openedRuns: Promise<unknown>[];

function readAndExecutePlan(): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: 60_000,
    steps: [
      {
        stepId: "read",
        kind: "batch_read",
        request: { items: [{ id: "hello", path: "hello.txt", maxBytes: 64 * 1024 }] },
      },
      {
        stepId: "command",
        kind: "execution",
        command: {
          engine: "program",
          executable: process.execPath,
          args: ["-e", "process.stdout.write('child-output')"],
          cwd: workspace.root,
        },
        timeoutSeconds: 5,
        repositoryPath: ".",
      },
      {
        stepId: "assert_success",
        kind: "assertion",
        sourceStepId: "command",
        jsonPointer: "/state",
        operator: "status_equals",
        expected: "succeeded",
      },
    ],
  };
}

function executionOnlyPlan(timeoutSeconds = 5): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: 60_000,
    steps: [
      {
        stepId: "command",
        kind: "execution",
        command: {
          engine: "program",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: workspace.root,
        },
        timeoutSeconds,
      },
      {
        stepId: "later_assertion",
        kind: "assertion",
        sourceStepId: "command",
        jsonPointer: "/state",
        operator: "status_equals",
        expected: "succeeded",
      },
    ],
  };
}

function createTask(plan = readAndExecutePlan()) {
  return taskSupervisor.create({
    ownerClientId: TASK_OWNER,
    idempotencyKey: `task-key-${Math.random().toString(36).slice(2, 24)}`,
    scopes: ["workspace.read", "execution.run"],
    plan,
  }).task;
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("TASK_SUPERVISOR_TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForChildOrTerminal(taskId: string, timeoutMs = 5_000): Promise<void> {
  await waitUntil(() => runner.runs.size === 1 ||
    ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(taskStore.get(taskId)?.state ?? ""), timeoutMs);
  if (runner.runs.size !== 1) {
    const task = taskStore.get(taskId);
    throw new Error(`Task stopped before child creation: ${task?.state ?? "missing"}:${task?.failureReason ?? "no reason"}`);
  }
}

function createAtomicStore(directory: string, failingPhase: "PREPARED" | "CHILD_BOUND"): TaskStore {
  return new TaskStore(workspace.id, {
    directory,
    atomicReplace(source, destination) {
      const serialized = fs.readFileSync(source, "utf8");
      if (serialized.includes(`\"phase\":\"${failingPhase}\"`)) {
        throw new Error(`INJECTED_${failingPhase}_WRITE_FAILURE`);
      }
      replaceFileAtomic(source, destination);
    },
  });
}

type DurabilityFailureStage = "temp-write" | "temp-flush" | "atomic-replace" | "write-through";

function createDurabilityFaultStore(directory: string, stage: DurabilityFailureStage): {
  store: TaskStore;
  lastCommitted: () => string | undefined;
} {
  let preparedPayload = false;
  let committed: string | undefined;
  const store = new TaskStore(workspace.id, {
    directory,
    writeTemp(fd, serialized) {
      preparedPayload = serialized.includes('"phase":"PREPARED"');
      if (preparedPayload && stage === "temp-write") {
        fs.writeFileSync(fd, serialized.slice(0, Math.max(1, Math.floor(serialized.length / 2))), { encoding: "utf8" });
        throw new Error("INJECTED_TEMP_WRITE_FAILURE");
      }
      fs.writeFileSync(fd, serialized, { encoding: "utf8" });
    },
    flushTemp(fd) {
      if (preparedPayload && stage === "temp-flush") throw new Error("INJECTED_TEMP_FLUSH_FAILURE");
      fs.fsyncSync(fd);
    },
    atomicReplace(source, destination, expectedNewHash) {
      const prepared = fs.readFileSync(source, "utf8").includes('"phase":"PREPARED"');
      if (prepared && stage === "atomic-replace") throw new Error("INJECTED_ATOMIC_REPLACE_FAILURE");
      if (prepared && stage === "write-through") throw new Error("INJECTED_WRITE_THROUGH_FAILURE");
      replaceFileAtomic(source, destination, { expectedNewHash });
      committed = fs.readFileSync(destination, "utf8");
    },
  });
  return { store, lastCommitted: () => committed };
}

beforeEach(() => {
  isolateStateDir();
  const root = makeTmpDir("task-supervisor");
  makeGitRepo(root);
  write(root, "hello.txt", "Hello from TaskSupervisor\n");
  workspace = new Workspace(root);
  setPermission(workspace.id, "level2");
  runner = new ControlledRunner();
  executionSupervisor = new ExecutionSupervisor(workspace, {
    runner,
    permissionPollMs: 60_000,
    cancelGraceMs: 100,
  });
  taskStore = new TaskStore(workspace.id);
  taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor, { pollIntervalMs: 5 });
  openedRuns = [];
});

afterEach(async () => {
  for (const job of executionSupervisor.store.listAll()) {
    if (job.state === "running" || job.state === "cancelling" || job.state === "queued") runner.finish(job.jobId, 1, 1);
  }
  await Promise.allSettled(openedRuns);
  await taskSupervisor.shutdown();
  await executionSupervisor.shutdown();
});

describe("TaskSupervisor persistent execution", () => {
  it("checks required scopes before returning an idempotent Task and filters reads by owner", async () => {
    const key = "owner-scope-idempotency-0001";
    const input = {
      ownerClientId: TASK_OWNER,
      idempotencyKey: key,
      scopes: ["workspace.read", "execution.run"] as const,
      plan: readAndExecutePlan(),
    };
    const created = taskSupervisor.create(input).task;
    expect(() => taskSupervisor.create({ ...input, scopes: ["execution.run"] }))
      .toThrow("caller does not hold all scopes");
    expect(taskSupervisor.get(created.taskId, "another-client")).toBeNull();
    await expect(taskSupervisor.run(created.taskId, "another-client")).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("runs pure domain work, a real Supervisor child, and an assertion in order", async () => {
    const task = createTask();
    const observedPhases: string[] = [];
    const replace = taskStore.replace.bind(taskStore);
    vi.spyOn(taskStore, "replace").mockImplementation((next) => {
      const phase = next.dispatchJournal.at(-1)?.phase;
      if (phase && observedPhases.at(-1) !== phase) observedPhases.push(phase);
      replace(next);
    });
    let phaseAtDispatchCall: string | undefined;
    const startFullAccess = executionSupervisor.startFullAccess.bind(executionSupervisor);
    vi.spyOn(executionSupervisor, "startFullAccess").mockImplementation(async (input) => {
      phaseAtDispatchCall = taskStore.get(task.taskId)?.dispatchJournal[0]?.phase;
      return startFullAccess(input);
    });

    const run = taskSupervisor.run(task.taskId, TASK_OWNER);
    openedRuns.push(run);
    await waitForChildOrTerminal(task.taskId);
    const jobId = [...runner.runs.keys()][0]!;
    expect(phaseAtDispatchCall).toBe("PREPARED");
    const during = taskStore.get(task.taskId)!;
    expect(during.state).toBe("RUNNING");
    expect(during.dispatchJournal[0]).toMatchObject({ phase: "CHILD_BOUND", childJobId: jobId });
    await runner.emit(jobId, "stdout", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    runner.finish(jobId, 0, 0);

    const completed = await run;
    expect(completed.state).toBe("COMPLETED");
    expect(completed.stepStates.map((entry) => entry.state)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(completed.dispatchJournal).toMatchObject([{ stepId: "command", phase: "CHECKPOINTED", childJobId: jobId }]);
    expect(observedPhases).toEqual(["PREPARED", "CHILD_BOUND", "OBSERVED", "CHECKPOINTED"]);
    expect(JSON.stringify(completed.checkpoints)).not.toContain("child-output");
    expect(JSON.stringify(completed.checkpoints)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const output = executionSupervisor.readOutputForClient(jobId, TASK_OWNER, "stdout");
    expect(output.ok).toBe(true);
    if (output.ok) {
      expect(output.text).toContain("[REDACTED]");
      expect(output.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    }
  });

  it("does not start a child when PREPARED cannot be made durable", async () => {
    const directory = path.join(makeTmpDir("task-prepared-failure"), "tasks");
    const failingStore = createAtomicStore(directory, "PREPARED");
    const failingSupervisor = new TaskSupervisor(workspace, failingStore, executionSupervisor, { pollIntervalMs: 5 });
    const task = failingSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: "prepared-failure-key-0001",
      scopes: ["execution.run"],
      plan: executionOnlyPlan(30),
    }).task;

    await expect(failingSupervisor.run(task.taskId, TASK_OWNER)).rejects.toThrow("INJECTED_PREPARED_WRITE_FAILURE");
    expect(runner.runs.size).toBe(0);
    const reloaded = new TaskStore(workspace.id, {
      directory,
      atomicReplace(source, destination, expectedNewHash) {
        replaceFileAtomic(source, destination, { expectedNewHash });
      },
    });
    expect(reloaded.corruption).toBeNull();
    expect(reloaded.get(task.taskId)).toMatchObject({ state: "RUNNING", dispatchJournal: [] });
    await failingSupervisor.shutdown();
  });

  it.each([
    ["temporary write", "temp-write", "INJECTED_TEMP_WRITE_FAILURE"],
    ["file flush", "temp-flush", "INJECTED_TEMP_FLUSH_FAILURE"],
    ["atomic replace", "atomic-replace", "INJECTED_ATOMIC_REPLACE_FAILURE"],
    ["write-through publish", "write-through", "INJECTED_WRITE_THROUGH_FAILURE"],
  ] as const)("fails closed before dispatch when PREPARED %s fails", async (_label, stage, failureCode) => {
    const directory = path.join(makeTmpDir(`task-prepared-${stage}`), "tasks");
    const { store, lastCommitted } = createDurabilityFaultStore(directory, stage);
    const failingSupervisor = new TaskSupervisor(workspace, store, executionSupervisor, { pollIntervalMs: 5 });
    const task = failingSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: `prepared-${stage}-failure-key-0001`,
      scopes: ["execution.run"],
      plan: executionOnlyPlan(),
    }).task;

    try {
      const run = failingSupervisor.run(task.taskId, TASK_OWNER);
      openedRuns.push(run);
      await expect(run).rejects.toThrow(failureCode);
      expect(runner.runs.size).toBe(0);
      expect(lastCommitted()).toBeDefined();
      expect(fs.readFileSync(path.join(directory, "tasks.json"), "utf8")).toBe(lastCommitted());
      const reloaded = new TaskStore(workspace.id, { directory });
      expect(reloaded.corruption).toBeNull();
      expect(reloaded.get(task.taskId)).toMatchObject({ state: "RUNNING", dispatchJournal: [] });
    } finally {
      await failingSupervisor.shutdown();
    }
  });

  it("flushes and durably publishes PREPARED before Full Access dispatch", async () => {
    const directory = path.join(makeTmpDir("task-prepared-durable-order"), "tasks");
    const order: string[] = [];
    let preparedPayload = false;
    const store = new TaskStore(workspace.id, {
      directory,
      writeTemp(fd, serialized) {
        preparedPayload = serialized.includes('"phase":"PREPARED"');
        fs.writeFileSync(fd, serialized, { encoding: "utf8" });
        if (preparedPayload) order.push("temp-written");
      },
      flushTemp(fd) {
        fs.fsyncSync(fd);
        if (preparedPayload) order.push("temp-flushed");
      },
      atomicReplace(source, destination, expectedNewHash) {
        if (fs.readFileSync(source, "utf8").includes('"phase":"PREPARED"')) order.push("durable-publish");
        replaceFileAtomic(source, destination, { expectedNewHash });
      },
    });
    const orderedSupervisor = new TaskSupervisor(workspace, store, executionSupervisor, { pollIntervalMs: 5 });
    const task = orderedSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: "prepared-durable-order-key-0001",
      scopes: ["execution.run"],
      plan: executionOnlyPlan(30),
    }).task;
    const startFullAccess = executionSupervisor.startFullAccess.bind(executionSupervisor);
    const startSpy = vi.spyOn(executionSupervisor, "startFullAccess").mockImplementation(async (input, expectedGrant) => {
      order.push("dispatch");
      return startFullAccess(input, expectedGrant);
    });

    try {
      const run = orderedSupervisor.run(task.taskId, TASK_OWNER);
      openedRuns.push(run);
      await waitForChildOrTerminal(task.taskId, 30_000);
      const childJobId = [...runner.runs.keys()][0]!;
      expect(order).toEqual(["temp-written", "temp-flushed", "durable-publish", "dispatch"]);
      runner.finish(childJobId, 0, 0);
      expect((await run).state).toBe("COMPLETED");
    } finally {
      startSpy.mockRestore();
      await orderedSupervisor.shutdown();
    }
  }, 60_000);

  it("stops an uncertain PREPARED dispatch after CHILD_BOUND persistence fails", async () => {
    const directory = path.join(makeTmpDir("task-child-bound-failure"), "tasks");
    const failingStore = createAtomicStore(directory, "CHILD_BOUND");
    const failingSupervisor = new TaskSupervisor(workspace, failingStore, executionSupervisor, { pollIntervalMs: 5 });
    const task = failingSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: "child-bound-failure-key-01",
      scopes: ["execution.run"],
      plan: executionOnlyPlan(30),
    }).task;

    let runError: unknown;
    let runResult: Awaited<ReturnType<TaskSupervisor["run"]>> | undefined;
    try {
      runResult = await failingSupervisor.run(task.taskId, TASK_OWNER);
    } catch (error) {
      runError = error;
    }
    if (!(runError instanceof Error) || !runError.message.includes("INJECTED_CHILD_BOUND_WRITE_FAILURE")) {
      throw new Error(`Expected CHILD_BOUND persistence failure; task=${runResult?.state ?? "rejected"}:${runResult?.failureReason ?? (runError as Error | undefined)?.message ?? "unknown"}`);
    }
    const childJobs = executionSupervisor.store.listAll();
    expect(childJobs).toHaveLength(1);
    const childJobId = childJobs[0]!.jobId;
    const reloaded = new TaskStore(workspace.id, { directory });
    expect(reloaded.corruption).toBeNull();
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.phase).toBe("PREPARED");
    fs.mkdirSync(path.join(executionSupervisor.store.directory, ".archive", "jobs"), { recursive: true });
    const restartedTaskSupervisor = new TaskSupervisor(workspace, reloaded, executionSupervisor, { pollIntervalMs: 5 });
    const resumed = restartedTaskSupervisor.run(task.taskId, TASK_OWNER);
    await waitUntil(() => reloaded.get(task.taskId)?.dispatchJournal[0]?.phase === "CHILD_BOUND", 30_000);
    expect(reloaded.get(task.taskId)?.dispatchJournal[0]?.childJobId).toBe(childJobId);
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
    await waitUntil(() => runner.runs.has(childJobId));
    runner.finish(childJobId, 0, 0);
    const resumedTask = await resumed;
    expect(resumedTask.state, JSON.stringify(resumedTask)).toBe("COMPLETED");
    await restartedTaskSupervisor.shutdown();
  }, 60_000);

  it("records a non-zero child result and never dispatches the following step", async () => {
    const task = createTask(executionOnlyPlan(30));
    const run = taskSupervisor.run(task.taskId, TASK_OWNER);
    openedRuns.push(run);
    await waitForChildOrTerminal(task.taskId, 30_000);
    const jobId = [...runner.runs.keys()][0]!;
    runner.finish(jobId, 9, 0);

    const failed = await run;
    expect(failed.state).toBe("FAILED");
    expect(failed.failureReason).toBe("NONZERO_EXIT");
    expect(failed.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
    expect(failed.stepStates.map((entry) => entry.state)).toEqual(["failed", "pending"]);
    expect(failed.checkpoints[0]?.result).toMatchObject({ state: "failed", exitCode: 9 });
    expect(runner.runs.size).toBe(1);
  }, 60_000);

  it("does not dispatch a Task under a replacement Full Access grant", async () => {
    const task = createTask(executionOnlyPlan());
    const startFullAccess = executionSupervisor.startFullAccess.bind(executionSupervisor);
    const startSpy = vi.spyOn(executionSupervisor, "startFullAccess").mockImplementation(async (input, expectedGrant) => {
      setPermission(workspace.id, "level1");
      setPermission(workspace.id, "level2");
      return startFullAccess(input, expectedGrant);
    });

    try {
      const failed = await taskSupervisor.run(task.taskId, TASK_OWNER);

      expect(failed.state).toBe("FAILED");
      expect(failed.failureReason).toBe("AUTHORIZATION_REVOKED");
      expect(failed.dispatchJournal[0]?.phase).toBe("PREPARED");
      expect(executionSupervisor.store.listAll()).toHaveLength(0);
      expect(runner.runs.size).toBe(0);
    } finally {
      startSpy.mockRestore();
    }
  });

  it("coalesces concurrent run requests to one active child", async () => {
    const task = createTask(executionOnlyPlan());
    const first = taskSupervisor.run(task.taskId, TASK_OWNER);
    const second = taskSupervisor.run(task.taskId, TASK_OWNER);
    expect(second).toBe(first);
    openedRuns.push(first);
    await waitForChildOrTerminal(task.taskId);
    const jobId = [...runner.runs.keys()][0]!;
    runner.finish(jobId, 0, 0);
    expect((await first).state).toBe("COMPLETED");
    expect(runner.runs.size).toBe(1);
  });

  it("fails closed when a new result would exceed the Task cumulative checkpoint limit", async () => {
    const steps = Array.from({ length: 16 }, (_, index) => ({
      stepId: `read_${index}`,
      kind: "batch_read" as const,
      request: { items: [{ id: `item_${index}`, path: "large.txt", maxBytes: 64 * 1024 }] },
    }));
    const plan: PersistentTaskPlan = { version: 1, maxDurationMs: 60_000, steps };
    write(workspace.root, "large.txt", "x".repeat(60_000));
    const task = taskSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: "cumulative-result-cap-0001",
      scopes: ["workspace.read"],
      plan,
    }).task;

    const completedAt = new Date(Date.parse(task.createdAt) + 1).toISOString();
    const previousResult = canonicalizeTaskResult("x".repeat(68_000));
    const progress = {
      ...task,
      state: "RUNNING" as const,
      updatedAt: completedAt,
      currentStep: 15,
      stepStates: task.stepStates.map((step, index) => ({
        stepId: step.stepId,
        state: index < 15 ? "succeeded" as const : "pending" as const,
      })),
      checkpoints: task.plan.steps.slice(0, 15).map((step) => ({
        stepId: step.stepId,
        completedAt,
        ...previousResult,
      })),
    };
    taskStore.replace(progress);
    const failed = await taskSupervisor.run(task.taskId, TASK_OWNER);

    expect(failed.state).toBe("FAILED");
    expect(failed.failureReason).toBe("TASK_RESULT_TOO_LARGE");
    expect(failed.stepStates[15]?.state).toBe("failed");
    expect(failed.checkpoints.reduce((total, item) => total + item.resultBytes, 0)).toBeLessThanOrEqual(MAX_TASK_RESULTS_BYTES);
    expect(taskStore.corruption).toBeNull();
  });

  it("fails explicitly when sanitization truncates a structured pure-step result", async () => {
    const largeDiff = Array.from({ length: 250 }, (_, index) => `line-${index}-${"x".repeat(160)}`).join("\n") + "\n";
    write(workspace.root, "hello.txt", largeDiff);
    const task = taskSupervisor.create({
      ownerClientId: TASK_OWNER,
      idempotencyKey: "sanitizer-truncation-fails-0001",
      scopes: ["git.read"],
      plan: {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{ stepId: "diff", kind: "git_read", operation: "diff", repositoryPath: "." }],
      },
    }).task;

    const failed = await taskSupervisor.run(task.taskId, TASK_OWNER);

    expect(failed.state).toBe("FAILED");
    expect(failed.failureReason).toBe("TASK_RESULT_TOO_LARGE");
    expect(failed.checkpoints[0]?.result).toEqual({ error: "TASK_RESULT_TOO_LARGE" });
  });
});
