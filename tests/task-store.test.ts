import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/shared/canonical-json.js";
import { TaskStore, MAX_TASKS_PER_WORKSPACE } from "../src/tasks/task-store.js";
import {
  canonicalizeTaskResult,
  createChildIdempotencyKey,
  taskPlanHash,
  type PersistentTask,
  type PersistentTaskPlan,
} from "../src/tasks/task-types.js";
import { transitionTask } from "../src/tasks/task-state-machine.js";
import { makeTmpDir, write } from "./helpers.js";

const WORKSPACE_ID = "012345abcdef";
const CREATED_AT = "2026-10-19T00:00:00.000Z";
const PLAN_DURATION_MS = 10_000;

function readPlan(pathValue = "src/index.ts"): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: PLAN_DURATION_MS,
    steps: [{ stepId: "read", kind: "batch_read", request: { items: [{ id: "item", path: pathValue }] } }],
  };
}

function makeTask(options: {
  taskId?: string;
  workspaceId?: string;
  ownerClientId?: string;
  idempotencyKeyHash?: string;
  plan?: PersistentTaskPlan;
} = {}): PersistentTask {
  const plan = options.plan ?? readPlan();
  return {
    taskId: options.taskId ?? "task_id_0123456789abcdef",
    schemaVersion: 1,
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    ownerClientId: options.ownerClientId ?? "client-a",
    idempotencyKeyHash: options.idempotencyKeyHash ?? "a".repeat(64),
    authBinding: {
      workspaceId: options.workspaceId ?? WORKSPACE_ID,
      sessionIdentityFingerprint: null,
      grantId: null,
      permissionMode: "readonly",
      requiredScopes: ["workspace.read"],
    },
    plan,
    planHash: taskPlanHash(plan),
    state: "QUEUED",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deadlineAt: new Date(Date.parse(CREATED_AT) + plan.maxDurationMs).toISOString(),
    currentStep: plan.steps.length > 0 ? 0 : null,
    stepStates: plan.steps.map((step) => ({ stepId: step.stepId, state: "pending" })),
    dispatchJournal: [],
    checkpoints: [],
    failureReason: null,
    waitingReason: null,
  };
}

function makeExecutionTask(): PersistentTask {
  const plan: PersistentTaskPlan = {
    version: 1,
    maxDurationMs: PLAN_DURATION_MS,
    steps: [{
      stepId: "exec",
      kind: "execution",
      command: { engine: "program", executable: "node.exe", args: ["--version"], cwd: "." },
      timeoutSeconds: 1,
    }],
  };
  const task = makeTask({ plan });
  task.authBinding = {
    workspaceId: WORKSPACE_ID,
    sessionIdentityFingerprint: "b".repeat(64),
    grantId: "c".repeat(64),
    permissionMode: "level2",
    requiredScopes: ["execution.run"],
  };
  return task;
}

function envelope(workspaceId: string, tasks: PersistentTask[]): string {
  return canonicalJson({ version: 1, workspaceId, tasks });
}

