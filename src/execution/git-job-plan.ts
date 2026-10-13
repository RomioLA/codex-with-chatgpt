import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import { planGitWrite, type GitWriteOperation, type GitWritePlan } from "../git-write/index.js";
import type { GenericCommand } from "./helper-protocol.js";

export const MAX_GIT_JOB_PLANS = 256;
const MAX_GIT_PLAN_BYTES = 1024 * 1024;

function filePath(workspaceId: string, requestId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId) || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) throw new Error("INVALID_ARGUMENTS");
  const directory = ensureDir(path.join(getStateDir(), "execution", "git-plans", workspaceId));
  if (fs.realpathSync.native(directory) !== directory || fs.lstatSync(directory).isSymbolicLink()) throw new Error("V13_AUTHORIZATION_DENIED");
  return path.join(directory, `${requestId}.json`);
}
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function readPlan(workspace: Workspace, requestId: string, digest: string): { plan: GitWritePlan; file: string; identity: string } {
  const file = filePath(workspace.id, requestId);
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024n * 1024n) throw new Error("V13_AUTHORIZATION_DENIED");
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== digest) throw new Error("V13_AUTHORIZATION_DENIED");
  return { plan: JSON.parse(bytes.toString("utf8")) as GitWritePlan, file, identity: `${stat.dev.toString(16)}:${stat.ino.toString(16)}` };
}

export function createGitJobPlan(workspace: Workspace, repositoryPath: string, operation: GitWriteOperation) {
  const requestId = randomBytes(24).toString("base64url");
  const file = filePath(workspace.id, requestId);
  const lock = path.join(path.dirname(file), "plans.lock");
  const owner = JSON.stringify({ pid: process.pid, nonce: requestId });
  try { fs.writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); }
  catch { throw new Error("GIT_PLAN_STORE_BUSY"); }
  try {
    let count = 0;
    const directory = fs.opendirSync(path.dirname(file));
    try {
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (entry.name === "plans.lock") continue;
        if (!entry.isFile() || !/^[A-Za-z0-9_-]{24,64}\.json$/.test(entry.name)) throw new Error("V13_AUTHORIZATION_DENIED");
        if (++count >= MAX_GIT_JOB_PLANS) throw new Error("GIT_PLAN_STORE_FULL");
      }
    } finally { directory.closeSync(); }
    const plan = planGitWrite(workspace, repositoryPath, operation);
    const bytes = Buffer.from(JSON.stringify(plan));
    if (bytes.length > MAX_GIT_PLAN_BYTES) throw new Error("INVALID_ARGUMENTS");
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    return { requestId, digest: sha(bytes), plan };
  } finally {
    // Never remove a replaced or unknown owner, and never prune audit plans.
    try {
      if (!fs.lstatSync(lock).isSymbolicLink() && fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock);
    } catch { /* Preserve unconfirmed ownership for local reconciliation. */ }
  }
}

export function readGitJobPlan(workspace: Workspace, requestId: string, digest: string): GitWritePlan {
  return readPlan(workspace, requestId, digest).plan;
}

export function resolveGitJobPlan(workspace: Workspace, requestId: string, digest: string) {
  const original = readPlan(workspace, requestId, digest);
  const plan = planGitWrite(workspace, original.plan.repository.workspaceRelativePath, original.plan.operation);
  if (plan.digest !== original.plan.digest) throw new Error("V13_AUTHORIZATION_DENIED");
  const executable = plan.materials.find((material) => material.path.toLowerCase() === plan.executable.toLowerCase());
  if (!executable) throw new Error("V13_AUTHORIZATION_DENIED");
  const genericCommand: GenericCommand = {
    mode: "direct", executable: plan.executable, executableFileIdentity: executable.fileIdentity, executableHash: executable.hash,
    args: [...plan.args], cwd: plan.repository.canonicalPath, cwdFileIdentity: plan.repository.fileIdentities.repository,
    approvalManifest: original.file, approvalManifestFileIdentity: original.identity, approvalManifestHash: digest,
    materials: plan.materials.filter((material) => material !== executable),
  };
  return { repository: plan.repository, genericCommand, plan };
}
