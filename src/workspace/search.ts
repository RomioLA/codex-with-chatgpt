import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { BatchContractError, type SearchStopReason } from "./batch.js";
import { Workspace, WorkspaceError } from "./manager.js";

export interface SearchOptions {
  query: string;
  path?: string;
  glob?: string;
  limit?: number;
  regex?: boolean;
}

export interface SearchBudget {
  maxBytesScanned: number;
  maxFilesConsidered: number;
  deadlineMs: number;
  maxFileBytes: number;
}

export interface BoundedSearchOptions extends SearchOptions {
  /** Values above the documented hard limits are clamped, never honored. */
  budget?: Partial<SearchBudget>;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node";
}

export interface BoundedSearchResult {
  matches: SearchMatch[];
  matchCount: number;
  truncated: boolean;
  engine: "ripgrep" | "node" | "none";
  /** Actual rg stats on completed files; interrupted rg scans conservatively account reserved bytes. */
  bytesScanned: number;
  filesConsidered: number;
  filesScanned: number;
  matchesObserved: number;
  matchesReturned: number;
  elapsedMs: number;
  stopReason: SearchStopReason | null;
  errorCode?: "ENGINE_UNAVAILABLE" | "INVALID_PATTERN" | "PROCESS_ERROR";
}

export const SEARCH_MAX_BYTES = 256 * 1024 * 1024;
export const SEARCH_MAX_FILES = 10_000;
export const SEARCH_MAX_DEADLINE_MS = 10_000;
export const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;

const SEARCH_MAX_RG_WORKERS = 4;
const SEARCH_MAX_RG_FILES_PER_PROCESS = 128;
const SEARCH_MAX_RG_ARG_CHARS = 24_000;
const SEARCH_MAX_JSON_LINE_CHARS = SEARCH_MAX_FILE_BYTES * 6 + 64 * 1024;
const SEARCH_MAX_ERROR_TEXT_CHARS = 4096;
const SEARCH_MAX_DIRECTORY_ENTRIES = 20_000;
const SEARCH_MAX_ENUMERATED_PATHS = 100_000;
const SEARCH_MAX_PENDING_DIRECTORIES = 20_000;

const RG_CANDIDATES = [
  "rg",
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  "/Applications/Cursor.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
  "/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules/@vscode/ripgrep/bin/rg",
];

let cachedRg: string | null | undefined;

