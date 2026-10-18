import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getStateDir } from "../config/paths.js";
import { atomicReplace, AtomicReplaceError, type AtomicReplaceResult } from "../execution/atomic-replace.js";

/**
 * Low-level mutation primitives. Callers must authorize the operation in the
 * permission layer and resolve and authorize every path in the path layer
 * before calling these functions. This module does not enforce workspace
 * boundaries; never pass raw model-supplied paths directly to it.
 */
export type WriteSafetyErrorCode =
  | "INVALID_ARGUMENT"
  | "STALE_FILE"
  | "FILE_TOO_LARGE"
  | "FILE_ALREADY_EXISTS"
  | "FILE_NOT_FOUND"
  | "NOT_A_FILE"
  | "AMBIGUOUS_EDIT"
  | "TEXT_NOT_FOUND"
  | "DESTINATION_EXISTS"
  | "WRITE_FAILED"
  | "AUDIT_FAILED";

export class WriteSafetyError extends Error {
  constructor(
    public readonly code: WriteSafetyErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "WriteSafetyError";
  }
}

export interface WriteContext {
  /** Optional integration metadata. This module does not make permission decisions. */
  workspaceId?: string;
  permissionMode?: string;
}

export interface FileSnapshot {
  path: string;
  content: string;
  contentHash: string;
}

export interface WriteResult {
  path: string;
  oldHash: string | null;
  newHash: string;
}

export interface MoveResult {
  source: string;
  destination: string;
  oldHash: string;
  newHash: string;
}

export interface DeleteResult {
  path: string;
  oldHash: string;
  newHash: null;
}

export interface DirectoryResult {
  path: string;
  oldHash: null;
  newHash: null;
}

interface AuditRecord {
  timestamp: string;
  operation: string;
  path: string;
  source?: string;
  destination?: string;
  oldHash: string | null;
  newHash: string | null;
  success: boolean;
  operationApplied?: boolean;
  errorCode?: WriteSafetyErrorCode;
  stage?: string;
  systemCode?: string;
  retryCount?: number;
  temporaryCleanupCode?: string;
  temporaryFile?: string;
  temporaryFileLeftover?: boolean;
  timingsMs?: WriteStageTimings;
  workspaceId?: string;
  permissionMode?: string;
}

interface WriteStageTimings {
  preflightMs: number;
  oldHashMs: number;
  newHashMs: number;
  tempWriteMs: number;
  flushMs: number;
  finalValidationMs: number;
  atomicReplaceMs: number;
  postVerificationMs: number;
  totalMs: number;
}

interface RegularFileSnapshot {
  bytes: Buffer;
  mode: number;
  dev: string;
  ino: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const MAX_EDITABLE_FILE_BYTES = 10 * 1024 * 1024;

function asAbsolutePath(input: string): string {
  if (typeof input !== "string" || input.includes("\0") || !path.isAbsolute(input)) {
    throw new WriteSafetyError("INVALID_ARGUMENT", "A resolved absolute file path is required.");
  }
  return path.resolve(input);
}

function asBuffer(content: string | Uint8Array): Buffer {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new WriteSafetyError("INVALID_ARGUMENT", "File content must be text or bytes.");
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function sameVersion(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function readRegularFile(filePath: string, maxBytes?: number): RegularFileSnapshot {
  let named: fs.BigIntStats;
  try {
    named = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WriteSafetyError("FILE_NOT_FOUND", `File not found: ${filePath}`);
    }
    throw new WriteSafetyError("WRITE_FAILED", `Could not inspect file: ${filePath}`, { systemCode: code });
  }
  if (!named.isFile() || named.isSymbolicLink()) {
    throw new WriteSafetyError("NOT_A_FILE", `Not a regular file: ${filePath}`);
  }
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new WriteSafetyError("WRITE_FAILED", `Could not open file: ${filePath}`, { systemCode: code });
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameVersion(named, opened)) {
      throw new WriteSafetyError("STALE_FILE", `File changed while it was being opened: ${filePath}`, { stage: "preflight-identity" });
    }
    if (maxBytes !== undefined && opened.size > BigInt(maxBytes)) {
      throw new WriteSafetyError("FILE_TOO_LARGE", `File exceeds the ${maxBytes}-byte edit limit: ${filePath}`, { maxBytes });
    }
    let bytes: Buffer;
    if (maxBytes === undefined) {
      bytes = fs.readFileSync(fd);
    } else {
      let buffer = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(1, Number(opened.size) + 1)));
      let total = 0;
      while (total <= maxBytes) {
        if (total === buffer.length) {
          const next = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(64 * 1024, buffer.length * 2)));
          buffer.copy(next, 0, 0, total);
          buffer = next;
        }
        const count = fs.readSync(fd, buffer, total, buffer.length - total, null);
        if (count === 0) break;
        total += count;
      }
      if (total > maxBytes) {
        throw new WriteSafetyError("FILE_TOO_LARGE", `File exceeds the ${maxBytes}-byte edit limit: ${filePath}`, { maxBytes });
      }
      bytes = buffer.subarray(0, total);
    }
    const afterHandle = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (!sameVersion(opened, afterHandle) || opened.dev !== afterPath.dev || opened.ino !== afterPath.ino || !afterPath.isFile()) {
      throw new WriteSafetyError("STALE_FILE", `File changed while it was being read: ${filePath}`, { stage: "preflight-read" });
    }
    return {
      bytes,
      mode: Number(opened.mode & 0o777n),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    };
  } catch (error) {
    if (error instanceof WriteSafetyError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new WriteSafetyError("WRITE_FAILED", `Could not read file: ${filePath}`, { systemCode: code });
  } finally {
    fs.closeSync(fd);
  }
}

