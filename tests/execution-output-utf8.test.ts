import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionJobStore, MAX_OUTPUT_BYTES_PER_STREAM } from "../src/execution/job-store.js";
import type { ExecutionJob, OutputStream } from "../src/execution/job-types.js";
import { transitionExecutionJob } from "../src/execution/state-machine.js";
import { makeTmpDir } from "./helpers.js";

function makeJob(workspaceId: string): ExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: "utf8-output-client",
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "queued",
    createdAt: new Date().toISOString(),
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

function finish(store: ExecutionJobStore, job: ExecutionJob): void {
  const current = store.get(job.jobId);
  if (!current) throw new Error("Missing execution output fixture job");
  const running = transitionExecutionJob(current, "running", { startedAt: new Date().toISOString() });
  store.replace(running);
  store.replace(transitionExecutionJob(running, "succeeded", { exitCode: 0 }));
}

function collectPages(store: ExecutionJobStore, jobId: string, stream: OutputStream, pageBytes: number): string {
  const pages: string[] = [];
  let offset = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const page = store.readOutput(jobId, stream, offset, pageBytes);
    expect(page.ok).toBe(true);
    if (!page.ok) throw new Error(page.error);
    pages.push(page.text);
    if (page.nextOffset === offset) break;
    offset = page.nextOffset;
  }
  return pages.join("");
}

describe("execution output UTF-8 pagination", () => {
  it("preserves Chinese, Japanese, and emoji across 1-byte, 2-byte, and mixed pages", () => {
    const directory = makeTmpDir("execution-output-utf8");
    const store = new ExecutionJobStore("utf8-output", { directory });
    const job = makeJob("utf8-output");
    store.create(job);
    const expected = "A中日あ😀B";
    store.appendSanitized(job.jobId, "stdout", expected);
    store.appendSanitized(job.jobId, "stderr", expected);
    finish(store, job);

    for (const stream of ["stdout", "stderr"] as const) {
      for (const pageBytes of [1, 2, 3, 4, 7]) {
        expect(collectPages(store, job.jobId, stream, pageBytes)).toBe(expected);
      }
    }

    const first = store.readOutput(job.jobId, "stdout", 0, 1);
    expect(first).toMatchObject({ ok: true, offset: 0, nextOffset: 1, text: "A" });
    const chinese = store.readOutput(job.jobId, "stdout", 1, 1);
    expect(chinese).toMatchObject({ ok: true, offset: 1, nextOffset: 4, text: "中" });
    const emojiOffset = Buffer.byteLength("A中日あ", "utf8");
    const emoji = store.readOutput(job.jobId, "stdout", emojiOffset, 1);
    expect(emoji).toMatchObject({ ok: true, nextOffset: emojiOffset + 4, text: "😀" });
  });

  it("rejects an input byte offset that splits a UTF-8 sequence", () => {
    const directory = makeTmpDir("execution-output-utf8-boundary");
    const store = new ExecutionJobStore("utf8-boundary", { directory });
    const job = makeJob("utf8-boundary");
    store.create(job);
    store.appendSanitized(job.jobId, "stdout", "中");
    finish(store, job);

    expect(store.readOutput(job.jobId, "stdout", 1, 1)).toEqual({ ok: false, error: "INVALID_OFFSET" });
  });

  it("keeps the retained offset on a UTF-8 boundary after truncation", () => {
    const directory = makeTmpDir("execution-output-utf8-truncate");
    const store = new ExecutionJobStore("utf8-truncate", { directory });
    const job = makeJob("utf8-truncate");
    store.create(job);
    store.appendSanitized(job.jobId, "stdout", "xx😀" + "z".repeat(MAX_OUTPUT_BYTES_PER_STREAM - 3));
    finish(store, job);

    const meta = store.get(job.jobId)!.stdout;
    expect(meta.truncated).toBe(true);
    const first = store.readOutput(job.jobId, "stdout", meta.oldestAvailableOffset, 1);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.offset).toBe(meta.oldestAvailableOffset);
      expect(first.text).not.toContain("\uFFFD");
      expect(Buffer.from(first.text, "utf8").byteLength).toBe(first.nextOffset - first.offset);
    }
  });
});
