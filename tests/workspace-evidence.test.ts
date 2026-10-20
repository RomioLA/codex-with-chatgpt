import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import {
  collectEvidence,
  computeEvidencePackageHash,
  EVIDENCE_PACKAGE_MAX_BYTES,
  EVIDENCE_PAGE_MAX_BYTES,
  type EvidenceSnapshot,
  type EvidenceSnapshotPage,
} from "../src/workspace/evidence.js";
import { READ_ITEM_HARD_MAX_BYTES, SnapshotRegistry, SNAPSHOT_TTL_MS } from "../src/workspace/batch.js";
import { batchRead } from "../src/workspace/batch-read.js";
import { Workspace } from "../src/workspace/manager.js";
import type { BoundedSearchOptions, BoundedSearchResult } from "../src/workspace/search.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let root: string;
let workspace: Workspace;
let registry: SnapshotRegistry;

beforeEach(() => {
  root = makeTmpDir("workspace-evidence");
  workspace = new Workspace(root);
  registry = new SnapshotRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup(root);
});

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeSearchResult(
  matches: BoundedSearchResult["matches"],
  bytesScanned = matches.reduce((sum, match) => sum + Buffer.byteLength(match.text, "utf8"), 0),
  stopReason: BoundedSearchResult["stopReason"] = null
): BoundedSearchResult {
  return {
    matches,
    matchCount: matches.length,
    truncated: false,
    engine: "node",
    bytesScanned,
    filesConsidered: matches.length > 0 ? 1 : 0,
    filesScanned: matches.length > 0 ? 1 : 0,
    matchesObserved: matches.length,
    matchesReturned: matches.length,
    elapsedMs: 0,
    stopReason,
  };
}

function evidenceContext(ownerId = "client-a", executionSupervisor?: ExecutionSupervisor) {
  return {
    ownerId,
    registry,
    ...(executionSupervisor === undefined ? {} : { executionSupervisor }),
  };
}

function snapshotFromPages(pages: EvidenceSnapshotPage[]): EvidenceSnapshot {
  const first = pages[0];
  if (!first) throw new Error("Expected at least one Evidence page");
  return {
    schemaVersion: first.schemaVersion,
    snapshotId: first.snapshotId,
    workspaceId: first.workspaceId,
    ownerClientId: first.ownerClientId,
    capturedAt: first.capturedAt,
    requestHash: first.requestHash,
    packageHash: first.packageHash,
    sourceHashes: first.sourceHashes,
    complete: first.complete,
    truncated: first.truncated,
    files: pages.flatMap((page) => page.page.files),
    searches: pages.flatMap((page) => page.page.searches),
    repositories: pages.flatMap((page) => page.page.repositories),
    artifacts: pages.flatMap((page) => page.page.artifacts),
    omitted: pages.flatMap((page) => page.page.omitted),
    errors: pages.flatMap((page) => page.page.errors),
  };
}

function fakeSupervisor(workspaceId: string) {
  const job = {
    jobId: "owned-job",
    workspaceId,
    oauthClientId: "client-a",
    state: "succeeded",
    exitCode: 0,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false },
  };
  const getForClient = vi.fn((jobId: string, ownerId: string) =>
    jobId === job.jobId && ownerId === job.oauthClientId ? job : null
  );
  const readOutputForClient = vi.fn((
    _jobId: string,
    _ownerId: string,
    stream: "stdout" | "stderr",
    offset = 0
  ) => ({
    ok: true as const,
    stream,
    offset,
    nextOffset: offset,
    oldestAvailableOffset: 0,
    eof: true,
    truncated: false,
    text: "",
  }));
  const startFullAccess = vi.fn();
  const supervisor = {
    getForClient,
    readOutputForClient,
    startFullAccess,
  } as unknown as ExecutionSupervisor;
  return { supervisor, getForClient, readOutputForClient, startFullAccess };
}