function assertDestinationAbsent(
  filePath: string,
  errorCode: "FILE_ALREADY_EXISTS" | "DESTINATION_EXISTS",
  oldHash?: string
): void {
  try {
    const stat = fs.lstatSync(filePath);
    let hash = oldHash;
    if (!hash && stat.isFile()) {
      try {
        hash = hashBytes(fs.readFileSync(filePath));
      } catch {
        // Keep the explicit existence error even when the existing file is unreadable.
      }
    }
    throw new WriteSafetyError(errorCode, `Destination already exists: ${filePath}`, {
      ...(hash ? { oldHash: hash } : {}),
    });
  } catch (error) {
    if (error instanceof WriteSafetyError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new WriteSafetyError("WRITE_FAILED", `Could not inspect destination: ${filePath}`, { systemCode: code });
    }
  }
}

function safeAuditWorkspaceId(workspaceId?: string): string {
  const raw = workspaceId?.trim() || "default";
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return safe === "" || safe === "." || safe === ".." ? "default" : safe;
}

/** Return the JSONL audit file path used for a workspace (or the default context). */
export function getWriteAuditPath(workspaceId?: string): string {
  return path.join(getStateDir(), "audit", `${safeAuditWorkspaceId(workspaceId)}.jsonl`);
}

function appendAudit(record: AuditRecord): void {
  const filePath = getWriteAuditPath(record.workspaceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX mode semantics.
  }
}

function errorCode(error: unknown): WriteSafetyErrorCode {
  if (error instanceof WriteSafetyError) return error.code;
  return "WRITE_FAILED";
}

