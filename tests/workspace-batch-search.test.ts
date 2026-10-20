import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { BatchContractError, SnapshotRegistry, SNAPSHOT_TTL_MS } from "../src/workspace/batch.js";
import { BATCH_SEARCH_MAX_PAGE_BYTES, batchSearch, type BatchSearchContext, type BatchSearchRequest } from "../src/workspace/batch-search.js";
import { Workspace } from "../src/workspace/manager.js";
import { findRipgrep, type SearchRuntime } from "../src/workspace/search.js";

let root: string;
let workspace: Workspace;
let registry: SnapshotRegistry;
const smokeRgPath = findRipgrep();

beforeEach(() => {
  root = makeTmpDir("workspace-batch-search");
  workspace = new Workspace(root);
  registry = new SnapshotRegistry();
});

afterEach(() => {
  cleanup(root);
});

function context(runtime: SearchRuntime = {}): BatchSearchContext {
  return { ownerId: "test-client", registry, runtime: { rgPath: null, ...runtime } };
}

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(options: {
  stdout?: string;
  stderr?: string;
  code?: number;
  hangUntilKilled?: boolean;
} = {}): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  let finished = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (finished) return;
    finished = true;
    let ended = 0;
    const onEnd = (): void => {
      if (++ended === 2) emitter.emit("close", code, signal);
    };
    emitter.stdout.once("end", onEnd);
    emitter.stderr.once("end", onEnd);
    if (options.stdout) emitter.stdout.write(options.stdout);
    if (options.stderr) emitter.stderr.write(options.stderr);
    emitter.stdout.end();
    emitter.stderr.end();
  };
  emitter.kill = vi.fn((signal?: NodeJS.Signals) => {
    if (options.hangUntilKilled) queueMicrotask(() => close(null, signal ?? "SIGTERM"));
    return true;
  });
  if (!options.hangUntilKilled) queueMicrotask(() => close(options.code ?? 0, null));
  return emitter;
}