export function findRipgrep(): string | null {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (process.env.C2C_RG_PATH) {
    cachedRg = process.env.C2C_RG_PATH;
    return cachedRg;
  }
  if (cachedRg !== undefined) return cachedRg;
  for (const candidate of RG_CANDIDATES) {
    try {
      const result = spawnSync(candidate, ["--version"], {
        stdio: "ignore",
        timeout: 3000,
        windowsHide: true,
      });
      if (result.status === 0) {
        cachedRg = candidate;
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  cachedRg = null;
  return null;
}

/** For tests and callers that change the rg executable in-process. */
export function resetRipgrepCache(): void {
  cachedRg = undefined;
}

type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Internal process seam used by deterministic budget and failure tests. */
export interface SearchRuntime {
  rgPath?: string | null;
  spawn?: SpawnFunction;
  /** Internal test seam for exercising bounded behavior through the legacy wrapper. */
  budget?: Partial<SearchBudget>;
}

interface CandidatePath {
  abs: string;
  rel: string;
}

interface CandidateFile {
  abs: string;
  rel: string;
  sizeBytes: number;
}

interface PlannedFile extends CandidateFile {
  reservedBytes: number;
}

interface Accumulator {
  matches: SearchMatch[];
  matchesObserved: number;
  filesScanned: number;
  bytesScanned: number;
  errorCode?: BoundedSearchResult["errorCode"];
}

interface ProcessOutcome {
  exitCode: number | null;
  error?: Error;
  stderr: string;
}

class SearchContext {
  readonly startedAt = performance.now();
  readonly deadlineAt: number;
  readonly abortController = new AbortController();
  private readonly children = new Set<ChildProcess>();
  private readonly timer: NodeJS.Timeout;
  stopReason: SearchStopReason | null = null;
  fatalReason: SearchStopReason | null = null;

  constructor(deadlineMs: number) {
    this.deadlineAt = this.startedAt + deadlineMs;
    this.timer = setTimeout(() => this.fail("DEADLINE"), deadlineMs);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get shouldStop(): boolean {
    this.checkDeadline();
    return this.fatalReason !== null;
  }

  get elapsedMs(): number {
    return Math.max(0, performance.now() - this.startedAt);
  }

  mark(reason: SearchStopReason): void {
    if (this.stopReason === null) this.stopReason = reason;
  }

  fail(reason: "DEADLINE" | "PROCESS_ERROR"): void {
    if (this.fatalReason !== null) return;
    this.fatalReason = reason;
    this.stopReason = reason;
    this.abortController.abort();
    for (const child of this.children) this.terminate(child);
  }

  checkDeadline(): boolean {
    if (this.fatalReason === null && performance.now() >= this.deadlineAt) this.fail("DEADLINE");
    return this.fatalReason === "DEADLINE";
  }

  add(child: ChildProcess): void {
    this.children.add(child);
    if (this.fatalReason !== null) this.terminate(child);
  }

  remove(child: ChildProcess): void {
    this.children.delete(child);
  }

  close(): void {
    clearTimeout(this.timer);
    this.children.clear();
  }

  private terminate(child: ChildProcess): void {
    const escalation = setTimeout(() => {
      if (!this.children.has(child)) return;
      try { child.kill("SIGKILL"); } catch { /* the process may already be closed */ }
    }, 250);
    escalation.unref?.();
    child.once("close", () => clearTimeout(escalation));
    try { child.kill("SIGTERM"); } catch { /* the process may already be closed */ }
  }
}

/** Keeps the lexically smallest paths with memory bounded by maxFilesConsidered. */
class BoundedCandidateSet {
  private readonly heap: CandidatePath[] = [];
  private enumerated = 0;
  overflow = false;

  constructor(private readonly limit: number, private readonly context: SearchContext) {}

  add(candidate: CandidatePath): void {
    this.enumerated++;
    if (this.enumerated > this.limit && !this.overflow) {
      this.overflow = true;
      this.context.mark("ITEM_LIMIT");
    }

    if (this.heap.length < this.limit) {
      this.heap.push(candidate);
      this.siftUp(this.heap.length - 1);
      return;
    }
    if (compareText(candidate.rel, this.heap[0]!.rel) >= 0) return;
    this.heap[0] = candidate;
    this.siftDown(0);
  }

  values(): CandidatePath[] {
    return [...this.heap].sort((left, right) => compareText(left.rel, right.rel));
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareText(this.heap[parent]!.rel, this.heap[child]!.rel) >= 0) return;
      [this.heap[parent], this.heap[child]] = [this.heap[child]!, this.heap[parent]!];
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let greatest = parent;
      if (left < this.heap.length && compareText(this.heap[left]!.rel, this.heap[greatest]!.rel) > 0) greatest = left;
      if (right < this.heap.length && compareText(this.heap[right]!.rel, this.heap[greatest]!.rel) > 0) greatest = right;
      if (greatest === parent) return;
      [this.heap[parent], this.heap[greatest]] = [this.heap[greatest]!, this.heap[parent]!];
      parent = greatest;
    }
  }
}

export function normalizeSearchBudget(input: Partial<SearchBudget> | undefined): SearchBudget {
  const pick = (value: number | undefined, fallback: number, cap: number, name: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BatchContractError("INVALID_BUDGET", "Search budget values must be positive safe integers");
    }
    return Math.min(value, cap);
  };
  return {
    maxBytesScanned: pick(input?.maxBytesScanned, SEARCH_MAX_BYTES, SEARCH_MAX_BYTES, "maxBytesScanned"),
    maxFilesConsidered: pick(input?.maxFilesConsidered, SEARCH_MAX_FILES, SEARCH_MAX_FILES, "maxFilesConsidered"),
    deadlineMs: pick(input?.deadlineMs, SEARCH_MAX_DEADLINE_MS, SEARCH_MAX_DEADLINE_MS, "deadlineMs"),
    maxFileBytes: pick(input?.maxFileBytes, SEARCH_MAX_FILE_BYTES, SEARCH_MAX_FILE_BYTES, "maxFileBytes"),
  };
}

function searchLimit(input: number | undefined): number {
  if (input === undefined || !Number.isFinite(input)) return 50;
  return Math.min(200, Math.max(1, Math.floor(input)));
}

function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function pathKey(abs: string): string {
  const resolved = path.resolve(abs);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Stable ordering: normalized workspace path, line number, then snippet. */
export function compareSearchMatches(left: SearchMatch, right: SearchMatch): number {
  return compareText(normalizeRel(left.path), normalizeRel(right.path)) ||
    left.line - right.line ||
    compareText(left.text, right.text);
}

function addMatch(acc: Accumulator, match: SearchMatch, limit: number): void {
  acc.matchesObserved++;
  if (acc.matches.length < limit) {
    acc.matches.push(match);
    let child = acc.matches.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareSearchMatches(acc.matches[parent]!, acc.matches[child]!) >= 0) break;
      [acc.matches[parent], acc.matches[child]] = [acc.matches[child]!, acc.matches[parent]!];
      child = parent;
    }
    return;
  }
  if (compareSearchMatches(match, acc.matches[0]!) >= 0) return;
  acc.matches[0] = match;
  let parent = 0;
  for (;;) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let greatest = parent;
    if (left < acc.matches.length && compareSearchMatches(acc.matches[left]!, acc.matches[greatest]!) > 0) greatest = left;
    if (right < acc.matches.length && compareSearchMatches(acc.matches[right]!, acc.matches[greatest]!) > 0) greatest = right;
    if (greatest === parent) break;
    [acc.matches[parent], acc.matches[greatest]] = [acc.matches[greatest]!, acc.matches[parent]!];
    parent = greatest;
  }
}