function logFailure(record: AuditRecord, error: unknown): void {
  const details = error instanceof WriteSafetyError ? error.details : {};
  const currentHash = typeof details.currentHash === "string" ? details.currentHash : null;
  const oldHash = typeof details.oldHash === "string" ? details.oldHash : currentHash ?? record.oldHash;
  const newHash = typeof details.newHash === "string" ? details.newHash : record.newHash;
  const stage = typeof details.stage === "string" ? details.stage : undefined;
  const systemCode = typeof details.systemCode === "string" ? details.systemCode : undefined;
  const retryCount = typeof details.retryCount === "number" ? details.retryCount : undefined;
  const temporaryCleanupCode = typeof details.temporaryCleanupCode === "string" ? details.temporaryCleanupCode : undefined;
  const temporaryFile = typeof details.temporaryFile === "string" ? details.temporaryFile : undefined;
  const temporaryFileLeftover = typeof details.temporaryFileLeftover === "boolean" ? details.temporaryFileLeftover : undefined;
  const operationApplied = typeof details.operationApplied === "boolean" ? details.operationApplied : undefined;
  const timingsMs = details.timingsMs && typeof details.timingsMs === "object"
    ? details.timingsMs as WriteStageTimings : undefined;
  try {
    appendAudit({
      ...record,
      oldHash,
      newHash,
      success: false,
      ...(operationApplied !== undefined ? { operationApplied } : {}),
      errorCode: errorCode(error),
      ...(stage ? { stage } : {}),
      ...(systemCode ? { systemCode } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(temporaryCleanupCode ? { temporaryCleanupCode } : {}),
      ...(temporaryFile ? { temporaryFile } : {}),
      ...(temporaryFileLeftover !== undefined ? { temporaryFileLeftover } : {}),
      ...(timingsMs ? { timingsMs } : {}),
    });
  } catch {
    // Preserve the operation's original error if the audit directory is unavailable.
  }
}

function audited<T extends WriteResult | MoveResult | DeleteResult | DirectoryResult>(
  operation: string,
  filePath: string,
  context: WriteContext,
  action: () => T,
  move?: { source: string; destination: string },
  getTimings?: () => WriteStageTimings,
): T {
  const base: AuditRecord = {
    timestamp: new Date().toISOString(),
    operation,
    path: filePath,
    ...(move ?? {}),
    oldHash: null,
    newHash: null,
    success: false,
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
  };

  let result: T;
  try {
    result = action();
  } catch (error) {
    const timingsMs = getTimings?.();
    const auditedError = error instanceof WriteSafetyError && timingsMs
      ? new WriteSafetyError(error.code, error.message, { ...error.details, timingsMs })
      : error;
    logFailure(base, auditedError);
    throw auditedError;
  }

  try {
    appendAudit({
      ...base,
      oldHash: result.oldHash,
      newHash: result.newHash,
      success: true,
      ...(getTimings ? { timingsMs: getTimings() } : {}),
    });
  } catch (error) {
    throw new WriteSafetyError("AUDIT_FAILED", "The file operation succeeded, but its audit record could not be written.", {
      operationApplied: true,
      systemCode: (error as NodeJS.ErrnoException).code,
    });
  }
  return result;
}

function temporaryFileFor(
  target: string,
  content: Buffer,
  mode: number,
  oldHash?: string,
  timings?: Pick<WriteStageTimings, "tempWriteMs" | "flushMs">,
): string {
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.c2c-${process.pid}-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let stage = "create-temp";
  try {
    let stageStarted = performance.now();
    fd = fs.openSync(tempPath, "wx", mode);
    stage = "write-temp";
    fs.writeFileSync(fd, content);
    if (timings) timings.tempWriteMs += performance.now() - stageStarted;
    stage = "flush-temp";
    stageStarted = performance.now();
    fs.fsyncSync(fd);
    if (timings) timings.flushMs += performance.now() - stageStarted;
    stage = "close-temp";
    stageStarted = performance.now();
    fs.closeSync(fd);
    if (timings) timings.tempWriteMs += performance.now() - stageStarted;
    fd = undefined;
    return tempPath;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Keep the original write error.
      }
    }
    let temporaryCleanupCode: string | undefined;
    try {
      fs.unlinkSync(tempPath);
    } catch (cleanupError) {
      const cleanupErrno = (cleanupError as NodeJS.ErrnoException).code;
      if (cleanupErrno !== "ENOENT") temporaryCleanupCode = cleanupErrno ?? "UNKNOWN";
    }
    throw new WriteSafetyError("WRITE_FAILED", `Could not prepare an atomic write for: ${target}`, {
      ...(oldHash ? { oldHash } : {}),
      stage,
      systemCode: (error as NodeJS.ErrnoException).code,
      operationApplied: false,
      ...(timings ? { timingsMs: { ...timings } } : {}),
      ...(temporaryCleanupCode ? {
        temporaryCleanupCode,
        temporaryFile: path.basename(tempPath),
        temporaryFileLeftover: true,
      } : {}),
    });
  }
}

