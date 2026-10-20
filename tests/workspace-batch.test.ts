import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  READ_ITEM_HARD_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_GLOBAL_COUNT,
  SNAPSHOT_MAX_PER_WORKSPACE,
  SnapshotRegistry,
} from "../src/workspace/batch.js";
import { canonicalJson, canonicalSha256 } from "../src/shared/canonical-json.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const requestHash = canonicalSha256({ request: "read", paths: ["a.txt"] });
const sourceHash = "a".repeat(64);
const binding = { workspaceId: "workspace-a", ownerId: "client-a", requestHash };
let root: string;
let ws: Workspace;

function expectBatchCode(run: () => unknown, code: string): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

beforeEach(() => {
  root = makeTmpDir("workspace-batch");
  ws = new Workspace(root);
});

afterEach(() => cleanup(root));

describe("canonical JSON hashing", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = { z: 1, nested: { b: true, a: null }, items: ["first", { y: 2, x: 1 }] };
    const right = { items: ["first", { x: 1, y: 2 }], nested: { a: null, b: true }, z: 1 };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
    expect(canonicalSha256({ ...right, items: [...right.items].reverse() })).not.toBe(canonicalSha256(right));
  });

  it("uses JSON scalar semantics for null, booleans, finite numbers and strings", () => {
    expect(canonicalJson({ n: null, yes: true, no: false, integer: 1, zero: -0, text: "中文😀" }))
      .toBe('{"integer":1,"n":null,"no":false,"text":"中文😀","yes":true,"zero":0}');
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["date", new Date(0)],
    ["function", () => 1],
    ["symbol", Symbol("x")],
  ])("rejects unsupported %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it("rejects cycles, sparse arrays, accessors and symbol keys", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    const symbolKey = { [Symbol("key")]: "value" };
    for (const value of [cyclic, sparse, accessor, symbolKey]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });
});

describe("bounded cursor snapshots", () => {
  it("resolves the stored snapshot and position for the correct bindings", () => {
    const registry = new SnapshotRegistry();
    const cursor = registry.create({ ...binding, sourceHashes: [sourceHash], payload: { matches: ["one", "two"] } }, 4, 1000);
    const first = registry.resolve<{ matches: string[] }>(cursor, { ...binding, sourceHashes: [sourceHash] }, 1001);
    expect(first).toMatchObject({
      ...binding,
      sourceHashes: [sourceHash],
      position: 4,
      payload: { matches: ["one", "two"] },
      expiresAt: 1000 + 10 * 60 * 1000,
    });

    const next = registry.issueCursor(first.snapshotId, 9, 1001);
    expect(registry.resolve(next, binding, 1002).position).toBe(9);
  });

  it("rejects a tampered position and mismatched workspace, owner or request", () => {
    const registry = new SnapshotRegistry();
    const cursor = registry.create({ ...binding, payload: { position: "server-owned" } }, 1, 1000);
    const [incarnation, body, signature] = cursor.split(".");
    const token = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { position: number };
    token.position++;
    const tampered = `${incarnation}.${Buffer.from(JSON.stringify(token), "utf8").toString("base64url")}.${signature}`;
    expectBatchCode(() => registry.resolve(tampered, binding, 1001), "CURSOR_INVALID");
    expectBatchCode(() => registry.resolve(cursor, { ...binding, workspaceId: "workspace-b" }, 1001), "CURSOR_INVALID");
    expectBatchCode(() => registry.resolve(cursor, { ...binding, ownerId: "client-b" }, 1001), "CURSOR_INVALID");
    expectBatchCode(() => registry.resolve(cursor, { ...binding, requestHash: "b".repeat(64) }, 1001), "CURSOR_INVALID");
  });

  it("expires by TTL and returns expired for a prior registry incarnation", () => {
    const registry = new SnapshotRegistry();
    const cursor = registry.create({ ...binding, payload: { data: "snapshot" } }, 0, 1000);
    expectBatchCode(() => registry.resolve(cursor, binding, 1000 + 10 * 60 * 1000), "CURSOR_EXPIRED");
    const second = registry.create({ ...binding, payload: { data: "snapshot" } }, 0, 2000);
    expectBatchCode(() => new SnapshotRegistry().resolve(second, binding, 2001), "CURSOR_EXPIRED");
  });

  it("enforces per-workspace, per-snapshot and global serialized storage limits", () => {
    const registry = new SnapshotRegistry();
    for (let index = 0; index < SNAPSHOT_MAX_PER_WORKSPACE; index++) {
      registry.create({ ...binding, payload: { index } }, 0, 1000);
    }
    expect(registry.size).toBe(SNAPSHOT_MAX_PER_WORKSPACE);
    expect(registry.bytesStored).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES * SNAPSHOT_MAX_PER_WORKSPACE);
    expectBatchCode(() => registry.create({ ...binding, payload: { overflow: true } }, 0, 1000), "CURSOR_CAPACITY");

    const oversized = new SnapshotRegistry();
    expectBatchCode(() => oversized.create({ ...binding, payload: "x".repeat(SNAPSHOT_MAX_BYTES) }, 0, 1000), "CURSOR_CAPACITY");
    expect(oversized.size).toBe(0);
    expect(oversized.bytesStored).toBe(0);
  });

  it("keeps the registry globally bounded across many workspaces", () => {
    const registry = new SnapshotRegistry();
    for (let index = 0; index < SNAPSHOT_MAX_GLOBAL_COUNT; index++) {
      registry.create({ workspaceId: `workspace-${index}`, ownerId: "client-a", requestHash, payload: { index } }, 0, 1000);
    }
    expect(registry.size).toBe(SNAPSHOT_MAX_GLOBAL_COUNT);
    expectBatchCode(() => registry.create({ workspaceId: "workspace-overflow", ownerId: "client-a", requestHash, payload: {} }, 0, 1000), "CURSOR_CAPACITY");
  });
});

