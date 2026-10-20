import { describe, expect, it } from "vitest";
import {
  createChildIdempotencyKey,
  taskPlanHash,
  type PersistentTask,
  type PersistentTaskPlan,
  type ObservedExecutionOutcome,
  type TaskDispatchJournalEntry,
  type TaskStepState,
} from "../src/tasks/task-types.js";
import {
  TaskJournalError,
  bindTaskExecutionChild,
  checkpointTaskExecution,
  getTaskDispatchJournalEntry,
  observeTaskExecutionChild,
  prepareTaskExecutionDispatch,
} from "../src/tasks/task-journal.js";
import { transitionTask } from "../src/tasks/task-state-machine.js";

const AT_1 = "2026-10-19T00:00:01.000Z";
const AT_2 = "2026-10-19T00:00:02.000Z";
const AT_3 = "2026-10-19T00:00:03.000Z";
const AT_4 = "2026-10-19T00:00:04.000Z";
const AT_5 = "2026-10-19T00:00:05.000Z";
const AT_6 = "2026-10-19T00:00:06.000Z";
const AT_7 = "2026-10-19T00:00:07.000Z";
const AT_8 = "2026-10-19T00:00:08.000Z";
const CHILD_JOB_ID = "job_12345678901234567890123456789012";
const SECOND_CHILD_JOB_ID = "job_22345678901234567890123456789012";

function makePlan(): PersistentTaskPlan {
  return {
    version: 1,
    maxDurationMs: 60_000,
    steps: [
      {
        stepId: "build",
        kind: "execution",
        command: { engine: "program", executable: "node.exe", args: ["--version"], cwd: "." },
        timeoutSeconds: 20,
      },
      {
        stepId: "lint",
        kind: "execution",
        command: { engine: "program", executable: "node.exe", args: ["--version"], cwd: "." },
        timeoutSeconds: 20,
      },
    ],
  };
}

function makeTask(overrides: Partial<PersistentTask> = {}): PersistentTask {
  const plan = makePlan();
  const base: PersistentTask = {
    taskId: "task_id_0123456789abcdef",
    schemaVersion: 1,
    workspaceId: "012345abcdef",
    ownerClientId: "client-a",
    idempotencyKeyHash: "a".repeat(64),
    authBinding: {
      workspaceId: "012345abcdef",
      sessionIdentityFingerprint: "b".repeat(64),
      grantId: "c".repeat(64),
      permissionMode: "level2",
      requiredScopes: ["execution.run"],
    },
    plan,
    planHash: taskPlanHash(plan),
    state: "RUNNING",
    createdAt: AT_1,
    updatedAt: AT_1,
    deadlineAt: "2026-10-19T01:00:00.000Z",
    currentStep: 0,
    stepStates: [
      { stepId: "build", state: "pending" },
      { stepId: "lint", state: "pending" },
    ],
    dispatchJournal: [],
    checkpoints: [],
    failureReason: null,
    waitingReason: null,
  };
  return { ...base, ...overrides };
}

function prepare(task = makeTask(), stepId = "build", attempt = 1): PersistentTask {
  return prepareTaskExecutionDispatch(task, stepId, attempt, AT_1).task;
}

function bound(task = prepare()): PersistentTask {
  return bindTaskExecutionChild(task, "build", CHILD_JOB_ID, AT_2);
}

function observed(task = bound(), outcome: ObservedExecutionOutcome = {
  state: "succeeded",
  exitCode: 0,
  failureCode: null,
  finishedAt: AT_3,
}): PersistentTask {
  return observeTaskExecutionChild(task, "build", outcome, AT_3);
}

function expectJournalError(action: () => unknown, code: TaskJournalError["code"]): void {
  try {
    action();
    throw new Error("Expected TaskJournalError");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskJournalError);
    expect((error as TaskJournalError).code).toBe(code);
  }
}

