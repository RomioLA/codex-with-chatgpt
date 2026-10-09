import { describe, expect, it } from "vitest";
import { canTransitionExecutionState, isTerminalExecutionState, transitionExecutionJob } from "../src/execution/state-machine.js";
import type { ExecutionJob } from "../src/execution/job-types.js";

function job(state: ExecutionJob["state"] = "queued"): ExecutionJob {
  return {
    jobId: "abcdefghijklmnopqrstuvwxyz123456",
    workspaceId: "workspace",
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: "client-a",
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

describe("execution job state machine", () => {
  it("allows queue, run, cancellation, and terminal completion paths", () => {
    expect(canTransitionExecutionState("queued", "running")).toBe(true);
    expect(canTransitionExecutionState("queued", "failed")).toBe(true);
    expect(canTransitionExecutionState("running", "cancelling")).toBe(true);
    expect(canTransitionExecutionState("cancelling", "cancelled")).toBe(true);
    expect(canTransitionExecutionState("cancelling", "timed_out")).toBe(true);
    expect(canTransitionExecutionState("running", "interrupted")).toBe(true);
  });

  it("sets start and finish timestamps at their first corresponding transition", () => {
    const running = transitionExecutionJob(job(), "running", {}, "2026-02-01T00:00:00.000Z");
    expect(running.startedAt).toBe("2026-02-01T00:00:00.000Z");
    const done = transitionExecutionJob(running, "succeeded", { exitCode: 0 }, "2026-02-01T00:01:00.000Z");
    expect(done.finishedAt).toBe("2026-02-01T00:01:00.000Z");
    expect(isTerminalExecutionState(done.state)).toBe(true);
  });

  it("rejects reopening terminal jobs and skipping cancellation coordination", () => {
    expect(() => transitionExecutionJob(job("succeeded"), "running")).toThrow(/Invalid execution job transition/);
    expect(canTransitionExecutionState("cancelled", "queued")).toBe(false);
  });
});
