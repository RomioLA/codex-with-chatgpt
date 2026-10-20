import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir, cleanup, write } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import {
  SEARCH_MAX_BYTES,
  SEARCH_MAX_DEADLINE_MS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_FILE_BYTES,
  normalizeSearchBudget,
  resetRipgrepCache,
  searchWorkspace,
  searchWorkspaceBounded,
  type SearchRuntime,
} from "../src/workspace/search.js";

let root: string;
let ws: Workspace;

beforeEach(() => {
  root = makeTmpDir("search-budget");
  ws = new Workspace(root);
});

afterEach(() => {
  resetRipgrepCache();
  cleanup(root);
});

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(options: { stdout?: string; stderr?: string; code?: number; hangUntilKilled?: boolean } = {}): {
  child: FakeChild;
  wasKilled: () => boolean;
} {
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  let killed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null): void => {
    let ended = 0;
    const onEnd = (): void => {
      if (++ended === 2) emitter.emit("close", code, signal);
    };
    emitter.stdout.once("end", onEnd);
    emitter.stderr.once("end", onEnd);
    emitter.stdout.end();
    emitter.stderr.end();
  };
  emitter.kill = vi.fn(() => {
    killed = true;
    if (options.hangUntilKilled) queueMicrotask(() => close(null, "SIGTERM"));
    return true;
  });
  if (!options.hangUntilKilled) {
    queueMicrotask(() => {
      if (options.stdout) emitter.stdout.write(options.stdout);
      if (options.stderr) emitter.stderr.write(options.stderr);
      close(options.code ?? 0, null);
    });
  }
  return { child: emitter, wasKilled: () => killed };
}

type SpawnCall = { command: string; args: string[]; options: SpawnOptions };

function fakeRuntime(
  files: string[],
  makeSearchChild: () => ReturnType<typeof fakeChild>,
  calls: SpawnCall[]
): SearchRuntime {
  return {
    rgPath: "fake-rg",
    spawn: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      if (args[0] === "--files") return fakeChild({ stdout: files.map((file) => `${file}\0`).join("") }).child;
      return makeSearchChild().child;
    },
  };
}

function event(type: string, file: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    data: {
      path: { text: file },
      ...extra,
    },
  });
}

function matchEvent(file: string, line: number, text: string): string {
  return event("match", file, { line_number: line, lines: { text: `${text}\n` } });
}

function endEvent(file: string, bytes: number): string {
  return event("end", file, { stats: { bytes_searched: bytes } });
}

function matchingEvents(files: string[]): string {
  return files.flatMap((file) => [
    event("begin", file),
    matchEvent(file, 1, "needle"),
    endEvent(file, fs.statSync(file).size),
  ]).join("\n") + "\n";
}