function finalizeResult(
  acc: Accumulator,
  engine: BoundedSearchResult["engine"],
  limit: number,
  context: SearchContext,
  filesConsidered: number,
  errorCode?: BoundedSearchResult["errorCode"]
): BoundedSearchResult {
  const matches = [...acc.matches].sort(compareSearchMatches);
  let stopReason = context.stopReason;
  if (stopReason === null && acc.matchesObserved > matches.length) stopReason = "MATCH_LIMIT";
  const finalError = errorCode ?? acc.errorCode ?? (stopReason === "PROCESS_ERROR" ? "PROCESS_ERROR" : undefined);
  return {
    matches,
    matchCount: matches.length,
    matchesReturned: matches.length,
    matchesObserved: acc.matchesObserved,
    filesConsidered,
    filesScanned: acc.filesScanned,
    bytesScanned: acc.bytesScanned,
    elapsedMs: context.elapsedMs,
    engine,
    stopReason,
    truncated: stopReason !== null || acc.matchesObserved > limit,
    ...(finalError ? { errorCode: finalError } : {}),
  };
}

function absoluteFromOutput(ws: Workspace, rawPath: string): string | null {
  const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(ws.root, rawPath);
  const rel = normalizeRel(path.relative(ws.root, absolute));
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return absolute;
}

function eligibleRelativePath(ws: Workspace, absolute: string, globRegex: RegExp | null): string | null {
  const rel = normalizeRel(path.relative(ws.root, absolute));
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  if (ws.ignoreRules.isHidden(rel) || (globRegex && !globRegex.test(rel))) return null;
  return rel;
}

function runProcess(
  command: string,
  args: string[],
  context: SearchContext,
  runSpawn: SpawnFunction,
  onStdout: (chunk: Buffer, child: ChildProcess) => void,
  cwd?: string
): Promise<ProcessOutcome> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = runSpawn(command, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      context.fail("PROCESS_ERROR");
      resolvePromise({ exitCode: null, error: error as Error, stderr: "" });
      return;
    }
    context.add(child);
    let stderr = "";
    let processError: Error | undefined;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      context.remove(child);
      resolvePromise({ exitCode, ...(processError ? { error: processError } : {}), stderr });
    };
    child.stdout?.on("data", (value: Buffer | string) => {
      if (context.fatalReason !== null) return;
      try {
        onStdout(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"), child);
      } catch (error) {
        processError = error as Error;
        context.fail("PROCESS_ERROR");
      }
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      if (stderr.length < SEARCH_MAX_ERROR_TEXT_CHARS) {
        const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
        stderr += text.slice(0, SEARCH_MAX_ERROR_TEXT_CHARS - stderr.length);
      }
    });
    child.on("error", (error) => {
      processError = error;
      context.fail("PROCESS_ERROR");
    });
    child.on("close", (code) => finish(code));
    if (!child.stdout) {
      processError = new Error("ripgrep process has no stdout pipe");
      context.fail("PROCESS_ERROR");
    }
  });
}

async function probeCandidate(candidate: string, context: SearchContext, runSpawn: SpawnFunction): Promise<boolean> {
  if (context.shouldStop) return false;
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = runSpawn(candidate, ["--version"], { windowsHide: true, stdio: "ignore" });
    } catch {
      resolvePromise(false);
      return;
    }
    context.add(child);
    let done = false;
    child.on("error", () => {
      if (done) return;
      done = true;
      context.remove(child);
      resolvePromise(false);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      context.remove(child);
      resolvePromise(code === 0 && !context.shouldStop);
    });
  });
}

async function findRipgrepWithinDeadline(context: SearchContext, runSpawn: SpawnFunction): Promise<string | null> {
  if (process.env.C2C_DISABLE_RG === "1") return null;
  if (process.env.C2C_RG_PATH) {
    const configured = process.env.C2C_RG_PATH;
    return await probeCandidate(configured, context, runSpawn) ? configured : null;
  }
  if (cachedRg !== undefined) return cachedRg;
  for (const candidate of RG_CANDIDATES) {
    if (context.shouldStop) return null;
    if (await probeCandidate(candidate, context, runSpawn)) {
      cachedRg = candidate;
      return candidate;
    }
  }
  if (context.fatalReason === null) cachedRg = null;
  return null;
}

interface FileEnumeration {
  candidates: CandidateFile[];
  overflow: boolean;
  complete: boolean;
}