describe("TaskStore persistence and ownership", () => {
  it("requires Workspace's 12 lowercase hexadecimal identity", () => {
    expect(() => new TaskStore("012345ABCDEf", { directory: makeTmpDir("task-store-invalid-workspace") }))
      .toThrow("workspaceId must be a 12 character lowercase Workspace ID");
    expect(() => new TaskStore("../../escape", { directory: makeTmpDir("task-store-invalid-workspace-path") }))
      .toThrow("workspaceId must be a 12 character lowercase Workspace ID");
  });

  it("opens an empty isolated store and follows the configured state root", () => {
    const previous = process.env.C2C_STATE_DIR;
    const stateRoot = makeTmpDir("task-store-state-root");
    process.env.C2C_STATE_DIR = stateRoot;
    try {
      const store = new TaskStore(WORKSPACE_ID);
      expect(store.directory).toBe(path.join(stateRoot, "persistent-tasks", WORKSPACE_ID));
      expect(store.corruption).toBeNull();
      expect(store.get("task_id_0123456789abcdef")).toBeNull();
      expect(store.listForClient("client-a")).toEqual([]);
      expect(store.findIdempotent("client-a", "a".repeat(64))).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previous;
    }
  });

  it("durably publishes the first tasks.json file, reloads it, and returns detached Task data", () => {
    const directory = makeTmpDir("task-store-create-reload");
    const store = new TaskStore(WORKSPACE_ID, { directory });
    const task = makeTask();
    const created = store.create(task);
    expect(created).toEqual({ task, duplicate: false });
    expect(store.get(task.taskId)).toEqual(task);
    expect(store.findIdempotent(task.ownerClientId, task.idempotencyKeyHash)).toEqual(task);

    const returned = store.get(task.taskId)!;
    returned.plan.steps[0]!.kind = "git_read";
    expect(store.get(task.taskId)).toEqual(task);

    const file = path.join(directory, "tasks.json");
    const persisted = fs.readFileSync(file, "utf8");
    expect(persisted).toBe(envelope(WORKSPACE_ID, [task]));
    expect(persisted).not.toContain("raw idempotency key");
    expect(new TaskStore(WORKSPACE_ID, { directory }).get(task.taskId)).toEqual(task);
  });

  it("durably persists legal state updates and complete checkpoints before exposing them", () => {
    const directory = makeTmpDir("task-store-checkpoint");
    const store = new TaskStore(WORKSPACE_ID, { directory });
    const task = makeTask();
    store.create(task);

    const runningAt = "2026-10-19T00:00:01.000Z";
    const running = transitionTask(task, "RUNNING", {
      currentStep: 0,
      stepStates: [{ stepId: "read", state: "running" }],
    }, runningAt);
    store.replace(running);
    expect(store.get(task.taskId)).toEqual(running);

    const completedAt = "2026-10-19T00:00:02.000Z";
    const canonicalResult = canonicalizeTaskResult({ status: "ok", count: 1 });
    const checkpoint = {
      stepId: "read",
      completedAt: completedAt,
      result: canonicalResult.result,
      resultHash: canonicalResult.resultHash,
      resultBytes: canonicalResult.resultBytes,
    };
    const completed = transitionTask(running, "COMPLETED", {
      currentStep: null,
      stepStates: [{ stepId: "read", state: "succeeded" }],
      checkpoints: [checkpoint],
    }, completedAt);
    store.replace(completed);

    expect(store.get(task.taskId)).toEqual(completed);
    expect(new TaskStore(WORKSPACE_ID, { directory }).get(task.taskId)).toEqual(completed);
  });

  it("persists and reloads an all-succeeded FAILED Task only for the deadline outcome", () => {
    const directory = makeTmpDir("task-store-deadline-failure");
    const store = new TaskStore(WORKSPACE_ID, { directory });
    const task = makeTask();
    store.create(task);
    const runningAt = "2026-10-19T00:00:01.000Z";
    const running = transitionTask(task, "RUNNING", {
      currentStep: 0,
      stepStates: [{ stepId: "read", state: "running" }],
    }, runningAt);
    store.replace(running);

    const completedAt = "2026-10-19T00:00:20.000Z";
    const result = canonicalizeTaskResult({ status: "ok" });
    const deadlineFailed = transitionTask(running, "FAILED", {
      currentStep: null,
      stepStates: [{ stepId: "read", state: "succeeded" }],
      checkpoints: [{
        stepId: "read",
        completedAt,
        result: result.result,
        resultHash: result.resultHash,
        resultBytes: result.resultBytes,
      }],
      failureReason: "TASK_DEADLINE_EXCEEDED",
    }, completedAt);
    store.replace(deadlineFailed);

    expect(deadlineFailed.currentStep).toBeNull();
    expect(deadlineFailed.stepStates).toEqual([{ stepId: "read", state: "succeeded" }]);
    expect(store.get(task.taskId)).toEqual(deadlineFailed);
    expect(new TaskStore(WORKSPACE_ID, { directory }).get(task.taskId)).toEqual(deadlineFailed);
  });

  it("allows current-step advancement after successful checkpoint and validates complete child journal progression", () => {
    const directory = makeTmpDir("task-store-ordered-progress");
    const readPlan: PersistentTaskPlan = {
      version: 1,
      maxDurationMs: PLAN_DURATION_MS,
      steps: [
        { stepId: "first", kind: "batch_read", request: { items: [{ id: "first", path: "src/first.ts" }] } },
        { stepId: "second", kind: "batch_read", request: { items: [{ id: "second", path: "src/second.ts" }] } },
      ],
    };
    const readTask = makeTask({ plan: readPlan });
    const store = new TaskStore(WORKSPACE_ID, { directory });
    store.create(readTask);
    const checkpointAt = "2026-10-19T00:00:01.000Z";
    const firstResult = canonicalizeTaskResult({ status: "ok" });
    const progressed = transitionTask(readTask, "RUNNING", {
      currentStep: 1,
      stepStates: [
        { stepId: "first", state: "succeeded" },
        { stepId: "second", state: "running" },
      ],
      checkpoints: [{
        stepId: "first",
        completedAt: checkpointAt,
        result: firstResult.result,
        resultHash: firstResult.resultHash,
        resultBytes: firstResult.resultBytes,
      }],
    }, checkpointAt);
    store.replace(progressed);
    expect(store.get(readTask.taskId)).toEqual(progressed);

    const executionTask = makeExecutionTask();
    const executionStore = new TaskStore(WORKSPACE_ID, { directory: makeTmpDir("task-store-child-journal") });
    executionStore.create(executionTask);
    const childKey = createChildIdempotencyKey(executionTask.taskId, "exec", 1);
    const running = transitionTask(executionTask, "RUNNING", {
      currentStep: 0,
      stepStates: [{ stepId: "exec", state: "running" }],
      dispatchJournal: [{ stepId: "exec", attempt: 1, childIdempotencyKey: childKey, phase: "PREPARED" }],
    }, "2026-10-19T00:00:01.000Z");
    executionStore.replace(running);
    const childBound = {
      ...running,
      updatedAt: "2026-10-19T00:00:02.000Z",
      dispatchJournal: [{
        stepId: "exec", attempt: 1, childIdempotencyKey: childKey, phase: "CHILD_BOUND" as const,
        childJobId: "child_job_0123456789abcdef",
      }],
    };
    executionStore.replace(childBound);
    const observedAt = "2026-10-19T00:00:03.000Z";
    const observed = {
      ...childBound,
      updatedAt: observedAt,
      dispatchJournal: [{
        ...childBound.dispatchJournal[0]!,
        phase: "OBSERVED" as const,
        observed: { state: "succeeded" as const, exitCode: 0, failureCode: null, finishedAt: observedAt },
      }],
    };
    executionStore.replace(observed);
    const completedAt = "2026-10-19T00:00:04.000Z";
    const result = canonicalizeTaskResult({ state: "succeeded" });
    const completed = transitionTask(observed, "COMPLETED", {
      currentStep: null,
      stepStates: [{ stepId: "exec", state: "succeeded" }],
      checkpoints: [{
        stepId: "exec",
        completedAt,
        result: result.result,
        resultHash: result.resultHash,
        resultBytes: result.resultBytes,
      }],
      dispatchJournal: [{
        ...observed.dispatchJournal[0]!,
        phase: "CHECKPOINTED",
      }],
    }, completedAt);
    executionStore.replace(completed);
    expect(executionStore.get(executionTask.taskId)).toEqual(completed);
  });

  it("persists PREPARED failures and uncertain CHILD_BOUND runs as failed terminal steps without checkpoints", () => {
    const cases = [
      { name: "failed-prepared", terminal: "FAILED" as const, phase: "PREPARED" as const },
      { name: "interrupted-child-bound", terminal: "INTERRUPTED" as const, phase: "CHILD_BOUND" as const },
    ];

    for (const entry of cases) {
      const directory = makeTmpDir(`task-store-${entry.name}`);
      const store = new TaskStore(WORKSPACE_ID, { directory });
      const task = makeExecutionTask();
      store.create(task);
      const childIdempotencyKey = createChildIdempotencyKey(task.taskId, "exec", 1);
      const running = transitionTask(task, "RUNNING", {
        currentStep: 0,
        stepStates: [{ stepId: "exec", state: "running" }],
        dispatchJournal: [{ stepId: "exec", attempt: 1, childIdempotencyKey, phase: "PREPARED" }],
      }, "2026-10-19T00:00:01.000Z");
      store.replace(running);

      let current = running;
      if (entry.phase === "CHILD_BOUND") {
        current = {
          ...running,
          updatedAt: "2026-10-19T00:00:02.000Z",
          dispatchJournal: [{
            stepId: "exec",
            attempt: 1,
            childIdempotencyKey,
            phase: "CHILD_BOUND",
            childJobId: "child_job_0123456789abcdef",
          }],
        };
        store.replace(current);
      }

      const failed = transitionTask(current, entry.terminal, {
        currentStep: 0,
        stepStates: [{ stepId: "exec", state: "failed" }],
        failureReason: entry.terminal === "FAILED" ? "EXECUTION_START_REJECTED" : "EXECUTION_OUTCOME_UNKNOWN",
      }, entry.phase === "CHILD_BOUND" ? "2026-10-19T00:00:03.000Z" : "2026-10-19T00:00:02.000Z");
      store.replace(failed);

      expect(failed.checkpoints).toEqual([]);
      expect(failed.dispatchJournal[0]?.phase).toBe(entry.phase);
      expect(store.get(task.taskId)).toEqual(failed);
      expect(new TaskStore(WORKSPACE_ID, { directory }).get(task.taskId)).toEqual(failed);
    }
  });

  it("isolates workspace paths and refuses cross-workspace records", () => {
    const previous = process.env.C2C_STATE_DIR;
    const stateRoot = makeTmpDir("task-store-workspace-isolation");
    process.env.C2C_STATE_DIR = stateRoot;
    try {
      const first = new TaskStore(WORKSPACE_ID);
      const secondId = "fedcba654321";
      const second = new TaskStore(secondId);
      const firstTask = makeTask();
      first.create(firstTask);

      expect(first.directory).not.toBe(second.directory);
      expect(second.get(firstTask.taskId)).toBeNull();
      expect(() => second.create(firstTask)).toThrow("Invalid Task identity, state, or timestamps");
      expect(new TaskStore(WORKSPACE_ID).get(firstTask.taskId)).toEqual(firstTask);
    } finally {
      if (previous === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previous;
    }
  });

  it("deduplicates by owner and key hash, conflicts on a different plan, and separates owners", () => {
    const directory = makeTmpDir("task-store-idempotency");
    const store = new TaskStore(WORKSPACE_ID, { directory });
    const original = makeTask();
    store.create(original);

    const duplicate = makeTask({ taskId: "task_duplicate_0123456789", plan: readPlan("src/other.ts") });
    duplicate.plan = original.plan;
    duplicate.planHash = original.planHash;
    expect(store.create(duplicate)).toEqual({ task: original, duplicate: true });

    const conflict = makeTask({ taskId: "task_conflict_0123456789", plan: readPlan("src/changed.ts") });
    expect(() => store.create(conflict)).toThrow("IDEMPOTENCY_CONFLICT");

    const otherOwner = makeTask({
      taskId: "task_other_owner_0123456789",
      ownerClientId: "client-b",
      idempotencyKeyHash: original.idempotencyKeyHash,
    });
    expect(store.create(otherOwner)).toEqual({ task: otherOwner, duplicate: false });
    expect(store.findIdempotent("client-b", original.idempotencyKeyHash)).toEqual(otherOwner);
  });

  it("enforces the persistent Task count cap without eviction", () => {
    const directory = makeTmpDir("task-store-capacity");
    const tasks = Array.from({ length: MAX_TASKS_PER_WORKSPACE }, (_, index) => {
      const suffix = String(index).padStart(20, "0");
      return makeTask({ taskId: `task_${suffix}`, ownerClientId: `client-${index}`, idempotencyKeyHash: index.toString(16).padStart(64, "0") });
    });
    write(directory, "tasks.json", envelope(WORKSPACE_ID, tasks));
    const store = new TaskStore(WORKSPACE_ID, { directory });
    const original = fs.readFileSync(path.join(directory, "tasks.json"), "utf8");

    expect(() => store.create(makeTask({ taskId: "task_over_capacity_0123456789", ownerClientId: "client-over", idempotencyKeyHash: "f".repeat(64) })))
      .toThrow("TASK_STORE_FULL");
    expect(fs.readFileSync(path.join(directory, "tasks.json"), "utf8")).toBe(original);
    expect(store.listForClient("client-0")).toHaveLength(1);
  });

  it("fails closed after an atomic replacement error and retains the last persisted checkpoint", () => {
    const directory = makeTmpDir("task-store-write-failure");
    const original = makeTask();
    new TaskStore(WORKSPACE_ID, { directory }).create(original);
    const failing = new TaskStore(WORKSPACE_ID, {
      directory,
      atomicReplace: () => { throw new Error("injected atomic replace failure"); },
    });
    const next = transitionTask(original, "RUNNING", {
      currentStep: 0,
      stepStates: [{ stepId: "read", state: "running" }],
    }, "2026-10-19T00:00:01.000Z");

    expect(() => failing.replace(next)).toThrow("injected atomic replace failure");
    expect(failing.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "write_failed" });
    expect(() => failing.get(original.taskId)).toThrow("TASK_STORE_CORRUPT");
    expect(fs.readFileSync(path.join(directory, "tasks.json"), "utf8")).toBe(envelope(WORKSPACE_ID, [original]));
    expect(fs.readdirSync(directory)).toEqual(["tasks.json"]);
    expect(new TaskStore(WORKSPACE_ID, { directory }).get(original.taskId)).toEqual(original);
  });
});
