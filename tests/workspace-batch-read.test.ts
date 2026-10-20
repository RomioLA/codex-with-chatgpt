import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Workspace } from "../src/workspace/manager.js";
import { READ_BATCH_HARD_MAX_BYTES, READ_ITEM_HARD_MAX_BYTES, SnapshotRegistry } from "../src/workspace/batch.js";
import {
  BATCH_READ_MAX_DEADLINE_MS,
  BATCH_READ_MAX_SOURCE_BYTES,
  BATCH_READ_MAX_SOURCE_FILE_BYTES,
  BatchReadRequestError,
  batchRead,
  type BatchReadRequest,
} from "../src/workspace/batch-read.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

let root: string;
let workspace: Workspace;

beforeEach(() => {
  root = makeTmpDir("workspace-batch-read");
  workspace = new Workspace(root);
});

afterEach(() => cleanup(root));

function trackReadFileBytes(): Array<{ path: string; maxBytes?: number }> {
  const calls: Array<{ path: string; maxBytes?: number }> = [];
  const original = workspace.readFileBytes.bind(workspace);
  workspace.readFileBytes = async (requested, options = {}) => {
    calls.push({ path: requested, maxBytes: options.maxBytes });
    return original(requested, options);
  };
  return calls;
}

function trackReadFileLinesBounded(): Array<{ path: string; maxBytes?: number }> {
  const calls: Array<{ path: string; maxBytes?: number }> = [];
  const original = workspace.readFileLinesBounded.bind(workspace);
  workspace.readFileLinesBounded = async (requested, options = {}) => {
    calls.push({ path: requested, maxBytes: options.maxBytes });
    return original(requested, options);
  };
  return calls;
}