async function materializeCandidateFiles(
  ws: Workspace,
  selectedPaths: CandidatePath[],
  context: SearchContext
): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];
  for (const candidate of selectedPaths) {
    if (context.shouldStop) break;
    try {
      const resolved = ws.resolve(candidate.abs);
      const lstat = await fs.promises.lstat(candidate.abs);
      if (!lstat.isFile() || lstat.isSymbolicLink()) continue;
      if (pathKey(resolved.abs) !== pathKey(candidate.abs)) continue;
      const stat = await fs.promises.stat(resolved.abs);
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) continue;
      candidates.push({ abs: resolved.abs, rel: resolved.rel, sizeBytes: stat.size });
    } catch {
      // A path that disappeared or became sensitive while enumerating is skipped.
    }
  }
  return candidates.sort((left, right) => compareText(left.rel, right.rel));
}

async function enumerateWithRipgrep(
  ws: Workspace,
  rgBin: string,
  searchAbs: string,
  opts: SearchOptions,
  budget: SearchBudget,
  context: SearchContext,
  runSpawn: SpawnFunction
): Promise<FileEnumeration> {
  const args = ["--files", "--no-config", "--null"];
  if (opts.glob) args.push("--glob", opts.glob);
  args.push("--", searchAbs);
  const decoder = new StringDecoder("utf8");
  const selected = new BoundedCandidateSet(budget.maxFilesConsidered, context);
  let pending = "";
  let incomplete = false;
  let enumeratedPaths = 0;
  const onText = (text: string, child: ChildProcess): void => {
    if (incomplete || context.fatalReason !== null) return;
    pending += text;
    let boundary: number;
    while ((boundary = pending.indexOf("\0")) >= 0) {
      if (context.checkDeadline()) {
        child.kill("SIGTERM");
        return;
      }
      const raw = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (!raw) continue;
      if (++enumeratedPaths > SEARCH_MAX_ENUMERATED_PATHS) {
        incomplete = true;
        context.mark("ITEM_LIMIT");
        child.kill("SIGTERM");
        return;
      }
      const absolute = absoluteFromOutput(ws, raw);
      const rel = absolute && eligibleRelativePath(ws, absolute, opts.glob ? globToRegex(opts.glob) : null);
      if (!absolute || !rel) continue;
      selected.add({ abs: absolute, rel });
    }
    if (pending.length > 32_768) {
      incomplete = true;
      context.mark("ITEM_LIMIT");
      child.kill("SIGTERM");
    }
  };
  const outcome = await runProcess(rgBin, args, context, runSpawn, (chunk, child) => {
    onText(decoder.write(chunk), child);
  }, ws.root);
  if (!incomplete && context.fatalReason === null) {
    pending += decoder.end();
    if (pending) {
      if (++enumeratedPaths > SEARCH_MAX_ENUMERATED_PATHS) {
        incomplete = true;
        context.mark("ITEM_LIMIT");
      } else {
        const absolute = absoluteFromOutput(ws, pending);
        const rel = absolute && eligibleRelativePath(ws, absolute, opts.glob ? globToRegex(opts.glob) : null);
        if (absolute && rel) selected.add({ abs: absolute, rel });
      }
      pending = "";
    }
  }
  if (incomplete || context.fatalReason !== null) {
    return { candidates: [], overflow: selected.overflow || incomplete, complete: false };
  }
  if (outcome.error || (outcome.exitCode !== 0 && outcome.exitCode !== 1)) {
    context.fail("PROCESS_ERROR");
    return { candidates: [], overflow: selected.overflow, complete: false };
  }
  const candidates = await materializeCandidateFiles(ws, selected.values(), context);
  if (context.fatalReason !== null) return { candidates: [], overflow: selected.overflow, complete: false };
  return { candidates, overflow: selected.overflow, complete: true };
}