describe("bounded search budgets and rg determinism", () => {
  it("clamps every caller budget to its hard maximum", () => {
    expect(normalizeSearchBudget({
      maxBytesScanned: Number.MAX_SAFE_INTEGER,
      maxFilesConsidered: Number.MAX_SAFE_INTEGER,
      deadlineMs: 60_000,
      maxFileBytes: Number.MAX_SAFE_INTEGER,
    })).toEqual({
      maxBytesScanned: SEARCH_MAX_BYTES,
      maxFilesConsidered: SEARCH_MAX_FILES,
      deadlineMs: SEARCH_MAX_DEADLINE_MS,
      maxFileBytes: SEARCH_MAX_FILE_BYTES,
    });
  });

  it("uses --no-config without --sort path and sorts randomized rg events and file lists", async () => {
    const a = write(root, "a.txt", "alpha\nbeta\ngamma");
    const b = write(root, "b.txt", "delta\nomega\nzeta");
    const aBytes = fs.statSync(a).size;
    const bBytes = fs.statSync(b).size;
    const run = async (files: string[], events: string[]) => {
      const calls: SpawnCall[] = [];
      const runtime = fakeRuntime(files, () => fakeChild({ stdout: `${events.join("\n")}\n` }), calls);
      const result = await searchWorkspaceBounded(ws, { query: "xx", limit: 2 }, runtime);
      return { calls, result };
    };
    const first = await run([b, a], [
      event("begin", b), matchEvent(b, 1, "delta"), endEvent(b, bBytes),
      event("begin", a), matchEvent(a, 3, "gamma"), matchEvent(a, 1, "alpha"), endEvent(a, aBytes),
    ]);
    const second = await run([a, b], [
      event("begin", a), matchEvent(a, 1, "alpha"), matchEvent(a, 3, "gamma"), endEvent(a, aBytes),
      event("begin", b), matchEvent(b, 1, "delta"), endEvent(b, bBytes),
    ]);

    expect(first.result.matches).toEqual([
      { path: "a.txt", line: 1, text: "alpha" },
      { path: "a.txt", line: 3, text: "gamma" },
    ]);
    expect(second.result.matches).toEqual(first.result.matches);
    expect(first.result).toMatchObject({ matchesObserved: 3, matchesReturned: 2, stopReason: "MATCH_LIMIT", truncated: true });
    for (const call of first.calls) {
      expect(call.args).toContain("--no-config");
      expect(call.args).not.toContain("--sort");
      expect(call.args).not.toContain("--max-count");
    }
  });

  it("charges file-size reservations before rg starts and returns bounded partial results", async () => {
    const a = write(root, "a.txt", "needle\n");
    const b = write(root, "b.txt", "needle\n");
    const calls: SpawnCall[] = [];
    const runtime = fakeRuntime([b, a], () => fakeChild({
      stdout: [event("begin", a), matchEvent(a, 1, "needle"), endEvent(a, fs.statSync(a).size)].join("\n") + "\n",
    }), calls);
    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { maxBytesScanned: 8 },
    }, runtime);
    expect(result).toMatchObject({
      matches: [{ path: "a.txt", line: 1, text: "needle" }],
      filesConsidered: 2,
      filesScanned: 1,
      bytesScanned: fs.statSync(a).size,
      stopReason: "SCAN_BYTE_LIMIT",
      truncated: true,
    });
    const scanCall = calls.find((call) => call.args[0] === "--json");
    expect(scanCall?.args).toContain("8");
  });

  it("bounds the literal Node fallback by scan bytes and returns stable order", async () => {
    write(root, "b.txt", "needle\n");
    write(root, "a.txt", "needle\n");
    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { maxBytesScanned: 8 },
    }, { rgPath: null });
    expect(result.engine).toBe("node");
    expect(result.bytesScanned).toBeLessThanOrEqual(8);
    expect(result.filesScanned).toBe(1);
    expect(result.filesConsidered).toBe(2);
    expect(result.stopReason).toBe("SCAN_BYTE_LIMIT");
    expect(result.matches.map((match) => match.path)).toEqual(["a.txt"]);
  });

  it("does not read past the hard per-file scan cap", async () => {
    fs.writeFileSync(path.join(root, "oversized.txt"), Buffer.alloc(SEARCH_MAX_FILE_BYTES + 1, 65));
    const result = await searchWorkspaceBounded(ws, { query: "needle" }, { rgPath: null });
    expect(result).toMatchObject({
      bytesScanned: 0,
      filesConsidered: 1,
      filesScanned: 0,
      stopReason: "SCAN_BYTE_LIMIT",
      truncated: true,
    });
  });

  it("honors C2C sensitive, noise and .c2cignore rules in the Node fallback", async () => {
    write(root, ".c2cignore", "private/\n");
    write(root, "public/needle.txt", "needle-alpha\n");
    write(root, "private/needle.txt", "needle-private\n");
    write(root, "node_modules/pkg/needle.txt", "needle-noise\n");
    const ignoredWorkspace = new Workspace(root);
    const result = await searchWorkspaceBounded(ignoredWorkspace, { query: "needle" }, { rgPath: null });
    expect(result.matches.map((match) => match.path)).toEqual(["public/needle.txt"]);
  });

  it("does not use JavaScript regex when bounded ripgrep is unavailable", async () => {
    const result = await searchWorkspaceBounded(ws, { query: "[(", regex: true }, { rgPath: null });
    expect(result).toMatchObject({
      engine: "none",
      errorCode: "ENGINE_UNAVAILABLE",
      stopReason: "ENGINE_UNAVAILABLE",
    });
  });

  it("keeps the legacy regex fallback while the strict primitive rejects it", async () => {
    write(root, "regex.txt", "needle-alpha\nother\n");
    const previous = process.env.C2C_DISABLE_RG;
    process.env.C2C_DISABLE_RG = "1";
    resetRipgrepCache();
    try {
      const legacy = await searchWorkspace(ws, { query: "needle-.*", regex: true });
      expect(legacy.engine).toBe("node");
      expect(legacy.matches[0]?.text).toBe("needle-alpha");
      const strict = await searchWorkspaceBounded(ws, { query: "needle-.*", regex: true });
      expect(strict.errorCode).toBe("ENGINE_UNAVAILABLE");
    } finally {
      if (previous === undefined) delete process.env.C2C_DISABLE_RG;
      else process.env.C2C_DISABLE_RG = previous;
      resetRipgrepCache();
    }
  });

  it("stops the literal Node fallback at its deadline", async () => {
    write(root, "slow.txt", "needle\n".repeat(150_000));
    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { deadlineMs: 1, maxBytesScanned: 2 * 1024 * 1024 },
    }, { rgPath: null });
    expect(result.stopReason).toBe("DEADLINE");
    expect(result.truncated).toBe(true);
    expect(result.bytesScanned).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.elapsedMs).toBeLessThan(1000);
  });

  it("terminates ripgrep at the deadline and keeps a bounded partial result", async () => {
    const file = write(root, "slow.txt", "needle\n");
    const calls: SpawnCall[] = [];
    let scanKilled = false;
    const runtime = fakeRuntime([file], () => {
      const hanging = fakeChild({ hangUntilKilled: true });
      const originalKill = hanging.child.kill;
      hanging.child.kill = vi.fn((signal) => {
        scanKilled = true;
        return originalKill(signal);
      });
      return hanging;
    }, calls);
    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { deadlineMs: 20 },
    }, runtime);
    expect(scanKilled).toBe(true);
    expect(result.stopReason).toBe("DEADLINE");
    expect(result.truncated).toBe(true);
    expect(calls.some((call) => call.args[0] === "--json")).toBe(true);
  });

  it("surfaces malformed JSON and rg process errors", async () => {
    write(root, "bad.txt", "needle\n");
    const malformedCalls: SpawnCall[] = [];
    const malformed = await searchWorkspaceBounded(ws, { query: "needle" }, fakeRuntime(
      [path.join(root, "bad.txt")],
      () => fakeChild({ stdout: "not-json\n" }),
      malformedCalls,
    ));
    expect(malformed).toMatchObject({ stopReason: "PROCESS_ERROR", errorCode: "PROCESS_ERROR" });

    const regexCalls: SpawnCall[] = [];
    const invalidPattern = await searchWorkspaceBounded(ws, { query: "[(", regex: true }, fakeRuntime(
      [path.join(root, "bad.txt")],
      () => fakeChild({ stderr: "regex parse error: unclosed character class", code: 2 }),
      regexCalls,
    ));
    expect(invalidPattern).toMatchObject({ stopReason: "PROCESS_ERROR", errorCode: "INVALID_PATTERN" });
  });

  it("preserves deterministic partial results when the Node candidate cap is reached", async () => {
    write(root, "c.txt", "needle-c\n");
    write(root, "b.txt", "no match\n");
    write(root, "a.txt", "needle-a\n");

    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { maxFilesConsidered: 2 },
    }, { rgPath: null });

    expect(result.matches).toEqual([{ path: "a.txt", line: 1, text: "needle-a" }]);
    expect(result).toMatchObject({
      engine: "node",
      filesConsidered: 2,
      matchesReturned: 1,
      truncated: true,
      stopReason: "ITEM_LIMIT",
    });
  });

  it("selects the same bounded candidates when ripgrep lists paths in different orders", async () => {
    const files = [
      write(root, "a.txt", "needle\n"),
      write(root, "b.txt", "needle\n"),
      write(root, "c.txt", "needle\n"),
      write(root, "d.txt", "needle\n"),
    ];
    const run = async (enumeration: string[]) => {
      const calls: SpawnCall[] = [];
      const result = await searchWorkspaceBounded(ws, {
        query: "needle",
        budget: { maxFilesConsidered: 2 },
      }, fakeRuntime(enumeration, () => fakeChild({ stdout: matchingEvents(files) }), calls));
      const searchCall = calls.find((call) => call.args[0] === "--json");
      const filesStart = searchCall!.args.indexOf("--") + 2;
      return {
        result,
        selected: searchCall!.args.slice(filesStart).map((file) => path.basename(file)),
      };
    };

    const first = await run([files[3]!, files[1]!, files[0]!, files[2]!]);
    const second = await run([files[2]!, files[0]!, files[3]!, files[1]!]);
    expect(first.selected).toEqual(["a.txt", "b.txt"]);
    expect(second.selected).toEqual(first.selected);
    expect(first.result.matches).toEqual(second.result.matches);
    expect(first.result).toMatchObject({ truncated: true, stopReason: "ITEM_LIMIT" });
  });

  it("searches preserved candidates after an over-limit ripgrep file listing closes", async () => {
    const files = [
      write(root, "c.txt", "needle\n"),
      write(root, "a.txt", "needle\n"),
      write(root, "b.txt", "needle\n"),
    ];
    const calls: SpawnCall[] = [];
    let listingClosed = false;
    const runtime: SearchRuntime = {
      rgPath: "fake-rg",
      spawn: (command, args, options) => {
        calls.push({ command, args: [...args], options });
        if (args[0] === "--files") {
          const listing = fakeChild({ stdout: files.map((file) => `${file}\0`).join("") });
          listing.child.once("close", () => { listingClosed = true; });
          return listing.child;
        }
        expect(listingClosed).toBe(true);
        return fakeChild({ stdout: matchingEvents(files) }).child;
      },
    };

    const result = await searchWorkspaceBounded(ws, {
      query: "needle",
      budget: { maxFilesConsidered: 2 },
    }, runtime);

    expect(listingClosed).toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["--files", "--json"]);
    expect(result.matches.map((match) => match.path)).toEqual(["a.txt", "b.txt"]);
    expect(result).toMatchObject({ engine: "ripgrep", truncated: true, stopReason: "ITEM_LIMIT" });
  });

  it("keeps the legacy four-field schema and partial matches at the candidate cap", async () => {
    write(root, "c.txt", "needle-c\n");
    write(root, "b.txt", "no match\n");
    write(root, "a.txt", "needle-a\n");

    const result = await searchWorkspace(ws, { query: "needle" }, {
      rgPath: null,
      budget: { maxFilesConsidered: 2 },
    });

    expect(Object.keys(result).sort()).toEqual(["engine", "matchCount", "matches", "truncated"]);
    expect(result).toEqual({
      matches: [{ path: "a.txt", line: 1, text: "needle-a" }],
      matchCount: 1,
      truncated: true,
      engine: "node",
    });
  });
});