describe("Persistent Task execution dispatch journal", () => {
  it("prepares one stable child dispatch and returns detached task and entry copies", () => {
    const input = makeTask();
    const original = structuredClone(input);
    const prepared = prepareTaskExecutionDispatch(input, "build", 1, AT_1);

    expect(prepared.entry).toEqual({
      stepId: "build",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey(input.taskId, "build", 1),
      phase: "PREPARED",
    });
    expect(prepared.task.dispatchJournal).toEqual([prepared.entry]);
    expect(prepared.task.dispatchJournal[0]).not.toBe(prepared.entry);
    expect(prepared.task.stepStates[0]).toEqual({ stepId: "build", state: "running" });
    expect(prepared.task.updatedAt).toBe(AT_1);
    expect(input).toEqual(original);

    prepared.entry.phase = "CHILD_BOUND";
    prepared.task.stepStates[0]!.state = "failed";
    expect(input).toEqual(original);
  });

  it("requires a running task, current execution step, pending state, and positive attempt", () => {
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask({ state: "QUEUED" }), "build", 1, AT_1), "JOURNAL_CONFLICT");
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask({ currentStep: 1 }), "build", 1, AT_1), "INVALID_STEP");
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask({ stepStates: [
      { stepId: "build", state: "failed" }, { stepId: "lint", state: "pending" },
    ] }), "build", 1, AT_1), "JOURNAL_CONFLICT");
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask(), "build", 0, AT_1), "INVALID_ATTEMPT");
  });

  it("rejects attempts above one because this wave does not retry execution commands", () => {
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask(), "build", 2, AT_1), "INVALID_ATTEMPT");
  });

  it("rejects a non-execution step and malformed task step-state references", () => {
    const plan = makePlan();
    plan.steps[0] = { stepId: "read", kind: "batch_read", request: { items: [{ id: "file", path: "a.txt" }] } };
    const readTask = makeTask({ plan, planHash: taskPlanHash(plan), currentStep: 0, stepStates: [
      { stepId: "read", state: "pending" }, { stepId: "lint", state: "pending" },
    ] });
    expectJournalError(() => prepareTaskExecutionDispatch(readTask, "read", 1, AT_1), "INVALID_STEP");
    expectJournalError(() => prepareTaskExecutionDispatch(makeTask({ stepStates: [{ stepId: "other", state: "pending" }] }), "build", 1, AT_1), "INVALID_TASK");
  });

  it("allows only one uncheckpointed child journal across the whole task", () => {
    const existing: TaskDispatchJournalEntry = {
      stepId: "build",
      attempt: 1,
      childIdempotencyKey: createChildIdempotencyKey("task_id_0123456789abcdef", "build", 1),
      phase: "PREPARED",
    };
    const task = makeTask({ currentStep: 1, stepStates: [
      { stepId: "build", state: "running" }, { stepId: "lint", state: "pending" },
    ], dispatchJournal: [existing] });
    expectJournalError(() => prepareTaskExecutionDispatch(task, "lint", 1, AT_1), "JOURNAL_CONFLICT");
    expectJournalError(() => prepareTaskExecutionDispatch(prepare(), "build", 1, AT_2), "JOURNAL_CONFLICT");
  });

  it("returns a detached validated journal entry or null when none exists", () => {
    const task = prepare();
    expect(getTaskDispatchJournalEntry(task, "lint")).toBeNull();
    const result = getTaskDispatchJournalEntry(task, "build");
    expect(result).toEqual(task.dispatchJournal[0]);
    expect(result).not.toBe(task.dispatchJournal[0]);
    result!.phase = "OBSERVED";
    expect(task.dispatchJournal[0]!.phase).toBe("PREPARED");
  });

  it("binds only a valid child ID to a PREPARED entry", () => {
    const input = prepare();
    const original = structuredClone(input);
    const result = bindTaskExecutionChild(input, "build", CHILD_JOB_ID, AT_2);
    expect(result.dispatchJournal[0]).toMatchObject({ phase: "CHILD_BOUND", childJobId: CHILD_JOB_ID });
    expect(result.updatedAt).toBe(AT_2);
    expect(input).toEqual(original);
    expectJournalError(() => bindTaskExecutionChild(input, "build", "not-a-job-id", AT_2), "INVALID_CHILD_JOB_ID");
    expectJournalError(() => bindTaskExecutionChild(result, "build", CHILD_JOB_ID, AT_2), "JOURNAL_CONFLICT");
  });

  it("observes only a terminal child outcome after binding", () => {
    const prepared = prepare();
    const runningOutcome = { state: "running", exitCode: null, failureCode: null, finishedAt: null } as unknown as ObservedExecutionOutcome;
    expectJournalError(() => observeTaskExecutionChild(prepared, "build", runningOutcome, AT_3), "INVALID_OUTCOME");
    const input = bound();
    const original = structuredClone(input);
    const outcome: ObservedExecutionOutcome = { state: "failed", exitCode: 1, failureCode: "NONZERO_EXIT", finishedAt: AT_3 };
    const result = observeTaskExecutionChild(input, "build", outcome, AT_3);
    expect(result.dispatchJournal[0]).toMatchObject({ phase: "OBSERVED", observed: outcome });
    expect(result.updatedAt).toBe(AT_3);
    expect(input).toEqual(original);
    expectJournalError(() => observeTaskExecutionChild(result, "build", outcome, AT_3), "JOURNAL_CONFLICT");
  });

  it("checkpoints a successful observed result and advances currentStep", () => {
    const input = observed();
    const original = structuredClone(input);
    const result = checkpointTaskExecution(input, "build", { status: "ok", count: 2 }, AT_4, true);

    expect(result.state).toBe("RUNNING");
    expect(result.currentStep).toBe(1);
    expect(result.stepStates[0]).toEqual({ stepId: "build", state: "succeeded" });
    expect(result.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]).toMatchObject({
      stepId: "build",
      completedAt: AT_4,
      result: { count: 2, status: "ok" },
      resultBytes: 25,
    });
    expect(result.checkpoints[0]?.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(input).toEqual(original);
  });

  it("checkpoints a failed result without advancing the current step", () => {
    const failedOutcome: ObservedExecutionOutcome = {
      state: "failed",
      exitCode: 1,
      failureCode: "NONZERO_EXIT",
      finishedAt: AT_3,
    };
    const input = observed(bound(prepare()), failedOutcome);
    const result = checkpointTaskExecution(input, "build", { error: "exit" }, AT_4, false);

    expect(result.state).toBe("RUNNING");
    expect(result.currentStep).toBe(0);
    expect(result.stepStates[0]).toEqual({ stepId: "build", state: "failed" });
    expect(result.dispatchJournal[0]?.phase).toBe("CHECKPOINTED");
  });

  it("rejects a checkpoint success flag that contradicts the observed child outcome", () => {
    const failedOutcome: ObservedExecutionOutcome = {
      state: "failed",
      exitCode: 1,
      failureCode: "NONZERO_EXIT",
      finishedAt: AT_3,
    };
    const failedTask = observed(bound(prepare()), failedOutcome);
    const originalFailedTask = structuredClone(failedTask);
    expectJournalError(
      () => checkpointTaskExecution(failedTask, "build", { error: "exit" }, AT_4, true),
      "INVALID_CHECKPOINT",
    );
    expect(failedTask).toEqual(originalFailedTask);

    const successfulTask = observed();
    const originalSuccessfulTask = structuredClone(successfulTask);
    expectJournalError(
      () => checkpointTaskExecution(successfulTask, "build", { status: "ok" }, AT_4, false),
      "INVALID_CHECKPOINT",
    );
    expect(successfulTask).toEqual(originalSuccessfulTask);
  });

  it("clears currentStep after the final successful step so completion can be committed with it", () => {
    const firstStep = checkpointTaskExecution(observed(), "build", { status: "built" }, AT_4, true);
    expect(firstStep.currentStep).toBe(1);

    const prepared = prepareTaskExecutionDispatch(firstStep, "lint", 1, AT_5).task;
    const bound = bindTaskExecutionChild(prepared, "lint", SECOND_CHILD_JOB_ID, AT_6);
    const observedFinal = observeTaskExecutionChild(bound, "lint", {
      state: "succeeded",
      exitCode: 0,
      failureCode: null,
      finishedAt: AT_7,
    }, AT_7);
    const finalCheckpoint = checkpointTaskExecution(observedFinal, "lint", { status: "linted" }, AT_8, true);

    expect(finalCheckpoint.currentStep).toBeNull();
    expect(finalCheckpoint.stepStates).toEqual([
      { stepId: "build", state: "succeeded" },
      { stepId: "lint", state: "succeeded" },
    ]);
    expect(finalCheckpoint.dispatchJournal[1]?.phase).toBe("CHECKPOINTED");
    expect(transitionTask(finalCheckpoint, "COMPLETED", {}, AT_8).state).toBe("COMPLETED");
  });

  it("rejects skipped phases and checkpointing before an observed outcome", () => {
    expectJournalError(() => observeTaskExecutionChild(makeTask(), "build", {
      state: "succeeded", exitCode: 0, failureCode: null, finishedAt: AT_3,
    }, AT_3), "JOURNAL_CONFLICT");
    expectJournalError(() => checkpointTaskExecution(bound(), "build", { ok: true }, AT_4, true), "JOURNAL_CONFLICT");
    expectJournalError(() => bindTaskExecutionChild(makeTask(), "build", CHILD_JOB_ID, AT_2), "JOURNAL_CONFLICT");
  });

  it("enforces the one MiB checkpoint cap without advancing or mutating the observed task", () => {
    const input = observed();
    const original = structuredClone(input);
    expectJournalError(() => checkpointTaskExecution(input, "build", "x".repeat(1024 * 1024 + 1), AT_4, true), "INVALID_CHECKPOINT");
    expect(input).toEqual(original);
    expect(input.dispatchJournal[0]?.phase).toBe("OBSERVED");
  });

  it("keeps attempt keys deterministic while distinct attempts receive distinct keys", () => {
    const task = makeTask();
    const first = prepareTaskExecutionDispatch(task, "build", 1, AT_1).entry;
    const secondAttemptKey = createChildIdempotencyKey(task.taskId, "build", 2);
    expect(first.childIdempotencyKey).toBe(createChildIdempotencyKey(task.taskId, "build", 1));
    expect(secondAttemptKey).not.toBe(first.childIdempotencyKey);
  });
});