function removeTempFile(tempPath: string): { code?: string } {
  try {
    fs.unlinkSync(tempPath);
    return {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    return { code: code ?? "UNKNOWN" };
  }
}

function publishReplacement(
  tempPath: string,
  filePath: string,
  oldHash: string,
  newHash: string,
  identity: { dev: string; ino: string },
  operation: "replace" | "edit",
): AtomicReplaceResult {
  try {
    return atomicReplace(tempPath, filePath, {
      preserveAcl: true,
      expectedHash: oldHash,
      expectedNewHash: newHash,
      expectedIdentity: identity,
    });
  } catch (error) {
    const cleanup = removeTempFile(tempPath);
    const cleanupDetails = cleanup.code
      ? {
        temporaryCleanupCode: cleanup.code,
        temporaryFile: path.basename(tempPath),
        temporaryFileLeftover: true,
      }
      : {};
    if (error instanceof WriteSafetyError) {
      if (cleanup.code) {
        throw new WriteSafetyError(error.code, error.message, { ...error.details, ...cleanupDetails });
      }
      throw error;
    }

    const atomicError = error instanceof AtomicReplaceError ? error : undefined;
    if (atomicError?.failureCode === "STALE_FILE") {
      throw new WriteSafetyError("STALE_FILE", `File changed while waiting to replace it: ${filePath}`, {
        oldHash,
        expectedHash: oldHash,
        ...(atomicError.currentHash ? { currentHash: atomicError.currentHash } : {}),
        stage: atomicError.stage,
        retryCount: atomicError.retryCount,
        operationApplied: atomicError.operationApplied,
        ...(atomicError.timings ? { timingsMs: atomicError.timings } : {}),
        ...cleanupDetails,
      });
    }
    const systemCode = atomicError?.systemCode ?? (error as NodeJS.ErrnoException).code;
    const retryCount = atomicError?.retryCount ?? 0;
    throw new WriteSafetyError("WRITE_FAILED", `Could not ${operation} file: ${filePath}`, {
      oldHash,
      stage: atomicError?.stage ?? "publish",
      ...(systemCode ? { systemCode } : {}),
      retryCount,
      operationApplied: atomicError?.operationApplied ?? false,
      ...(atomicError?.readOnly ? { readOnly: true } : {}),
      ...(atomicError?.finalHash ? { newHash: atomicError.finalHash } : {}),
      ...(atomicError?.timings ? { timingsMs: atomicError.timings } : {}),
      ...cleanupDetails,
    });
  }
}

function validateExpectedHash(expectedHash: string): void {
  if (typeof expectedHash !== "string" || !SHA256_HEX.test(expectedHash)) {
    throw new WriteSafetyError("INVALID_ARGUMENT", "expectedHash must be a 64-character SHA-256 hex digest.");
  }
}

function emptyWriteTimings(): WriteStageTimings {
  return {
    preflightMs: 0,
    oldHashMs: 0,
    newHashMs: 0,
    tempWriteMs: 0,
    flushMs: 0,
    finalValidationMs: 0,
    atomicReplaceMs: 0,
    postVerificationMs: 0,
    totalMs: 0,
  };
}

/** Read a regular file and return the SHA-256 hash of its exact bytes. */
export function readFileForWrite(filePath: string): FileSnapshot {
  const absolutePath = asAbsolutePath(filePath);
  const { bytes } = readRegularFile(absolutePath);
  return {
    path: absolutePath,
    content: bytes.toString("utf8"),
    contentHash: hashBytes(bytes),
  };
}

/** Compute the SHA-256 hash of a regular file without returning its content. */
export function hashFile(filePath: string): string {
  const absolutePath = asAbsolutePath(filePath);
  return hashBytes(readRegularFile(absolutePath).bytes);
}

/** Create a new file. Existing destinations are never overwritten. */
export function createFile(
  filePath: string,
  content: string | Uint8Array,
  context: WriteContext = {}
): WriteResult {
  const absolutePath = asAbsolutePath(filePath);
  const bytes = asBuffer(content);
  return audited("create", absolutePath, context, () => {
    assertDestinationAbsent(absolutePath, "FILE_ALREADY_EXISTS");
    const tempPath = temporaryFileFor(absolutePath, bytes, 0o666);
    try {
      // Hard-link publication is exclusive and makes the fully written temp file
      // visible in one step. It fails closed on file systems without hard links.
      fs.linkSync(tempPath, absolutePath);
      const newHash = hashBytes(bytes);
      return { path: absolutePath, oldHash: null, newHash };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const currentHash = (() => {
          try {
            return hashFile(absolutePath);
          } catch {
            return undefined;
          }
        })();
        throw new WriteSafetyError("FILE_ALREADY_EXISTS", `File already exists: ${absolutePath}`, {
          ...(currentHash ? { currentHash } : {}),
        });
      }
      throw new WriteSafetyError("WRITE_FAILED", `Could not create file: ${absolutePath}`, { systemCode: code });
    } finally {
      removeTempFile(tempPath);
    }
  });
}

/**
 * Replace an existing file only when its exact current bytes match expectedHash.
 * The synchronous hash check and rename serialize callers in this Node process;
 * external processes that ignore this layer cannot participate in that check.
 */
