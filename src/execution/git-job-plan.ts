import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveTrustedRuntime } from "./runtime-discovery.js";
import { readFileMaterial } from "../git-write/security.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import {
  planGitWrite,
  type GitWriteOperation,
  type GitWritePlan,
  type GitWritePlanAuthorization,
} from "../git-write/index.js";
import type { GenericCommand } from "./helper-protocol.js";
import type { ExecutionJob } from "./job-types.js";
import { archiveRecord, readArchivedRecord, jobCanBeArchived } from "./record-archive.js";

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
  if (!fs.existsSync(file)) {
    const archived = readArchivedRecord<{digest: string; plan: GitWritePlan}>(path.dirname(file), "git-plans", requestId);
    if (!archived || archived.digest !== digest || sha(Buffer.from(JSON.stringify(archived.plan))) !== digest) throw new Error("V13_AUTHORIZATION_DENIED");
    return { plan: archived.plan, file, identity: "0:0" };
  }
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024n * 1024n) throw new Error("V13_AUTHORIZATION_DENIED");
  const bytes = fs.readFileSync(file);
  if (sha(bytes) !== digest) throw new Error("V13_AUTHORIZATION_DENIED");
  return { plan: JSON.parse(bytes.toString("utf8")) as GitWritePlan, file, identity: `${stat.dev.toString(16)}:${stat.ino.toString(16)}` };
}

export function archiveGitJobPlan(workspace: Workspace, job: ExecutionJob): void {
  if (job.workspaceId !== workspace.id || job.authorization?.type !== "git" || !jobCanBeArchived(job)) return;
  const { requestId, digest } = job.authorization;
  const expectedAuthorization = job.authorization?.type === "git"
    ? job.authorization.source === "full_access"
      ? {
          source: "full_access" as const,
          permissionMode: job.authorization.permissionMode,
          sessionGrantFingerprint: job.authorization.sessionGrantFingerprint,
          sessionGrantId: job.authorization.sessionGrantId,
        }
      : { source: "repository_approval" as const }
    : undefined;
  const original = readPlan(workspace, requestId, digest);
  if (!fs.existsSync(original.file)) return;
  if (expectedAuthorization?.source === "full_access" &&
      (!original.plan.authorization || original.plan.authorization.source !== "full_access" ||
       original.plan.authorization.sessionGrantFingerprint !== expectedAuthorization.sessionGrantFingerprint ||
       original.plan.authorization.sessionGrantId !== expectedAuthorization.sessionGrantId)) {
    throw new Error("V13_AUTHORIZATION_DENIED");
  }
  if (expectedAuthorization?.source === "repository_approval" &&
      original.plan.authorization?.source === "full_access") throw new Error("V13_AUTHORIZATION_DENIED");
  if (original.plan.repository.identity !== job.repositoryIdentity) throw new Error("V13_AUTHORIZATION_DENIED");
  archiveRecord(path.dirname(original.file), "git-plans", requestId, { digest, plan: original.plan });
  const archive = path.join(path.dirname(original.file), ".archive", "git-plans", requestId.slice(0, 2), `${requestId}.material.json`);
  // Move one exact, verified file. Existing material is preserved after a crash.
  if (fs.existsSync(archive)) {
    if (sha(fs.readFileSync(archive)) !== digest) throw new Error("ARCHIVE_CONFLICT");
    return;
  }
  fs.renameSync(original.file, archive);
}

export function createGitJobPlan(
  workspace: Workspace,
  repositoryPath: string,
  operation: GitWriteOperation,
  authorization?: GitWritePlanAuthorization,
) {
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
        if (entry.name === "plans.lock" || entry.name === ".archive" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (!entry.isFile() || !/^[A-Za-z0-9_-]{24,64}\.json$/.test(entry.name)) throw new Error("V13_AUTHORIZATION_DENIED");
        if (++count >= MAX_GIT_JOB_PLANS) throw new Error("GIT_PLAN_STORE_FULL");
      }
    } finally { directory.closeSync(); }
    const plan = planGitWrite(workspace, repositoryPath, operation, authorization);
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

