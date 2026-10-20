import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { TextDecoder } from "node:util";
import { IgnoreRules } from "./ignore.js";
import { READ_ITEM_DEFAULT_BYTES, READ_ITEM_HARD_MAX_BYTES } from "./batch.js";
import { readJsonIfExists } from "../config/paths.js";

export type WorkspaceErrorCode =
  | "INVALID_PATH"
  | "GIT_EXECUTABLE_UNTRUSTED"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PATH_OUTSIDE_REPOSITORY"
  | "ACCESS_DENIED_SENSITIVE_FILE"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "NOT_A_DIRECTORY"
  | "BINARY_FILE"
  | "FILE_TOO_LARGE"
  | "INVALID_OFFSET"
  | "INVALID_HASH"
  | "INVALID_UTF8"
  | "SOURCE_CHANGED"
  | "SOURCE_SCAN_LIMIT"
  | "DEADLINE"
  | "BYTE_LIMIT";

export class WorkspaceError extends Error {
  constructor(
    public code: WorkspaceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const normCase = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

export interface WorkspaceReadOptions {
  /** Absolute performance.now() deadline shared by a bounded operation. */
  deadlineAt?: number;
  /** Maximum complete source bytes that may be scanned to produce a full hash. */
  maxSourceBytes?: number;
  /** Receives decoded source text chunks while the complete source is scanned. */
  onChunk?: (chunk: string) => void;
  /** Reports actual source bytes read, in chunk increments. */
  onSourceBytesScanned?: (bytes: number) => void;
}

function validateReadOptions(options: WorkspaceReadOptions): void {
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0)) {
    throw new RangeError("deadlineAt must be a positive finite performance.now() timestamp");
  }
  if (options.maxSourceBytes !== undefined &&
      (!Number.isSafeInteger(options.maxSourceBytes) || options.maxSourceBytes < 0)) {
    throw new RangeError("maxSourceBytes must be a non-negative safe integer");
  }
  if (options.onChunk !== undefined && typeof options.onChunk !== "function") {
    throw new TypeError("onChunk must be a function");
  }
  if (options.onSourceBytesScanned !== undefined && typeof options.onSourceBytesScanned !== "function") {
    throw new TypeError("onSourceBytesScanned must be a function");
  }
}

function assertReadDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");
  }
}

async function openForBoundedRead(abs: string, deadlineAt: number | undefined): Promise<fs.promises.FileHandle> {
  assertReadDeadline(deadlineAt);
  if (deadlineAt === undefined) return fs.promises.open(abs, "r");
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");

  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const opening = fs.promises.open(abs, "r").then(async (handle) => {
    if (expired || performance.now() >= deadlineAt) {
      void handle.close().catch(() => undefined);
      throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");
    }
    return handle;
  });
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new WorkspaceError("DEADLINE", "Workspace read deadline exceeded"));
    }, remainingMs);
  });
  try {
    const handle = await Promise.race([opening, timeout]);
    try {
      assertReadDeadline(deadlineAt);
      return handle;
    } catch (error) {
      void handle.close().catch(() => undefined);
      throw error;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function statForBoundedRead(
  handle: fs.promises.FileHandle,
  deadlineAt: number | undefined
): Promise<fs.Stats> {
  assertReadDeadline(deadlineAt);
  if (deadlineAt === undefined) return handle.stat();
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");

  const operation = handle.stat();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkspaceError("DEADLINE", "Workspace read deadline exceeded")), remainingMs);
  });
  try {
    const result = await Promise.race([operation, timeout]);
    assertReadDeadline(deadlineAt);
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeForBoundedRead(handle: fs.promises.FileHandle, deadlineAt: number | undefined): Promise<void> {
  let operation: Promise<void>;
  try {
    operation = handle.close();
  } catch {
    assertReadDeadline(deadlineAt);
    return;
  }
  if (deadlineAt === undefined) {
    try { await operation; } catch { /* a platform may have already closed the handle */ }
    return;
  }

  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) {
    // close() is not abortable; keep its cleanup operation alive but withhold the result.
    void operation.catch(() => undefined);
    throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkspaceError("DEADLINE", "Workspace read deadline exceeded")), remainingMs);
  });
  try {
    await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "DEADLINE") throw error;
    // Preserve the prior best-effort close behavior for platform close errors.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  assertReadDeadline(deadlineAt);
}

