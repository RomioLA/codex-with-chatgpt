import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import { resolveRepositoryIdentity } from "./repository-identity.js";
import { repositoryWriteKey, acquireRepositoryWriteLock } from "./repository-write-lock.js";
import { confirmGitWriteState, type GitWriteBefore } from "../git-write/index.js";

type Hold = { version: 1; workspaceId: string; repositoryIdentity: string; repositoryPath: string; jobId: string; reason: string; before: GitWriteBefore; createdAt: string };
function fileFor(workspace: Workspace, repositoryPath: string) {
  const repository = resolveRepositoryIdentity(workspace, repositoryPath);
  const directory = ensureDir(path.join(getStateDir(), "execution", "git-review"));
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) throw new Error("GIT_REVIEW_CORRUPT");
  return { repository, file: path.join(directory, `${repositoryWriteKey(repository)}.json`) };
}
function read(file: string): Hold | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error("GIT_REVIEW_CORRUPT");
    const hold = JSON.parse(fs.readFileSync(file, "utf8"));
    if (hold.version !== 1 || !/^[A-Za-z0-9_-]{24,64}$/.test(hold.jobId) || !hold.before || !/^[a-f0-9]{64}$/.test(hold.repositoryIdentity)) throw new Error("GIT_REVIEW_CORRUPT");
    return hold;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function hasGitReviewHold(workspace: Workspace, repositoryPath: string): boolean { return read(fileFor(workspace, repositoryPath).file) !== null; }
export function requireGitReview(workspace: Workspace, repositoryPath: string, jobId: string, reason: string, before: GitWriteBefore): void {
  const { repository, file } = fileFor(workspace, repositoryPath);
  if (read(file)) return;
  const hold: Hold = { version: 1, workspaceId: workspace.id, repositoryIdentity: repository.identity, repositoryPath, jobId, reason, before, createdAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(hold), { flag: "wx", mode: 0o600 });
}
export function previewGitReview(workspace: Workspace, repositoryPath: string) {
  const { repository, file } = fileFor(workspace, repositoryPath); const hold = read(file);
  if (!hold) return null;
  if (hold.workspaceId !== workspace.id || hold.repositoryIdentity !== repository.identity) throw new Error("GIT_REVIEW_OWNER_MISMATCH");
  const observed = confirmGitWriteState(workspace, repositoryPath, hold.before);
  if (observed.state === "unavailable" || observed.state === "identity_changed") throw new Error("GIT_REVIEW_STATE_UNAVAILABLE");
  const digest = createHash("sha256").update(JSON.stringify({ hold, observed })).digest("hex");
  return { hold, observed, digest };
}
export function acknowledgeGitReview(workspace: Workspace, repositoryPath: string, jobId: string, digest: string, localApproval: true): void {
  if (localApproval !== true) throw new Error("GIT_REVIEW_APPROVAL_REQUIRED");
  const { repository, file } = fileFor(workspace, repositoryPath);
  const release = acquireRepositoryWriteLock(repository, "local-git-review");
  try {
    const preview = previewGitReview(workspace, repositoryPath);
    if (!preview || preview.hold.jobId !== jobId || preview.digest !== digest) throw new Error("GIT_REVIEW_DIGEST_MISMATCH");
    const archive = `${file}.${jobId}.${digest}.acknowledged`;
    if (fs.existsSync(archive)) throw new Error("GIT_REVIEW_CORRUPT");
    fs.renameSync(file, archive);
  } finally { release(); }
}
