import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { RepositoryIdentity } from "./repository-identity.js";

/** Cross-Bridge lock: worktrees sharing Git metadata share this authority. */
export function repositoryWriteKey(repository: RepositoryIdentity): string {
  return createHash("sha256").update(repository.commonGitDirectory.toLowerCase())
    .update(repository.fileIdentities.commonGitDirectory).digest("hex");
}

export function acquireRepositoryWriteLock(repository: RepositoryIdentity, jobId: string): () => void {
  const directory = ensureDir(path.join(getStateDir(), "execution", "repository-locks"));
  const file = path.join(directory, `${repositoryWriteKey(repository)}.lock`);
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync.native(directory) !== directory) {
    throw new Error("REPOSITORY_LOCK_INVALID");
  }
  const content = JSON.stringify({ version: 1, pid: process.pid, jobId, repositoryIdentity: repository.identity,
    createdAt: new Date().toISOString() });
  try { fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("REPOSITORY_BUSY"); }
  // Never steal an unknown/stale lock. A local operator must reconcile it after
  // confirming the recorded owner and controlled process tree have stopped.
  return () => {
    try {
      if (!fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, "utf8") === content) fs.unlinkSync(file);
    } catch { /* fail closed: preserve evidence if authority changed */ }
  };
}