async function* readFileChunks(
  handle: fs.promises.FileHandle,
  sizeBytes: number,
  deadlineAt: number
): AsyncGenerator<Buffer> {
  assertReadDeadline(deadlineAt);
  if (sizeBytes === 0) return;
  const controller = new AbortController();
  const stream = handle.createReadStream({
    start: 0,
    end: sizeBytes - 1,
    highWaterMark: 64 * 1024,
    autoClose: false,
    signal: controller.signal,
  });
  const remainingMs = deadlineAt - performance.now();
  if (remainingMs <= 0) {
    stream.destroy();
    throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");
  }
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, remainingMs);
  try {
    for await (const value of stream) {
      assertReadDeadline(deadlineAt);
      yield Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
  } catch (error) {
    if (expired || performance.now() >= deadlineAt) {
      throw new WorkspaceError("DEADLINE", "Workspace read deadline exceeded");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    if (!stream.readableEnded && !stream.destroyed) stream.destroy();
  }
}

function emitReadChunk(options: WorkspaceReadOptions, chunk: string): void {
  if (options.onChunk?.constructor.name === "AsyncFunction") {
    throw new TypeError("onChunk must be synchronous");
  }
  const result = options.onChunk?.(chunk) as unknown;
  if (result && (typeof result === "object" || typeof result === "function") &&
    "then" in result && typeof (result as { then?: unknown }).then === "function") {
    throw new TypeError("onChunk must be synchronous");
  }
}

function emitSourceBytesScanned(options: WorkspaceReadOptions, bytes: number): void {
  if (options.onSourceBytesScanned?.constructor.name === "AsyncFunction") {
    throw new TypeError("onSourceBytesScanned must be synchronous");
  }
  const result = options.onSourceBytesScanned?.(bytes) as unknown;
  if (result && (typeof result === "object" || typeof result === "function") &&
    "then" in result && typeof (result as { then?: unknown }).then === "function") {
    throw new TypeError("onSourceBytesScanned must be synchronous");
  }
}

export interface ReadFileResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  remainingLines: number;
  nextStartLine: number | null;
  content: string;
  /** SHA-256 of the exact bytes consumed by this read, before line pagination. */
  contentHash: string;
}

export interface ReadFileBytesResult {
  path: string;
  sizeBytes: number;
  startOffsetBytes: number;
  nextOffsetBytes: number;
  returnedBytes: number;
  eof: boolean;
  truncated: boolean;
  content: string;
  /** SHA-256 of the complete original file bytes, not just this page. */
  sourceHash: string;
  /** Actual source bytes consumed to calculate sourceHash. */
  sourceBytesScanned: number;
}

export interface ReadFileLinesBoundedResult {
  path: string;
  sizeBytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  nextStartLine: number | null;
  startOffsetBytes: number;
  nextOffsetBytes: number;
  returnedBytes: number;
  truncated: boolean;
  content: string;
  /** SHA-256 of the complete original file bytes, not just this page. */
  sourceHash: string;
  /** Actual source bytes consumed to calculate sourceHash. */
  sourceBytesScanned: number;
}

export interface DirEntry {
  path: string;
  type: "file" | "dir";
  sizeBytes?: number;
}

export interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ProjectConfig {
  name?: string;
  maxIterations?: number;
}

function parseProjectConfig(value: unknown): ProjectConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const config: ProjectConfig = {};
  if (typeof raw.name === "string") config.name = raw.name;
  if (typeof raw.maxIterations === "number") config.maxIterations = raw.maxIterations;
  return config;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}

