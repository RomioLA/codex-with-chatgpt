import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionJobStore, MAX_OUTPUT_BYTES_PER_STREAM } from "../src/execution/job-store.js";
import {
  archivedIdempotencyKey,
  archiveRecord,
  DEFAULT_ARCHIVE_RECORD_OPERATIONS,
  readArchivedRecord,
  scanArchivedJobRecords,
  type ArchiveRecordOperations,
} from "../src/execution/record-archive.js";
import { atomicReplace } from "../src/execution/atomic-replace.js";
import type { ExecutionJob, FullAccessExecutionJob } from "../src/execution/job-types.js";
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
    tempOwnership: null,
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

function makeHostJob(workspaceId: string): FullAccessExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    executionContext: "host",
    repositoryIdentity: null,
    repositoryPath: null,
    oauthClientId: "store-full-access-client",
    recipe: null,
    authorization: {
      type: "full_access",
      permissionMode: "level2",
      sessionGrantFingerprint: "d".repeat(64),
      requestHash: "e".repeat(64),
    },
    fullAccessCommand: {
      engine: "program",
      executable: "C:\\Tools\\node.exe",
      executableFileIdentity: "1:2",
      executableHash: "a".repeat(64),
      args: ["-e", "1"],
      cwd: "C:\\Outside\\work",
      cwdFileIdentity: "3:4",
    },
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    tempOwnership: null,
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

function archiveTerminalJob(directory: string, clientId: string, idempotencyKeyHash: string): ExecutionJob {
  const workspaceId = "archive-reconciliation-workspace";
  const store = new ExecutionJobStore(workspaceId, { directory });
  const job = makeJob(workspaceId, "succeeded");
  const oldAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  job.oauthClientId = clientId;
  job.idempotencyKeyHash = idempotencyKeyHash;
  job.createdAt = oldAt;
  job.startedAt = oldAt;
  job.finishedAt = oldAt;
  job.exitCode = 0;
  store.create(job);
  store.prepareCapacity();
  const archived = store.get(job.jobId);
  if (!archived) throw new Error("TEST_ARCHIVE_SEED_MISSING");
  return archived;
}

function makeExpiredTerminalJob(workspaceId: string, clientId: string, idempotencyKeyHash: string): ExecutionJob {
  const job = makeJob(workspaceId, "succeeded");
  job.executionContext = "repository";
  const oldAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  job.oauthClientId = clientId;
  job.idempotencyKeyHash = idempotencyKeyHash;
  job.createdAt = oldAt;
  job.startedAt = oldAt;
  job.finishedAt = oldAt;
  job.exitCode = 0;
  return job;
}

type ArchiveFailurePoint = "write" | "flush" | "publish" | "pointer";

function archiveOperationsWithFailure(getFailure: () => ArchiveFailurePoint | null): ArchiveRecordOperations {
  return {
    writeTemp(fd, bytes) {
      if (getFailure() === "write") throw new Error("INJECT_ARCHIVE_WRITE_FAILURE");
      DEFAULT_ARCHIVE_RECORD_OPERATIONS.writeTemp(fd, bytes);
    },
    flushTemp(fd) {
      if (getFailure() === "flush") throw new Error("INJECT_ARCHIVE_FLUSH_FAILURE");
      DEFAULT_ARCHIVE_RECORD_OPERATIONS.flushTemp(fd);
    },
    publish(source, destination, expectedHash) {
      const failure = getFailure();
      if (failure === "publish" && destination.includes(`${path.sep}jobs${path.sep}`)) {
        throw new Error("INJECT_ARCHIVE_PUBLISH_FAILURE");
      }
      if (failure === "pointer" && destination.includes(`${path.sep}idempotency${path.sep}`)) {
        throw new Error("INJECT_ARCHIVE_POINTER_FAILURE");
      }
      DEFAULT_ARCHIVE_RECORD_OPERATIONS.publish(source, destination, expectedHash);
    },
  };
}

