import { describe, expect, it } from "vitest";
import {
  TASK_MAX_CHECKPOINT_BYTES,
  TASK_MAX_DURATION_MS,
  TASK_MAX_EXECUTION_STEPS,
  TASK_MAX_EXECUTION_TIMEOUT_SECONDS,
  TASK_MAX_PLAN_BYTES,
  TASK_MAX_STEPS,
  TASK_MIN_EXECUTION_TIMEOUT_SECONDS,
  TaskPlanValidationError,
  canonicalizeTaskResult,
  createChildIdempotencyKey,
  isTaskState,
  taskPlanHash,
  validateTaskPlan,
  type PersistentTask,
  type PersistentTaskPlan,
  type BatchReadTaskStep,
  type ExecutionTaskStep,
  type TaskPlanStep,
  type TaskState,
} from "../src/tasks/task-types.js";
import { canTransitionTask, isTerminalTaskState, transitionTask } from "../src/tasks/task-state-machine.js";
import { canonicalJson } from "../src/shared/canonical-json.js";

function readStep(stepId: string, filePath = "src/index.ts"): BatchReadTaskStep {
  return {
    stepId,
    kind: "batch_read",
    request: { items: [{ id: "item", path: filePath }] },
  };
}

function executionStep(stepId: string): ExecutionTaskStep {
  return {
    stepId,
    kind: "execution",
    command: { engine: "program", executable: "node.exe", args: ["--version"], cwd: "." },
    timeoutSeconds: TASK_MIN_EXECUTION_TIMEOUT_SECONDS,
  };
}

function plan(steps: TaskPlanStep[] = [readStep("read")], maxDurationMs = 1): PersistentTaskPlan {
  return { version: 1, maxDurationMs, steps };
}

function validTask(state: TaskState = "QUEUED"): PersistentTask {
  const taskPlan = plan();
  const timestamp = "2026-10-19T00:00:00.000Z";
  return {
    taskId: "task_id_0123456789abcdef",
    schemaVersion: 1,
    workspaceId: "012345abcdef",
    ownerClientId: "client-a",
    idempotencyKeyHash: "a".repeat(64),
    authBinding: {
      workspaceId: "012345abcdef",
      sessionIdentityFingerprint: null,
      grantId: null,
      permissionMode: "readonly",
      requiredScopes: [],
    },
    plan: taskPlan,
    planHash: taskPlanHash(taskPlan),
    state,
    createdAt: timestamp,
    updatedAt: timestamp,
    deadlineAt: "2026-10-19T00:00:00.001Z",
    currentStep: null,
    stepStates: [{ stepId: "read", state: "pending" }],
    dispatchJournal: [],
    checkpoints: [],
    failureReason: null,
    waitingReason: null,
  };
}

function expectInvalidPlan(value: unknown): void {
  expect(() => validateTaskPlan(value)).toThrow(TaskPlanValidationError);
}

