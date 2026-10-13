import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExecutionJob } from "./job-types.js";

const MAX_ARCHIVE_BYTES = 3 * 1024 * 1024;
type Kind = "jobs" | "idempotency" | "level3" | "git-plans";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

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

export function archiveRecord(root: string, kind: Kind, key: string, value: unknown): void {
  const previous = readArchivedRecord(root, kind, key);
  if (previous !== null) {
    if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error("ARCHIVE_CONFLICT");
    return;
  }
  const bytes = JSON.stringify({ version: 1, kind, key, digest: hash(JSON.stringify(value)), value });
  if (Buffer.byteLength(bytes) > MAX_ARCHIVE_BYTES) throw new Error("ARCHIVE_TOO_LARGE");
  fs.writeFileSync(archivePath(root, kind, key, true), bytes, { mode: 0o600, flag: "wx" });
}

export function jobCanBeArchived(job: ExecutionJob): boolean {
  if (!job.finishedAt || job.tempOwnership !== null || job.state === "interrupted") return false;
  if (!["succeeded", "cancelled", "timed_out"].includes(job.state) && !(job.state === "failed" && (job.startedAt === null || ["NONZERO_EXIT", "AUTHORIZATION_REVOKED"].includes(job.failureCode ?? "")))) return false;
  if (job.authorization?.type === "git" && (!job.gitResult || job.gitResult.integrity === "unexpected" || job.gitResult.remoteOutcome === "unknown" || job.gitResult.partialSuccessPossible || ["identity_changed", "unavailable"].includes(job.gitResult.confirmation))) return false;
  return true;
}

export const archivedIdempotencyKey = (clientId: string, keyHash: string) => hash(`${clientId}\0${keyHash}`);