function verifyArchiveFailurePreservesActive(failurePoint: ArchiveFailurePoint): void {
  const directory = makeTmpDir(`execution-archive-failure-${failurePoint}`);
  const workspaceId = `archive-failure-${failurePoint}`;
  const clientId = `archive-failure-client-${failurePoint}`;
  const keyHash = "a".repeat(64);
  let failure: ArchiveFailurePoint | null = null;
  const store = new ExecutionJobStore(workspaceId, {
    directory,
    archiveOperations: archiveOperationsWithFailure(() => failure),
  });
  const job = makeExpiredTerminalJob(workspaceId, clientId, keyHash);
  store.create(job);
  failure = failurePoint;

  expect(() => store.prepareCapacity()).toThrow(`INJECT_ARCHIVE_${failurePoint.toUpperCase()}_FAILURE`);
  expect(store.get(job.jobId)).toMatchObject({ jobId: job.jobId, state: "succeeded" });
  expect(readArchivedRecord(directory, "jobs", job.jobId)).toEqual(failurePoint === "pointer" ? job : null);
  expect(store.lookupIdempotentForReconciliation(clientId, keyHash)).toMatchObject({
    kind: "found",
    job: { jobId: job.jobId },
  });
}

function archivePath(directory: string, kind: "jobs" | "idempotency", key: string): string {
  return path.join(directory, ".archive", kind, key.slice(0, 2), `${key}.json`);
}