const DEFAULT_MAX_LINES = 400;
const HARD_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export class Workspace {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly ignoreRules: IgnoreRules;
  readonly projectConfig: ProjectConfig;

  constructor(rootInput: string) {
    const resolved = path.resolve(rootInput);
    let real: string;
    try {
      real = fs.realpathSync.native(resolved);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Workspace root does not exist: ${rootInput}`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Workspace root is not a directory: ${rootInput}`);
    }
    this.root = real;
    this.id = createHash("sha256").update(normCase(real)).digest("hex").slice(0, 12);
    this.ignoreRules = new IgnoreRules(real);
    this.projectConfig = parseProjectConfig(readJsonIfExists<unknown>(path.join(real, ".c2c.json")));
    this.name = this.projectConfig.name ?? path.basename(real);
  }

  private contains(candidate: string): boolean {
    const r = normCase(this.root);
    const c = normCase(candidate);
    return c === r || c.startsWith(r + path.sep);
  }

  /**
   * Canonicalize a path by realpath-ing its deepest existing ancestor.
   * Defends against symlink escapes even for not-yet-existing leaf segments.
   */
  private canonicalize(abs: string): string {
    let current = abs;
    const suffix: string[] = [];
    for (;;) {
      try {
        const real = fs.realpathSync.native(current);
        return suffix.length > 0 ? path.join(real, ...suffix) : real;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return abs;
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }

  /**
   * Resolve an untrusted path to a canonical absolute path inside the workspace.
   * Throws PATH_OUTSIDE_WORKSPACE or ACCESS_DENIED_SENSITIVE_FILE.
   */
  resolve(requested: string, opts: { allowSensitive?: boolean } = {}): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    let p = requested.trim();
    if (p === "" || p === "/") p = ".";
    // Normalize separators so Windows-style input behaves identically everywhere.
    p = p.replace(/\\/g, "/");
    // Strip a "workspace:/" alias prefix if the model echoes it back.
    p = p.replace(/^workspace:\/*/i, "");
    if (p === "") p = ".";

    const abs = path.resolve(this.root, p);
    const canonical = this.canonicalize(abs);
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const rel = path.relative(this.root, canonical).split(path.sep).join("/");
    if (rel.startsWith("..")) {
      throw new WorkspaceError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside the connected workspace: ${requested}`);
    }
    if (!opts.allowSensitive && rel !== "" && this.ignoreRules.isSensitive(rel)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  /** Resolve an existing directory that may select a nested repository/worktree. */
  resolveRepositoryPath(requested: string): { abs: string; rel: string } {
    const resolved = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${resolved.rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${resolved.rel || "."}`);
    }
    return resolved;
  }

  /** Resolve a git_diff pathspec relative to a selected repository and keep it inside that repo. */
  resolveRepositoryScope(repositoryRoot: string, requested: string): { abs: string; rel: string } {
    if (typeof requested !== "string" || requested.includes("\0")) {
      throw new WorkspaceError("INVALID_PATH", "Invalid path");
    }
    const base = this.resolve(repositoryRoot, { allowSensitive: true });
    let baseStat: fs.Stats;
    try {
      baseStat = fs.statSync(base.abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", "Selected repository directory no longer exists");
    }
    if (!baseStat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", "Selected repository path is not a directory");
    }

    let p = requested.trim().replace(/\\/g, "/");
    if (p === "" || p === "/") p = ".";
    const canonical = /^workspace:\/*/i.test(p)
      ? this.resolve(p, { allowSensitive: true }).abs
      : this.canonicalize(path.resolve(base.abs, p));
    if (!this.contains(canonical)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_WORKSPACE",
        `Path resolves outside the connected workspace: ${requested}`
      );
    }
    const baseKey = normCase(base.abs);
    const candidateKey = normCase(canonical);
    if (candidateKey !== baseKey && !candidateKey.startsWith(baseKey + path.sep)) {
      throw new WorkspaceError(
        "PATH_OUTSIDE_REPOSITORY",
        `Path resolves outside the selected repository: ${requested}`
      );
    }
    const rel = path.relative(base.abs, canonical).split(path.sep).join("/");
    const workspaceRel = path.relative(this.root, canonical).split(path.sep).join("/");
    if (workspaceRel !== "" && this.ignoreRules.isSensitive(workspaceRel)) {
      throw new WorkspaceError(
        "ACCESS_DENIED_SENSITIVE_FILE",
        `ACCESS_DENIED_SENSITIVE_FILE: '${workspaceRel}' matches the sensitive-file policy and cannot be read.`
      );
    }
    return { abs: canonical, rel };
  }

  private async isBinary(abs: string): Promise<boolean> {
    const fd = await fs.promises.open(abs, "r");
    try {
      const buf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await fd.close();
    }
  }

  async readFile(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxLines?: number; maxBytes?: number } = {}
  ): Promise<ReadFileResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }
    if (!stat.isFile()) {
      throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
    }
    if (await this.isBinary(abs)) {
      throw new WorkspaceError("BINARY_FILE", `Binary file (${stat.size} bytes): ${rel}. Content is not returned.`);
    }

    const startLine = Math.max(1, Math.floor(opts.startLine ?? 1));
    const maxLines = Math.min(HARD_MAX_LINES, Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES)));
    const endLimit = opts.endLine
      ? Math.min(Math.floor(opts.endLine), startLine + HARD_MAX_LINES - 1)
      : startLine + maxLines - 1;
    const maxBytes = Math.min(1024 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES)));

    const lines: string[] = [];
    let totalLines = 0;
    let collectedBytes = 0;
    let byteTruncated = false;
    let actualEnd = startLine - 1;

    const contentHash = createHash("sha256");
    const stream = fs.createReadStream(abs);
    stream.on("data", (chunk) => contentHash.update(chunk));
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      totalLines++;
      if (totalLines >= startLine && totalLines <= endLimit && !byteTruncated) {
        const cost = Buffer.byteLength(line, "utf8") + 1;
        if (collectedBytes + cost > maxBytes && lines.length > 0) {
          byteTruncated = true;
        } else {
          lines.push(line);
          collectedBytes += cost;
          actualEnd = totalLines;
        }
      }
    }
    rl.close();

    const remaining = Math.max(0, totalLines - actualEnd);
    return {
      path: rel,
      sizeBytes: stat.size,
      totalLines,
      startLine: Math.min(startLine, Math.max(totalLines, 1)),
      endLine: actualEnd,
      truncated: remaining > 0,
      remainingLines: remaining,
      nextStartLine: remaining > 0 ? actualEnd + 1 : null,
      content: lines.join("\n"),
      contentHash: contentHash.digest("hex"),
    };
  }

  /**
   * Read one UTF-8-safe byte page while hashing and validating the complete
   * source stream. The returned page is hard-capped at 64 KiB even when a
   * caller supplies a larger maxBytes value.
   */
  async readFileBytes(
    requested: string,
    opts: { offsetBytes?: number; maxBytes?: number; expectedSourceHash?: string } & WorkspaceReadOptions = {}
  ): Promise<ReadFileBytesResult> {
    validateReadOptions(opts);
    assertReadDeadline(opts.deadlineAt);
    const { abs, rel } = this.resolve(requested);
    const offsetBytes = opts.offsetBytes ?? 0;
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) {
      throw new WorkspaceError("INVALID_OFFSET", "Byte offset must be a non-negative safe integer");
    }
    if (opts.expectedSourceHash !== undefined && !/^[a-f0-9]{64}$/.test(opts.expectedSourceHash)) {
      throw new WorkspaceError("INVALID_HASH", "Expected source hash must be a lowercase SHA-256 hex digest");
    }
    const requestedMax = opts.maxBytes ?? READ_ITEM_DEFAULT_BYTES;
    if (!Number.isSafeInteger(requestedMax) || requestedMax < 4) {
      throw new WorkspaceError("BYTE_LIMIT", "maxBytes must be an integer of at least four bytes");
    }
    const maxBytes = Math.min(requestedMax, READ_ITEM_HARD_MAX_BYTES);

    let handle: fs.promises.FileHandle;
    try {
      handle = await openForBoundedRead(abs, opts.deadlineAt);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "DEADLINE") throw error;
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }

    let result: ReadFileBytesResult;
    let sourceBytesScanned = 0;
    try {
      const before = await statForBoundedRead(handle, opts.deadlineAt);
      if (!before.isFile()) {
        throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
      }
      if (!Number.isSafeInteger(before.size) || before.size < 0) {
        throw new WorkspaceError("FILE_TOO_LARGE", `File size cannot be represented safely: ${rel}`);
      }
      if (opts.maxSourceBytes !== undefined && before.size > opts.maxSourceBytes) {
        throw new WorkspaceError("SOURCE_SCAN_LIMIT", `Complete source exceeds the ${opts.maxSourceBytes}-byte scan limit: ${rel}`);
      }
      if (offsetBytes > before.size) {
        throw new WorkspaceError("INVALID_OFFSET", `Byte offset exceeds file size (${before.size})`);
      }
      const availableBytes = before.size - offsetBytes;
      const pageCapacity = Math.min(maxBytes, availableBytes);
      const page = Buffer.alloc(pageCapacity);
      const pageEnd = offsetBytes + pageCapacity;
      const hash = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      let bytesRead = 0;
      let pageBytes = 0;

      const consumeChunk = (chunk: Buffer): void => {
        if (opts.maxSourceBytes !== undefined && sourceBytesScanned + chunk.length > opts.maxSourceBytes) {
          throw new WorkspaceError("SOURCE_SCAN_LIMIT", `Complete source exceeds the ${opts.maxSourceBytes}-byte scan limit: ${rel}`);
        }
        sourceBytesScanned += chunk.length;
        emitSourceBytesScanned(opts, chunk.length);
        hash.update(chunk);
        if (chunk.includes(0)) {
          throw new WorkspaceError("BINARY_FILE", `Binary file (${before.size} bytes): ${rel}. Content is not returned.`);
        }
        let decoded: string;
        try {
          decoded = decoder.decode(chunk, { stream: true });
        } catch {
          throw new WorkspaceError("INVALID_UTF8", `File is not valid UTF-8 text: ${rel}`);
        }
        if (decoded) emitReadChunk(opts, decoded);

        const chunkStart = bytesRead;
        const chunkEnd = chunkStart + chunk.length;
        const copyStart = Math.max(offsetBytes, chunkStart);
        const copyEnd = Math.min(pageEnd, chunkEnd);
        if (copyEnd > copyStart) {
          const sourceStart = copyStart - chunkStart;
          const copyLength = copyEnd - copyStart;
          chunk.copy(page, pageBytes, sourceStart, sourceStart + copyLength);
          pageBytes += copyLength;
        }
        bytesRead = chunkEnd;
      };
      if (opts.deadlineAt === undefined) {
        const readBuffer = Buffer.alloc(64 * 1024);
        while (bytesRead < before.size) {
          const requestBytes = Math.min(readBuffer.length, before.size - bytesRead);
          const result = await handle.read(readBuffer, 0, requestBytes, bytesRead);
          if (result.bytesRead === 0) break;
          consumeChunk(readBuffer.subarray(0, result.bytesRead));
        }
      } else {
        for await (const chunk of readFileChunks(handle, before.size, opts.deadlineAt)) consumeChunk(chunk);
      }
      let decodedTail: string;
      try {
        decodedTail = decoder.decode();
      } catch {
        throw new WorkspaceError("INVALID_UTF8", `File is not valid UTF-8 text: ${rel}`);
      }
      if (decodedTail) emitReadChunk(opts, decodedTail);
      assertReadDeadline(opts.deadlineAt);

      const after = await statForBoundedRead(handle, opts.deadlineAt);
      if (
        bytesRead !== before.size ||
        after.size !== before.size ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new WorkspaceError("SOURCE_CHANGED", `File changed while it was being read: ${rel}`);
      }

      const sourceHash = hash.digest("hex");
      if (opts.expectedSourceHash !== undefined && opts.expectedSourceHash !== sourceHash) {
        throw new WorkspaceError("SOURCE_CHANGED", `File content no longer matches the expected source hash: ${rel}`);
      }

      if (offsetBytes < before.size && pageBytes > 0 && (page[0]! & 0xc0) === 0x80) {
        throw new WorkspaceError("INVALID_OFFSET", "Byte offset falls inside a UTF-8 code point");
      }

      let returnedBytes = pageBytes;
      let content: string | undefined;
      while (returnedBytes >= 0) {
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(page.subarray(0, returnedBytes));
          break;
        } catch {
          // A valid source can still have the page boundary inside a code
          // point. Drop at most the incomplete tail; the full-stream decoder
          // above has already rejected malformed source bytes.
          returnedBytes--;
        }
      }
      if (content === undefined) {
        throw new WorkspaceError("INVALID_UTF8", `Could not decode a UTF-8-safe page: ${rel}`);
      }

      const nextOffsetBytes = offsetBytes + returnedBytes;
      const eof = nextOffsetBytes >= before.size;
      result = {
        path: rel,
        sizeBytes: before.size,
        startOffsetBytes: offsetBytes,
        nextOffsetBytes,
        returnedBytes,
        eof,
        truncated: !eof,
        content,
        sourceHash,
        sourceBytesScanned,
      };
    } finally {
      await closeForBoundedRead(handle, opts.deadlineAt);
    }
    assertReadDeadline(opts.deadlineAt);
    return result;
  }

  /**
   * Read a bounded line-range page without retaining an unbounded line in
   * memory. The complete source is still hashed and UTF-8 validated so callers
   * get the same source-change semantics as readFileBytes().
   */
  async readFileLinesBounded(
    requested: string,
    opts: { startLine?: number; endLine?: number; maxBytes?: number; expectedSourceHash?: string } & WorkspaceReadOptions = {}
  ): Promise<ReadFileLinesBoundedResult> {
    validateReadOptions(opts);
    assertReadDeadline(opts.deadlineAt);
    const { abs, rel } = this.resolve(requested);
    const startLine = opts.startLine ?? 1;
    const endLine = opts.endLine;
    if (!Number.isSafeInteger(startLine) || startLine < 1 ||
      (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))) {
      throw new RangeError("Line range must use positive safe integers with endLine >= startLine");
    }
    if (opts.expectedSourceHash !== undefined && !/^[a-f0-9]{64}$/.test(opts.expectedSourceHash)) {
      throw new WorkspaceError("INVALID_HASH", "Expected source hash must be a lowercase SHA-256 hex digest");
    }
    const requestedMax = opts.maxBytes ?? READ_ITEM_DEFAULT_BYTES;
    if (!Number.isSafeInteger(requestedMax) || requestedMax < 1) {
      throw new WorkspaceError("BYTE_LIMIT", "maxBytes must be a positive safe integer");
    }
    const maxBytes = Math.min(requestedMax, READ_ITEM_HARD_MAX_BYTES);

    let handle: fs.promises.FileHandle;
    try {
      handle = await openForBoundedRead(abs, opts.deadlineAt);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === "DEADLINE") throw error;
      throw new WorkspaceError("FILE_NOT_FOUND", `File not found: ${rel}`);
    }

    let result: ReadFileLinesBoundedResult;
    let sourceBytesScanned = 0;
    try {
      const before = await statForBoundedRead(handle, opts.deadlineAt);
      if (!before.isFile()) {
        throw new WorkspaceError("NOT_A_FILE", `Not a regular file: ${rel}`);
      }
      if (!Number.isSafeInteger(before.size) || before.size < 0) {
        throw new WorkspaceError("FILE_TOO_LARGE", `File size cannot be represented safely: ${rel}`);
      }
      if (opts.maxSourceBytes !== undefined && before.size > opts.maxSourceBytes) {
        throw new WorkspaceError("SOURCE_SCAN_LIMIT", `Complete source exceeds the ${opts.maxSourceBytes}-byte scan limit: ${rel}`);
      }

      const output = Buffer.alloc(maxBytes);
      let outputBytes = 0;
      let returnedLines = 0;
      let totalLines = 0;
      let actualEndLine = startLine - 1;
      let sourceStartOffset = before.size;
      let nextOffsetBytes = before.size;
      let startOffsetFound = false;
      let byteTruncated = false;
      let partialLine = false;
      let scanOffset = 0;
      let lineNumber = 1;
      let lineStartOffset = 0;
      let lineContentBytes = 0;
      let lineCapturedBytes = 0;
      let lineOutputStart = 0;
      let lineContentStart = 0;
      let lineSeparatorBytes = 0;
      let lineSelected = false;
      let lineCaptureEnabled = false;
      let lineHadOverflow = false;
      let lineInitialized = false;
      let captureBlocked = false;
      let pendingCarriageReturn = false;

      const beginLine = (): void => {
        lineContentBytes = 0;
        lineCapturedBytes = 0;
        lineHadOverflow = false;
        lineOutputStart = outputBytes;
        lineSelected = lineNumber >= startLine && (endLine === undefined || lineNumber <= endLine);
        lineCaptureEnabled = false;
        lineSeparatorBytes = 0;
        lineInitialized = true;
        if (lineNumber === startLine) {
          sourceStartOffset = lineStartOffset;
          startOffsetFound = true;
        }
        if (!lineSelected || captureBlocked) return;

        lineSeparatorBytes = returnedLines > 0 ? 1 : 0;
        if (outputBytes + lineSeparatorBytes > maxBytes) {
          byteTruncated = true;
          captureBlocked = true;
          nextOffsetBytes = lineStartOffset;
          return;
        }
        if (lineSeparatorBytes > 0) output[outputBytes++] = 0x0a;
        lineContentStart = outputBytes;
        lineCaptureEnabled = true;
      };

      const appendLineBytes = (bytes: Buffer): void => {
        lineContentBytes += bytes.length;
        if (!lineCaptureEnabled || bytes.length === 0) return;
        const capacity = maxBytes - outputBytes;
        const copied = Math.min(capacity, bytes.length);
        if (copied > 0) {
          bytes.copy(output, outputBytes, 0, copied);
          outputBytes += copied;
          lineCapturedBytes += copied;
        }
        if (copied < bytes.length) lineHadOverflow = true;
      };

      const finishLine = (afterLineOffset: number): void => {
        totalLines = lineNumber;
        if (lineSelected && lineCaptureEnabled) {
          let safeLength = lineCapturedBytes;
          while (safeLength > 0) {
            try {
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
                .decode(output.subarray(lineContentStart, lineContentStart + safeLength));
              break;
            } catch {
              safeLength--;
            }
          }
          if (safeLength < lineCapturedBytes) {
            outputBytes = lineContentStart + safeLength;
            lineHadOverflow = true;
          }

          if (lineContentBytes > 0 && safeLength === 0) {
            // Keep the separator out when no byte of this line can be returned.
            outputBytes = lineOutputStart;
            byteTruncated = true;
            captureBlocked = true;
            nextOffsetBytes = lineStartOffset;
          } else {
            returnedLines++;
            actualEndLine = lineNumber;
            if (lineHadOverflow || lineContentBytes > lineCapturedBytes) {
              partialLine = true;
              byteTruncated = true;
              captureBlocked = true;
              nextOffsetBytes = lineStartOffset + safeLength;
            } else {
              nextOffsetBytes = afterLineOffset;
            }
          }
        } else if (lineSelected && !lineCaptureEnabled) {
          if (!captureBlocked) {
            byteTruncated = true;
            captureBlocked = true;
            nextOffsetBytes = lineStartOffset;
          }
        }

        lineNumber++;
        lineStartOffset = afterLineOffset;
        lineInitialized = false;
      };

      const hash = createHash("sha256");
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      const consumeChunk = (chunk: Buffer): void => {
        if (opts.maxSourceBytes !== undefined && sourceBytesScanned + chunk.length > opts.maxSourceBytes) {
          throw new WorkspaceError("SOURCE_SCAN_LIMIT", `Complete source exceeds the ${opts.maxSourceBytes}-byte scan limit: ${rel}`);
        }
        sourceBytesScanned += chunk.length;
        emitSourceBytesScanned(opts, chunk.length);
        hash.update(chunk);
        if (chunk.includes(0)) {
          throw new WorkspaceError("BINARY_FILE", `Binary file (${before.size} bytes): ${rel}. Content is not returned.`);
        }
        let decoded: string;
        try {
          decoded = decoder.decode(chunk, { stream: true });
        } catch {
          throw new WorkspaceError("INVALID_UTF8", `File is not valid UTF-8 text: ${rel}`);
        }
        if (decoded) emitReadChunk(opts, decoded);

        if (pendingCarriageReturn) {
          if (chunk[0] !== 0x0a) appendLineBytes(Buffer.from([0x0d]));
          pendingCarriageReturn = false;
        }
        let segmentStart = 0;
        for (;;) {
          const newline = chunk.indexOf(0x0a, segmentStart);
          const segmentEnd = newline < 0 ? chunk.length : newline;
          if (!lineInitialized && (segmentEnd > segmentStart || newline >= 0)) beginLine();
          if (lineInitialized) {
            const sourceSegment = chunk.subarray(segmentStart, segmentEnd);
            const isCrLf = newline >= 0 && sourceSegment.length > 0 && sourceSegment[sourceSegment.length - 1] === 0x0d;
            const endsWithDeferredCr = newline < 0 && scanOffset + chunk.length < before.size &&
              sourceSegment.length > 0 && sourceSegment[sourceSegment.length - 1] === 0x0d;
            if (isCrLf || endsWithDeferredCr) {
              appendLineBytes(sourceSegment.subarray(0, sourceSegment.length - 1));
              if (endsWithDeferredCr) pendingCarriageReturn = true;
            } else {
              appendLineBytes(sourceSegment);
            }
          }
          if (newline < 0) break;
          finishLine(scanOffset + newline + 1);
          segmentStart = newline + 1;
        }
        scanOffset += chunk.length;
      };
      if (opts.deadlineAt === undefined) {
        const readBuffer = Buffer.alloc(64 * 1024);
        while (scanOffset < before.size) {
          const requestBytes = Math.min(readBuffer.length, before.size - scanOffset);
          const result = await handle.read(readBuffer, 0, requestBytes, scanOffset);
          if (result.bytesRead === 0) break;
          consumeChunk(readBuffer.subarray(0, result.bytesRead));
        }
      } else {
        for await (const chunk of readFileChunks(handle, before.size, opts.deadlineAt)) consumeChunk(chunk);
      }
      let decodedTail: string;
      try {
        decodedTail = decoder.decode();
      } catch {
        throw new WorkspaceError("INVALID_UTF8", `File is not valid UTF-8 text: ${rel}`);
      }
      if (decodedTail) emitReadChunk(opts, decodedTail);
      assertReadDeadline(opts.deadlineAt);

      const hasUnterminatedLastLine = before.size > 0 && lineStartOffset < before.size;
      if (hasUnterminatedLastLine && lineInitialized) finishLine(before.size);
      else if (!startOffsetFound && startLine === 1) sourceStartOffset = 0;

      const after = await statForBoundedRead(handle, opts.deadlineAt);
      if (
        scanOffset !== before.size ||
        after.size !== before.size ||
        after.ino !== before.ino ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      ) {
        throw new WorkspaceError("SOURCE_CHANGED", `File changed while it was being read: ${rel}`);
      }

      const sourceHash = hash.digest("hex");
      if (opts.expectedSourceHash !== undefined && opts.expectedSourceHash !== sourceHash) {
        throw new WorkspaceError("SOURCE_CHANGED", `File content no longer matches the expected source hash: ${rel}`);
      }

      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.subarray(0, outputBytes));
      const truncated = byteTruncated || (endLine === undefined && actualEndLine < totalLines);
      const nextStartLine = truncated
        ? (partialLine ? actualEndLine : Math.max(startLine, actualEndLine + 1))
        : null;
      result = {
        path: rel,
        sizeBytes: before.size,
        totalLines,
        startLine,
        endLine: actualEndLine,
        nextStartLine,
        startOffsetBytes: sourceStartOffset,
        nextOffsetBytes,
        returnedBytes: outputBytes,
        truncated,
        content,
        sourceHash,
        sourceBytesScanned,
      };
    } finally {
      await closeForBoundedRead(handle, opts.deadlineAt);
    }
    assertReadDeadline(opts.deadlineAt);
    return result;
  }

  async listDirectory(
    requested: string,
    opts: { depth?: number; limit?: number; offset?: number } = {}
  ): Promise<ListDirectoryResult> {
    const { abs, rel } = this.resolve(requested);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw new WorkspaceError("FILE_NOT_FOUND", `Directory not found: ${rel || "."}`);
    }
    if (!stat.isDirectory()) {
      throw new WorkspaceError("NOT_A_DIRECTORY", `Not a directory: ${rel}`);
    }
    const depth = Math.min(4, Math.max(1, Math.floor(opts.depth ?? 1)));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const all: DirEntry[] = [];
    const walk = async (dirAbs: string, dirRel: string, level: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (this.ignoreRules.isHidden(childRel) || this.ignoreRules.isHidden(childRel + "/")) continue;
        if (entry.isDirectory()) {
          all.push({ path: childRel + "/", type: "dir" });
          if (level < depth) await walk(path.join(dirAbs, entry.name), childRel, level + 1);
        } else if (entry.isFile()) {
          let size: number | undefined;
          try {
            size = (await fs.promises.stat(path.join(dirAbs, entry.name))).size;
          } catch {
            size = undefined;
          }
          all.push({ path: childRel, type: "file", sizeBytes: size });
        }
        if (all.length >= offset + limit + 2000) return; // hard cap for huge trees
      }
    };
    await walk(abs, rel, 1);

    const page = all.slice(offset, offset + limit);
    return {
      path: rel || ".",
      entries: page,
      total: all.length,
      offset,
      limit,
      hasMore: offset + page.length < all.length,
    };
  }

  /** Lightweight project detection for workspace_info. */
  detectProject(): {
    projectType: string;
    languages: string[];
    frameworks: string[];
    packageManager: string | null;
    scripts: Record<string, string>;
  } {
    const has = (f: string): boolean => fs.existsSync(path.join(this.root, f));
    const languages = new Set<string>();
    const frameworks = new Set<string>();
    let projectType = "unknown";
    let packageManager: string | null = null;
    let scripts: Record<string, string> = {};

    if (has("package.json")) {
      projectType = "node";
      languages.add("JavaScript");
      const rawPackage = readJsonIfExists<unknown>(path.join(this.root, "package.json"));
      const pkg = rawPackage && typeof rawPackage === "object" && !Array.isArray(rawPackage)
        ? rawPackage as Record<string, unknown>
        : {};
      scripts = stringRecord(pkg.scripts);
      const deps = { ...stringRecord(pkg.dependencies), ...stringRecord(pkg.devDependencies) };
      const known: Record<string, string> = {
        next: "Next.js",
        react: "React",
        vue: "Vue",
        svelte: "Svelte",
        express: "Express",
        fastify: "Fastify",
        "@nestjs/core": "NestJS",
        electron: "Electron",
        vitest: "Vitest",
        jest: "Jest",
      };
      for (const [dep, label] of Object.entries(known)) {
        if (deps[dep]) frameworks.add(label);
      }
      if (has("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (has("yarn.lock")) packageManager = "yarn";
      else if (has("bun.lockb") || has("bun.lock")) packageManager = "bun";
      else if (has("package-lock.json")) packageManager = "npm";
    }
    if (has("tsconfig.json")) languages.add("TypeScript");
    if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
      languages.add("Python");
      if (projectType === "unknown") projectType = "python";
    }
    if (has("Cargo.toml")) {
      languages.add("Rust");
      if (projectType === "unknown") projectType = "rust";
    }
    if (has("go.mod")) {
      languages.add("Go");
      if (projectType === "unknown") projectType = "go";
    }
    if (has("Package.swift")) {
      languages.add("Swift");
      if (projectType === "unknown") projectType = "swift";
    }
    return {
      projectType,
      languages: [...languages],
      frameworks: [...frameworks],
      packageManager,
      scripts,
    };
  }
}