async function enumerateWithNode(
  ws: Workspace,
  searchAbs: string,
  opts: SearchOptions,
  budget: SearchBudget,
  context: SearchContext
): Promise<FileEnumeration> {
  const selected = new BoundedCandidateSet(budget.maxFilesConsidered, context);
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const stack: Array<{ abs: string; rel: string }> = [];
  let incomplete = false;
  let directoriesVisited = 0;
  let entriesVisited = 0;
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(searchAbs);
  } catch {
    throw new WorkspaceError("FILE_NOT_FOUND", "Search path does not exist");
  }
  if (rootStat.isFile()) {
    const rel = eligibleRelativePath(ws, searchAbs, globRegex);
    if (rel) selected.add({ abs: searchAbs, rel });
  } else if (rootStat.isDirectory()) {
    const rootRel = normalizeRel(path.relative(ws.root, searchAbs));
    stack.push({ abs: searchAbs, rel: rootRel === "." ? "" : rootRel });
  } else {
    return { candidates: [], overflow: false, complete: true };
  }

  while (stack.length > 0 && !incomplete && !context.shouldStop) {
    const current = stack.pop()!;
    if (++directoriesVisited > SEARCH_MAX_DIRECTORY_ENTRIES) {
      incomplete = true;
      context.mark("ITEM_LIMIT");
      break;
    }
    let directory: fs.Dir;
    try {
      directory = await fs.promises.opendir(current.abs);
    } catch {
      context.mark("PROCESS_ERROR");
      continue;
    }
    try {
      for await (const entry of directory) {
        if (context.shouldStop) break;
        if (++entriesVisited > SEARCH_MAX_ENUMERATED_PATHS) {
          incomplete = true;
          context.mark("ITEM_LIMIT");
          break;
        }
        const childRel = current.rel ? current.rel + "/" + entry.name : entry.name;
        const childAbs = path.join(current.abs, entry.name);
        if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(childRel + "/")) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (stack.length >= SEARCH_MAX_PENDING_DIRECTORIES) {
            incomplete = true;
            context.mark("ITEM_LIMIT");
            break;
          }
          stack.push({ abs: childAbs, rel: childRel });
          continue;
        }
        if (!entry.isFile() || (globRegex && !globRegex.test(childRel))) continue;
        selected.add({ abs: childAbs, rel: normalizeRel(childRel) });
      }
    } finally {
      try { await directory.close(); } catch { /* async iteration may already have closed it */ }
    }
  }
  if (incomplete || context.fatalReason !== null) {
    return { candidates: [], overflow: selected.overflow || incomplete, complete: false };
  }
  const candidates = await materializeCandidateFiles(ws, selected.values(), context);
  if (context.fatalReason !== null) return { candidates: [], overflow: selected.overflow, complete: false };
  return { candidates, overflow: selected.overflow, complete: true };
}
function fileReservation(sizeBytes: number, maxFileBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > maxFileBytes) return 0;
  let reserved = 1;
  while (reserved < sizeBytes && reserved < maxFileBytes) reserved *= 2;
  return Math.min(reserved, maxFileBytes);
}

function planFiles(candidates: CandidateFile[], budget: SearchBudget, context: SearchContext): {
  selected: PlannedFile[];
  filesConsidered: number;
} {
  const selected: PlannedFile[] = [];
  let reservedTotal = 0;
  for (const candidate of candidates) {
    if (context.shouldStop) break;
    const reservedBytes = fileReservation(candidate.sizeBytes, budget.maxFileBytes);
    if (reservedBytes === 0) {
      if (candidate.sizeBytes > budget.maxFileBytes) context.mark("SCAN_BYTE_LIMIT");
      continue;
    }
    if (reservedTotal + reservedBytes > budget.maxBytesScanned) {
      context.mark("SCAN_BYTE_LIMIT");
      break;
    }
    selected.push({ ...candidate, reservedBytes });
    reservedTotal += reservedBytes;
  }
  return { selected, filesConsidered: candidates.length };
}

function buildRgBatches(files: PlannedFile[], context: SearchContext): Array<{ cap: number; files: PlannedFile[] }> {
  const byCap = new Map<number, PlannedFile[]>();
  for (const file of files) {
    const group = byCap.get(file.reservedBytes) ?? [];
    group.push(file);
    byCap.set(file.reservedBytes, group);
  }
  const batches: Array<{ cap: number; files: PlannedFile[] }> = [];
  for (const cap of [...byCap.keys()].sort((left, right) => left - right)) {
    const group = byCap.get(cap)!;
    let current: PlannedFile[] = [];
    let chars = 256;
    for (const file of group) {
      const nextChars = chars + file.abs.length + 4;
      if (current.length > 0 && (current.length >= SEARCH_MAX_RG_FILES_PER_PROCESS || nextChars > SEARCH_MAX_RG_ARG_CHARS)) {
        batches.push({ cap, files: current });
        current = [];
        chars = 256;
      }
      if (file.abs.length + 256 > SEARCH_MAX_RG_ARG_CHARS) {
        context.mark("ITEM_LIMIT");
        continue;
      }
      current.push(file);
      chars += file.abs.length + 4;
    }
    if (current.length > 0) batches.push({ cap, files: current });
  }
  return batches.sort((left, right) => compareText(left.files[0]!.rel, right.files[0]!.rel));
}

interface JsonLineState {
  decoder: StringDecoder;
  pending: string;
  discarding: boolean;
}

function createJsonLineState(): JsonLineState {
  return { decoder: new StringDecoder("utf8"), pending: "", discarding: false };
}

function consumeJsonChunk(
  state: JsonLineState,
  chunk: Buffer,
  child: ChildProcess,
  context: SearchContext,
  consume: (line: string) => void
): void {
  state.pending += state.decoder.write(chunk);
  for (;;) {
    if (context.checkDeadline()) {
      child.kill("SIGTERM");
      return;
    }
    const newline = state.pending.indexOf("\n");
    if (newline < 0) break;
    const line = state.pending.slice(0, newline);
    state.pending = state.pending.slice(newline + 1);
    if (state.discarding) {
      state.discarding = false;
      continue;
    }
    if (line.length > SEARCH_MAX_JSON_LINE_CHARS) {
      context.fail("PROCESS_ERROR");
      child.kill("SIGTERM");
      continue;
    }
    if (line) consume(line);
  }
  if (state.pending.length > SEARCH_MAX_JSON_LINE_CHARS) {
    state.pending = "";
    state.discarding = true;
    context.fail("PROCESS_ERROR");
    child.kill("SIGTERM");
  }
}