describe("strict bounded line reads", () => {
  it("keeps UTF-8 code points intact when a byte cap lands inside a character", async () => {
    write(root, "utf8.txt", "A中😀B");
    const result = await workspace.readFileLinesBounded("utf8.txt", { maxBytes: 5 });

    expect(result.content).toBe("A中");
    expect(result.returnedBytes).toBe(4);
    expect(result.nextOffsetBytes).toBe(4);
    expect(result.truncated).toBe(true);
    expect(result.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("continues a long UTF-8 line from nextOffsetBytes without loss or duplication", async () => {
    const source = `A中😀B${"x".repeat(100)}`;
    write(root, "continuation.txt", source);
    const registry = new SnapshotRegistry();
    const firstPage = await batchRead(workspace, {
      items: [{ id: "line", path: "continuation.txt", startLine: 1, maxBytes: 5 }],
    }, { ownerId: "client-a", registry });
    const first = firstPage.results[0];
    if (!first?.ok) throw new Error("Expected the line page to succeed");
    expect(first).toMatchObject({ content: "A中", returnedBytes: 4, nextOffsetBytes: 4, truncated: true });

    const secondPage = await batchRead(workspace, {
      items: [{
        id: "bytes",
        path: "continuation.txt",
        offsetBytes: first.nextOffsetBytes,
        expectedSourceHash: first.sourceHash,
        maxBytes: 128,
      }],
    }, { ownerId: "client-a", registry });
    const second = secondPage.results[0];
    if (!second?.ok) throw new Error("Expected the byte continuation to succeed");
    expect(second.content).toBe(source.slice(first.content.length));
    expect(first.content + second.content).toBe(source);
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  it("bounds a very long first line while preserving legacy readFile behavior", async () => {
    const longLine = "x".repeat(100_000);
    write(root, "long.txt", `${longLine}\nnext`);

    const bounded = await workspace.readFileLinesBounded("long.txt", { maxBytes: 32 });
    expect(bounded.content).toBe("x".repeat(32));
    expect(bounded.returnedBytes).toBe(32);
    expect(bounded.truncated).toBe(true);
    expect(bounded.nextOffsetBytes).toBe(32);

    const legacy = await workspace.readFile("long.txt", { maxBytes: 1024 });
    expect(Buffer.byteLength(legacy.content, "utf8")).toBeGreaterThan(1024);
    expect(legacy.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rechecks the complete source hash and reports source changes", async () => {
    write(root, "source.txt", "before\nsecond line");
    const first = await workspace.readFileLinesBounded("source.txt", { startLine: 1, endLine: 1, maxBytes: 16 });
    fs.writeFileSync(path.join(root, "source.txt"), "after\nsecond line");

    await expect(workspace.readFileLinesBounded("source.txt", {
      startLine: 1,
      endLine: 1,
      maxBytes: 16,
      expectedSourceHash: first.sourceHash,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("keeps source hashes complete and reports actual source bytes scanned", async () => {
    const source = "hello 中\n";
    write(root, "hash-source.txt", source);
    const result = await batchRead(workspace, {
      items: [{ id: "hash", path: "hash-source.txt", offsetBytes: 0, maxBytes: 4 }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });
    const item = result.results[0];
    if (!item?.ok) throw new Error("Expected the source file to be readable");

    expect(item.sourceHash).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
    expect(item.sourceBytesScanned).toBe(Buffer.byteLength(source, "utf8"));
    expect(result.sourceBytesScanned).toBe(Buffer.byteLength(source, "utf8"));
  });

  it("enforces source limits inside both complete-hash primitives without returning partial hashes", async () => {
    write(root, "over-cap.txt", "123456789");
    const scanned: number[] = [];
    const options = {
      maxSourceBytes: 8,
      onSourceBytesScanned: (bytes: number) => scanned.push(bytes),
    };

    await expect(workspace.readFileBytes("over-cap.txt", { ...options, maxBytes: 4 }))
      .rejects.toMatchObject({ code: "SOURCE_SCAN_LIMIT" });
    await expect(workspace.readFileLinesBounded("over-cap.txt", { ...options, maxBytes: 4 }))
      .rejects.toMatchObject({ code: "SOURCE_SCAN_LIMIT" });
    expect(scanned).toEqual([]);

    const batch = await batchRead(workspace, {
      items: [{ id: "single-large", path: "over-cap.txt", offsetBytes: 0, maxBytes: 4 }],
    }, {
      ownerId: "client-a",
      registry: new SnapshotRegistry(),
      runtime: { maxSourceBytesPerFile: 8, maxSourceBytes: 32, deadlineMs: 1_000 },
    });
    expect(batch.results[0]).toMatchObject({
      ok: false,
      sourceBytesScanned: 0,
      truncated: true,
      error: { code: "SOURCE_SCAN_LIMIT" },
    });
    expect(batch.results[0]).not.toHaveProperty("sourceHash");
    expect(batch.sourceBytesScanned).toBe(0);
  });

  it("applies per-file and shared source scan limits with remaining budget passed to each item", async () => {
    write(root, "first-source.txt", "12345678");
    write(root, "too-large-source.txt", "123456");
    write(root, "last-source.txt", "1234");
    const calls: Array<{ path: string; maxSourceBytes?: number; deadlineAt?: number }> = [];
    const original = workspace.readFileBytes.bind(workspace);
    workspace.readFileBytes = async (requested, options = {}) => {
      calls.push({ path: requested, maxSourceBytes: options.maxSourceBytes, deadlineAt: options.deadlineAt });
      return original(requested, options);
    };

    const result = await batchRead(workspace, {
      items: [
        { id: "first", path: "first-source.txt", offsetBytes: 0 },
        { id: "too-large", path: "too-large-source.txt", offsetBytes: 0 },
        { id: "last", path: "last-source.txt", offsetBytes: 0 },
      ],
    }, {
      ownerId: "client-a",
      registry: new SnapshotRegistry(),
      runtime: { maxSourceBytesPerFile: 8, maxSourceBytes: 12, deadlineMs: 1_000 },
    });

    expect(calls.map((call) => call.maxSourceBytes)).toEqual([8, 4, 4]);
    expect(new Set(calls.map((call) => call.deadlineAt)).size).toBe(1);
    expect(result.results[0]).toMatchObject({ ok: true, sourceBytesScanned: 8 });
    expect(result.results[1]).toMatchObject({ ok: false, sourceBytesScanned: 0, truncated: true, error: { code: "SOURCE_SCAN_LIMIT" } });
    expect(result.results[2]).toMatchObject({ ok: true, sourceBytesScanned: 4 });
    expect(result.results[1] && "sourceHash" in result.results[1]).toBe(false);
    expect(result.sourceBytesScanned).toBe(12);
    expect(BATCH_READ_MAX_SOURCE_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(BATCH_READ_MAX_SOURCE_BYTES).toBe(256 * 1024 * 1024);
    expect(BATCH_READ_MAX_DEADLINE_MS).toBe(10_000);
  });

  it("shares one deadline and stops source hashing before later items are read", async () => {
    write(root, "slow-source.txt", "x".repeat(1024 * 1024));
    write(root, "after-deadline.txt", "not read");
    const calls: string[] = [];
    const original = workspace.readFileBytes.bind(workspace);
    workspace.readFileBytes = async (requested, options = {}) => {
      calls.push(requested);
      const onScanned = options.onSourceBytesScanned;
      let heldDeadline = false;
      return original(requested, {
        ...options,
        onSourceBytesScanned: (bytes) => {
          onScanned?.(bytes);
          if (!heldDeadline && options.deadlineAt !== undefined) {
            heldDeadline = true;
            while (performance.now() <= options.deadlineAt) { /* Hold the first chunk past the shared deadline. */ }
          }
        },
      });
    };

    const result = await batchRead(workspace, {
      items: [
        { id: "slow", path: "slow-source.txt", offsetBytes: 0 },
        { id: "later", path: "after-deadline.txt", offsetBytes: 0 },
      ],
    }, {
      ownerId: "client-a",
      registry: new SnapshotRegistry(),
      runtime: { maxSourceBytesPerFile: 1024 * 1024, maxSourceBytes: 2 * 1024 * 1024, deadlineMs: 100 },
    });

    expect(calls).toEqual(["slow-source.txt"]);
    expect(result.results[0]).toMatchObject({ ok: false, error: { code: "DEADLINE" }, truncated: true });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: "DEADLINE" }, sourceBytesScanned: 0 });
    const scanned = result.results[0]?.sourceBytesScanned ?? 0;
    expect(scanned).toBeGreaterThan(0);
    expect(scanned).toBeLessThan(1024 * 1024);
    expect(result.sourceBytesScanned).toBe(scanned);
  });

  it("does not mark a fully satisfied explicit line range truncated", async () => {
    write(root, "range.txt", "one\ntwo\nthree\nfour\n");
    const result = await workspace.readFileLinesBounded("range.txt", {
      startLine: 2,
      endLine: 3,
      maxBytes: 32,
    });

    expect(result.content).toBe("two\nthree");
    expect(result).toMatchObject({ startLine: 2, endLine: 3, truncated: false, nextStartLine: null });
  });

  it("normalizes CRLF like legacy readFile while retaining source byte offsets", async () => {
    write(root, "crlf.txt", "one\r\ntwo\r\nthree");
    const result = await workspace.readFileLinesBounded("crlf.txt", {
      startLine: 2,
      endLine: 3,
      maxBytes: 16,
    });

    expect(result.content).toBe("two\nthree");
    expect(result.returnedBytes).toBe(9);
    expect(result.startOffsetBytes).toBe(5);
    expect(result.nextOffsetBytes).toBe(15);
    expect(result.truncated).toBe(false);
  });

  it("normalizes CRLF even when the pair crosses the 64 KiB read boundary", async () => {
    write(root, "crlf-boundary.txt", `${"x".repeat(65_535)}\r\nz`);
    const result = await workspace.readFileLinesBounded("crlf-boundary.txt", {
      startLine: 1,
      endLine: 1,
      maxBytes: READ_ITEM_HARD_MAX_BYTES,
    });

    expect(result.returnedBytes).toBe(65_535);
    expect(result.content.endsWith("\r")).toBe(false);
    expect(result.nextOffsetBytes).toBe(65_537);
  });

  it("keeps NUL and malformed UTF-8 checks over the complete source", async () => {
    fs.writeFileSync(path.join(root, "late-nul.txt"), Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0, 66])]));
    fs.writeFileSync(path.join(root, "late-bad-utf8.txt"), Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0xc3, 0x28])]));

    await expect(workspace.readFileLinesBounded("late-nul.txt", { maxBytes: 4 })).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(workspace.readFileLinesBounded("late-bad-utf8.txt", { maxBytes: 4 })).rejects.toMatchObject({ code: "INVALID_UTF8" });
  });
});

describe("batchRead domain", () => {
  it("preserves request order and reports missing and sensitive paths per item", async () => {
    write(root, "a.txt", "alpha\n");
    write(root, "b.txt", "beta\n");
    write(root, ".env", "secret\n");
    const registry = new SnapshotRegistry();
    const result = await batchRead(workspace, {
      items: [
        { id: "second", path: "b.txt" },
        { id: "missing", path: "missing.txt" },
        { id: "secret", path: ".env" },
        { id: "first", path: "a.txt" },
      ],
    }, { ownerId: "client-a", registry });

    expect(result.results.map((item) => item.id)).toEqual(["second", "missing", "secret", "first"]);
    expect(result.results[0]).toMatchObject({ ok: true, path: "b.txt", content: "beta", startLine: 1 });
    expect(result.results[1]).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
    expect(result.results[2]).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED_SENSITIVE_FILE" } });
    expect(result.results[3]).toMatchObject({ ok: true, path: "a.txt", content: "alpha" });
    expect(registry.size).toBe(0);
  });

  it("clamps item content at 64 KiB and batch content at 512 KiB before reads", async () => {
    const request: BatchReadRequest = {
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
      items: Array.from({ length: 9 }, (_, index) => {
        const name = `large-${index}.txt`;
        write(root, name, "x".repeat(READ_ITEM_HARD_MAX_BYTES + 32));
        return { id: `item-${index}`, path: name, offsetBytes: 0, maxBytes: Number.MAX_SAFE_INTEGER };
      }),
    };
    const readCalls = trackReadFileBytes();
    const registry = new SnapshotRegistry();
    let page = await batchRead(workspace, request, { ownerId: "client-a", registry });
    const all = [...page.results];
    while (page.nextCursor) {
      page = await batchRead(workspace, { ...request, cursor: page.nextCursor }, { ownerId: "client-a", registry });
      all.push(...page.results);
    }

    expect(readCalls).toHaveLength(8);
    for (const call of readCalls) expect(call.maxBytes).toBeLessThanOrEqual(READ_ITEM_HARD_MAX_BYTES);
    expect(all).toHaveLength(9);
    expect(all.slice(0, 8).every((item) => item.ok && item.returnedBytes === READ_ITEM_HARD_MAX_BYTES)).toBe(true);
    expect(all[8]).toMatchObject({ ok: false, error: { code: "BYTE_LIMIT" }, truncated: true });
    expect(all.reduce((total, item) => total + (item.ok ? item.returnedBytes : 0), 0)).toBe(READ_BATCH_HARD_MAX_BYTES);
  });

  it("fails whole-request validation before reading more than 16 items", async () => {
    const readCalls = trackReadFileBytes();
    const items = Array.from({ length: 17 }, (_, index) => ({ id: `item-${index}`, path: `f-${index}.txt`, offsetBytes: 0 }));
    await expect(batchRead(workspace, { items }, { ownerId: "client-a", registry: new SnapshotRegistry() }))
      .rejects.toMatchObject({ code: "ITEM_LIMIT" });
    expect(readCalls).toHaveLength(0);

    await expect(batchRead(workspace, {
      items: [{ id: "bad-range", path: "missing.txt", startLine: 3, endLine: 2 }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() })).rejects.toBeInstanceOf(BatchReadRequestError);
  });

  it("rejects malformed ids, duplicate ids, mixed modes, and sub-four-byte budgets", async () => {
    const readCalls = trackReadFileBytes();
    const context = { ownerId: "client-a", registry: new SnapshotRegistry() };
    const invalidRequests: BatchReadRequest[] = [
      { maxTotalBytes: 3, items: [{ id: "a", path: "a.txt", offsetBytes: 0 }] },
      { items: [{ id: "a", path: "a.txt", offsetBytes: 0, maxBytes: 3 }] },
      { items: [{ id: "not valid", path: "a.txt", offsetBytes: 0 }] },
      { items: [{ id: "a", path: "a.txt", offsetBytes: 0, startLine: 1 }] },
      { items: [{ id: "a", path: "a.txt" }, { id: "a", path: "b.txt" }] },
    ];

    for (const request of invalidRequests) {
      await expect(batchRead(workspace, request, context)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(readCalls).toHaveLength(0);
  });

  it("returns SOURCE_CHANGED for an expected hash mismatch", async () => {
    write(root, "changing.txt", "before content");
    const first = await workspace.readFileBytes("changing.txt", { offsetBytes: 0, maxBytes: 4 });
    fs.writeFileSync(path.join(root, "changing.txt"), "after content");
    const result = await batchRead(workspace, {
      items: [{ id: "change", path: "changing.txt", offsetBytes: 4, expectedSourceHash: first.sourceHash }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });

    expect(result.results[0]).toMatchObject({ ok: false, error: { code: "SOURCE_CHANGED" } });
  });

  it("marks the batch page truncated when an item page is capped without a cursor page", async () => {
    write(root, "capped.txt", "x".repeat(100));
    const result = await batchRead(workspace, {
      maxTotalBytes: 16,
      items: [{ id: "capped", path: "capped.txt", offsetBytes: 0, maxBytes: 16 }],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });

    expect(result.results[0]).toMatchObject({ ok: true, returnedBytes: 16, truncated: true });
    expect(result).toMatchObject({ truncated: true });
    expect(result.nextCursor).toBeUndefined();
  });

  it("passes only the remaining batch budget to each line-mode read", async () => {
    write(root, "first-line.txt", "a".repeat(30));
    write(root, "second-line.txt", "b".repeat(100));
    const readCalls = trackReadFileLinesBounded();
    const result = await batchRead(workspace, {
      maxTotalBytes: 40,
      items: [
        { id: "first", path: "first-line.txt", maxBytes: 30 },
        { id: "second", path: "second-line.txt", maxBytes: 64 },
      ],
    }, { ownerId: "client-a", registry: new SnapshotRegistry() });

    expect(readCalls.map((call) => call.maxBytes)).toEqual([30, 10]);
    expect(result.results.map((item) => item.ok && item.returnedBytes)).toEqual([30, 10]);
    expect(result.returnedBytes).toBe(40);
    expect(result.truncated).toBe(true);
  });

  it("pages serialized results through bound cursors without rereading snapshots", async () => {
    const request: BatchReadRequest = {
      maxTotalBytes: READ_BATCH_HARD_MAX_BYTES,
      items: Array.from({ length: 5 }, (_, index) => {
        const name = `page-${index}.txt`;
        write(root, name, String(index).repeat(READ_ITEM_HARD_MAX_BYTES));
        return { id: `page-${index}`, path: name, offsetBytes: 0, maxBytes: READ_ITEM_HARD_MAX_BYTES };
      }),
    };
    const registry = new SnapshotRegistry();
    const readCalls = trackReadFileBytes();
    const first = await batchRead(workspace, request, { ownerId: "client-a", registry });

    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(256 * 1024);
    const firstCursor = first.nextCursor!;
    const second = await batchRead(workspace, { ...request, cursor: firstCursor }, { ownerId: "client-a", registry });
    expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(256 * 1024);
    expect(second.results.map((item) => item.id)).not.toEqual(first.results.map((item) => item.id));
    expect(readCalls).toHaveLength(5);

    const tampered = `${firstCursor.slice(0, -1)}${firstCursor.endsWith("A") ? "B" : "A"}`;
    await expect(batchRead(workspace, { ...request, cursor: tampered }, { ownerId: "client-a", registry }))
      .rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(batchRead(workspace, { ...request, cursor: firstCursor }, { ownerId: "client-b", registry }))
      .rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(batchRead(workspace, {
      ...request,
      items: [...request.items.slice(0, -1), { ...request.items.at(-1)!, path: "different.txt" }],
      cursor: firstCursor,
    }, { ownerId: "client-a", registry })).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    const otherRoot = makeTmpDir("workspace-batch-read-other");
    const otherWorkspace = new Workspace(otherRoot);
    await expect(batchRead(otherWorkspace, { ...request, cursor: firstCursor }, { ownerId: "client-a", registry }))
      .rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(batchRead(workspace, { ...request, cursor: firstCursor }, { ownerId: "client-a", registry: new SnapshotRegistry() }))
      .rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
});
