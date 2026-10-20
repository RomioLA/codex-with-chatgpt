import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { durableAtomicReplace } from "./atomic-replace.js";
import type { ExecutionJob } from "./job-types.js";

const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024;
type Kind = "jobs" | "idempotency" | "level3" | "git-plans";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface ArchiveScanLimits {
  maxRecords: number;
  maxBytes: number;
  timeoutMs: number;
}

export type ArchiveScanClock = () => number;
export type ArchiveJobRecordReader = (root: string, jobId: string) => unknown | null;

export const DEFAULT_ARCHIVED_JOB_SCAN_LIMITS: Readonly<ArchiveScanLimits> = Object.freeze({
  maxRecords: 10_000,
  maxBytes: 64 * 1024 * 1024,
  timeoutMs: 3_000,
});

export type ArchiveScanResult =
  | { kind: "complete"; records: number; bytes: number }
  | { kind: "incomplete"; reason: string; records: number; bytes: number };

export interface ArchiveRecordOperations {
  writeTemp(fd: number, bytes: Buffer): void;
  flushTemp(fd: number): void;
  publish(source: string, destination: string, expectedHash: string): void;
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.byteLength;) {
    const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) throw new Error("ARCHIVE_TEMP_WRITE_FAILED");
    offset += written;
  }
}

export const DEFAULT_ARCHIVE_RECORD_OPERATIONS: Readonly<ArchiveRecordOperations> = Object.freeze({
  writeTemp: writeAll,
  flushTemp(fd: number) { fs.fsyncSync(fd); },
  publish(source: string, destination: string, expectedHash: string) {
    durableAtomicReplace(source, destination, expectedHash);
  },
});

function requireSafeDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()) {
    throw new Error("ARCHIVE_INVALID_PATH");
  }
}

function scanErrorReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "ARCHIVE_DIRECTORY_MISSING";
  if (code === "EACCES" || code === "EPERM") return "ARCHIVE_READ_DENIED";
  if (error instanceof SyntaxError) return "ARCHIVE_CORRUPT";
  const message = error instanceof Error ? error.message : String(error);
  if (message === "ARCHIVE_CORRUPT" || message === "ARCHIVE_INVALID_PATH") return message;
  return "ARCHIVE_SCAN_FAILED";
}

/**
 * Enumerate the complete immutable execution-job archive under strict bounds.
 * Missing directories, malformed entries, unreadable records, and exhausted
 * bounds are incomplete results; callers must never interpret them as absent.
 */
export function scanArchivedJobRecords<T>(
  root: string,
  visit: (jobId: string, value: T) => void,
  limits: Readonly<ArchiveScanLimits> = DEFAULT_ARCHIVED_JOB_SCAN_LIMITS,
  now: ArchiveScanClock = Date.now,
  readJobRecord: ArchiveJobRecordReader = (archiveRoot, jobId) => readArchivedRecord(archiveRoot, "jobs", jobId),
): ArchiveScanResult {
  let records = 0;
  let bytes = 0;
  const incomplete = (reason: string): ArchiveScanResult => ({ kind: "incomplete", reason, records, bytes });
  if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1 ||
      !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
      !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) {
    return incomplete("ARCHIVE_SCAN_LIMITS_INVALID");
  }

  const startedAt = now();
  const deadline = startedAt + limits.timeoutMs;
  const jobsRoot = path.join(path.resolve(root), ".archive", "jobs");
  const expired = (): boolean => now() >= deadline;

  try {
    requireSafeDirectory(root);
    requireSafeDirectory(path.join(path.resolve(root), ".archive"));
    requireSafeDirectory(jobsRoot);

    const shards = fs.opendirSync(jobsRoot);
    try {
      for (;;) {
        if (expired()) return incomplete("ARCHIVE_SCAN_DEADLINE");
        const shard = shards.readSync();
        if (shard === null) break;
        if (!shard.isDirectory() || shard.isSymbolicLink() || !/^[A-Za-z0-9_-]{2}$/.test(shard.name)) {
          return incomplete("ARCHIVE_ENTRY_INVALID");
        }

        const shardPath = path.join(jobsRoot, shard.name);
        requireSafeDirectory(shardPath);
        const entries = fs.opendirSync(shardPath);
        try {
          for (;;) {
            if (expired()) return incomplete("ARCHIVE_SCAN_DEADLINE");
            const entry = entries.readSync();
            if (entry === null) break;
            if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
              return incomplete("ARCHIVE_ENTRY_INVALID");
            }
            const jobId = entry.name.slice(0, -5);
            if (!/^[A-Za-z0-9_-]{24,64}$/.test(jobId) || !jobId.startsWith(shard.name)) {
              return incomplete("ARCHIVE_ENTRY_INVALID");
            }
            if (records >= limits.maxRecords) return incomplete("ARCHIVE_SCAN_RECORD_LIMIT");

            const file = path.join(shardPath, entry.name);
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES) {
              return incomplete("ARCHIVE_RECORD_INVALID");
            }
            if (stat.size > limits.maxBytes - bytes) return incomplete("ARCHIVE_SCAN_BYTE_LIMIT");
            const value = readJobRecord(root, jobId) as T | null;
            if (value === null) return incomplete("ARCHIVE_RECORD_MISSING_DURING_SCAN");
            visit(jobId, value);
            records += 1;
            bytes += stat.size;
          }
        } finally {
          try { entries.closeSync(); } catch { /* already closed */ }
        }
      }
    } finally {
      try { shards.closeSync(); } catch { /* already closed */ }
    }
    return expired() ? incomplete("ARCHIVE_SCAN_DEADLINE") : { kind: "complete", records, bytes };
  } catch (error) {
    return incomplete(scanErrorReason(error));
  }
}