function decodeEvent(line: string): { type?: string; data?: any } | null {
  try {
    const parsed = JSON.parse(line) as { type?: string; data?: any };
    if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function runRgSearch(
  ws: Workspace,
  rgBin: string,
  opts: SearchOptions,
  files: PlannedFile[],
  limit: number,
  budget: SearchBudget,
  context: SearchContext,
  accumulator: Accumulator,
  runSpawn: SpawnFunction
): Promise<void> {
  const batches = buildRgBatches(files, context);
  const byAbsolutePath = new Map(files.map((file) => [pathKey(file.abs), file]));
  let nextBatch = 0;
  let errorCode: BoundedSearchResult["errorCode"] | undefined;

  const runBatch = async (batch: { cap: number; files: PlannedFile[] }): Promise<void> => {
    if (context.shouldStop || batch.files.length === 0) return;
    const args = ["--json", "--no-config", "--max-filesize", String(batch.cap)];
    if (!opts.regex) args.push("-F");
    args.push("--smart-case");
    args.push("--", opts.query, ...batch.files.map((file) => file.abs));
    const states = createJsonLineState();
    const inFlight = new Map<string, number>();
    const ended = new Set<string>();
    let exactBytes = 0;
    let summaryBytes: number | null = null;
    let summaryFiles: number | null = null;
    let malformed = false;
    const consume = (line: string): void => {
      const event = decodeEvent(line);
      if (!event) {
        malformed = true;
        return;
      }
      if (event.type === "summary") {
        const bytes = event.data?.stats?.bytes_searched;
        const files = event.data?.stats?.searches;
        if (Number.isSafeInteger(bytes) && bytes >= 0) summaryBytes = bytes;
        if (Number.isSafeInteger(files) && files >= 0) summaryFiles = files;
        return;
      }
      const rawPath = event.data?.path?.text;
      if (typeof rawPath !== "string") return;
      const abs = absoluteFromOutput(ws, rawPath);
      if (!abs) return;
      const key = pathKey(abs);
      const file = byAbsolutePath.get(key);
      if (!file) return;
      if (event.type === "begin") {
        inFlight.set(key, file.reservedBytes);
      } else if (event.type === "end") {
        const bytes = event.data?.stats?.bytes_searched;
        exactBytes += Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : file.reservedBytes;
        inFlight.delete(key);
        ended.add(key);
      } else if (event.type === "match") {
        const lineNumber = event.data?.line_number;
        const text = event.data?.lines?.text;
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || typeof text !== "string") return;
        addMatch(accumulator, { path: file.rel, line: lineNumber, text: text.trimEnd().slice(0, 500) }, limit);
      }
    };
    const onStdout = (chunk: Buffer, child: ChildProcess): void => consumeJsonChunk(states, chunk, child, context, consume);
    const outcome = await runProcess(rgBin, args, context, runSpawn, onStdout, ws.root);
    const decoderTail = states.decoder.end();
    if (decoderTail) {
      states.pending += decoderTail;
    }
    if (states.pending && !states.discarding) {
      const event = decodeEvent(states.pending);
      if (event) consume(states.pending);
      else malformed = true;
    }
    const incompleteBytes = [...inFlight.values()].reduce((total, bytes) => total + bytes, 0);
    const batchReservation = batch.files.reduce((total, file) => total + file.reservedBytes, 0);
    const processCompleted = context.fatalReason === null && !outcome.error && (outcome.exitCode === 0 || outcome.exitCode === 1);
    const perFileComplete = ended.size === batch.files.length;
    const batchBytes = processCompleted && summaryBytes !== null
      ? summaryBytes
      : processCompleted && perFileComplete ? exactBytes
      : context.fatalReason !== null ? batchReservation : exactBytes + incompleteBytes;
    accumulator.bytesScanned += batchBytes;
    accumulator.filesScanned += processCompleted && summaryFiles !== null ? summaryFiles : ended.size;
    if (context.fatalReason === "DEADLINE") {
      // The timer has already terminated this process; preserve DEADLINE as the
      // actual stop reason instead of reclassifying the expected signal exit.
    } else if (malformed) {
      errorCode = "PROCESS_ERROR";
      accumulator.errorCode = errorCode;
      context.fail("PROCESS_ERROR");
    } else if (outcome.error || (outcome.exitCode !== 0 && outcome.exitCode !== 1)) {
      errorCode = outcome.stderr.toLowerCase().includes("regex parse error") ? "INVALID_PATTERN" : "PROCESS_ERROR";
      accumulator.errorCode = errorCode;
      context.fail("PROCESS_ERROR");
    } else if ((summaryBytes === null || summaryFiles === null) && !perFileComplete) {
      errorCode = "PROCESS_ERROR";
      accumulator.errorCode = errorCode;
      context.fail("PROCESS_ERROR");
    } else if (summaryFiles !== null && summaryFiles < batch.files.length) {
      context.mark("SCAN_BYTE_LIMIT");
    }
    if (accumulator.bytesScanned > budget.maxBytesScanned) {
      // This is defensive: the pre-scan reservations and per-file --max-filesize
      // make it unreachable for an unchanged workspace.
      accumulator.bytesScanned = budget.maxBytesScanned;
      context.fail("PROCESS_ERROR");
      errorCode = "PROCESS_ERROR";
      accumulator.errorCode = errorCode;
    }
  };

  const worker = async (): Promise<void> => {
    while (!context.shouldStop) {
      const index = nextBatch++;
      if (index >= batches.length) return;
      await runBatch(batches[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_MAX_RG_WORKERS, batches.length) }, () => worker()));
  if (errorCode && context.stopReason === null) context.mark("PROCESS_ERROR");
}

async function readNodeCandidate(file: PlannedFile, context: SearchContext): Promise<{ bytes: Buffer; bytesRead: number; complete: boolean; failed: boolean }> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  const stream = fs.createReadStream(file.abs, {
    start: 0,
    end: file.reservedBytes - 1,
    highWaterMark: 64 * 1024,
    signal: context.signal,
  });
  let complete = false;
  let failed = false;
  try {
    for await (const chunkValue of stream) {
      if (context.shouldStop) break;
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue as Uint8Array);
      chunks.push(chunk);
      bytesRead += chunk.length;
    }
    complete = context.fatalReason === null;
  } catch (error) {
    if (context.fatalReason === null && !(error instanceof Error && error.name === "AbortError")) failed = true;
  } finally {
    stream.destroy();
  }
  const currentStat = await fs.promises.stat(file.abs).catch(() => null);
  const sourceFitsReservation = currentStat !== null && currentStat.size <= file.reservedBytes && bytesRead >= currentStat.size;
  return {
    bytes: Buffer.concat(chunks, bytesRead),
    bytesRead,
    complete: complete && sourceFitsReservation,
    failed: failed || currentStat === null,
  };
}