export function replaceFile(
  filePath: string,
  content: string | Uint8Array,
  expectedHash: string,
  context: WriteContext = {}
): WriteResult {
  const absolutePath = asAbsolutePath(filePath);
  validateExpectedHash(expectedHash);
  const bytes = asBuffer(content);
  const timings = emptyWriteTimings();
  const started = performance.now();
  const getTimings = () => ({ ...timings, totalMs: performance.now() - started });
  return audited("replace", absolutePath, context, () => {
    let stageStarted = performance.now();
    const current = readRegularFile(absolutePath, MAX_EDITABLE_FILE_BYTES);
    timings.preflightMs += performance.now() - stageStarted;
    stageStarted = performance.now();
    const oldHash = hashBytes(current.bytes);
    timings.oldHashMs += performance.now() - stageStarted;
    if (oldHash !== expectedHash.toLowerCase()) {
      throw new WriteSafetyError("STALE_FILE", `File changed since it was read: ${absolutePath}`, {
        expectedHash: expectedHash.toLowerCase(),
        currentHash: oldHash,
      });
    }
    if (process.platform === "win32" && (current.mode & 0o222) === 0) {
      throw new WriteSafetyError("WRITE_FAILED", `File is read-only and cannot be replaced: ${absolutePath}`, {
        oldHash,
        stage: "preflight-readonly",
        systemCode: "EACCES",
        readOnly: true,
        operationApplied: false,
      });
    }

    stageStarted = performance.now();
    const newHash = hashBytes(bytes);
    timings.newHashMs += performance.now() - stageStarted;
    const tempPath = temporaryFileFor(absolutePath, bytes, current.mode, oldHash, timings);
    const publication = publishReplacement(tempPath, absolutePath, oldHash, newHash,
      { dev: current.dev, ino: current.ino }, "replace");
    timings.finalValidationMs += publication.timings.finalValidationMs;
    timings.atomicReplaceMs += publication.timings.atomicReplaceMs;
    timings.postVerificationMs += publication.timings.postVerificationMs;
    return { path: absolutePath, oldHash, newHash };
  }, undefined, getTimings);
}

/** Replace a text match after checking the caller's hash. Matches must be unique by default. */
export function editText(
  filePath: string,
  oldText: string,
  newText: string,
  expectedHash: string,
  options: WriteContext & { unique?: boolean } = {}
): WriteResult {
  const absolutePath = asAbsolutePath(filePath);
  validateExpectedHash(expectedHash);
  if (oldText.length === 0) {
    throw new WriteSafetyError("INVALID_ARGUMENT", "oldText must not be empty.");
  }

  const timings = emptyWriteTimings();
  const started = performance.now();
  const getTimings = () => ({ ...timings, totalMs: performance.now() - started });
  return audited("edit", absolutePath, options, () => {
    let stageStarted = performance.now();
    const current = readRegularFile(absolutePath, MAX_EDITABLE_FILE_BYTES);
    timings.preflightMs += performance.now() - stageStarted;
    stageStarted = performance.now();
    const oldHash = hashBytes(current.bytes);
    timings.oldHashMs += performance.now() - stageStarted;
    if (oldHash !== expectedHash.toLowerCase()) {
      throw new WriteSafetyError("STALE_FILE", `File changed since it was read: ${absolutePath}`, {
        expectedHash: expectedHash.toLowerCase(),
        currentHash: oldHash,
      });
    }

    const text = current.bytes.toString("utf8");
    const matches: number[] = [];
    for (let index = text.indexOf(oldText); index !== -1; index = text.indexOf(oldText, index + 1)) {
      matches.push(index);
      if (options.unique !== false && matches.length > 1) break;
    }
    if (matches.length === 0) {
      throw new WriteSafetyError("TEXT_NOT_FOUND", `Text to replace was not found in: ${absolutePath}`, { oldHash });
    }
    if (options.unique !== false && matches.length > 1) {
      throw new WriteSafetyError("AMBIGUOUS_EDIT", `Text to replace appears more than once in: ${absolutePath}`, { oldHash });
    }

    const updated = options.unique === false
      ? text.split(oldText).join(newText)
      : `${text.slice(0, matches[0])}${newText}${text.slice(matches[0] + oldText.length)}`;
    const bytes = Buffer.from(updated, "utf8");
    if (process.platform === "win32" && (current.mode & 0o222) === 0) {
      throw new WriteSafetyError("WRITE_FAILED", `File is read-only and cannot be edited: ${absolutePath}`, {
        oldHash,
        stage: "preflight-readonly",
        systemCode: "EACCES",
        readOnly: true,
        operationApplied: false,
      });
    }
    stageStarted = performance.now();
    const newHash = hashBytes(bytes);
    timings.newHashMs += performance.now() - stageStarted;
    const tempPath = temporaryFileFor(absolutePath, bytes, current.mode, oldHash, timings);
    const publication = publishReplacement(tempPath, absolutePath, oldHash, newHash,
      { dev: current.dev, ino: current.ino }, "edit");
    timings.finalValidationMs += publication.timings.finalValidationMs;
    timings.atomicReplaceMs += publication.timings.atomicReplaceMs;
    timings.postVerificationMs += publication.timings.postVerificationMs;
    return { path: absolutePath, oldHash, newHash };
  }, undefined, getTimings);
}

