import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/shared/canonical-json.js";
import { TaskStore, MAX_TASK_RESULTS_BYTES, MAX_TASK_STORE_BYTES } from "../src/tasks/task-store.js";
import { canonicalizeTaskResult, createChildIdempotencyKey, taskPlanHash, type PersistentTask, type PersistentTaskPlan } from "../src/tasks/task-types.js";
import { makeTmpDir, write } from "./helpers.js";

const WORKSPACE_ID = "012345abcdef";
const CREATED_AT = "2026-10-19T00:00:00.000Z";
const PLAN_DURATION_MS = 10_000;

function taskPlan(stepIds: string[] = ["read"]): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: PLAN_DURATION_MS,
    steps: stepIds.map((stepId, index) => ({
      stepId,
      kind: "batch_read" as const,
      request: { items: [{ id: `item_${index}`, path: `src/${index}.ts` }] },
    })),
  };
}

function makeTask(plan = taskPlan()): PersistentTask {
  return {
    taskId: "task_id_0123456789abcdef",
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    ownerClientId: "client-a",
    idempotencyKeyHash: "a".repeat(64),
    authBinding: {
      workspaceId: WORKSPACE_ID,
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
  const task = makeTask(plan);
  task.authBinding = {
    workspaceId: WORKSPACE_ID,
    sessionIdentityFingerprint: "b".repeat(64),
    grantId: "c".repeat(64),
    permissionMode: "level2",
    requiredScopes: ["execution.run"],
  };
  return task;
}

function checkpoint(task: PersistentTask, stepId: string): PersistentTask["checkpoints"][number] {
  const result = canonicalizeTaskResult({ status: "ok" });
  return {
    stepId,
    completedAt: task.updatedAt,
    result: result.result,
    resultHash: result.resultHash,
    resultBytes: result.resultBytes,
  };
}

function writeStore(name: string, text: string, workspaceId = WORKSPACE_ID): { directory: string; file: string } {
  const directory = makeTmpDir(name);
  const file = write(directory, "tasks.json", text);
  return { directory, file };
}

function storeEnvelope(workspaceId: string, tasks: unknown[]): string {
  return canonicalJson({ version: 1, workspaceId, tasks });
}

describe("TaskStore corruption handling", () => {
  it("fails closed on corrupt JSON and preserves the original bytes", () => {
    const original = "{ truncated task store";
    const { directory, file } = writeStore("task-store-invalid-json", original);
    const store = new TaskStore(WORKSPACE_ID, { directory });

    expect(store.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_json" });
    expect(() => store.get("task_id_0123456789abcdef")).toThrow("TASK_STORE_CORRUPT");
    expect(() => store.listForClient("client-a")).toThrow("TASK_STORE_CORRUPT");
    expect(() => store.findIdempotent("client-a", "a".repeat(64))).toThrow("TASK_STORE_CORRUPT");
    expect(() => store.create(makeTask())).toThrow("TASK_STORE_CORRUPT");
    expect(() => store.replace(makeTask())).toThrow("TASK_STORE_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("rejects unknown envelope schemas and unknown record fields without rewriting evidence", () => {
    const cases: Array<{ name: string; text: string; reason: string }> = [
      {
        name: "unknown-version",
        text: JSON.stringify({ version: 2, workspaceId: WORKSPACE_ID, tasks: [] }),
        reason: "unsupported_schema",
      },
      {
        name: "unknown-envelope-field",
        text: JSON.stringify({ version: 1, workspaceId: WORKSPACE_ID, tasks: [], future: true }),
        reason: "unsupported_schema",
      },
      {
        name: "unknown-record-field",
        text: storeEnvelope(WORKSPACE_ID, [{ ...makeTask(), future: true }]),
        reason: "invalid_record",
      },
    ];

    for (const entry of cases) {
      const { directory, file } = writeStore(`task-store-${entry.name}`, entry.text);
      const first = new TaskStore(WORKSPACE_ID, { directory });
      const second = new TaskStore(WORKSPACE_ID, { directory });
      expect(first.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: entry.reason });
      expect(second.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: entry.reason });
      expect(() => second.get("task_id_0123456789abcdef")).toThrow("TASK_STORE_CORRUPT");
      expect(fs.readFileSync(file, "utf8")).toBe(entry.text);
    }
  });

  it("rejects workspace mismatch, impossible Task states, and invalid child references", () => {
    const valid = makeTask();
    const impossibleState = {
      ...valid,
      stepStates: [{ stepId: "read", state: "running" }],
    };
    const invalidChildReference = {
      ...valid,
      state: "RUNNING",
      currentStep: 0,
      stepStates: [{ stepId: "read", state: "running" }],
      dispatchJournal: [{
        stepId: "read",
        attempt: 1,
        childIdempotencyKey: "c2c-task-v1-wrong",
        phase: "CHILD_BOUND",
        childJobId: "bad child id",
      }],
      updatedAt: "2026-10-19T00:00:01.000Z",
    };
    const cases: Array<{ name: string; workspaceId: string; tasks: unknown[]; reason: string }> = [
      { name: "workspace-mismatch", workspaceId: "fedcba654321", tasks: [], reason: "workspace_mismatch" },
      { name: "impossible-queued-state", workspaceId: WORKSPACE_ID, tasks: [impossibleState], reason: "invalid_record" },
      { name: "invalid-child-reference", workspaceId: WORKSPACE_ID, tasks: [invalidChildReference], reason: "invalid_record" },
    ];

    for (const entry of cases) {
      const { directory } = writeStore(`task-store-${entry.name}`, storeEnvelope(entry.workspaceId, entry.tasks));
      const store = new TaskStore(WORKSPACE_ID, { directory });
      expect(store.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: entry.reason });
    }
  });

  it("rejects a skipped current step and later success without prior checkpoint progression", () => {
    const plan = taskPlan(["first", "second", "third"]);
    const skippedCurrent = makeTask(plan);
    skippedCurrent.state = "RUNNING";
    skippedCurrent.updatedAt = "2026-10-19T00:00:01.000Z";
    skippedCurrent.currentStep = 1;
    skippedCurrent.stepStates = [
      { stepId: "first", state: "pending" },
      { stepId: "second", state: "running" },
      { stepId: "third", state: "pending" },
    ];

    const forwardSkip = makeTask(plan);
    forwardSkip.state = "RUNNING";
    forwardSkip.updatedAt = "2026-10-19T00:00:02.000Z";
    forwardSkip.currentStep = 1;
    forwardSkip.stepStates = [
      { stepId: "first", state: "succeeded" },
      { stepId: "second", state: "pending" },
      { stepId: "third", state: "succeeded" },
    ];
    forwardSkip.checkpoints = [checkpoint(forwardSkip, "first"), checkpoint(forwardSkip, "third")];

    for (const [name, task] of [["current-step-skip", skippedCurrent], ["forward-step-skip", forwardSkip]] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("requires incomplete execution journal phases to match the running current step", () => {
    const childJobId = "child_job_0123456789abcdef";
    const prepared = makeExecutionTask();
    prepared.state = "RUNNING";
    prepared.updatedAt = "2026-10-19T00:00:01.000Z";
    prepared.currentStep = 0;
    prepared.dispatchJournal = [{
      stepId: "exec",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey(prepared.taskId, "exec", 1),
      phase: "PREPARED",
    }];

    const childBound = makeExecutionTask();
    childBound.state = "RUNNING";
    childBound.updatedAt = "2026-10-19T00:00:01.000Z";
    childBound.currentStep = 0;
    childBound.stepStates = [{ stepId: "exec", state: "pending" }];
    childBound.dispatchJournal = [{
      stepId: "exec",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey(childBound.taskId, "exec", 1),
      phase: "CHILD_BOUND",
      childJobId,
    }];

    const observed = makeExecutionTask();
    observed.state = "RUNNING";
    observed.updatedAt = "2026-10-19T00:00:01.000Z";
    observed.currentStep = 0;
    observed.stepStates = [{ stepId: "exec", state: "failed" }];
    observed.dispatchJournal = [{
      stepId: "exec",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey(observed.taskId, "exec", 1),
      phase: "OBSERVED",
      childJobId,
      observed: {
        state: "failed",
        exitCode: 1,
        failureCode: "NONZERO_EXIT",
        finishedAt: observed.updatedAt,
      },
    }];

    for (const [name, task] of [["prepared-pending-step", prepared], ["child-bound-pending-step", childBound], ["observed-failed-step", observed]] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("accepts WAITING_FOR_MODEL and rejects incomplete journals outside explicit fail-closed states", () => {
    const makePrepared = (): PersistentTask => {
      const task = makeExecutionTask();
      task.updatedAt = "2026-10-19T00:00:01.000Z";
      task.currentStep = 0;
      task.dispatchJournal = [{
        stepId: "exec",
        attempt: 1,
        childIdempotencyKey: createChildIdempotencyKey(task.taskId, "exec", 1),
        phase: "PREPARED",
      }];
      return task;
    };
    const failedRunning = makePrepared();
    failedRunning.state = "FAILED";
    failedRunning.failureReason = "EXECUTION_START_REJECTED";
    failedRunning.stepStates = [{ stepId: "exec", state: "running" }];

    const interruptedWithoutReason = makePrepared();
    interruptedWithoutReason.state = "INTERRUPTED";
    interruptedWithoutReason.stepStates = [{ stepId: "exec", state: "failed" }];

    const waitingFailed = makePrepared();
    waitingFailed.state = "WAITING_FOR_MODEL";
    waitingFailed.waitingReason = "OUTCOME_REVIEW_REQUIRED";
    waitingFailed.stepStates = [{ stepId: "exec", state: "failed" }];

    const runningFailed = makePrepared();
    runningFailed.state = "RUNNING";
    runningFailed.stepStates = [{ stepId: "exec", state: "failed" }];

    const waitingDirectory = writeStore("task-store-waiting-model", storeEnvelope(WORKSPACE_ID, [waitingFailed]));
    expect(new TaskStore(WORKSPACE_ID, { directory: waitingDirectory.directory }).corruption).toBeNull();

    for (const [name, task] of [
      ["failed-running-step", failedRunning],
      ["interrupted-no-reason", interruptedWithoutReason],
      ["running-failed-step", runningFailed],
    ] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("requires execution success and failure checkpoints to have CHECKPOINTED journals", () => {
    const succeeded = makeExecutionTask();
    succeeded.state = "COMPLETED";
    succeeded.updatedAt = "2026-10-19T00:00:02.000Z";
    succeeded.currentStep = null;
    succeeded.stepStates = [{ stepId: "exec", state: "succeeded" }];
    succeeded.checkpoints = [checkpoint(succeeded, "exec")];

    const failed = makeExecutionTask();
    failed.state = "FAILED";
    failed.failureReason = "NONZERO_EXIT";
    failed.updatedAt = "2026-10-19T00:00:02.000Z";
    failed.currentStep = 0;
    failed.stepStates = [{ stepId: "exec", state: "failed" }];
    failed.checkpoints = [checkpoint(failed, "exec")];

    for (const [name, task] of [["succeeded-without-journal", succeeded], ["failed-without-journal", failed]] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("rejects all-succeeded terminal Tasks unless they are COMPLETED or deadline-failed", () => {
    const otherFailure = makeTask();
    otherFailure.state = "FAILED";
    otherFailure.failureReason = "EXECUTION_OUTCOME_UNKNOWN";
    otherFailure.updatedAt = "2026-10-19T00:00:20.000Z";
    otherFailure.currentStep = null;
    otherFailure.stepStates = [{ stepId: "read", state: "succeeded" }];
    otherFailure.checkpoints = [checkpoint(otherFailure, "read")];

    const interruptedDeadline = makeTask();
    interruptedDeadline.state = "INTERRUPTED";
    interruptedDeadline.failureReason = "TASK_DEADLINE_EXCEEDED";
    interruptedDeadline.updatedAt = "2026-10-19T00:00:20.000Z";
    interruptedDeadline.currentStep = null;
    interruptedDeadline.stepStates = [{ stepId: "read", state: "succeeded" }];
    interruptedDeadline.checkpoints = [checkpoint(interruptedDeadline, "read")];

    for (const [name, task] of [["other-failure-all-succeeded", otherFailure], ["interrupted-all-succeeded", interruptedDeadline]] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("rejects unknown plan-step and dispatch-journal fields", () => {
    const unknownStep = makeTask();
    (unknownStep.plan.steps[0] as unknown as Record<string, unknown>).futureField = true;

    const executionPlan: PersistentTaskPlan = {
      version: 1,
      maxDurationMs: PLAN_DURATION_MS,
      steps: [{
        stepId: "exec",
        kind: "execution",
        command: { engine: "program", executable: "node.exe", args: ["--version"], cwd: "." },
        timeoutSeconds: 1,
      }],
    };
    const unknownJournal = makeTask(executionPlan);
    unknownJournal.authBinding = {
      workspaceId: WORKSPACE_ID,
      sessionIdentityFingerprint: "b".repeat(64),
      grantId: "c".repeat(64),
      permissionMode: "level2",
      requiredScopes: ["execution.run"],
    };
    unknownJournal.state = "RUNNING";
    unknownJournal.updatedAt = "2026-10-19T00:00:01.000Z";
    unknownJournal.currentStep = 0;
    unknownJournal.stepStates = [{ stepId: "exec", state: "running" }];
    unknownJournal.dispatchJournal = [{
      stepId: "exec",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey(unknownJournal.taskId, "exec", 1),
      phase: "PREPARED",
      futureField: true,
    } as never];

    for (const [name, task] of [["unknown-step", unknownStep], ["unknown-journal", unknownJournal]] as const) {
      const { directory } = writeStore(`task-store-${name}`, storeEnvelope(WORKSPACE_ID, [task]));
      expect(new TaskStore(WORKSPACE_ID, { directory }).corruption)
        .toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
    }
  });

  it("checks the hard store byte cap before JSON parsing", () => {
    const directory = makeTmpDir("task-store-oversized-envelope");
    const file = path.join(directory, "tasks.json");
    fs.writeFileSync(file, "");
    const fd = fs.openSync(file, "r+");
    try { fs.ftruncateSync(fd, MAX_TASK_STORE_BYTES + 1); } finally { fs.closeSync(fd); }

    const parse = vi.spyOn(JSON, "parse");
    try {
      const store = new TaskStore(WORKSPACE_ID, { directory });
      expect(store.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "store_too_large" });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("rejects too many persisted Tasks and oversized cumulative checkpoint results", () => {
    const tooMany = Array.from({ length: 33 }, (_, index) => {
      const task = makeTask();
      task.taskId = `task_${String(index).padStart(20, "0")}`;
      task.ownerClientId = `client-${index}`;
      task.idempotencyKeyHash = index.toString(16).padStart(64, "0");
      return task;
    });
    const countStore = new TaskStore(WORKSPACE_ID, {
      directory: writeStore("task-store-too-many-records", storeEnvelope(WORKSPACE_ID, tooMany)).directory,
    });
    expect(countStore.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "too_many_tasks" });

    const plan = taskPlan(["first", "second"]);
    const task = makeTask(plan);
    task.state = "COMPLETED";
    task.currentStep = null;
    task.stepStates = plan.steps.map((step) => ({ stepId: step.stepId, state: "succeeded" }));
    task.updatedAt = "2026-10-19T00:00:02.000Z";
    const large = canonicalizeTaskResult("x".repeat(600 * 1024));
    task.checkpoints = plan.steps.map((step) => ({
      stepId: step.stepId,
      completedAt: task.updatedAt,
      result: large.result,
      resultHash: large.resultHash,
      resultBytes: large.resultBytes,
    }));
    expect(task.checkpoints.reduce((sum, item) => sum + item.resultBytes, 0)).toBeGreaterThan(MAX_TASK_RESULTS_BYTES);
    const resultStore = new TaskStore(WORKSPACE_ID, {
      directory: writeStore("task-store-oversized-results", storeEnvelope(WORKSPACE_ID, [task])).directory,
    });
    expect(resultStore.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
  });

  it("rejects a checkpoint over the per-result cap", () => {
    const task = makeTask();
    task.state = "COMPLETED";
    task.currentStep = null;
    task.stepStates = [{ stepId: "read", state: "succeeded" }];
    task.updatedAt = "2026-10-19T00:00:02.000Z";
    task.checkpoints = [{
      stepId: "read",
      completedAt: task.updatedAt,
      result: "x".repeat(1024 * 1024 + 1),
      resultHash: "b".repeat(64),
      resultBytes: 1024 * 1024 + 3,
    }];
    const store = new TaskStore(WORKSPACE_ID, {
      directory: writeStore("task-store-oversized-single-result", storeEnvelope(WORKSPACE_ID, [task])).directory,
    });
    expect(store.corruption).toEqual({ code: "TASK_STORE_CORRUPT", reason: "invalid_record" });
  });
});