function decodeSafePrefix(bytes: Buffer, allowIncompleteTail: boolean): string | null {
  for (let length = bytes.length; length >= Math.max(0, bytes.length - (allowIncompleteTail ? 3 : 0)); length--) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } catch {
      // Try trimming an incomplete trailing code point only after a deadline.
    }
  }
  return null;
}

async function runNodeLiteralSearch(
  files: PlannedFile[],
  opts: SearchOptions,
  limit: number,
  budget: SearchBudget,
  context: SearchContext,
  accumulator: Accumulator
): Promise<void> {
  const query = /[A-Z]/.test(opts.query) ? opts.query : opts.query.toLowerCase();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!context.shouldStop) {
      const index = next++;
      if (index >= files.length) return;
      const file = files[index]!;
      let read: { bytes: Buffer; bytesRead: number; complete: boolean; failed: boolean };
      try {
        read = await readNodeCandidate(file, context);
      } catch {
        context.mark("PROCESS_ERROR");
        continue;
      }
      accumulator.bytesScanned += read.bytesRead;
      if (accumulator.bytesScanned > budget.maxBytesScanned) {
        accumulator.bytesScanned = budget.maxBytesScanned;
        context.fail("PROCESS_ERROR");
        return;
      }
      if (read.bytesRead > 0 || file.sizeBytes === 0) accumulator.filesScanned++;
      if (read.failed) {
        context.mark("PROCESS_ERROR");
        continue;
      }
      if (read.bytes.includes(0)) continue;
      const content = decodeSafePrefix(read.bytes, !read.complete);
      if (content === null) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (context.shouldStop) return;
        const line = lines[index]!;
        const searchable = /[A-Z]/.test(opts.query) ? line : line.toLowerCase();
        if (searchable.includes(query)) {
          addMatch(accumulator, { path: file.rel, line: index + 1, text: line.trimEnd().slice(0, 500) }, limit);
        }
      }
      if (!read.complete) context.mark("SCAN_BYTE_LIMIT");
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_MAX_RG_WORKERS, files.length) }, () => worker()));
}