function archivePath(root: string, kind: Kind, key: string, create = false): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("ARCHIVE_INVALID_KEY");
  let current = path.resolve(root);
  for (const component of [".archive", kind, key.slice(0, 2)]) {
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw new Error("ARCHIVE_INVALID_PATH");
    current = path.join(current, component);
    if (create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  }
  if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw new Error("ARCHIVE_INVALID_PATH");
  return path.join(current, `${key}.json`);
}

/** Immutable, identity-named history; never enumerates or deletes unknown files. */
export function readArchivedRecord<T>(root: string, kind: Kind, key: string): T | null {
  try {
    const file = archivePath(root, kind, key);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARCHIVE_BYTES) throw new Error("ARCHIVE_CORRUPT");
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    if (envelope.version !== 1 || envelope.kind !== kind || envelope.key !== key || envelope.digest !== hash(JSON.stringify(envelope.value))) throw new Error("ARCHIVE_CORRUPT");
    return envelope.value as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export function archiveRecord(
  root: string,
  kind: Kind,
  key: string,
  value: unknown,
  operations: Readonly<ArchiveRecordOperations> = DEFAULT_ARCHIVE_RECORD_OPERATIONS,
): void {
  const previous = readArchivedRecord(root, kind, key);
  if (previous !== null && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("ARCHIVE_CONFLICT");
  const bytes = JSON.stringify({ version: 1, kind, key, digest: hash(JSON.stringify(value)), value });
  const serialized = Buffer.from(bytes, "utf8");
  if (serialized.byteLength > MAX_ARCHIVE_BYTES) throw new Error("ARCHIVE_TOO_LARGE");
  const destination = archivePath(root, kind, key, true);
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const expectedHash = hash(bytes);
  let fd: number | undefined;
  let published = false;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    operations.writeTemp(fd, serialized);
    operations.flushTemp(fd);
    fs.closeSync(fd);
    fd = undefined;
    operations.publish(temporary, destination, expectedHash);
    published = true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the archive write or flush failure */ }
    }
    if (!published) {
      try { fs.unlinkSync(temporary); } catch { /* remove only this exact temporary path */ }
    }
  }
}

export function jobCanBeArchived(job: ExecutionJob): boolean {
  if (!job.finishedAt || job.tempOwnership !== null || job.state === "interrupted") return false;
  if (!["succeeded", "cancelled", "timed_out"].includes(job.state) && !(job.state === "failed" && (job.startedAt === null || ["NONZERO_EXIT", "AUTHORIZATION_REVOKED"].includes(job.failureCode ?? "")))) return false;
  if (job.authorization?.type === "git" && (!job.gitResult || job.gitResult.integrity === "unexpected" || job.gitResult.remoteOutcome === "unknown" || job.gitResult.partialSuccessPossible || ["identity_changed", "unavailable"].includes(job.gitResult.confirmation))) return false;
  return true;
}

export const archivedIdempotencyKey = (clientId: string, keyHash: string) => hash(`${clientId}\0${keyHash}`);