describe("Persistent Task domain state machine", () => {
  it("recognizes only the frozen Task states", () => {
    for (const state of ["QUEUED", "RUNNING", "WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]) {
      expect(isTaskState(state)).toBe(true);
    }
    expect(isTaskState("running")).toBe(false);
    expect(isTaskState("working")).toBe(false);
  });

  it("allows exactly the frozen Task state edges", () => {
    const edges: Record<TaskState, readonly TaskState[]> = {
    QUEUED: ["RUNNING", "WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "INTERRUPTED"],
      RUNNING: ["WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "INTERRUPTED"],
      WAITING_FOR_MODEL: ["CANCELLING", "INTERRUPTED"],
      CANCELLING: ["CANCELLED", "INTERRUPTED"],
      COMPLETED: [],
      FAILED: [],
      CANCELLED: [],
      INTERRUPTED: [],
    };
    for (const from of Object.keys(edges) as TaskState[]) {
      for (const to of Object.keys(edges) as TaskState[]) {
        expect(canTransitionTask(from, to)).toBe(edges[from].includes(to));
      }
    }
    expect(canTransitionTask("unknown", "RUNNING")).toBe(false);
  });

  it("marks only finished states terminal and rejects transitions out of them", () => {
    for (const state of ["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"] as const) {
      expect(isTerminalTaskState(state)).toBe(true);
      for (const target of ["QUEUED", "RUNNING", "WAITING_FOR_MODEL", "CANCELLING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"] as const) {
        expect(canTransitionTask(state, target)).toBe(false);
      }
    }
    expect(isTerminalTaskState("WAITING_FOR_MODEL")).toBe(false);
  });

  it("updates state and updatedAt through transitionTask while preserving the plan", () => {
    const task = validTask();
    const next = transitionTask(task, "RUNNING", { currentStep: 0 }, "2026-10-19T00:00:01.000Z");

    expect(next).toMatchObject({ state: "RUNNING", currentStep: 0, updatedAt: "2026-10-19T00:00:01.000Z" });
    expect(next.plan).toEqual(task.plan);
    expect(task.state).toBe("QUEUED");
  });

  it("rejects illegal transitions and patches that mutate immutable task fields", () => {
    expect(() => transitionTask(validTask("COMPLETED"), "RUNNING")).toThrow(/Invalid task transition/);
    expect(() => transitionTask(validTask(), "RUNNING", { plan: plan() } as never)).toThrow(/cannot change plan/);
    expect(() => transitionTask(validTask(), "RUNNING", { state: "FAILED" } as never)).toThrow(/cannot change state/);
  });
});

describe("Persistent Task plan validation", () => {
  it("accepts the maximum step count, execution count, duration, and per-command timeout", () => {
    const steps: TaskPlanStep[] = [
      ...Array.from({ length: TASK_MAX_EXECUTION_STEPS }, (_, index) => executionStep(`exec_${index}`)),
      ...Array.from({ length: TASK_MAX_STEPS - TASK_MAX_EXECUTION_STEPS }, (_, index) => readStep(`read_${index}`)),
    ];
    const accepted = validateTaskPlan(plan(steps, TASK_MAX_DURATION_MS));
    expect(accepted.steps).toHaveLength(TASK_MAX_STEPS);
    expect(accepted.maxDurationMs).toBe(TASK_MAX_DURATION_MS);
    expect(validateTaskPlan(plan([executionStep("exec")], TASK_MAX_DURATION_MS)).steps[0]).toMatchObject({
      timeoutSeconds: TASK_MIN_EXECUTION_TIMEOUT_SECONDS,
    });
    expect(validateTaskPlan(plan([
      { ...executionStep("exec"), timeoutSeconds: TASK_MAX_EXECUTION_TIMEOUT_SECONDS },
    ])).steps[0]).toMatchObject({ timeoutSeconds: TASK_MAX_EXECUTION_TIMEOUT_SECONDS });
  });

  it("rejects plans over the step and execution-step caps", () => {
    expectInvalidPlan(plan(Array.from({ length: TASK_MAX_STEPS + 1 }, (_, index) => readStep(`read_${index}`))));
    expectInvalidPlan(plan(Array.from({ length: TASK_MAX_EXECUTION_STEPS + 1 }, (_, index) => executionStep(`exec_${index}`))));
  });

  it("caps canonical UTF-8 plan bytes at 256 KiB", () => {
    const largeRead = readStep("bulk", "x".repeat(32_768));
    const oversized = plan(Array.from({ length: 9 }, (_, index) => ({
      ...largeRead,
      stepId: `bulk_${index}`,
      request: { items: [{ id: `item_${index}`, path: "x".repeat(32_768) }] },
    })));

    expect(Buffer.byteLength(canonicalJson(oversized), "utf8")).toBeGreaterThan(TASK_MAX_PLAN_BYTES);
    expect(() => validateTaskPlan(oversized)).toThrow(expect.objectContaining({ code: "PLAN_TOO_LARGE" }));
  });

  it("requires a positive duration no greater than four hours", () => {
    expect(validateTaskPlan(plan([], 1)).maxDurationMs).toBe(1);
    expectInvalidPlan(plan([], 0));
    expectInvalidPlan(plan([], TASK_MAX_DURATION_MS + 1));
    expectInvalidPlan(plan([], 1.5));
  });

  it("enforces the Full Access timeout range for each execution step", () => {
    expectInvalidPlan(plan([{ ...executionStep("exec"), timeoutSeconds: 0 }]));
    expectInvalidPlan(plan([{ ...executionStep("exec"), timeoutSeconds: TASK_MAX_EXECUTION_TIMEOUT_SECONDS + 1 }]));
    expectInvalidPlan(plan([{ ...executionStep("exec"), timeoutSeconds: 1.5 }]));
  });

  it("requires version 1, unique stable step IDs, and a supported step union", () => {
    expectInvalidPlan({ ...plan(), version: 2 });
    expectInvalidPlan(plan([readStep("duplicate"), readStep("duplicate")]));
    expectInvalidPlan(plan([{ stepId: "bad id", kind: "batch_read", request: { items: [{ id: "item", path: "a" }] } } as never]));
    expectInvalidPlan(plan([{ stepId: "unsupported", kind: "shell", command: "echo no" } as never]));
  });

  it("rejects unknown request fields instead of silently accepting schema drift", () => {
    expectInvalidPlan(plan([{
      ...readStep("read"),
      unexpected: true,
    } as never]));
    expectInvalidPlan(plan([{
      ...readStep("read"),
      request: { items: [{ id: "item", path: "a" }], cursor: "memory-only" },
    } as never]));
  });

  it("validates assertion operators, JSON pointers, and backward-only references", () => {
    const assertion: TaskPlanStep = {
      stepId: "assert",
      kind: "assertion",
      sourceStepId: "read",
      jsonPointer: "/result~1field",
      operator: "equals",
      expected: { b: 2, a: 1 },
    };
    expect(validateTaskPlan(plan([readStep("read"), assertion])).steps).toHaveLength(2);
    expectInvalidPlan(plan([{
      stepId: "assert",
      kind: "assertion",
      sourceStepId: "later",
      jsonPointer: "/status",
      operator: "status_equals",
      expected: "ok",
    }, readStep("later")]));
    expectInvalidPlan(plan([readStep("read"), {
      stepId: "assert",
      kind: "assertion",
      sourceStepId: "read",
      jsonPointer: "/bad~escape",
      operator: "exists",
    }]));
    expectInvalidPlan(plan([readStep("read"), {
      stepId: "assert",
      kind: "assertion",
      sourceStepId: "read",
      jsonPointer: "/items",
      operator: "count_at_least",
      expected: 1,
      count: 1,
    }]));
  });

  it("produces stable canonical plan hashes and derived child keys", () => {
    const left = plan([{
      stepId: "read",
      kind: "batch_read",
      request: { items: [{ id: "item", path: "a" }] },
    }]);
    const right = plan([{
      request: { items: [{ path: "a", id: "item" }] },
      kind: "batch_read",
      stepId: "read",
    } as TaskPlanStep]);

    expect(taskPlanHash(left)).toBe(taskPlanHash(right));
    const key = createChildIdempotencyKey("task_id_0123456789abcdef", "read", 1);
    expect(key).toBe(createChildIdempotencyKey("task_id_0123456789abcdef", "read", 1));
    expect(key).toMatch(/^c2c-task-v1-[a-f0-9]{64}$/);
    expect(createChildIdempotencyKey("task_id_0123456789abcdef", "read", 2)).not.toBe(key);
    expect(() => createChildIdempotencyKey("task_id_0123456789abcdef", "read", 0)).toThrow(/positive safe integer/);
  });

  it("canonicalizes plain JSON checkpoint results and enforces the 1 MiB cap", () => {
    const result = canonicalizeTaskResult({ b: 2, a: [true, null] });
    expect(result.result).toEqual({ a: [true, null], b: 2 });
    expect(result.resultBytes).toBe(Buffer.byteLength(canonicalJson(result.result), "utf8"));
    expect(result.resultHash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => canonicalizeTaskResult("x".repeat(TASK_MAX_CHECKPOINT_BYTES + 1))).toThrow(/exceeds/);
    expect(TASK_MAX_CHECKPOINT_BYTES).toBe(1024 * 1024);
    expect(() => canonicalizeTaskResult({ invalid: undefined })).toThrow();
  });
});