export function readGitJobPlan(
  workspace: Workspace,
  requestId: string,
  digest: string,
  expectedAuthorization?: GitWritePlanAuthorization,
): GitWritePlan {
  const plan = readPlan(workspace, requestId, digest).plan;
  if (expectedAuthorization?.source === "full_access") {
    if (!plan.authorization || plan.authorization.source !== "full_access" ||
        plan.authorization.permissionMode !== expectedAuthorization.permissionMode ||
        plan.authorization.sessionGrantFingerprint !== expectedAuthorization.sessionGrantFingerprint ||
        plan.authorization.sessionGrantId !== expectedAuthorization.sessionGrantId) {
      throw new Error("V13_AUTHORIZATION_DENIED");
    }
  } else if (expectedAuthorization?.source === "repository_approval" &&
      plan.authorization?.source === "full_access") {
    throw new Error("V13_AUTHORIZATION_DENIED");
  }
  return plan;
}

export function resolveGitJobPlan(
  workspace: Workspace,
  requestId: string,
  digest: string,
  expectedAuthorization?: GitWritePlanAuthorization,
) {
  const original = readPlan(workspace, requestId, digest);
  if (original.identity === "0:0") throw new Error("V13_AUTHORIZATION_DENIED");
  const storedAuthorization = original.plan.authorization;
  if (expectedAuthorization?.source === "full_access") {
    if (!storedAuthorization || storedAuthorization.source !== "full_access" ||
        storedAuthorization.permissionMode !== expectedAuthorization.permissionMode ||
        storedAuthorization.sessionGrantFingerprint !== expectedAuthorization.sessionGrantFingerprint ||
        storedAuthorization.sessionGrantId !== expectedAuthorization.sessionGrantId) {
      throw new Error("V13_AUTHORIZATION_DENIED");
    }
  } else if (expectedAuthorization?.source === "repository_approval" &&
      storedAuthorization?.source === "full_access") {
    throw new Error("V13_AUTHORIZATION_DENIED");
  }
  const plan = planGitWrite(
    workspace,
    original.plan.repository.workspaceRelativePath,
    original.plan.operation,
    storedAuthorization,
  );
  if (plan.digest !== original.plan.digest) throw new Error("V13_AUTHORIZATION_DENIED");
  const executable = plan.materials.find((material) => material.path.toLowerCase() === plan.executable.toLowerCase());
  if (!executable) throw new Error("V13_AUTHORIZATION_DENIED");
  const genericCommand: GenericCommand = {
    mode: "direct", executable: plan.executable, executableFileIdentity: executable.fileIdentity, executableHash: executable.hash,
    args: [...plan.args], cwd: plan.repository.canonicalPath, cwdFileIdentity: plan.repository.fileIdentities.repository,
    approvalManifest: original.file, approvalManifestFileIdentity: original.identity, approvalManifestHash: digest,
    materials: plan.materials.filter((material) => material !== executable),
    launchSnapshots: plan.snapshotMaterials,
  };
  if (plan.operation.kind === "commit") {
    if (!plan.commitBinding) throw new Error("V13_AUTHORIZATION_DENIED");
    const runtime = resolveTrustedRuntime("npm");
    const module = fileURLToPath(import.meta.url);
    const entry = readFileMaterial(path.resolve(path.dirname(module), path.extname(module) === ".ts" ? "../../dist/execution/git-commit-entry.js" : "git-commit-entry.js"));
    genericCommand.executable = runtime.nodeExecutable;
    genericCommand.executableFileIdentity = runtime.nodeFileIdentity;
    genericCommand.executableHash = runtime.nodeHash;
    genericCommand.args = [entry.path, original.file];
    genericCommand.materials = [...plan.materials, entry];
  }
  return { repository: plan.repository, genericCommand, plan };
}
