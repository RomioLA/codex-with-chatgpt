import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionJobStore, MAX_OUTPUT_BYTES_PER_STREAM } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { transitionExecutionJob } from "../src/execution/state-machine.js";
import { makeTmpDir } from "./helpers.js";

function makeJob(workspaceId: string, state: ExecutionJob["state"] = "queued"): ExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: "store-test-client",
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state,
    createdAt: new Date().toISOString(),
    startedAt: state === "queued" ? null : new Date().toISOString(),
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

describe("ExecutionJobStore", () => {
  it("reads incremental byte offsets and reports EOF only after completion", () => {
    const directory = makeTmpDir("execution-output-offsets");
    const store = new ExecutionJobStore("store-offsets", { directory });
    const job = makeJob("store-offsets");
    store.create(job);
    store.appendSanitized(job.jobId, "stdout", "first\nsecond\n");

    const first = store.readOutput(job.jobId, "stdout", 2, 3);
    expect(first).toMatchObject({ ok: true, offset: 2, nextOffset: 5, eof: false, text: "rst" });

    const running = transitionExecutionJob(store.get(job.jobId)!, "running");
    const succeeded = transitionExecutionJob(running, "succeeded", { exitCode: 0 });
    store.replace(succeeded);
    const tail = store.readOutput(job.jobId, "stdout", 5, 32);
    expect(tail).toMatchObject({ ok: true, offset: 5, eof: true, text: "\nsecond\n" });
  });

  it("bounds each stream and exposes truncation through the oldest byte offset", () => {
    const directory = makeTmpDir("execution-output-truncation");
    const store = new ExecutionJobStore("store-truncation", { directory });
    const job = makeJob("store-truncation");
    store.create(job);
    const input = "x".repeat(MAX_OUTPUT_BYTES_PER_STREAM + 17);
    store.appendSanitized(job.jobId, "stderr", input);

    const current = store.get(job.jobId)!;
    expect(current.stderr.totalBytes).toBe(input.length);
    expect(current.stderr.retainedBytes).toBe(MAX_OUTPUT_BYTES_PER_STREAM);
    expect(current.stderr.oldestAvailableOffset).toBe(17);
    expect(current.stderr.truncated).toBe(true);

    const read = store.readOutput(job.jobId, "stderr", 0, 32);
    expect(read).toMatchObject({ ok: true, offset: 17, nextOffset: 49, oldestAvailableOffset: 17, truncated: true });
    expect(read.ok && read.text).toBe("x".repeat(32));
  });

  it("marks unfinished jobs interrupted after reload and preserves sanitized output", () => {
    const directory = makeTmpDir("execution-restart");
    const store = new ExecutionJobStore("store-restart", { directory });
    const job = makeJob("store-restart");
    store.create(job);
    store.replace(transitionExecutionJob(job, "running"));
    store.appendSanitized(job.jobId, "stdout", "safe partial output\n");

    const restarted = new ExecutionJobStore("store-restart", { directory });
    expect(restarted.get(job.jobId)).toMatchObject({ state: "interrupted", failureCode: "BRIDGE_RESTARTED" });
    expect(restarted.readOutput(job.jobId, "stdout", 0)).toMatchObject({
      ok: true,
      eof: true,
      text: "safe partial output\n",
    });
  });
});