function makeStoredJob(workspaceId: string, oauthClientId: string): ExecutionJob {
  const now = new Date().toISOString();
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId,
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    tempOwnership: null,
    exitCode: 0,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

describe("collectEvidence", () => {
  it("collects only requested file ranges and hashes the full source", async () => {
    const source = "first line\nsecond line\nthird line\n";
    write(root, "notes.txt", source);
    write(root, "unrequested.txt", "this file was not selected\n");

    const page = await collectEvidence(workspace, {
      files: [{
        id: "notes",
        path: "notes.txt",
        ranges: [{ startLine: 1, endLine: 1 }, { startLine: 3 }],
      }],
    }, evidenceContext());

    expect(page.page.omitted).toEqual([]);
    expect(page.page.files).toHaveLength(2);
    expect(page.page.files.map((file) => file.id)).toEqual(["notes:1", "notes:2"]);
    expect(page.page.files.every((file) => file.path === "notes.txt")).toBe(true);
    expect(page.page.files.map((file) => file.ranges[0]?.snippet)).toEqual(["first line", "third line"]);
    expect(page.page.files.map((file) => file.contentHash)).toEqual([hash(source), hash(source)]);
    expect(page.sourceHashes).toEqual([hash(source)]);
    expect(page.complete).toBe(true);
    expect(page.packageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(computeEvidencePackageHash(snapshotFromPages([page]))).toBe(page.packageHash);
  });

  it.each([
    { label: "ASCII", source: "a".repeat(150 * 1024) },
    { label: "Chinese and emoji", source: "中文😀🙂".repeat(20_000) },
  ])("continues a long $label line from the returned UTF-8 byte offset", async ({ label, source }) => {
    const filePath = `${label === "ASCII" ? "ascii" : "unicode"}-long-line.txt`;
    write(root, filePath, source);
    const evidence = await collectEvidence(workspace, {
      files: [{ id: "long", path: filePath, ranges: [{ startLine: 1 }] }],
    }, evidenceContext());
    const file = evidence.page.files[0];
    const range = file?.ranges[0];
    if (!file || !range) throw new Error("Expected a long-line Evidence range");

    const expectedOffset = Buffer.byteLength(range.snippet, "utf8");
    expect(Buffer.byteLength(range.snippet, "utf8")).toBeLessThanOrEqual(READ_ITEM_HARD_MAX_BYTES);
    expect(range).toMatchObject({
      startLine: 1,
      endLine: 1,
      nextStartLine: 1,
      nextOffsetBytes: expectedOffset,
      continuationMode: "byte",
      truncated: true,
    });

    const continuation: string[] = [];
    let offsetBytes = range.nextOffsetBytes;
    while (offsetBytes < file.sizeBytes) {
      const nextPage = await batchRead(workspace, {
        items: [{
          id: "continue",
          path: filePath,
          offsetBytes,
          expectedSourceHash: file.contentHash,
          maxBytes: READ_ITEM_HARD_MAX_BYTES,
        }],
      }, { ownerId: "client-a", registry: new SnapshotRegistry() });
      const result = nextPage.results[0];
      if (!result?.ok) throw new Error(`Expected byte continuation to succeed: ${result?.error.code}`);
      expect(result.startOffsetBytes).toBe(offsetBytes);
      expect(result.nextOffsetBytes).toBe(offsetBytes + result.returnedBytes);
      expect(result.returnedBytes).toBe(Buffer.byteLength(result.content, "utf8"));
      expect(result.nextOffsetBytes).toBeGreaterThan(offsetBytes);
      continuation.push(result.content);
      offsetBytes = result.nextOffsetBytes;
    }

    expect(range.snippet + continuation.join("")).toBe(source);
  });

  it("continues at the first omitted line after the 200-line sanitizer ceiling", async () => {
    const lines = Array.from({ length: 201 }, (_, index) => `line-${index + 1}`);
    const source = lines.join("\n");
    const filePath = "many-lines.txt";
    write(root, filePath, source);

    const evidence = await collectEvidence(workspace, {
      files: [{ id: "many", path: filePath, ranges: [{ startLine: 1 }] }],
    }, evidenceContext());
    const file = evidence.page.files[0];
    const range = file?.ranges[0];
    if (!file || !range) throw new Error("Expected a line-limited Evidence range");

    expect(range.snippet).toBe(lines.slice(0, 200).join("\n"));
    expect(range).toMatchObject({
      endLine: 200,
      nextStartLine: 201,
      nextOffsetBytes: Buffer.byteLength(lines.slice(0, 200).join("\n") + "\n", "utf8"),
      continuationMode: "line",
      truncated: true,
    });

    const nextPage = await batchRead(workspace, {
      items: [{
        id: "continue-line",
        path: filePath,
        offsetBytes: range.nextOffsetBytes,
        expectedSourceHash: file.contentHash,
        maxBytes: READ_ITEM_HARD_MAX_BYTES,
      }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });
    const result = nextPage.results[0];
    if (!result?.ok) throw new Error(`Expected line continuation to succeed: ${result?.error.code}`);
    expect(result.startOffsetBytes).toBe(range.nextOffsetBytes);
    expect(result.content).toBe(lines[200]);
  });

  it("backs a byte continuation up over a CR removed from the snippet", async () => {
    const source = `${"a".repeat(READ_ITEM_HARD_MAX_BYTES - 1)}\rB\n`;
    const filePath = "cr-boundary.txt";
    write(root, filePath, source);

    const evidence = await collectEvidence(workspace, {
      files: [{ id: "cr", path: filePath, ranges: [{ startLine: 1 }] }],
    }, evidenceContext());
    const file = evidence.page.files[0];
    const range = file?.ranges[0];
    if (!file || !range) throw new Error("Expected a CR boundary Evidence range");

    expect(range.snippet).toBe("a".repeat(READ_ITEM_HARD_MAX_BYTES - 1));
    expect(range).toMatchObject({
      nextOffsetBytes: READ_ITEM_HARD_MAX_BYTES - 1,
      continuationMode: "byte",
      truncated: true,
    });

    const nextPage = await batchRead(workspace, {
      items: [{
        id: "continue-cr",
        path: filePath,
        offsetBytes: range.nextOffsetBytes,
        expectedSourceHash: file.contentHash,
        maxBytes: READ_ITEM_HARD_MAX_BYTES,
      }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });
    const result = nextPage.results[0];
    if (!result?.ok) throw new Error(`Expected CR continuation to succeed: ${result?.error.code}`);
    expect(range.snippet + result.content).toBe(source);
  });

  it("withholds sanitizer-truncated content without classifying it as a private key", async () => {
    const source = "password=a ".repeat(7_000);
    const filePath = "expanded-redaction.txt";
    write(root, filePath, source);

    const page = await collectEvidence(workspace, {
      files: [{ id: "expanded", path: filePath, ranges: [{ startLine: 1 }] }],
    }, evidenceContext());
    const file = page.page.files[0];
    const range = file?.ranges[0];
    if (!file || !range) throw new Error("Expected a sanitizer-limited Evidence range");

    expect(range).toMatchObject({
      snippet: "",
      nextOffsetBytes: range.startOffsetBytes,
      nextStartLine: null,
      continuationMode: "unavailable",
      redacted: true,
      truncated: true,
      status: "restricted",
    });
    expect(page.page.errors).toContainEqual({
      kind: "file",
      id: "expanded:1",
      path: filePath,
      code: "OUTPUT_RESTRICTED",
    });
    expect(page.page.errors).not.toContainEqual(expect.objectContaining({
      id: "expanded:1",
      code: "PRIVATE_KEY_RESTRICTED",
    }));
    expect(JSON.stringify(page)).not.toContain("password=a");
  });

  it("rejects more than 16 explicit files before reading any item", async () => {
    const readFileBytes = vi.spyOn(workspace, "readFileBytes");
    const files = Array.from({ length: 17 }, (_, index) => ({
      id: `file-${index}`,
      path: `file-${index}.txt`,
      ranges: [{ startLine: 1 }],
    }));

    await expect(collectEvidence(workspace, { files }, evidenceContext()))
      .rejects.toMatchObject({ name: "EvidenceRequestError", code: "ITEM_LIMIT" });
    expect(readFileBytes).not.toHaveBeenCalled();
  });

  it("keeps per-item errors isolated and suppresses sensitive file content and paths", async () => {
    write(root, "safe.txt", "ordinary text\n");
    write(root, ".env", "API_TOKEN=environment-secret\n");
    write(root, "ordinary.txt", "-----BEGIN RSA PRIVATE KEY-----\nprivate-key-material\n-----END RSA PRIVATE KEY-----\n");

    const page = await collectEvidence(workspace, {
      files: [
        { id: "safe", path: "safe.txt", ranges: [{ startLine: 1 }] },
        { id: "missing", path: "missing.txt", ranges: [{ startLine: 1 }] },
        { id: "env", path: ".env", ranges: [{ startLine: 1 }] },
        { id: "key", path: "ordinary.txt", ranges: [{ startLine: 1 }] },
      ],
    }, evidenceContext());

    expect(page.page.files.map((file) => file.id)).toEqual(["safe:1", "key:1"]);
    expect(page.page.omitted).toContainEqual({ kind: "file", id: "missing:1", path: "missing.txt", code: "FILE_NOT_FOUND" });
    expect(page.page.omitted).toContainEqual({ kind: "file", id: "env:1", code: "ACCESS_DENIED_SENSITIVE_FILE" });
    expect(page.page.omitted.find((issue) => issue.id === "env:1")).not.toHaveProperty("path");
    expect(page.page.errors).toContainEqual({
      kind: "file",
      id: "key:1",
      path: "ordinary.txt",
      code: "PRIVATE_KEY_RESTRICTED",
    });
    expect(page.page.files[1]).toMatchObject({
      redacted: true,
      truncated: true,
      status: "restricted",
      ranges: [{ snippet: "", redacted: true, truncated: true, status: "restricted" }],
    });
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("environment-secret");
    expect(serialized).not.toContain("private-key-material");
    expect(serialized).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("runs the default workspace search path and reports its bounded engine counts", async () => {
    const source = "first\nneedle from default search\nlast\n";
    write(root, "search-target.txt", source);

    const page = await collectEvidence(workspace, {
      searches: [{ id: "default", query: "needle", path: "." }],
    }, evidenceContext());

    expect(page.page.searches[0]).toMatchObject({
      id: "default",
      sourceVerification: "match_set_rechecked",
      status: "partial",
      matches: [{ path: "search-target.txt", line: 2, text: "needle from default search" }],
    });
    expect(["node", "ripgrep"]).toContain(page.page.searches[0]?.engine);
    expect(page.page.searches[0]?.scannedBytes).toBeGreaterThan(0);
    expect(page.page.searches[0]?.filesConsidered).toBeGreaterThan(0);
    expect(page.page.searches[0]?.filesScanned).toBeGreaterThan(0);
    expect(page.page.searches[0]?.sourceFileHashes[0]?.sourceHash).toBe(hash(source));
    expect(page.page.errors).toContainEqual({ kind: "search", id: "default", code: "SOURCE_SNAPSHOT_UNAVAILABLE" });
  });

  it("propagates a shared ITEM_LIMIT and does not start later evidence searches", async () => {
    let calls = 0;
    const runtime = {
      searchWorkspaceBounded: async () => {
        calls += 1;
        return makeSearchResult([], 0, "ITEM_LIMIT");
      },
    };

    const page = await collectEvidence(workspace, {
      searches: [
        { id: "first", query: "first", path: "." },
        { id: "second", query: "second", path: "." },
      ],
    }, evidenceContext(), runtime);

    expect(calls).toBe(1);
    expect(page.page.searches.map((search) => search.stopReasons)).toEqual([["ITEM_LIMIT"], ["ITEM_LIMIT"]]);
    expect(page.page.errors).toContainEqual({ kind: "search", id: "first", code: "ITEM_LIMIT" });
    expect(page.page.errors).toContainEqual({ kind: "search", id: "second", code: "ITEM_LIMIT" });
  });

  it("retains per-query MATCH_LIMIT stop reasons and emits a stable issue", async () => {
    const source = "needle hit\n";
    write(root, "match-limit.txt", source);
    const runtime = {
      searchWorkspaceBounded: async () => makeSearchResult(
        [{ path: "match-limit.txt", line: 1, text: "needle hit" }],
        Buffer.byteLength(source),
        "MATCH_LIMIT"
      ),
    };

    const page = await collectEvidence(workspace, {
      searches: [{ id: "limited", query: "needle", path: "." }],
    }, evidenceContext(), runtime);

    expect(page.page.searches[0]).toMatchObject({
      stopReasons: ["MATCH_LIMIT"],
      matches: [{ path: "match-limit.txt", line: 1, text: "needle hit" }],
    });
    expect(page.page.errors.filter((issue) => issue.kind === "search" && issue.id === "limited" && issue.code === "MATCH_LIMIT"))
      .toHaveLength(1);
  });

  it("rechecks search matches and records the real post-search source hash", async () => {
    const firstSource = "before\nneedle hit\nafter\n";
    const observedSource = "changed before\nneedle hit\nafter\n";
    write(root, "needle.txt", firstSource);
    let calls = 0;
    const runtime = {
      searchWorkspaceBounded: async (_ws: Workspace, _options: BoundedSearchOptions) => {
        calls += 1;
        if (calls === 2) write(root, "needle.txt", observedSource);
        return makeSearchResult([{ path: "needle.txt", line: 2, text: "needle hit" }], Buffer.byteLength(observedSource));
      },
    };

    const page = await collectEvidence(workspace, {
      searches: [{ id: "query", query: "needle", path: "." }],
    }, evidenceContext(), runtime);

    expect(calls).toBe(2);
    expect(page.page.searches[0]).toMatchObject({
      id: "query",
      queryHash: hash("needle"),
      sourceVerification: "match_set_rechecked",
      status: "partial",
      matches: [{
        path: "needle.txt",
        line: 2,
        text: "needle hit",
        sourceHash: hash(observedSource),
        sourceHashTiming: "post_search_observation",
      }],
      sourceFileHashes: [{ path: "needle.txt", sourceHash: hash(observedSource) }],
    });
    expect(page.page.errors).toContainEqual({ kind: "search", id: "query", code: "SOURCE_SNAPSHOT_UNAVAILABLE" });
    expect(page.sourceHashes).toContain(hash(observedSource));
    expect(page.packageHash).toBe(computeEvidencePackageHash(snapshotFromPages([page])));
  });

  it("marks a changed search match set and returns no stale matches", async () => {
    write(root, "race.txt", "needle before\n");
    let calls = 0;
    const runtime = {
      searchWorkspaceBounded: async (_ws: Workspace, _options: BoundedSearchOptions) => {
        calls += 1;
        if (calls === 2) write(root, "race.txt", "needle after\n");
        const text = fs.readFileSync(`${root}/race.txt`, "utf8").trim();
        return makeSearchResult([{ path: "race.txt", line: 1, text }], Buffer.byteLength(text));
      },
    };

    const page = await collectEvidence(workspace, {
      searches: [{ id: "race", query: "needle", path: "." }],
    }, evidenceContext(), runtime);

    expect(calls).toBe(2);
    expect(page.page.searches[0]).toMatchObject({
      id: "race",
      status: "source_changed",
      truncated: true,
      matches: [],
      sourceFileHashes: [],
    });
    expect(page.page.errors).toContainEqual({ kind: "search", id: "race", code: "SOURCE_CHANGED" });
  });

  it("marks a file source changed when it changes during the selected range read", async () => {
    write(root, "changing.txt", "before collection\n");
    const originalReadFileBytes = workspace.readFileBytes.bind(workspace);
    let changed = false;
    workspace.readFileBytes = async (requested, options = {}) => {
      const result = await originalReadFileBytes(requested, options);
      if (requested === "changing.txt" && !changed) {
        changed = true;
        write(root, "changing.txt", "different source after read\n");
      }
      return result;
    };

    const page = await collectEvidence(workspace, {
      files: [{ id: "changing", path: "changing.txt", ranges: [{ startLine: 1 }] }],
    }, evidenceContext());

    expect(changed).toBe(true);
    expect(page.page.files).toEqual([]);
    expect(page.page.omitted).toContainEqual({
      kind: "file",
      id: "changing:1",
      path: "changing.txt",
      code: "SOURCE_CHANGED",
    });
  });

  it("redacts sk-proj tokens from file, search, and Git diff evidence", async () => {
    const token = `sk-proj-${"A".repeat(32)}`;
    makeGitRepo(root);
    const source = `token ${token}\n`;
    write(root, "hello.txt", source);
    write(root, "report.txt", source);
    const runtime = {
      searchWorkspaceBounded: async (_ws: Workspace, _options: BoundedSearchOptions) =>
        makeSearchResult([{ path: "report.txt", line: 1, text: source.trimEnd() }], Buffer.byteLength(source)),
    };

    const page = await collectEvidence(workspace, {
      files: [{ id: "file", path: "report.txt", ranges: [{ startLine: 1 }] }],
      searches: [{ id: "search", query: "sk-proj", path: "." }],
      repositories: [{ id: "repo", path: ".", diffPath: "hello.txt", diffMode: "unstaged" }],
    }, evidenceContext(), runtime);

    expect(page.page.files[0]?.ranges[0]).toMatchObject({ redacted: true, status: "ok" });
    expect(page.page.files[0]?.ranges[0]?.snippet).not.toContain(token);
    expect(page.page.files[0]?.ranges[0]?.snippet).toContain("[REDACTED]");
    expect(page.page.searches[0]?.matches[0]).toMatchObject({ redacted: true });
    expect(page.page.searches[0]?.matches[0]?.text).not.toContain(token);
    expect(page.page.searches[0]?.matches[0]?.text).toContain("[REDACTED]");
    expect(page.page.repositories[0]?.diff).toMatchObject({ redacted: true, status: "ok" });
    expect(page.page.repositories[0]?.diff?.diff).not.toContain(token);
    expect(page.page.repositories[0]?.diff?.diff).toContain("[REDACTED]");
    expect(JSON.stringify(page)).not.toContain(token);
  });

  it("collects explicit Git and owned job metadata without starting execution", async () => {
    makeGitRepo(root);
    const changed = "Hello updated evidence\n";
    write(root, "hello.txt", changed);
    const supervisor = fakeSupervisor(workspace.id);
    const entriesBefore = fs.readdirSync(root).sort();
    const runtime = {
      searchWorkspaceBounded: async (_ws: Workspace, _options: BoundedSearchOptions) =>
        makeSearchResult([{ path: "hello.txt", line: 1, text: "Hello updated evidence" }], Buffer.byteLength(changed)),
    };

    const page = await collectEvidence(workspace, {
      files: [{ id: "file", path: "hello.txt", ranges: [{ startLine: 1 }] }],
      searches: [{ id: "search", query: "Hello", path: "." }],
      repositories: [{ id: "repo", path: ".", diffPath: "hello.txt", diffMode: "unstaged" }],
      executionJobs: [
        { id: "owned", jobId: "owned-job" },
        { id: "foreign", jobId: "foreign-job" },
      ],
    }, evidenceContext("client-a", supervisor.supervisor), runtime);

    expect(page.page.files[0]?.contentHash).toBe(hash(changed));
    expect(page.page.searches[0]?.matches[0]).toMatchObject({ sourceHash: hash(changed), sourceHashTiming: "post_search_observation" });
    expect(page.page.repositories[0]).toMatchObject({
      id: "repo",
      path: ".",
      branch: "main",
      head: expect.any(String),
      status: { isRepo: true, unstaged: expect.arrayContaining([expect.objectContaining({ path: "hello.txt" })]) },
      diff: { path: "hello.txt", mode: "unstaged", status: "ok" },
    });
    expect(page.page.repositories[0]?.repositoryIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.page.repositories[0]?.dirtyStatusHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.page.artifacts[0]).toMatchObject({
      id: "owned",
      jobId: "owned-job",
      ownerVerified: true,
      state: "succeeded",
      stdout: { stream: "stdout", offset: 0, nextOffset: 0 },
      stderr: { stream: "stderr", offset: 0, nextOffset: 0 },
    });
    expect(page.page.omitted).toContainEqual({ kind: "execution_job", id: "foreign", code: "JOB_NOT_FOUND_OR_NOT_OWNED" });
    expect(supervisor.getForClient).toHaveBeenCalledWith("owned-job", "client-a");
    expect(supervisor.readOutputForClient).toHaveBeenCalledTimes(2);
    expect(supervisor.startFullAccess).not.toHaveBeenCalled();
    expect(fs.readdirSync(root).sort()).toEqual(entriesBefore);
    expect(fs.readFileSync(`${root}/hello.txt`, "utf8")).toBe(changed);
  });

  it("collects only the requested repository and selected diff in a Git-only plan", async () => {
    makeGitRepo(root);
    write(root, "hello.txt", "changed for git-only evidence\n");

    const page = await collectEvidence(workspace, {
      repositories: [{ id: "git-only", path: ".", diffPath: "hello.txt" }],
    }, evidenceContext());

    expect(page.page).toMatchObject({ files: [], searches: [], artifacts: [] });
    expect(page.page.repositories).toHaveLength(1);
    expect(page.page.repositories[0]).toMatchObject({
      id: "git-only",
      path: ".",
      diff: { path: "hello.txt", mode: "unstaged", status: "ok" },
    });
    expect(page.page.repositories[0]?.head).toMatch(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
    expect(page.page.repositories[0]?.repositoryIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.page.repositories[0]?.dirtyStatusHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports a selected non-repository path without inventing Git evidence", async () => {
    fs.mkdirSync(path.join(root, "plain-directory"));

    const page = await collectEvidence(workspace, {
      repositories: [{ id: "invalid-repo", path: "plain-directory" }],
    }, evidenceContext());

    expect(page.page.repositories).toEqual([]);
    expect(page.page.omitted).toContainEqual({
      kind: "repository",
      id: "invalid-repo",
      path: "plain-directory",
      code: "NOT_A_REPOSITORY",
    });
  });

  it("reads foreign-job ownership and restricted output through the real store API", async () => {
    const storeDirectory = path.join(root, "job-store");
    const store = new ExecutionJobStore(workspace.id, { directory: storeDirectory });
    const owned = makeStoredJob(workspace.id, "client-a");
    const foreign = makeStoredJob(workspace.id, "client-b");
    store.create(owned);
    store.create(foreign);
    store.markOutputRestricted(owned.jobId, "stdout", "private_key");
    const supervisor = new ExecutionSupervisor(workspace, {
      store,
      permissionPollMs: 60_000,
    });
    const startFullAccess = vi.spyOn(supervisor, "startFullAccess");
    const jobsFile = path.join(storeDirectory, "jobs.json");
    const jobsBefore = fs.readFileSync(jobsFile);

    try {
      const page = await collectEvidence(workspace, {
        executionJobs: [
          { id: "owned", jobId: owned.jobId },
          { id: "foreign", jobId: foreign.jobId },
        ],
      }, evidenceContext("client-a", supervisor));

      expect(page.page.artifacts[0]).toMatchObject({
        id: "owned",
        jobId: owned.jobId,
        ownerVerified: true,
        stdout: null,
        stderr: { stream: "stderr" },
      });
      expect(page.page.errors).toContainEqual({
        kind: "execution_job",
        id: "owned:stdout",
        code: "OUTPUT_RESTRICTED",
      });
      expect(page.page.omitted).toContainEqual({
        kind: "execution_job",
        id: "foreign",
        code: "JOB_NOT_FOUND_OR_NOT_OWNED",
      });
      expect(startFullAccess).not.toHaveBeenCalled();
      expect(fs.readFileSync(jobsFile)).toEqual(jobsBefore);
    } finally {
      await supervisor.shutdown();
    }
  });

  it("keeps standalone collection read-only and creates no persistent snapshot file", async () => {
    const source = "read this file\n";
    write(root, "source.txt", source);
    const entriesBefore = fs.readdirSync(root).sort();

    const page = await collectEvidence(workspace, {
      files: [{ id: "source", path: "source.txt", ranges: [{ startLine: 1 }] }],
    }, evidenceContext());

    expect(page.page.files[0]?.ranges[0]?.snippet).toBe("read this file");
    expect(fs.readdirSync(root).sort()).toEqual(entriesBefore);
    expect(fs.readFileSync(`${root}/source.txt`, "utf8")).toBe(source);
    expect(registry.size).toBe(0);
    expect(registry.bytesStored).toBe(0);
  });

  it("pages a fixed in-memory snapshot within the response cap and binds cursors", async () => {
    const files = Array.from({ length: 16 }, (_, index) => {
      const path = `large-${index}.txt`;
      write(root, path, `${String(index).padStart(2, "0")}:${"x".repeat(30_000)}\n`);
      return { id: `file-${index}`, path, ranges: [{ startLine: 1 }] };
    });
    const request = { files };
    const pages: EvidenceSnapshotPage[] = [];
    let page = await collectEvidence(workspace, request, evidenceContext());
    pages.push(page);
    expect(page.nextCursor).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(EVIDENCE_PAGE_MAX_BYTES);
    expect(registry.size).toBe(1);

    const firstCursor = page.nextCursor;
    const cursorParts = firstCursor!.split(".");
    const signature = cursorParts[2]!;
    const tamperedCursor = [
      cursorParts[0],
      cursorParts[1],
      `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
    ].join(".");
    const tampered = await collectEvidence(workspace, { ...request, cursor: tamperedCursor }, evidenceContext())
      .then(() => null, (error: unknown) => error);
    expect(tampered).toMatchObject({ code: "CURSOR_INVALID" });

    const restarted = await collectEvidence(workspace, { ...request, cursor: firstCursor }, {
      ownerId: "client-a",
      registry: new SnapshotRegistry(),
    }).then(() => null, (error: unknown) => error);
    expect(restarted).toMatchObject({ code: "CURSOR_EXPIRED" });

    const wrongOwner = await collectEvidence(workspace, { ...request, cursor: firstCursor }, evidenceContext("client-b"))
      .then(() => null, (error: unknown) => error);
    expect(wrongOwner).toMatchObject({ code: "CURSOR_INVALID" });

    const changedRequest = {
      files: files.map((item, index) => index === 0 ? { ...item, path: "not-read.txt" } : item),
    };
    const wrongRequest = await collectEvidence(workspace, { ...changedRequest, cursor: firstCursor }, evidenceContext())
      .then(() => null, (error: unknown) => error);
    expect(wrongRequest).toMatchObject({ code: "CURSOR_INVALID" });

    const otherRoot = makeTmpDir("workspace-evidence-other");
    const wrongWorkspace = await collectEvidence(new Workspace(otherRoot), { ...request, cursor: firstCursor }, evidenceContext())
      .then(() => null, (error: unknown) => error);
    expect(wrongWorkspace).toMatchObject({ code: "CURSOR_INVALID" });

    const originalLastSource = fs.readFileSync(`${root}/large-15.txt`, "utf8");
    write(root, "large-15.txt", "changed after snapshot\n");
    while (page.nextCursor) {
      page = await collectEvidence(workspace, { ...request, cursor: page.nextCursor }, evidenceContext());
      pages.push(page);
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(EVIDENCE_PAGE_MAX_BYTES);
    }

    const reconstructed = snapshotFromPages(pages);
    expect(reconstructed.files).toHaveLength(16);
    expect(reconstructed.files.find((file) => file.path === "large-15.txt")?.ranges[0]?.snippet).toBe(originalLastSource.trimEnd());
    expect(reconstructed.files.find((file) => file.path === "large-15.txt")?.contentHash).toBe(hash(originalLastSource));
    expect(computeEvidencePackageHash(reconstructed)).toBe(reconstructed.packageHash);
    expect(pages.every((item) => item.snapshotId === pages[0]?.snapshotId)).toBe(true);
    expect(pages.every((item) => item.packageHash === pages[0]?.packageHash)).toBe(true);
    expect(pages.every((item) => item.complete && !item.truncated)).toBe(true);
  });

  it("discards a newly created registry entry when first-page construction fails", async () => {
    const files = Array.from({ length: 10 }, (_, index) => {
      const filePath = `rollback-${index}.txt`;
      write(root, filePath, `${"x".repeat(30_000)}\n`);
      return { id: `rollback-${index}`, path: filePath, ranges: [{ startLine: 1 }] };
    });
    vi.spyOn(registry, "resolve").mockImplementation(() => {
      throw new Error("injected first-page failure");
    });

    await expect(collectEvidence(workspace, { files }, evidenceContext())).rejects.toThrow("injected first-page failure");
    expect(registry.size).toBe(0);
    expect(registry.bytesStored).toBe(0);
  });

  it("omits content records when the Evidence package exceeds 2 MiB", async () => {
    const files = Array.from({ length: 16 }, (_, index) => {
      const filePath = `oversize-${index}.txt`;
      const source = Array.from({ length: 8 }, (_, line) => `${index}:${line}:${"x".repeat(18_000)}\n`).join("");
      write(root, filePath, source);
      return {
        id: `oversize-${index}`,
        path: filePath,
        ranges: Array.from({ length: 8 }, (_, line) => ({ startLine: line + 1 })),
      };
    });
    expect(files.length * files[0]!.ranges.length * 18_000).toBeGreaterThan(EVIDENCE_PACKAGE_MAX_BYTES);
    const pages: EvidenceSnapshotPage[] = [];
    let page = await collectEvidence(workspace, { files }, evidenceContext());
    pages.push(page);
    expect(page.nextCursor).toBeDefined();
    while (page.nextCursor) {
      page = await collectEvidence(workspace, { files, cursor: page.nextCursor }, evidenceContext());
      pages.push(page);
    }

    const snapshot = snapshotFromPages(pages);
    expect(snapshot.omitted.some((issue) => issue.code === "PACKAGE_BYTE_LIMIT")).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.complete).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(EVIDENCE_PACKAGE_MAX_BYTES);
    expect(registry.bytesStored).toBeLessThanOrEqual(EVIDENCE_PACKAGE_MAX_BYTES);
    expect(computeEvidencePackageHash(snapshot)).toBe(snapshot.packageHash);
  });

  it("expires paginated cursors after the snapshot TTL", async () => {
    const files = Array.from({ length: 10 }, (_, index) => {
      const path = `ttl-${index}.txt`;
      write(root, path, "x".repeat(32_000));
      return { id: `ttl-${index}`, path, ranges: [{ startLine: 1 }] };
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const page = await collectEvidence(workspace, { files }, evidenceContext());
    expect(page.nextCursor).toBeDefined();

    vi.advanceTimersByTime(SNAPSHOT_TTL_MS + 1);
    const expired = await collectEvidence(workspace, { files, cursor: page.nextCursor }, evidenceContext())
      .then(() => null, (error: unknown) => error);
    expect(expired).toMatchObject({ code: "CURSOR_EXPIRED" });
  });
});