describe("ExecutionJobStore", () => {
  it("durably publishes a first archive record when the destination does not exist", () => {
    const directory = makeTmpDir("execution-archive-first-publish");
    const job = makeJob("archive-first-publish-workspace", "succeeded");
    job.startedAt = job.createdAt;
    job.finishedAt = job.createdAt;
    job.exitCode = 0;
    const destination = archivePath(directory, "jobs", job.jobId);
    let flushCount = 0;
    let publishCount = 0;
    const operations = {
      ...DEFAULT_ARCHIVE_RECORD_OPERATIONS,
      flushTemp(fd: number) {
        flushCount += 1;
        DEFAULT_ARCHIVE_RECORD_OPERATIONS.flushTemp(fd);
      },
      publish(source: string, target: string, expectedHash: string) {
        expect(target).toBe(destination);
        expect(fs.existsSync(target)).toBe(false);
        publishCount += 1;
        DEFAULT_ARCHIVE_RECORD_OPERATIONS.publish(source, target, expectedHash);
      },
    };

    archiveRecord(directory, "jobs", job.jobId, job, operations);

    expect(flushCount).toBe(1);
    expect(publishCount).toBe(1);
    expect(JSON.parse(fs.readFileSync(destination, "utf8")).value).toEqual(job);
  });

  for (const failurePoint of ["write", "flush", "publish", "pointer"] as const) {
    it(`preserves the active child when archive ${failurePoint} fails`, () => {
      verifyArchiveFailurePreservesActive(failurePoint);
    });
  }

  it("keeps active state and deduplicates the same job when active-index removal fails", () => {
    const directory = makeTmpDir("execution-archive-active-index-failure");
    const workspaceId = "archive-active-index-failure";
    const clientId = "archive-active-index-client";
    const keyHash = "b".repeat(64);
    let failIndexPublish = false;
    const store = new ExecutionJobStore(workspaceId, {
      directory,
      replaceActiveIndex(source, destination) {
        if (failIndexPublish && path.resolve(destination) === path.join(path.resolve(directory), "jobs.json")) {
          throw new Error("INJECT_ACTIVE_INDEX_PUBLISH_FAILURE");
        }
        atomicReplace(source, destination);
      },
    });
    const job = makeExpiredTerminalJob(workspaceId, clientId, keyHash);
    store.create(job);
    failIndexPublish = true;

    expect(() => store.prepareCapacity()).toThrow("INJECT_ACTIVE_INDEX_PUBLISH_FAILURE");
    expect(store.get(job.jobId)).toMatchObject({ jobId: job.jobId, state: "succeeded" });
    expect(readArchivedRecord(directory, "jobs", job.jobId)).toMatchObject({ jobId: job.jobId });
    expect(store.lookupIdempotentForReconciliation(clientId, keyHash)).toMatchObject({
      kind: "found",
      job: { jobId: job.jobId },
    });

    const restarted = new ExecutionJobStore(workspaceId, { directory });
    expect(restarted.lookupIdempotentForReconciliation(clientId, keyHash)).toMatchObject({
      kind: "found",
      job: { jobId: job.jobId },
    });
    expect(restarted.listAll()).toEqual([]);
  });

  it("persists host jobs without changing store version and reads legacy repository records", () => {
    const hostDirectory = makeTmpDir("execution-host-store");
    const hostJob = makeHostJob("store-host-workspace");
    const hostStore = new ExecutionJobStore("store-host-workspace", { directory: hostDirectory });
    hostStore.create(hostJob);
    const persisted = JSON.parse(fs.readFileSync(path.join(hostDirectory, "jobs.json"), "utf8")) as { version: number };
    expect(persisted.version).toBe(1);
    const reopenedHostStore = new ExecutionJobStore("store-host-workspace", { directory: hostDirectory });
    expect(reopenedHostStore.corruption).toBeNull();
    expect(reopenedHostStore.get(hostJob.jobId)).toMatchObject({
      executionContext: "host", repositoryIdentity: null, repositoryPath: null,
      authorization: { type: "full_access", permissionMode: "level2" },
      fullAccessCommand: { engine: "program", cwd: "C:\\Outside\\work" },
    });

    const legacyDirectory = makeTmpDir("execution-legacy-context-store");
    const legacyJob = makeJob("store-legacy-context");
    fs.writeFileSync(path.join(legacyDirectory, "jobs.json"), JSON.stringify({
      version: 1,
      workspaceId: "store-legacy-context",
      jobs: [legacyJob],
    }), { mode: 0o600 });
    const reopenedLegacyStore = new ExecutionJobStore("store-legacy-context", { directory: legacyDirectory });
    expect(reopenedLegacyStore.corruption).toBeNull();
    expect(reopenedLegacyStore.get(legacyJob.jobId)).toMatchObject({ executionContext: "repository" });
  });

  it("reads incremental byte offsets and reports EOF only after completion", async () => {
    const directory = makeTmpDir("execution-output-offsets");
    const store = new ExecutionJobStore("store-offsets", { directory });
    const job = makeJob("store-offsets");
    store.create(job);
    await store.appendSanitized(job.jobId, "stdout", "first\nsecond\n");

    const first = store.readOutput(job.jobId, "stdout", 2, 3);
    expect(first).toMatchObject({ ok: true, offset: 2, nextOffset: 5, eof: false, text: "rst" });

    const running = transitionExecutionJob(store.get(job.jobId)!, "running");
    await store.flushOutput(job.jobId);
    const succeeded = transitionExecutionJob(running, "succeeded", { exitCode: 0 });
    store.replace(succeeded);
    const tail = store.readOutput(job.jobId, "stdout", 5, 32);
    expect(tail).toMatchObject({ ok: true, offset: 5, eof: true, text: "\nsecond\n" });
  });

  it("bounds each stream and exposes truncation through the oldest byte offset", async () => {
    const directory = makeTmpDir("execution-output-truncation");
    const store = new ExecutionJobStore("store-truncation", { directory });
    const job = makeJob("store-truncation");
    store.create(job);
    const input = "x".repeat(MAX_OUTPUT_BYTES_PER_STREAM + 17);
    await store.appendSanitized(job.jobId, "stderr", input);
    await store.flushOutput(job.jobId);

    const current = store.get(job.jobId)!;
    expect(current.stderr.totalBytes).toBe(input.length);
    expect(current.stderr.retainedBytes).toBe(MAX_OUTPUT_BYTES_PER_STREAM);
    expect(current.stderr.oldestAvailableOffset).toBe(17);
    expect(current.stderr.truncated).toBe(true);

    const read = store.readOutput(job.jobId, "stderr", 0, 32);
    expect(read).toMatchObject({ ok: true, offset: 17, nextOffset: 49, oldestAvailableOffset: 17, truncated: true });
    expect(read.ok && read.text).toBe("x".repeat(32));
  });

  it("marks unfinished jobs interrupted after reload and preserves sanitized output", async () => {
    const directory = makeTmpDir("execution-restart");
    const store = new ExecutionJobStore("store-restart", { directory });
    const job = makeJob("store-restart");
    store.create(job);
    store.replace(transitionExecutionJob(job, "running"));
    await store.appendSanitized(job.jobId, "stdout", "safe partial output\n");
    await store.flushOutput(job.jobId);

    const restarted = new ExecutionJobStore("store-restart", { directory });
    expect(restarted.get(job.jobId)).toMatchObject({ state: "interrupted", failureCode: "BRIDGE_RESTARTED" });
    expect(restarted.readOutput(job.jobId, "stdout", 0)).toMatchObject({
      ok: true,
      eof: true,
      text: "safe partial output\n",
    });
  });

  it("persists only committed output metadata when a state transition races a pending tail", async () => {
    const directory = makeTmpDir("execution-pending-output-restart");
    const store = new ExecutionJobStore("pending-output-restart", { directory });
    const job = makeJob("pending-output-restart");
    store.create(job);
    store.replace(transitionExecutionJob(store.get(job.jobId)!, "running"));
    await store.appendSanitized(job.jobId, "stdout", "volatile tail");
    store.replace(transitionExecutionJob(store.get(job.jobId)!, "cancelling"));

    const persisted = JSON.parse(fs.readFileSync(path.join(directory, "jobs.json"), "utf8")) as { jobs: ExecutionJob[] };
    expect(persisted.jobs[0]?.stdout).toMatchObject({ totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0 });

    const restarted = new ExecutionJobStore("pending-output-restart", { directory });
    expect(restarted.get(job.jobId)?.state).toBe("interrupted");
    expect(restarted.readOutput(job.jobId, "stdout")).toMatchObject({ ok: true, text: "" });
  });

  it("prunes persisted segments to a bounded retained window and recovers it", async () => {
    const directory = makeTmpDir("execution-output-pruned-restart");
    const store = new ExecutionJobStore("output-pruned-restart", { directory });
    const job = makeJob("output-pruned-restart");
    store.create(job);
    const input = "x".repeat(MAX_OUTPUT_BYTES_PER_STREAM * 2 + 17);
    await store.appendSanitized(job.jobId, "stdout", input);
    await store.flushOutput(job.jobId);

    const segmentPrefix = `${job.jobId}.stdout.seg.`;
    const segmentBytes = fs.readdirSync(directory)
      .filter((name) => name.startsWith(segmentPrefix) && /^\d{16}$/.test(name.slice(segmentPrefix.length)))
      .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
    expect(segmentBytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES_PER_STREAM + 256 * 1024);

    const restarted = new ExecutionJobStore("output-pruned-restart", { directory });
    const meta = restarted.get(job.jobId)!.stdout;
    expect(meta).toMatchObject({ totalBytes: input.length, retainedBytes: MAX_OUTPUT_BYTES_PER_STREAM, truncated: true });
    expect(restarted.readOutput(job.jobId, "stdout", meta.oldestAvailableOffset, 32))
      .toMatchObject({ ok: true, text: "x".repeat(32), truncated: true });
  });

  it("serializes chunks per stream while keeping streams and jobs independent", async () => {
    const directory = makeTmpDir("execution-output-order");
    const store = new ExecutionJobStore("output-order", { directory });
    const first = makeJob("output-order");
    const second = makeJob("output-order");
    store.create(first);
    store.create(second);

    await Promise.all([
      store.appendSanitized(first.jobId, "stdout", "out-1|"),
      store.appendSanitized(first.jobId, "stdout", "out-2|"),
      store.appendSanitized(first.jobId, "stdout", "out-3"),
      store.appendSanitized(first.jobId, "stderr", "err-1|"),
      store.appendSanitized(first.jobId, "stderr", "err-2"),
      store.appendSanitized(second.jobId, "stdout", "other-job"),
    ]);
    await Promise.all([store.flushOutput(first.jobId), store.flushOutput(second.jobId)]);

    expect(store.readOutput(first.jobId, "stdout")).toMatchObject({ ok: true, text: "out-1|out-2|out-3" });
    expect(store.readOutput(first.jobId, "stderr")).toMatchObject({ ok: true, text: "err-1|err-2" });
    expect(store.readOutput(second.jobId, "stdout")).toMatchObject({ ok: true, text: "other-job" });
  });

  it("propagates persistence failure, marks the stream restricted, and handles its promise rejection", async () => {
    const directory = makeTmpDir("execution-output-persist-failure");
    const store = new ExecutionJobStore("output-persist-failure", { directory });
    const job = makeJob("output-persist-failure");
    store.create(job);
    const pendingFile = path.join(directory, `${job.jobId}.stdout.seg.${"0".repeat(16)}.pending`);
    fs.writeFileSync(pendingFile, "occupied");
    const unhandled: unknown[] = [];
    const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", captureUnhandled);
    try {
      await expect(store.appendSanitized(job.jobId, "stdout", "x".repeat(256 * 1024)))
        .rejects.toThrow("OUTPUT_PERSISTENCE_FAILED");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.get(job.jobId)?.stdout.restrictedReason).toBe("output_store_error");
      expect(store.readOutput(job.jobId, "stdout")).toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
    }
  });

  it("reads legacy single-file output and metadata after reconstruction", () => {
    const directory = makeTmpDir("execution-output-legacy");
    const store = new ExecutionJobStore("output-legacy", { directory });
    const job = makeJob("output-legacy");
    store.create(job);
    const output = Buffer.from("legacy output\n", "utf8");
    fs.writeFileSync(path.join(directory, `${job.jobId}.stdout.log`), output, { mode: 0o600 });
    const current = store.get(job.jobId)!;
    const legacyJobs = {
      version: 1,
      workspaceId: "output-legacy",
      jobs: [{
        ...current,
        stdout: { totalBytes: output.byteLength, retainedBytes: output.byteLength, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      }],
    };
    fs.writeFileSync(path.join(directory, "jobs.json"), JSON.stringify(legacyJobs), { mode: 0o600 });

    const reopened = new ExecutionJobStore("output-legacy", { directory });
    expect(reopened.readOutput(job.jobId, "stdout")).toMatchObject({ ok: true, text: "legacy output\n" });
  });

  it("finds the archived job record when its idempotency pointer is missing", () => {
    const directory = makeTmpDir("execution-archive-pointer-missing");
    const clientId = "archive-pointer-owner";
    const keyHash = "a".repeat(64);
    const archived = archiveTerminalJob(directory, clientId, keyHash);
    const pointerKey = archivedIdempotencyKey(clientId, keyHash);
    const pointer = archivePath(directory, "idempotency", pointerKey);
    const isolatedPointer = `${pointer}.isolated`;
    fs.renameSync(pointer, isolatedPointer);

    try {
      const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
      expect(reopened.lookupIdempotentForReconciliation(clientId, keyHash)).toEqual({ kind: "found", job: archived });
    } finally {
      fs.renameSync(isolatedPointer, pointer);
    }
  });

  it("returns trusted absence only after a complete archive scan", () => {
    const directory = makeTmpDir("execution-archive-trusted-absent");
    const archived = archiveTerminalJob(directory, "archive-other-owner", "b".repeat(64));
    const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
    expect(reopened.lookupIdempotentForReconciliation("archive-target-owner", "c".repeat(64)))
      .toEqual({ kind: "trusted_absent" });
  });

  it("returns unknown when the authoritative archived-job directory is missing", () => {
    const directory = makeTmpDir("execution-archive-root-missing");
    const store = new ExecutionJobStore("archive-root-missing", { directory });
    expect(store.lookupIdempotentForReconciliation("archive-owner", "d".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_DIRECTORY_MISSING" });
  });

  it("fails closed on corrupt archive records", () => {
    const directory = makeTmpDir("execution-archive-corrupt");
    const archived = archiveTerminalJob(directory, "archive-corrupt-owner", "e".repeat(64));
    fs.writeFileSync(archivePath(directory, "jobs", archived.jobId), "{corrupt archive record");

    const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
    expect(reopened.lookupIdempotentForReconciliation("archive-corrupt-owner", "e".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_CORRUPT" });
  });

  it("fails closed on an invalid archived-record schema", () => {
    const directory = makeTmpDir("execution-archive-schema-corrupt");
    const archived = archiveTerminalJob(directory, "archive-schema-owner", "d".repeat(64));
    const record = archivePath(directory, "jobs", archived.jobId);
    const envelope = JSON.parse(fs.readFileSync(record, "utf8")) as Record<string, unknown>;
    envelope.version = 2;
    fs.writeFileSync(record, JSON.stringify(envelope));

    const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
    expect(reopened.lookupIdempotentForReconciliation("archive-schema-owner", "d".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_CORRUPT" });
  });

  it("fails closed when an archived job record read is denied", () => {
    const directory = makeTmpDir("execution-archive-read-denied");
    const archived = archiveTerminalJob(directory, "archive-read-denied-owner", "e".repeat(64));
    const readError = Object.assign(new Error("INJECT_ARCHIVE_READ_DENIED"), { code: "EACCES" });
    const reopened = new ExecutionJobStore(archived.workspaceId, {
      directory,
      archiveScanReader: () => { throw readError; },
    });
    expect(reopened.lookupIdempotentForReconciliation("archive-read-denied-owner", "e".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_READ_DENIED" });
  });

  it("reports conflicting archived jobs with the same owner and idempotency key", () => {
    const directory = makeTmpDir("execution-archive-duplicate");
    const clientId = "archive-duplicate-owner";
    const keyHash = "f".repeat(64);
    const archived = archiveTerminalJob(directory, clientId, keyHash);
    const duplicate = { ...archived, jobId: randomBytes(24).toString("base64url") };
    archiveRecord(directory, "jobs", duplicate.jobId, duplicate);

    const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
    expect(reopened.lookupIdempotentForReconciliation(clientId, keyHash)).toEqual({ kind: "conflict" });
  });

  it("rejects a validly encoded archive pointer that targets a different owner and key", () => {
    const directory = makeTmpDir("execution-archive-bad-pointer");
    const clientId = "archive-pointer-expected-owner";
    const keyHash = "1".repeat(64);
    const archived = archiveTerminalJob(directory, clientId, keyHash);
    const pointerKey = archivedIdempotencyKey(clientId, keyHash);
    const pointer = archivePath(directory, "idempotency", pointerKey);
    const isolatedPointer = `${pointer}.original`;
    const wrongPointer = `${pointer}.wrong`;
    fs.renameSync(pointer, isolatedPointer);
    const unrelated = {
      ...archived,
      jobId: randomBytes(24).toString("base64url"),
      oauthClientId: "archive-pointer-other-owner",
      idempotencyKeyHash: "2".repeat(64),
    };
    archiveRecord(directory, "jobs", unrelated.jobId, unrelated);
    archiveRecord(directory, "idempotency", pointerKey, { workspaceId: archived.workspaceId, jobId: unrelated.jobId });

    try {
      const reopened = new ExecutionJobStore(archived.workspaceId, { directory });
      expect(reopened.lookupIdempotentForReconciliation(clientId, keyHash))
        .toEqual({ kind: "unknown", reason: "ARCHIVE_POINTER_MISMATCH" });
    } finally {
      fs.renameSync(pointer, wrongPointer);
      fs.renameSync(isolatedPointer, pointer);
    }
  });

  it("fails closed when an archive pointer targets a missing job record", () => {
    const directory = makeTmpDir("execution-archive-pointer-missing-record");
    const workspaceId = "archive-pointer-missing-record";
    const clientId = "archive-missing-record-owner";
    const keyHash = "5".repeat(64);
    fs.mkdirSync(path.join(directory, ".archive", "jobs"), { recursive: true });
    archiveRecord(directory, "idempotency", archivedIdempotencyKey(clientId, keyHash), {
      workspaceId,
      jobId: randomBytes(24).toString("base64url"),
    });

    const reopened = new ExecutionJobStore(workspaceId, { directory });
    expect(reopened.lookupIdempotentForReconciliation(clientId, keyHash))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_POINTER_MISMATCH" });
  });

  it("returns unknown when the archive scan byte budget is exceeded", () => {
    const directory = makeTmpDir("execution-archive-scan-byte-bound");
    const archived = archiveTerminalJob(directory, "archive-byte-owner", "6".repeat(64));
    const reopened = new ExecutionJobStore(archived.workspaceId, {
      directory,
      archiveScanLimits: { maxRecords: 10, maxBytes: 1, timeoutMs: 3_000 },
    });
    expect(reopened.lookupIdempotentForReconciliation("archive-byte-target", "7".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_SCAN_BYTE_LIMIT" });
  });

  it("returns unknown when the archive scan deadline is reached without sleeping", () => {
    const directory = makeTmpDir("execution-archive-scan-deadline");
    const archived = archiveTerminalJob(directory, "archive-deadline-owner", "8".repeat(64));
    let clockValue = 0;
    const reopened = new ExecutionJobStore(archived.workspaceId, {
      directory,
      archiveScanLimits: { maxRecords: 10, maxBytes: 1024 * 1024, timeoutMs: 1 },
      archiveScanClock: () => clockValue++,
    });
    expect(reopened.lookupIdempotentForReconciliation("archive-deadline-target", "9".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_SCAN_DEADLINE" });
  });

  it("marks archive scans incomplete when a configured record bound is exceeded", () => {
    const directory = makeTmpDir("execution-archive-scan-bound");
    const archived = archiveTerminalJob(directory, "archive-bound-owner", "3".repeat(64));
    const duplicate = { ...archived, jobId: randomBytes(24).toString("base64url") };
    archiveRecord(directory, "jobs", duplicate.jobId, duplicate);

    const scan = scanArchivedJobRecords(directory, () => undefined, { maxRecords: 1, maxBytes: 1024 * 1024, timeoutMs: 3_000 });
    expect(scan).toMatchObject({ kind: "incomplete", reason: "ARCHIVE_SCAN_RECORD_LIMIT" });
    const reopened = new ExecutionJobStore(archived.workspaceId, {
      directory,
      archiveScanLimits: { maxRecords: 1, maxBytes: 1024 * 1024, timeoutMs: 3_000 },
    });
    expect(reopened.lookupIdempotentForReconciliation("archive-scan-target", "0".repeat(64)))
      .toEqual({ kind: "unknown", reason: "ARCHIVE_SCAN_RECORD_LIMIT" });
  });
});