describe("byte-bounded workspace read", () => {
  it("paginates ASCII by exact byte offsets and returns the full source hash", async () => {
    const bytes = Buffer.from("abcdefghij\n", "utf8");
    fs.writeFileSync(path.join(root, "ascii.txt"), bytes);
    const first = await ws.readFileBytes("ascii.txt", { maxBytes: 4 });
    const second = await ws.readFileBytes("ascii.txt", {
      offsetBytes: first.nextOffsetBytes,
      maxBytes: 4,
      expectedSourceHash: first.sourceHash,
    });
    expect(first).toMatchObject({
      content: "abcd",
      startOffsetBytes: 0,
      nextOffsetBytes: 4,
      returnedBytes: 4,
      truncated: true,
      eof: false,
      sourceHash: sha256(bytes),
    });
    expect(first.content + second.content).toBe("abcdefgh");
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  it("keeps Chinese and emoji code points intact when a page cap lands inside one", async () => {
    const text = "A中😀B";
    write(root, "utf8.txt", text);
    const first = await ws.readFileBytes("utf8.txt", { maxBytes: 5 });
    const second = await ws.readFileBytes("utf8.txt", {
      offsetBytes: first.nextOffsetBytes,
      maxBytes: 4,
      expectedSourceHash: first.sourceHash,
    });
    const third = await ws.readFileBytes("utf8.txt", {
      offsetBytes: second.nextOffsetBytes,
      maxBytes: 4,
      expectedSourceHash: first.sourceHash,
    });
    expect(first.content).toBe("A中");
    expect(first.returnedBytes).toBe(4);
    expect(first.nextOffsetBytes).toBe(4);
    expect(second.content).toBe("😀");
    expect(second.nextOffsetBytes).toBe(8);
    expect(third.content).toBe("B");
    expect(third.eof).toBe(true);
    expect(first.content + second.content + third.content).toBe(text);
  });

  it("bounds a huge single line by bytes and clamps huge requested pages", async () => {
    const text = "x".repeat(READ_ITEM_HARD_MAX_BYTES + 25);
    write(root, "long-line.txt", text);
    const result = await ws.readFileBytes("long-line.txt", { maxBytes: Number.MAX_SAFE_INTEGER });
    expect(result.returnedBytes).toBe(READ_ITEM_HARD_MAX_BYTES);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(READ_ITEM_HARD_MAX_BYTES);
    expect(result.nextOffsetBytes).toBe(READ_ITEM_HARD_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.sourceHash).toBe(sha256(text));
  });

  it("supports an exact cap and an empty EOF page", async () => {
    const bytes = Buffer.from("12345", "utf8");
    fs.writeFileSync(path.join(root, "exact.txt"), bytes);
    const page = await ws.readFileBytes("exact.txt", { maxBytes: 4 });
    const eof = await ws.readFileBytes("exact.txt", { offsetBytes: bytes.length, maxBytes: 4 });
    expect(page.returnedBytes).toBe(4);
    expect(page.content).toBe("1234");
    expect(eof).toMatchObject({ content: "", returnedBytes: 0, eof: true, truncated: false, nextOffsetBytes: 5 });
    expect(eof.sourceHash).toBe(sha256(bytes));
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 6])("rejects invalid offset %s", async (offset) => {
    write(root, "offset.txt", "small");
    await expect(ws.readFileBytes("offset.txt", { offsetBytes: offset })).rejects.toMatchObject({ code: "INVALID_OFFSET" });
  });

  it("rejects offsets inside a UTF-8 code point and page limits too small to progress safely", async () => {
    write(root, "boundary.txt", "中a");
    await expect(ws.readFileBytes("boundary.txt", { offsetBytes: 1, maxBytes: 4 })).rejects.toMatchObject({ code: "INVALID_OFFSET" });
    await expect(ws.readFileBytes("boundary.txt", { maxBytes: 3 })).rejects.toMatchObject({ code: "BYTE_LIMIT" });
    await expect(ws.readFileBytes("boundary.txt", { maxBytes: 0 })).rejects.toMatchObject({ code: "BYTE_LIMIT" });
  });

  it("returns SOURCE_CHANGED when a continuation hash no longer matches", async () => {
    write(root, "changing.txt", "before content");
    const first = await ws.readFileBytes("changing.txt", { maxBytes: 4 });
    fs.writeFileSync(path.join(root, "changing.txt"), "after content");
    await expect(ws.readFileBytes("changing.txt", {
      offsetBytes: first.nextOffsetBytes,
      maxBytes: 4,
      expectedSourceHash: first.sourceHash,
    })).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("reuses sensitive and workspace path policies", async () => {
    write(root, ".env", "secret");
    await expect(ws.readFileBytes(".env")).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
    await expect(ws.readFileBytes("../outside.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects a symlink that resolves outside the workspace", async (context) => {
    const outside = makeTmpDir("workspace-batch-outside");
    write(outside, "secret.txt", "outside bytes");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "outside-link.txt"));
    } catch {
      return context.skip();
    }
    await expect(ws.readFileBytes("outside-link.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });

  it("rejects NUL bytes and malformed UTF-8 anywhere in the source", async () => {
    const binary = Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0, 66])]);
    fs.writeFileSync(path.join(root, "late-nul.bin"), binary);
    await expect(ws.readFileBytes("late-nul.bin", { maxBytes: 4 })).rejects.toMatchObject({ code: "BINARY_FILE" });
    fs.writeFileSync(path.join(root, "bad-utf8.txt"), Buffer.from([0x61, 0xc3, 0x28, 0x62]));
    await expect(ws.readFileBytes("bad-utf8.txt", { maxBytes: 4 })).rejects.toMatchObject({ code: "INVALID_UTF8" });
  });
});
