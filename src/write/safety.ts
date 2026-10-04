import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";

/**
 * Low-level mutation primitives. Callers must authorize the operation in the
 * permission layer and resolve and authorize every path in the path layer
 * before calling these functions. This module does not enforce workspace
 * boundaries; never pass raw model-supplied paths directly to it.
 */
export type WriteSafetyErrorCode =
  | "INVALID_ARGUMENT"
  | "STALE_FILE"
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
  errorCode?: WriteSafetyErrorCode;
  workspaceId?: string;
  permissionMode?: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

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

function readRegularFile(filePath: string): { bytes: Buffer; mode: number } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WriteSafetyError("FILE_NOT_FOUND", `File not found: ${filePath}`);
    }
    throw new WriteSafetyError("WRITE_FAILED", `Could not inspect file: ${filePath}`, { systemCode: code });
  }
  if (!stat.isFile()) {
    throw new WriteSafetyError("NOT_A_FILE", `Not a regular file: ${filePath}`);
  }
  try {
    return { bytes: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new WriteSafetyError("WRITE_FAILED", `Could not read file: ${filePath}`, { systemCode: code });
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
  try {
    appendAudit({ ...record, oldHash, success: false, errorCode: errorCode(error) });
  } catch {
    // Preserve the operation's original error if the audit directory is unavailable.
  }
}

function audited<T extends WriteResult | MoveResult | DeleteResult | DirectoryResult>(
  operation: string,
  filePath: string,
  context: WriteContext,
  action: () => T,
  move?: { source: string; destination: string }
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
    logFailure(base, error);
    throw error;
  }

  try {
    appendAudit({
      ...base,
      oldHash: result.oldHash,
      newHash: result.newHash,
      success: true,
    });
  } catch (error) {
    throw new WriteSafetyError("AUDIT_FAILED", "The file operation succeeded, but its audit record could not be written.", {
      operationApplied: true,
      systemCode: (error as NodeJS.ErrnoException).code,
    });
  }
  return result;
}

function temporaryFileFor(target: string, content: Buffer, mode: number, oldHash?: string): string {
  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.c2c-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
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
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new WriteSafetyError("WRITE_FAILED", `Could not prepare an atomic write for: ${target}`, {
      ...(oldHash ? { oldHash } : {}),
      systemCode: (error as NodeJS.ErrnoException).code,
    });
  }
}

function removeTempFile(tempPath: string): void {
  try {
    fs.unlinkSync(tempPath);
  } catch {
    // Cleanup is best effort after the target has already been safely published.
  }
}

function validateExpectedHash(expectedHash: string): void {
  if (typeof expectedHash !== "string" || !SHA256_HEX.test(expectedHash)) {
    throw new WriteSafetyError("INVALID_ARGUMENT", "expectedHash must be a 64-character SHA-256 hex digest.");
  }
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
  return audited("replace", absolutePath, context, () => {
    const current = readRegularFile(absolutePath);
    const oldHash = hashBytes(current.bytes);
    if (oldHash !== expectedHash.toLowerCase()) {
      throw new WriteSafetyError("STALE_FILE", `File changed since it was read: ${absolutePath}`, {
        expectedHash: expectedHash.toLowerCase(),
        currentHash: oldHash,
      });
    }

    const tempPath = temporaryFileFor(absolutePath, bytes, current.mode, oldHash);
    try {
      // The temp file is in the target directory. On local filesystems, rename
      // publishes the replacement atomically; Windows may reject replacement
      // while another process holds the target open, in which case we fail closed.
      fs.renameSync(tempPath, absolutePath);
    } catch (error) {
      throw new WriteSafetyError("WRITE_FAILED", `Could not replace file: ${absolutePath}`, {
        oldHash,
        systemCode: (error as NodeJS.ErrnoException).code,
      });
    } finally {
      removeTempFile(tempPath);
    }
    return { path: absolutePath, oldHash, newHash: hashBytes(bytes) };
  });
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

  return audited("edit", absolutePath, options, () => {
    const current = readRegularFile(absolutePath);
    const oldHash = hashBytes(current.bytes);
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
    const tempPath = temporaryFileFor(absolutePath, bytes, current.mode, oldHash);
    try {
      fs.renameSync(tempPath, absolutePath);
    } catch (error) {
      throw new WriteSafetyError("WRITE_FAILED", `Could not edit file: ${absolutePath}`, {
        oldHash,
        systemCode: (error as NodeJS.ErrnoException).code,
      });
    } finally {
      removeTempFile(tempPath);
    }
    return { path: absolutePath, oldHash, newHash: hashBytes(bytes) };
  });
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