/**
 * Move a regular file without replacing an existing destination. Hard-link then
 * unlink keeps the destination creation exclusive; source and destination must
 * be on a filesystem that supports hard links. There is a brief interval where
 * both names exist, so this is not advertised as an atomic rename.
 */
export function moveFile(sourcePath: string, destinationPath: string, context: WriteContext = {}): MoveResult {
  const source = asAbsolutePath(sourcePath);
  const destination = asAbsolutePath(destinationPath);
  return audited("move", source, context, () => {
    const sourceFile = readRegularFile(source);
    const oldHash = hashBytes(sourceFile.bytes);
    assertDestinationAbsent(destination, "DESTINATION_EXISTS", oldHash);
    try {
      fs.linkSync(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EISDIR") {
        throw new WriteSafetyError("DESTINATION_EXISTS", `Destination already exists: ${destination}`, { oldHash });
      }
      if (code === "ENOENT") {
        throw new WriteSafetyError("FILE_NOT_FOUND", `Source or destination parent not found.`, { oldHash });
      }
      throw new WriteSafetyError("WRITE_FAILED", `Could not create destination: ${destination}`, {
        oldHash,
        systemCode: code,
      });
    }

    try {
      fs.unlinkSync(source);
    } catch (error) {
      let rolledBack = false;
      try {
        fs.unlinkSync(destination);
        rolledBack = true;
      } catch {
        // Report that the destination may remain if rollback also fails.
      }
      throw new WriteSafetyError("WRITE_FAILED", `Could not remove the source after linking: ${source}`, {
        oldHash,
        operationApplied: !rolledBack,
        systemCode: (error as NodeJS.ErrnoException).code,
      });
    }
    return { source, destination, oldHash, newHash: oldHash };
  }, { source, destination });
}

/** Delete exactly one authorized regular file, only if its bytes still match the snapshot. */
export function deleteFile(filePath: string, expectedHash: string, context: WriteContext = {}): DeleteResult {
  const absolutePath = asAbsolutePath(filePath);
  validateExpectedHash(expectedHash);
  return audited("delete", absolutePath, context, () => {
    const oldHash = hashBytes(readRegularFile(absolutePath).bytes);
    if (oldHash !== expectedHash.toLowerCase()) {
      throw new WriteSafetyError("STALE_FILE", `File changed since it was read: ${absolutePath}`, {
        expectedHash: expectedHash.toLowerCase(), currentHash: oldHash,
      });
    }
    try {
      fs.unlinkSync(absolutePath);
    } catch (error) {
      throw new WriteSafetyError("WRITE_FAILED", `Could not delete file: ${absolutePath}`, {
        oldHash, systemCode: (error as NodeJS.ErrnoException).code,
      });
    }
    return { path: absolutePath, oldHash, newHash: null };
  });
}

/** Create exactly one authorized directory. Its parent must already exist; no implicit recursion. */
export function createDirectory(directoryPath: string, context: WriteContext = {}): DirectoryResult {
  const absolutePath = asAbsolutePath(directoryPath);
  return audited("create_directory", absolutePath, context, () => {
    assertDestinationAbsent(absolutePath, "FILE_ALREADY_EXISTS");
    try {
      fs.mkdirSync(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new WriteSafetyError(code === "EEXIST" ? "FILE_ALREADY_EXISTS" : "WRITE_FAILED",
        `Could not create directory: ${absolutePath}`, { systemCode: code });
    }
    return { path: absolutePath, oldHash: null, newHash: null };
  });
}