function fakeRgRuntime(file: string, options: { invalidPattern?: string; hangSearch?: boolean } = {}): SearchRuntime {
  return {
    rgPath: "fake-rg",
    spawn: (_command: string, args: string[], _spawnOptions: SpawnOptions): ChildProcess => {
      if (args[0] === "--files") return fakeChild({ stdout: `${file}\0` });
      if (options.hangSearch) return fakeChild({ hangUntilKilled: true });
      const query = args[args.indexOf("--") + 1] ?? "";
      if (options.invalidPattern === query) {
        return fakeChild({ stderr: "regex parse error: unclosed character class", code: 2 });
      }
      const content = fs.readFileSync(file, "utf8");
      const events: unknown[] = [{ type: "begin", data: { path: { text: file } } }];
      content.split("\n").forEach((line, index) => {
        if (line.includes(query)) {
          events.push({
            type: "match",
            data: { path: { text: file }, line_number: index + 1, lines: { text: `${line}\n` } },
          });
        }
      });
      events.push({ type: "end", data: { path: { text: file }, stats: { bytes_searched: Buffer.byteLength(content) } } });
      return fakeChild({ stdout: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
    },
  };
}

describe("workspace batch search", () => {
  it("deduplicates scopes, folds descendants, and returns stable query/path order", async () => {
    write(root, "src/nested/b.ts", "needle-b\n");
    write(root, "src/a.ts", "needle-a\n");
    const result = await batchSearch(workspace, {
      queries: [{ id: "q1", query: "needle", mode: "literal", paths: ["src", "src/nested", "src"] }],
    }, context());

    expect(result.matches.map(({ path, line }) => [path, line])).toEqual([
      ["src/a.ts", 1],
      ["src/nested/b.ts", 1],
    ]);
    expect(result.queries[0]).toMatchObject({
      id: "q1",
      scanComplete: true,
      resultsComplete: true,
      complete: true,
      truncated: false,
      matchesObserved: 2,
      matchesReturned: 2,
      bytesScanned: Buffer.byteLength("needle-a\nneedle-b\n"),
    });
    expect(result.nextCursor).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it("shares scan bytes serially and marks later queries partial when the budget is exhausted", async () => {
    write(root, "first.txt", "needle\n");
    write(root, "second.txt", "needle\n");
    const result = await batchSearch(workspace, {
      queries: [
        { id: "first", query: "needle", mode: "literal", paths: ["first.txt"] },
        { id: "second", query: "needle", mode: "literal", paths: ["second.txt"] },
      ],
    }, context({ budget: { maxBytesScanned: 8, maxFilesConsidered: 10, deadlineMs: 5_000, maxFileBytes: 2 * 1024 * 1024 } }));

    expect(result.queries[0]).toMatchObject({ bytesScanned: 7, scanComplete: true, resultsComplete: true, complete: true, matchesObserved: 1 });
    expect(result.queries[1]).toMatchObject({ bytesScanned: 0, scanComplete: false, resultsComplete: true, complete: false, truncated: true });
    expect(result.queries[1]?.stopReasons).toContain("SCAN_BYTE_LIMIT");
    expect(result).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
  });

  it("keeps scanning after a per-query return cap and applies the whole-batch 100-match cap", async () => {
    write(root, "matches.txt", Array.from({ length: 60 }, (_, index) => `needle-${index}`).join("\n"));
    const result = await batchSearch(workspace, {
      queries: Array.from({ length: 8 }, (_, index) => ({
        id: `q${index}`,
        query: "needle",
        mode: "literal" as const,
        paths: ["matches.txt"],
        max_matches: 500,
      })),
    }, context());

    expect(result.matches).toHaveLength(100);
    expect(result.totalMatches).toBe(100);
    expect(result.queries.map((query) => query.matchesObserved)).toEqual(Array(8).fill(60));
    expect(result.queries.slice(0, 2).map((query) => query.matchesReturned)).toEqual([50, 50]);
    expect(result.queries.slice(2).map((query) => query.matchesReturned)).toEqual(Array(6).fill(0));
    expect(result.queries.every((query) => query.scanComplete)).toBe(true);
    expect(result.queries.every((query) => query.resultsComplete)).toBe(false);
    expect(result.queries.every((query) => query.complete)).toBe(false);
    expect(result).toMatchObject({ scanComplete: true, resultsComplete: false, complete: false });
    expect(result.truncated).toBe(true);
  });

  it.skipIf(!smokeRgPath)("smokes a 500-file workspace with three queries inside shared budgets using ripgrep", async () => {
    for (let index = 0; index < 500; index += 1) {
      write(root, `medium/file-${String(index).padStart(4, "0")}.txt`, `needle file ${index}\n`);
    }

    const result = await batchSearch(workspace, {
      queries: Array.from({ length: 3 }, (_, index) => ({
        id: `medium-${index}`,
        query: "needle",
        mode: "literal" as const,
        paths: ["medium"],
        max_matches: 5,
      })),
    }, context({ rgPath: smokeRgPath }));

    expect(result.queries).toHaveLength(3);
    expect(result.queries.every((query) => query.engine === "ripgrep")).toBe(true);
    expect(result.queries.every((query) => query.scanComplete && !query.resultsComplete && !query.complete)).toBe(true);
    expect(result).toMatchObject({ scanComplete: true, resultsComplete: false, complete: false, truncated: true });
    expect(result.matches).toHaveLength(15);
    expect(result.filesConsidered).toBeLessThanOrEqual(10_000);
    expect(result.filesScanned).toBeLessThanOrEqual(result.filesConsidered);
    expect(result.bytesScanned).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(BATCH_SEARCH_MAX_PAGE_BYTES);
  });

  it("marks per-query match truncation without stopping the scan", async () => {
    write(root, "many.txt", Array.from({ length: 25 }, (_, index) => `needle-${index}`).join("\n"));
    const result = await batchSearch(workspace, {
      queries: [{ id: "limited", query: "needle", mode: "literal", paths: ["many.txt"], max_matches: 1 }],
    }, context());

    expect(result.queries[0]).toMatchObject({
      matchesObserved: 25,
      matchesReturned: 1,
      scanComplete: true,
      resultsComplete: false,
      complete: false,
      truncated: true,
    });
    expect(result.queries[0]?.stopReasons).toContain("MATCH_LIMIT");
    expect(result).toMatchObject({ scanComplete: true, resultsComplete: false, complete: false });

    const defaultLimit = await batchSearch(workspace, {
      queries: [{ id: "default", query: "needle", mode: "literal", paths: ["many.txt"] }],
    }, context());
    expect(defaultLimit.queries[0]).toMatchObject({
      matchesObserved: 25,
      matchesReturned: 20,
      scanComplete: true,
      resultsComplete: false,
      complete: false,
      truncated: true,
    });
  });

  it("applies path and glob filters to the same bounded search", async () => {
    write(root, "src/a.ts", "needle-typescript\n");
    write(root, "src/b.txt", "needle-text\n");
    write(root, "other.ts", "needle-other\n");
    const result = await batchSearch(workspace, {
      queries: [{ id: "glob", query: "needle", mode: "literal", paths: ["src"], glob: "**/*.ts" }],
    }, context());

    expect(result.matches.map((match) => match.path)).toEqual(["src/a.ts"]);
  });

  it("reports an invalid regex for its query and continues with the next query", async () => {
    const file = write(root, "regex.txt", "needle-good\n");
    const result = await batchSearch(workspace, {
      queries: [
        { id: "bad-regex", query: "[a", mode: "regex", paths: ["regex.txt"] },
        { id: "literal", query: "needle", mode: "literal", paths: ["regex.txt"] },
      ],
    }, context(fakeRgRuntime(file, { invalidPattern: "[a" })));

    expect(result.queries[0]?.errors[0]?.code).toBe("INVALID_PATTERN");
    expect(result.queries[0]?.stopReasons).toContain("PROCESS_ERROR");
    expect(result.queries[1]?.matchesObserved).toBe(1);
    expect(result.matches).toEqual([{ id: "literal", untrusted: true, path: "regex.txt", line: 1, text: "needle-good" }]);
  });

  it("shares the deadline across serial queries", async () => {
    const file = write(root, "slow.txt", "needle\n");
    const result = await batchSearch(workspace, {
      queries: [
        { id: "first", query: "needle", mode: "literal" },
        { id: "second", query: "needle", mode: "literal" },
      ],
    }, context({
      ...fakeRgRuntime(file, { hangSearch: true }),
      budget: { maxBytesScanned: 1024, maxFilesConsidered: 10, deadlineMs: 25, maxFileBytes: 2 * 1024 * 1024 },
    }));

    expect(result.queries[0]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result.queries[1]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result.queries[0]?.stopReasons).toContain("DEADLINE");
    expect(result.queries[1]?.stopReasons).toContain("DEADLINE");
    expect(result).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
  });

  it("surfaces ITEM_LIMIT when a query exhausts its file-entry budget", async () => {
    write(root, "one.txt", "needle\n");
    write(root, "two.txt", "needle\n");
    write(root, "three.txt", "needle\n");
    const runtime: SearchRuntime = {
      rgPath: null,
      budget: { maxBytesScanned: 1024, maxFilesConsidered: 2, deadlineMs: 10_000, maxFileBytes: 2 * 1024 * 1024 },
    };
    const result = await batchSearch(workspace, {
      queries: [{ id: "many-files", query: "needle", mode: "literal" }],
    }, context(runtime));

    expect(result.queries[0]?.stopReasons).toContain("ITEM_LIMIT");
    expect(result.queries[0]?.filesConsidered).toBe(2);
    expect(result.queries[0]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
  });

  it("shares file-entry budget across queries and skips later scans", async () => {
    write(root, "first.txt", "needle\n");
    write(root, "second.txt", "needle\n");
    const runtime: SearchRuntime = {
      rgPath: null,
      budget: { maxBytesScanned: 1024, maxFilesConsidered: 1, deadlineMs: 10_000, maxFileBytes: 2 * 1024 * 1024 },
    };
    const result = await batchSearch(workspace, {
      queries: [
        { id: "first", query: "needle", mode: "literal", paths: ["first.txt"] },
        { id: "second", query: "needle", mode: "literal", paths: ["second.txt"] },
      ],
    }, context(runtime));

    expect(result.queries[0]).toMatchObject({
      filesConsidered: 1,
      scanComplete: true,
      resultsComplete: true,
      complete: true,
      matchesObserved: 1,
    });
    expect(result.queries[1]?.stopReasons).toContain("ITEM_LIMIT");
    expect(result.queries[1]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result.filesConsidered).toBe(1);
    expect(result.matches.map((match) => match.id)).toEqual(["first"]);
  });

  it("enforces path, query, and glob schema bounds and the 500-character snippet cap", async () => {
    await expect(batchSearch(workspace, {
      queries: [{ id: "paths", query: "needle", mode: "literal", paths: Array.from({ length: 17 }, (_, index) => `p${index}`) }],
    }, context())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(batchSearch(workspace, {
      queries: [{ id: "query", query: "q".repeat(513), mode: "literal" }],
    }, context())).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(batchSearch(workspace, {
      queries: [{ id: "glob", query: "needle", mode: "literal", glob: "g".repeat(513) }],
    }, context())).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    write(root, "long-line.txt", `needle${"x".repeat(600)}\n`);
    const result = await batchSearch(workspace, {
      queries: [{ id: "snippet", query: "needle", mode: "literal", paths: ["long-line.txt"] }],
    }, context());
    expect(result.matches[0]?.text).toHaveLength(500);
    expect(result.matches[0]?.untrusted).toBe(true);
  });

  it("reports the primitive's short-query constraint explicitly", async () => {
    const result = await batchSearch(workspace, {
      queries: [{ id: "short", query: "x", mode: "literal" }],
    }, context());

    expect(result.queries[0]?.errors[0]?.code).toBe("QUERY_TOO_SHORT");
    expect(result.queries[0]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result.complete).toBe(false);
  });

  it("keeps regex engine failures and path errors local to their query", async () => {
    write(root, "public.txt", "needle-public\n");
    const result = await batchSearch(workspace, {
      queries: [
        { id: "regex", query: "needle", mode: "regex" },
        { id: "outside", query: "needle", mode: "literal", paths: ["../outside"] },
        { id: "literal", query: "needle", mode: "literal", paths: ["public.txt"] },
      ],
    }, context({ rgPath: null }));

    expect(result.queries[0]?.errors[0]?.code).toBe("ENGINE_UNAVAILABLE");
    expect(result.queries[0]).toMatchObject({ scanComplete: false, resultsComplete: true, complete: false });
    expect(result.queries[1]?.errors[0]?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(result.queries[2]).toMatchObject({ complete: true, matchesObserved: 1, matchesReturned: 1 });
    expect(result.matches).toEqual([{ id: "literal", untrusted: true, path: "public.txt", line: 1, text: "needle-public" }]);
  });

  it("rejects sensitive path scopes while continuing other queries", async () => {
    write(root, ".env", "SECRET=needle-secret\n");
    write(root, "public.txt", "needle-public\n");
    const result = await batchSearch(workspace, {
      queries: [
        { id: "secret", query: "needle", mode: "literal", paths: [".", ".env"] },
        { id: "public", query: "needle", mode: "literal", paths: ["public.txt"] },
      ],
    }, context());

    expect(result.queries[0]?.errors[0]?.code).toBe("ACCESS_DENIED_SENSITIVE_FILE");
    expect(result.matches.map((match) => [match.id, match.path, match.untrusted])).toEqual([
      ["secret", "public.txt", true],
      ["public", "public.txt", true],
    ]);
  });

  it("follows Workspace.resolve path trimming semantics", async () => {
    write(root, "named file  .txt", "needle\n");
    const result = await batchSearch(workspace, {
      queries: [{ id: "spaces", query: "needle", mode: "literal", paths: ["  named file  .txt  "] }],
    }, context());

    expect(result.matches[0]?.path).toBe("named file  .txt");
    expect(result.queries[0]?.complete).toBe(true);
  });

  it("keeps the full result inline below the page cap and does not invent source hashes", async () => {
    write(root, "a.txt", "needle\n");
    const result = await batchSearch(workspace, {
      queries: [{ id: "q", query: "needle", mode: "literal" }],
    }, context());

    expect(result).toMatchObject({
      returnedMatches: 1,
      totalMatches: 1,
      scanComplete: true,
      resultsComplete: true,
      complete: true,
      truncated: false,
    });
    expect(result.nextCursor).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("sourceHash");
    expect(registry.size).toBe(0);
  });

  it("paginates a fixed snapshot and binds its cursor to owner, request, and TTL", async () => {
    const line = `needle${'"'.repeat(494)}`;
    write(root, "matches.txt", `${Array.from({ length: 13 }, () => line).join("\n")}\n`);
    const longSensitiveScopes = Array.from({ length: 15 }, (_, index) => `.env.${index}.${"x".repeat(1000)}`);
    const request: BatchSearchRequest = {
      queries: Array.from({ length: 8 }, (_, index) => ({
        id: `page-${index}`,
        query: "needle",
        mode: "literal" as const,
        paths: ["matches.txt", ...longSensitiveScopes],
        max_matches: 13,
      })),
    };
    const first = await batchSearch(workspace, request, context());

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.matches.length).toBeGreaterThan(0);
    expect(first.matches.length).toBeLessThan(first.totalMatches);
    expect(first.totalMatches).toBe(100);
    expect(first).toMatchObject({ scanComplete: false, resultsComplete: false, complete: false, truncated: true });
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(BATCH_SEARCH_MAX_PAGE_BYTES);
    expect(registry.size).toBe(1);

    write(root, "matches.txt", "changed after snapshot\n");
    const next = await batchSearch(workspace, { ...request, cursor: first.nextCursor }, context());
    expect(next.totalMatches).toBe(100);
    expect(next).toMatchObject({ scanComplete: false, resultsComplete: false, complete: false });
    expect(next.matches[0]).not.toEqual(first.matches[0]);
    expect(next.matches[0]?.text).toBe(line);

    await expect(batchSearch(
      workspace,
      { ...request, cursor: first.nextCursor },
      { ...context(), ownerId: "different-client" },
    )).rejects.toBeInstanceOf(BatchContractError);
    await expect(batchSearch(
      workspace,
      {
        ...request,
        queries: request.queries.map((query, index) => index === 0 ? { ...query, query: "changed" } : query),
        cursor: first.nextCursor,
      },
      context(),
    )).rejects.toMatchObject({ code: "CURSOR_INVALID" });

    const originalNow = Date.now;
    Date.now = () => originalNow() + SNAPSHOT_TTL_MS + 1;
    try {
      await expect(batchSearch(
        workspace,
        { ...request, cursor: first.nextCursor },
        context(),
      )).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    } finally {
      Date.now = originalNow;
    }
  });

  it("enforces the batch query count before starting any query", async () => {
    const queries = Array.from({ length: 9 }, (_, index) => ({
      id: `q${index}`,
      query: "needle",
      mode: "literal" as const,
    }));
    const request: BatchSearchRequest = { queries };
    await expect(batchSearch(workspace, request, context())).rejects.toMatchObject({ code: "QUERY_LIMIT" });
  });
});
