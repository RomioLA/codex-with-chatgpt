import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AtomicReplaceError } from "../src/execution/atomic-replace.js";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { WindowsNativeExecutionRunner, type NativeRunnerHandle } from "../src/execution/native-runner.js";
import { bindTaskExecutionChild, prepareTaskExecutionDispatch } from "../src/tasks/task-journal.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { transitionTask } from "../src/tasks/task-state-machine.js";
import { TaskSupervisor } from "../src/tasks/task-supervisor.js";
import type { PersistentTaskPlan } from "../src/tasks/task-types.js";
import { readCurrentSessionGrant, setPermission } from "../src/permission/store.js";
import { Workspace } from "../src/workspace/manager.js";

const moduleDirectory = process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY
  ? path.resolve(process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/execution");

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("TASK_NATIVE_TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function captureRunnerFailure(
  runner: ExecutionRunner,
  failures: string[],
  handles?: NativeRunnerHandle[],
): ExecutionRunner {
  return {
    start(request, callbacks) {
      const handle = runner.start(request, {
        ...callbacks,
        onDiagnostic(message) {
          failures.push(message.slice(-512));
          callbacks.onDiagnostic?.(message);
        },
      });
      handles?.push(handle);
      const completion = handle.completion.catch((error: unknown) => {
        failures.push((error instanceof Error ? error.message : String(error)).slice(-512));
        throw error;
      });
      return { ...handle, completion };
    },
  };
}

describe("TaskSupervisor with the Windows native execution path", () => {
  it.skipIf(process.platform !== "win32")("runs read → Full Access execution → assertion and keeps command output in JobStore", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("task-supervisor-native-state");
    const workspaceRoot = makeSystemTempDir("task-supervisor-native-workspace");
    const markerPath = path.join(stateRoot, "native-task-ran.txt");
    const outputSentinel = "TASK_NATIVE_JOB_OUTPUT_7D18A";
    const markerLine = "executed-once\n";
    const runnerFailures: string[] = [];
    let executionSupervisor: ExecutionSupervisor | undefined;
    let taskSupervisor: TaskSupervisor | undefined;

    process.env.C2C_STATE_DIR = stateRoot;

    try {
      const workspace = new Workspace(workspaceRoot);
      fs.writeFileSync(path.join(workspace.root, "task-input.txt"), "read-checkpoint-value");
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();

      const jobStore = new ExecutionJobStore(workspace.id);
      const taskStore = new TaskStore(workspace.id);
      executionSupervisor = new ExecutionSupervisor(workspace, {
        store: jobStore,
        runner: captureRunnerFailure(new WindowsNativeExecutionRunner({ moduleDirectory }), runnerFailures),
      });
      taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor);

      const script = [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerLine)}, { encoding: 'utf8' })`,
        `process.stdout.write(${JSON.stringify(outputSentinel)})`,
      ].join(";");
      const plan: PersistentTaskPlan = {
        version: 1,
        maxDurationMs: 60_000,
        steps: [
          {
            stepId: "read_input",
            kind: "batch_read",
            request: { items: [{ id: "input", path: "task-input.txt", maxBytes: 1024 }] },
          },
          {
            stepId: "execute_node",
            kind: "execution",
            command: {
              engine: "program",
              executable: process.execPath,
              args: ["-e", script],
              cwd: workspace.root,
            },
            timeoutSeconds: 20,
          },
          {
            stepId: "assert_execution_succeeded",
            kind: "assertion",
            sourceStepId: "execute_node",
            jsonPointer: "/state",
            operator: "equals",
            expected: "succeeded",
          },
        ],
      };

      const ownerClientId = "task-supervisor-native-test-client";
      const created = taskSupervisor.create({
        ownerClientId,
        idempotencyKey: "task-supervisor-native-test-0001",
        scopes: ["workspace.read", "execution.run"],
        plan,
      });
      expect(created.duplicate).toBe(false);

      const completed = await taskSupervisor.run(created.task.taskId, ownerClientId);
      expect(completed.state, runnerFailures.join("\n")).toBe("COMPLETED");

      const persistedTask = new TaskStore(workspace.id).get(created.task.taskId);
      expect(persistedTask).toMatchObject({
        state: "COMPLETED",
        currentStep: null,
        stepStates: [
          { stepId: "read_input", state: "succeeded" },
          { stepId: "execute_node", state: "succeeded" },
          { stepId: "assert_execution_succeeded", state: "succeeded" },
        ],
      });
      expect(persistedTask?.checkpoints[0]?.result).toMatchObject({
        results: [{ id: "input", ok: true, content: "read-checkpoint-value" }],
      });
      expect(persistedTask?.checkpoints[2]?.result).toMatchObject({
        passed: true,
        sourceStepId: "execute_node",
        operator: "equals",
      });

      const executionJournal = persistedTask?.dispatchJournal;
      expect(executionJournal).toHaveLength(1);
      const childJobId = executionJournal?.[0]?.childJobId;
      expect(executionJournal?.[0]).toMatchObject({
        stepId: "execute_node",
        attempt: 1,
        phase: "CHECKPOINTED",
        observed: { state: "succeeded", exitCode: 0, failureCode: null },
      });
      expect(childJobId).toEqual(expect.any(String));

      const persistedJobs = new ExecutionJobStore(workspace.id);
      const childJob = childJobId ? persistedJobs.get(childJobId) : null;
      expect(childJob).toMatchObject({ state: "succeeded", exitCode: 0, oauthClientId: ownerClientId });
      if (!childJobId) throw new Error("Task execution child job ID was not persisted");
      const output = persistedJobs.readOutput(childJobId, "stdout", 0, 64 * 1024);
      expect(output).toMatchObject({ ok: true, text: expect.stringContaining(outputSentinel) });

      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);
      expect(JSON.stringify(persistedTask?.checkpoints)).not.toContain(outputSentinel);
      expect(persistedTask?.checkpoints[1]?.result).not.toHaveProperty("stdout");
      expect(persistedTask?.checkpoints[1]?.result).not.toHaveProperty("output");
    } finally {
      try {
        await executionSupervisor?.shutdown();
      } finally {
        try {
          await taskSupervisor?.shutdown();
        } finally {
          if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
          else process.env.C2C_STATE_DIR = previousStateRoot;
        }
      }
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("checkpoints a real nonzero child failure without retrying or running later steps", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("task-supervisor-native-failure-state");
    const workspaceRoot = makeSystemTempDir("task-supervisor-native-failure-workspace");
    const markerPath = path.join(stateRoot, "native-task-failed-once.txt");
    const markerLine = "failed-child-ran-once\n";
    const runnerFailures: string[] = [];
    let executionSupervisor: ExecutionSupervisor | undefined;
    let taskSupervisor: TaskSupervisor | undefined;

    process.env.C2C_STATE_DIR = stateRoot;

    try {
      const workspace = new Workspace(workspaceRoot);
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();

      const jobStore = new ExecutionJobStore(workspace.id);
      const taskStore = new TaskStore(workspace.id);
      executionSupervisor = new ExecutionSupervisor(workspace, {
        store: jobStore,
        runner: captureRunnerFailure(new WindowsNativeExecutionRunner({ moduleDirectory }), runnerFailures),
      });
      taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor);

      const script = [
        "const fs = require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerLine)}, { encoding: 'utf8' })`,
        "process.exitCode = 7",
      ].join(";");
      const plan: PersistentTaskPlan = {
        version: 1,
        maxDurationMs: 60_000,
        steps: [
          {
            stepId: "execute_nonzero",
            kind: "execution",
            command: {
              engine: "program",
              executable: process.execPath,
              args: ["-e", script],
              cwd: workspace.root,
            },
            timeoutSeconds: 20,
          },
          {
            stepId: "must_remain_pending",
            kind: "assertion",
            sourceStepId: "execute_nonzero",
            jsonPointer: "/state",
            operator: "equals",
            expected: "failed",
          },
        ],
      };
      const ownerClientId = "task-supervisor-native-failure-client";
      const created = taskSupervisor.create({
        ownerClientId,
        idempotencyKey: "task-supervisor-native-failure-0001",
        scopes: ["execution.run"],
        plan,
      });
      expect(created.duplicate).toBe(false);

      const failed = await taskSupervisor.run(created.task.taskId, ownerClientId);
      expect(failed.state).toBe("FAILED");
      expect(failed.failureReason, runnerFailures.join("\n")).toBe("NONZERO_EXIT");
      expect(failed.stepStates).toEqual([
        { stepId: "execute_nonzero", state: "failed" },
        { stepId: "must_remain_pending", state: "pending", attemptCount: 0 },
      ]);

      const executionJournal = failed.dispatchJournal;
      expect(executionJournal).toHaveLength(1);
      expect(executionJournal[0]).toMatchObject({
        stepId: "execute_nonzero",
        attempt: 1,
        phase: "CHECKPOINTED",
        observed: { state: "failed", exitCode: 7 },
      });
      const childJobId = executionJournal[0]?.childJobId;
      expect(childJobId).toEqual(expect.any(String));
      if (!childJobId) throw new Error("Task execution child job ID was not persisted");

      const persistedTask = new TaskStore(workspace.id).get(created.task.taskId);
      expect(persistedTask).toMatchObject({
        state: "FAILED",
        stepStates: [
          { stepId: "execute_nonzero", state: "failed" },
          { stepId: "must_remain_pending", state: "pending" },
        ],
        dispatchJournal: [{
          stepId: "execute_nonzero",
          attempt: 1,
          phase: "CHECKPOINTED",
          childJobId,
          observed: { state: "failed", exitCode: 7 },
        }],
      });

      const persistedJobs = new ExecutionJobStore(workspace.id);
      const children = persistedJobs.listForClient(ownerClientId);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({
        jobId: childJobId,
        oauthClientId: ownerClientId,
        state: "failed",
        exitCode: 7,
      });

      const repeated = await taskSupervisor.run(created.task.taskId, ownerClientId);
      expect(repeated.state).toBe("FAILED");
      expect(new ExecutionJobStore(workspace.id).listForClient(ownerClientId)).toHaveLength(1);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);
    } finally {
      try {
        await executionSupervisor?.shutdown();
      } finally {
        try {
          await taskSupervisor?.shutdown();
        } finally {
          if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
          else process.env.C2C_STATE_DIR = previousStateRoot;
        }
      }
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("fails closed on a real Native durable-publish error before PREPARED dispatch", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("task-supervisor-native-publish-failure-state");
    const workspaceRoot = makeSystemTempDir("task-supervisor-native-publish-failure-workspace");
    const markerPath = path.join(stateRoot, "native-task-must-not-run.txt");
    const taskOwner = "task-supervisor-native-publish-failure-client";
    let executionSupervisor: ExecutionSupervisor | undefined;
    let taskSupervisor: TaskSupervisor | undefined;
    let taskFile: string | undefined;
    let replaceSpy: ReturnType<typeof vi.spyOn> | undefined;
    let startSpy: ReturnType<typeof vi.spyOn> | undefined;
    let spawnSyncSpy: ReturnType<typeof vi.spyOn> | undefined;

    process.env.C2C_STATE_DIR = stateRoot;

    try {
      const workspace = new Workspace(workspaceRoot);
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();

      const jobStore = new ExecutionJobStore(workspace.id);
      const taskStore = new TaskStore(workspace.id);
      taskFile = path.join(taskStore.directory, "tasks.json");
      executionSupervisor = new ExecutionSupervisor(workspace, {
        store: jobStore,
        runner: new WindowsNativeExecutionRunner({ moduleDirectory }),
      });
      taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor);

      const created = taskSupervisor.create({
        ownerClientId: taskOwner,
        idempotencyKey: "task-supervisor-native-publish-failure-0001",
        scopes: ["execution.run"],
        plan: {
          version: 1,
          maxDurationMs: 60_000,
          steps: [{
            stepId: "must_not_dispatch",
            kind: "execution",
            command: {
              engine: "program",
              executable: process.execPath,
              args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'unexpected')`],
              cwd: workspace.root,
            },
            timeoutSeconds: 20,
          }],
        },
      });

      const replace = taskStore.replace.bind(taskStore);
      replaceSpy = vi.spyOn(taskStore, "replace").mockImplementation((next) => {
        replace(next);
        if (next.state === "RUNNING" && next.dispatchJournal.length === 0) {
          fs.chmodSync(taskFile!, 0o444);
        }
      });
      startSpy = vi.spyOn(executionSupervisor, "startFullAccess");
      spawnSyncSpy = vi.spyOn(childProcess, "spawnSync");

      const run = taskSupervisor.run(created.task.taskId, taskOwner);
      let publishError: unknown;
      try { await run; } catch (error) { publishError = error; }
      expect(publishError).toBeInstanceOf(AtomicReplaceError);
      expect(publishError).toMatchObject({ stage: "publish", systemCode: "EACCES" });

      const nativeCalls = spawnSyncSpy.mock.calls.filter(([, args]) => args?.[0] === "--durable-atomic-publish");
      expect(nativeCalls).toHaveLength(2);
      const failedCall = spawnSyncSpy.mock.results.at(-1);
      expect(failedCall?.type).toBe("return");
      if (failedCall?.type === "return") {
        expect(failedCall.value.stdout).toContain("C2C_RESULT|ERROR|5|publish|0");
      }

      expect(taskStore.corruption).toMatchObject({ code: "TASK_STORE_CORRUPT", reason: "write_failed" });
      expect(() => taskStore.get(created.task.taskId)).toThrow("TASK_STORE_CORRUPT");
      expect(startSpy).not.toHaveBeenCalled();
      expect(jobStore.listAll()).toEqual([]);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.readdirSync(taskStore.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);

      const lastCommitted = JSON.parse(fs.readFileSync(taskFile, "utf8")) as { tasks: Array<{ state: string; dispatchJournal: unknown[] }> };
      expect(lastCommitted.tasks[0]).toMatchObject({ state: "RUNNING", dispatchJournal: [] });
      const reloaded = new TaskStore(workspace.id);
      expect(reloaded.get(created.task.taskId)).toMatchObject({ state: "RUNNING", dispatchJournal: [] });
    } finally {
      replaceSpy?.mockRestore();
      startSpy?.mockRestore();
      spawnSyncSpy?.mockRestore();
      if (taskFile && fs.existsSync(taskFile) && fs.statSync(taskFile).isFile()) {
        try { fs.chmodSync(taskFile, 0o600); } catch { /* preserve the original test result */ }
      }
      try {
        await executionSupervisor?.shutdown();
      } finally {
        try {
          await taskSupervisor?.shutdown();
        } finally {
          if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
          else process.env.C2C_STATE_DIR = previousStateRoot;
        }
      }
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("reconciles a real Native child after recreating all persistent runtime stores", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("task-native-restart-state");
    const workspaceRoot = makeSystemTempDir("task-native-restart-workspace");
    const markerPath = path.join(stateRoot, "native-task-restart.txt");
    const markerLine = "executed-once\n";
    const runnerFailures: string[] = [];
    let executionSupervisor: ExecutionSupervisor | undefined;
    let taskSupervisor: TaskSupervisor | undefined;
    let restartedExecutionSupervisor: ExecutionSupervisor | undefined;
    let restartedTaskSupervisor: TaskSupervisor | undefined;

    process.env.C2C_STATE_DIR = stateRoot;

    try {
      const workspace = new Workspace(workspaceRoot);
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();

      const taskStore = new TaskStore(workspace.id);
      const jobStore = new ExecutionJobStore(workspace.id);
      executionSupervisor = new ExecutionSupervisor(workspace, {
        store: jobStore,
        runner: captureRunnerFailure(new WindowsNativeExecutionRunner({ moduleDirectory }), runnerFailures),
      });
      taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor);
      const ownerClientId = "task-supervisor-native-restart-client";
      const plan: PersistentTaskPlan = {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{
          stepId: "execute_once",
          kind: "execution",
          command: {
            engine: "program",
            executable: process.execPath,
            args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerLine)})`],
            cwd: workspace.root,
          },
          timeoutSeconds: 20,
        }],
      };
      const created = taskSupervisor.create({
        ownerClientId,
        idempotencyKey: "task-supervisor-native-restart-0001",
        scopes: ["execution.run"],
        plan,
      });
      const running = transitionTask(created.task, "RUNNING", { currentStep: 0 });
      taskStore.replace(running);
      const prepared = prepareTaskExecutionDispatch(running, "execute_once", 1);
      taskStore.replace(prepared.task);
      const step = plan.steps[0];
      if (!step || step.kind !== "execution") throw new Error("NATIVE_RESTART_STEP_NOT_EXECUTION");
      const grant = readCurrentSessionGrant(workspace.id)!;
      const started = await executionSupervisor.startFullAccess({
        ...step.command,
        timeoutSeconds: step.timeoutSeconds,
        idempotencyKey: prepared.entry.childIdempotencyKey,
        oauthClientId: ownerClientId,
        scopes: created.task.authBinding.requiredScopes,
      }, grant);
      if (!started.ok) throw new Error(started.error);
      const childJobId = started.job.jobId;
      await waitUntil(() => {
        const child = executionSupervisor?.store.get(childJobId);
        return child?.state === "succeeded" || child?.state === "failed" || child?.state === "interrupted" || child?.state === "timed_out";
      });
      expect(executionSupervisor.store.get(childJobId)?.state, runnerFailures.join("\n")).toBe("succeeded");
      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);

      await taskSupervisor.shutdown();
      await executionSupervisor.shutdown();
      taskSupervisor = undefined;
      executionSupervisor = undefined;

      fs.mkdirSync(path.join(jobStore.directory, ".archive", "jobs"), { recursive: true });
      const reloadedTaskStore = new TaskStore(workspace.id);
      const reloadedJobStore = new ExecutionJobStore(workspace.id);
      restartedExecutionSupervisor = new ExecutionSupervisor(workspace, {
        store: reloadedJobStore,
        runner: captureRunnerFailure(new WindowsNativeExecutionRunner({ moduleDirectory }), runnerFailures),
      });
      restartedTaskSupervisor = new TaskSupervisor(workspace, reloadedTaskStore, restartedExecutionSupervisor, { requireRecovery: true });
      await restartedTaskSupervisor.recover();

      expect(reloadedTaskStore.get(created.task.taskId)).toMatchObject({
        state: "COMPLETED",
        dispatchJournal: [{
          stepId: "execute_once",
          childJobId,
          phase: "CHECKPOINTED",
        }],
      });
      expect(reloadedJobStore.listAll()).toHaveLength(1);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);
    } finally {
      try {
        await executionSupervisor?.shutdown();
      } finally {
        try {
          await taskSupervisor?.shutdown();
        } finally {
          try {
            await restartedExecutionSupervisor?.shutdown();
          } finally {
            try {
              await restartedTaskSupervisor?.shutdown();
            } finally {
              if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
              else process.env.C2C_STATE_DIR = previousStateRoot;
            }
          }
        }
      }
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("fails closed when a Native child is running during runtime reconstruction", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("task-native-running-restart-state");
    const workspaceRoot = makeSystemTempDir("task-native-running-restart-workspace");
    const markerPath = path.join(stateRoot, "native-task-running-restart.txt");
    const readyPath = path.join(stateRoot, "native-task-running-ready.txt");
    const markerLine = "executed-once\n";
    const runnerFailures: string[] = [];
    const runnerHandles: NativeRunnerHandle[] = [];
    let executionSupervisor: ExecutionSupervisor | undefined;
    let taskSupervisor: TaskSupervisor | undefined;
    let restartedExecutionSupervisor: ExecutionSupervisor | undefined;
    let restartedTaskSupervisor: TaskSupervisor | undefined;

    process.env.C2C_STATE_DIR = stateRoot;

    try {
      const workspace = new Workspace(workspaceRoot);
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();

      const taskStore = new TaskStore(workspace.id);
      const jobStore = new ExecutionJobStore(workspace.id);
      executionSupervisor = new ExecutionSupervisor(workspace, {
        store: jobStore,
        runner: captureRunnerFailure(
          new WindowsNativeExecutionRunner({ moduleDirectory }),
          runnerFailures,
          runnerHandles,
        ),
      });
      taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor);
      const ownerClientId = "task-supervisor-native-running-restart-client";
      const plan: PersistentTaskPlan = {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{
          stepId: "execute_once",
          kind: "execution",
          command: {
            engine: "program",
            executable: process.execPath,
            args: ["-e", [
              "const fs = require('node:fs')",
              `fs.appendFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(markerLine)})`,
              `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready', { flag: 'wx' })`,
              "setInterval(() => {}, 1000)",
            ].join(";")],
            cwd: workspace.root,
          },
          timeoutSeconds: 45,
        }],
      };
      const created = taskSupervisor.create({
        ownerClientId,
        idempotencyKey: "task-supervisor-native-running-restart-0001",
        scopes: ["execution.run"],
        plan,
      });
      const running = transitionTask(created.task, "RUNNING", { currentStep: 0 });
      taskStore.replace(running);
      const prepared = prepareTaskExecutionDispatch(running, "execute_once", 1);
      taskStore.replace(prepared.task);
      const step = plan.steps[0];
      if (!step || step.kind !== "execution") throw new Error("NATIVE_RUNNING_RESTART_STEP_NOT_EXECUTION");
      const grant = readCurrentSessionGrant(workspace.id)!;
      const started = await executionSupervisor.startFullAccess({
        ...step.command,
        timeoutSeconds: step.timeoutSeconds,
        idempotencyKey: prepared.entry.childIdempotencyKey,
        oauthClientId: ownerClientId,
        scopes: created.task.authBinding.requiredScopes,
      }, grant);
      if (!started.ok) throw new Error(started.error);
      const childJobId = started.job.jobId;

      await waitUntil(() => fs.existsSync(readyPath) && executionSupervisor?.store.get(childJobId)?.state === "running");
      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);
      expect(executionSupervisor.store.get(childJobId)?.state).toBe("running");
      expect(runnerHandles).toHaveLength(1);

      // Persist CHILD_BOUND without asking the old TaskSupervisor to observe the child.
      taskStore.replace(bindTaskExecutionChild(prepared.task, step.stepId, childJobId, new Date().toISOString()));
      expect(taskStore.get(created.task.taskId)?.dispatchJournal).toMatchObject([{
        stepId: step.stepId,
        childIdempotencyKey: prepared.entry.childIdempotencyKey,
        childJobId,
        phase: "CHILD_BOUND",
      }]);

      // Closing the owner pipe exercises the Native helper's real Job Object cleanup contract.
      // Keep the old supervisors from observing completion until the new stores recover.
      runnerHandles[0]!.abandon();

      const reloadedTaskStore = new TaskStore(workspace.id);
      const reloadedJobStore = new ExecutionJobStore(workspace.id);
      expect(reloadedTaskStore).not.toBe(taskStore);
      expect(reloadedJobStore).not.toBe(jobStore);
      expect(reloadedJobStore.get(childJobId)).toMatchObject({
        state: "interrupted",
        failureCode: "BRIDGE_RESTARTED",
      });
      restartedExecutionSupervisor = new ExecutionSupervisor(workspace, {
        store: reloadedJobStore,
        runner: captureRunnerFailure(new WindowsNativeExecutionRunner({ moduleDirectory }), runnerFailures),
      });
      restartedTaskSupervisor = new TaskSupervisor(
        workspace,
        reloadedTaskStore,
        restartedExecutionSupervisor,
        { requireRecovery: true },
      );
      expect(restartedExecutionSupervisor).not.toBe(executionSupervisor);
      expect(restartedTaskSupervisor).not.toBe(taskSupervisor);
      await restartedTaskSupervisor.recover();

      expect(reloadedTaskStore.get(created.task.taskId)).toMatchObject({
        state: "WAITING_FOR_MODEL",
        waitingReason: "BRIDGE_RESTARTED",
        dispatchJournal: [{
          stepId: step.stepId,
          childIdempotencyKey: prepared.entry.childIdempotencyKey,
          childJobId,
          phase: "CHILD_BOUND",
        }],
      });
      expect(reloadedJobStore.listAll().map((job) => job.jobId)).toEqual([childJobId]);

      // The helper's EOF path must finish terminating the old child before the test exits.
      await runnerHandles[0]!.completion.catch(() => undefined);
      expect(fs.readFileSync(markerPath, "utf8")).toBe(markerLine);
      expect(reloadedJobStore.get(childJobId)?.state).toBe("interrupted");
    } finally {
      try {
        await restartedTaskSupervisor?.shutdown();
      } finally {
        try {
          await restartedExecutionSupervisor?.shutdown();
        } finally {
          try {
            await taskSupervisor?.shutdown();
          } finally {
            try {
              await executionSupervisor?.shutdown();
            } finally {
              if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
              else process.env.C2C_STATE_DIR = previousStateRoot;
            }
          }
        }
      }
    }
  }, 90_000);
});