async function searchWithLegacyNodeRegex(ws: Workspace, opts: SearchOptions): Promise<SearchResult> {
  const limit = searchLimit(opts.limit);
  const { abs } = ws.resolve(opts.path ?? ".");
  const matcher = new RegExp(opts.query, "i");
  const globRegex = opts.glob ? globToRegex(opts.glob) : null;
  const matches: SearchMatch[] = [];
  let truncated = false;

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (ws.ignoreRules.isHidden(childRel) || ws.ignoreRules.isHidden(`${childRel}/`)) continue;
      const childAbs = path.join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (entry.isFile()) {
        if (globRegex && !globRegex.test(childRel)) continue;
        let stat: fs.Stats;
        try { stat = await fs.promises.stat(childAbs); } catch { continue; }
        if (stat.size > SEARCH_MAX_FILE_BYTES) continue;
        let content: string;
        try { content = await fs.promises.readFile(childAbs, "utf8"); } catch { continue; }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]!;
          if (matcher.test(line)) {
            if (matches.length >= limit) {
              truncated = true;
              return;
            }
            matches.push({ path: childRel, line: index + 1, text: line.trimEnd().slice(0, 500) });
          }
        }
      }
    }
  };

  const startRel = normalizeRel(path.relative(ws.root, abs));
  await walk(abs, startRel === "." ? "" : startRel);
  return { matches, matchCount: matches.length, truncated, engine: "node" };
}

/** Strict bounded search primitive for Wave 1 and future batch_search. */
export async function searchWorkspaceBounded(
  ws: Workspace,
  opts: BoundedSearchOptions,
  runtime: SearchRuntime = {}
): Promise<BoundedSearchResult> {
  const budget = normalizeSearchBudget(opts.budget ?? runtime.budget);
  const context = new SearchContext(budget.deadlineMs);
  const limit = searchLimit(opts.limit);
  const accumulator: Accumulator = { matches: [], matchesObserved: 0, filesScanned: 0, bytesScanned: 0 };
  let filesConsidered = 0;
  let engine: BoundedSearchResult["engine"] = "none";
  let errorCode: BoundedSearchResult["errorCode"] | undefined;

  try {
    if (!opts.query || opts.query.length < 2) {
      return finalizeResult(accumulator, "node", limit, context, 0);
    }
    const { abs: searchAbs } = ws.resolve(opts.path ?? ".");
    const stat = await fs.promises.stat(searchAbs).catch(() => null);
    if (!stat) throw new WorkspaceError("FILE_NOT_FOUND", "Search path does not exist");
    const runSpawn = runtime.spawn ?? spawn as SpawnFunction;
    const rgBin = runtime.rgPath === undefined
      ? await findRipgrepWithinDeadline(context, runSpawn)
      : runtime.rgPath;
    if (context.fatalReason !== null) return finalizeResult(accumulator, "none", limit, context, filesConsidered);

    if (!rgBin && opts.regex) {
      context.mark("ENGINE_UNAVAILABLE");
      errorCode = "ENGINE_UNAVAILABLE";
      return finalizeResult(accumulator, "none", limit, context, 0, errorCode);
    }

    if (rgBin) {
      engine = "ripgrep";
      const listing = await enumerateWithRipgrep(ws, rgBin, searchAbs, opts, budget, context, runSpawn);
      if (!listing.complete) return finalizeResult(accumulator, engine, limit, context, listing.candidates.length);
      if (context.fatalReason !== null) return finalizeResult(accumulator, engine, limit, context, 0);
      const plan = planFiles(listing.candidates, budget, context);
      filesConsidered = plan.filesConsidered;
      if (plan.selected.length > 0) {
        await runRgSearch(ws, rgBin, opts, plan.selected, limit, budget, context, accumulator, runSpawn);
      }
    } else {
      engine = "node";
      const listing = await enumerateWithNode(ws, searchAbs, opts, budget, context);
      if (!listing.complete) return finalizeResult(accumulator, engine, limit, context, listing.candidates.length);
      if (context.fatalReason !== null) return finalizeResult(accumulator, engine, limit, context, 0);
      const plan = planFiles(listing.candidates, budget, context);
      filesConsidered = plan.filesConsidered;
      if (plan.selected.length > 0) await runNodeLiteralSearch(plan.selected, opts, limit, budget, context, accumulator);
    }
    return finalizeResult(accumulator, engine, limit, context, filesConsidered, errorCode);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (context.fatalReason === null) context.fail("PROCESS_ERROR");
    errorCode = "PROCESS_ERROR";
    return finalizeResult(accumulator, engine, limit, context, filesConsidered, errorCode);
  } finally {
    context.close();
  }
}

/**
 * V1.3-compatible result shape. Literal search now uses the bounded primitive;
 * when controlled rg is unavailable, the historical regex fallback remains
 * available here while the strict primitive returns ENGINE_UNAVAILABLE.
 */
export async function searchWorkspace(
  ws: Workspace,
  opts: SearchOptions,
  runtime: SearchRuntime = {}
): Promise<SearchResult> {
  const result = await searchWorkspaceBounded(ws, opts, runtime);
  if (opts.regex && result.errorCode === "ENGINE_UNAVAILABLE") return searchWithLegacyNodeRegex(ws, opts);
  return {
    matches: result.matches,
    matchCount: result.matchesReturned,
    truncated: result.truncated,
    engine: result.engine === "ripgrep" ? "ripgrep" : "node",
  };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`(^|/)${escaped}$`, "i");
}
