import { createHash, randomBytes } from "node:crypto";
import { getStateDir, ensureDir } from "../config/paths.js";
import fs from "node:fs";
import path from "node:path";
import { resolveRepositoryIdentity, RepositoryIdentityError } from "../execution/repository-identity.js";
import { IgnoreRules } from "../workspace/ignore.js";
import type { Workspace } from "../workspace/manager.js";
import {
  findGitRepositoryApproval,
  gitWritePolicyHash,
  type GitRepositoryApproval,
  type GitWriteCredentialHelper,
  type GitWriteRemoteApproval,
} from "./registry.js";
import {
  assertNoReparsePath,
  buildCommonGitArgs,
  captureGitBundleCriticalMaterials,
  configFilesAsMaterials,
  configUserValue,
  decodeGitPaths,
  GIT_WRITE_CLEAR_ENVIRONMENT,
  getGitWriteEnvironment,
  loadGitConfig,
  MAX_GIT_MATERIALS,
  makeSourceMaterials,
  makeMaterials,
  readFileMaterial,
  remoteValues,
  requireGitSuccess,
  resolveGitExecutable,
  runVerifiedGit,
  validateGitConfig,
  verifyExecutable,
  type GitConfigEntry,
  type GitExecutable,
} from "./security.js";
import {
  GitWriteError,
  type ConfirmGitWriteStateResult,
  type GitWriteBefore,
  type GitWriteMaterial,
  type GitWriteOperation,
  type GitWritePlan,
  type GitWritePlanAuthorization,
  type GitWriteStateSnapshot,
} from "./types.js";

const HEX = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_ADD_PATHS = 256;
const MAX_ADD_PATH_BYTES = 24 * 1024;

type GitWritePolicy = Pick<GitRepositoryApproval,
  "allowedOperations" | "allowedBranches" | "allowedRemotes" | "approvedProxy" |
  "credentialHelper" | "author" | "bundleMaterials">;

function norm(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  return value;
}

function validExpectedState(operation: GitWriteOperation): void {
  if (operation.expectedHead !== null && !HEX.test(operation.expectedHead)) throw new GitWriteError("INVALID_ARGUMENTS");
  if (operation.expectedBranch !== null && !validBranchName(operation.expectedBranch)) throw new GitWriteError("INVALID_ARGUMENTS");
  if (operation.expectedStatusHash !== undefined &&
      (typeof operation.expectedStatusHash !== "string" || !/^[a-f0-9]{64}$/i.test(operation.expectedStatusHash))) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
}

function validBranchName(value: unknown): value is string {
  return typeof value === "string" && BRANCH_NAME.test(value) && !value.includes("..") &&
    !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("@{");
}

function validateOperationShape(input: unknown): asserts input is GitWriteOperation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GitWriteError("INVALID_ARGUMENTS");
  const op = input as Partial<GitWriteOperation>;
  if (typeof op.kind !== "string") throw new GitWriteError("INVALID_ARGUMENTS");
  switch (op.kind) {
    case "add":
      if (!Array.isArray(op.paths) || op.paths.length < 1 || op.paths.length > 64 || op.paths.some((item) => typeof item !== "string")) {
        throw new GitWriteError("INVALID_ARGUMENTS");
      }
      break;
    case "commit":
      requireString(op.message, 8192);
      break;
    case "push":
      requireString(op.remote, 64);
      requireString(op.branch, 128);
      break;
    case "fetch":
      requireString(op.remote, 64);
      if (op.branches !== undefined && (!Array.isArray(op.branches) || op.branches.length < 1 ||
          op.branches.length > 128 || op.branches.some((item) => typeof item !== "string"))) {
        throw new GitWriteError("INVALID_ARGUMENTS");
      }
      break;
    case "branch_list":
      break;
    case "branch_create":
      requireString(op.name, 128);
      if (op.startPoint !== undefined) requireString(op.startPoint, 128);
      break;
    case "switch":
      requireString(op.name, 128);
      break;
    case "pull_ff_only":
      requireString(op.remote, 64);
      requireString(op.branch, 128);
      break;
    default:
      throw new GitWriteError("INVALID_ARGUMENTS");
  }
  validExpectedState(input as GitWriteOperation);
}

function runText(executable: GitExecutable, cwd: string, args: string[], common: string[]): string {
  const output = requireGitSuccess(runVerifiedGit(executable, cwd, [...common, ...args], { maxBuffer: 64 * 1024 }));
  return output.toString("utf8").replace(/\r?\n$/, "");
}

function reviewedIndexTree(repository: ReturnType<typeof resolveRepositoryIdentity>, executable: GitExecutable, config: GitConfigEntry[]) {
  const source = readFileMaterial(path.join(repository.gitDirectory, "index"));
  const bytes = fs.readFileSync(source.path);
  if (sha256(bytes) !== source.hash) throw new GitWriteError("EXPECTED_STATE_CHANGED");
  const directory = assertNoReparsePath(ensureDir(path.join(getStateDir(), "execution", "git-index-snapshots")));
  const temporary = path.join(directory, `${randomBytes(24).toString("hex")}.index`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try {
    const result = requireGitSuccess(runVerifiedGit(executable, repository.canonicalPath,
      [...buildCommonGitArgs(config, null), "write-tree"], { maxBuffer: 4096, indexFile: temporary }));
    return { tree: result.toString("utf8").trim(), source };
  } finally {
    // One exact per-call scratch file, created with wx beneath protected state.
    // No directory/unknown-file pruning; interrupted artifacts remain evidence.
    try { if (fs.lstatSync(temporary).isFile() && !fs.lstatSync(temporary).isSymbolicLink() && fs.realpathSync.native(temporary).toLowerCase() === temporary.toLowerCase()) fs.unlinkSync(temporary); } catch { /* preserve unconfirmed scratch ownership */ }
  }
}

function stateSnapshot(
  repositoryIdentity: string,
  executable: GitExecutable,
  root: string,
  config: GitConfigEntry[],
  helperCommand: string | null,
): GitWriteStateSnapshot {
  const common = buildCommonGitArgs(config, helperCommand);
  const headResult = runVerifiedGit(executable, root, [...common, "rev-parse", "--verify", "--quiet", "HEAD"], { maxBuffer: 4096 });
  if (headResult.code !== 0 && headResult.code !== 1) throw new GitWriteError("STATE_UNAVAILABLE");
  const headText = headResult.stdout.toString("utf8").trim();
  const head = headText || null;
  if (head !== null && !HEX.test(head)) throw new GitWriteError("STATE_UNAVAILABLE");
  const branchResult = runVerifiedGit(executable, root, [...common, "symbolic-ref", "--short", "-q", "HEAD"], { maxBuffer: 4096 });
  if (branchResult.code !== 0 && branchResult.code !== 1) throw new GitWriteError("STATE_UNAVAILABLE");
  const branchText = branchResult.stdout.toString("utf8").replace(/\r?\n$/, "");
  const branch = branchText || null;
  if (branch !== null && !validBranchName(branch)) throw new GitWriteError("STATE_UNAVAILABLE");
  const status = requireGitSuccess(runVerifiedGit(executable, root, [...common, "status", "--porcelain=v2", "-z", "--branch"]));
  const refs = requireGitSuccess(runVerifiedGit(executable, root, [
    ...common,
    "for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/heads", "refs/remotes",
  ]));
  return {
    repositoryIdentity,
    head,
    branch,
    statusHash: sha256(status),
    refsHash: sha256(refs),
  };
}

function verifyIdentityWithExecutable(
  repository: ReturnType<typeof resolveRepositoryIdentity>,
  executable: GitExecutable,
  config: GitConfigEntry[],
): void {
  const common = buildCommonGitArgs(config, null);
  const top = runText(executable, repository.canonicalPath, ["rev-parse", "--show-toplevel"], common);
  const gitDir = runText(executable, repository.canonicalPath, ["rev-parse", "--absolute-git-dir"], common);
  const commonDir = runText(executable, repository.canonicalPath, ["rev-parse", "--git-common-dir"], common);
  try {
    const canonicalTop = fs.realpathSync.native(path.resolve(top));
    const canonicalGitDir = fs.realpathSync.native(path.resolve(repository.canonicalPath, gitDir));
    const canonicalCommon = fs.realpathSync.native(path.resolve(repository.canonicalPath, commonDir));
    if (norm(canonicalTop) !== norm(repository.canonicalPath) ||
        norm(canonicalGitDir) !== norm(repository.gitDirectory) ||
        norm(canonicalCommon) !== norm(repository.commonGitDirectory)) throw new Error("mismatch");
  } catch {
    throw new GitWriteError("INVALID_REPOSITORY");
  }
}

function requireAllowedOperation(approval: GitWritePolicy, kind: GitWriteOperation["kind"]): void {
  if (!approval.allowedOperations.includes(kind)) throw new GitWriteError("NOT_APPROVED");
}

function requireAllowedBranch(approval: GitWritePolicy, value: string): void {
  if (!validBranchName(value) || !approval.allowedBranches.includes(value)) throw new GitWriteError("NOT_APPROVED");
}

function approvedRemote(
  approval: GitWritePolicy,
  config: GitConfigEntry[],
  requested: string,
): { name: string; url: string } {
  if (!REMOTE_NAME.test(requested)) throw new GitWriteError("INVALID_REMOTE");
  const remote = approval.allowedRemotes.find((item) => item.name.toLowerCase() === requested.toLowerCase());
  if (!remote) throw new GitWriteError("NOT_APPROVED");
  const urls = remoteValues(config, remote.name, "url");
  const pushUrls = remoteValues(config, remote.name, "pushurl");
  if (urls.length !== 1 || urls[0] !== remote.url || pushUrls.length > 1 ||
      (pushUrls.length === 1 && pushUrls[0] !== remote.url)) throw new GitWriteError("INVALID_REMOTE");
  return { name: remote.name, url: remote.url };
}

function credentialHelperCommand(approval: GitWritePolicy, needsRemote: boolean): string | null {
  if (!needsRemote || !approval.credentialHelper) return null;
  const current = fs.realpathSync.native(approval.credentialHelper.path).replace(/\\/g, "/");
  if (/[\0\r\n"'`$&|<>^%!;(){}\[\]]/.test(current)) throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
  return `"${current}"`;
}

function exactHttpsRemoteUrl(value: string): boolean {
  if (value.length > 2048 || /[\0\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 &&
      parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" &&
      parsed.href === value;
  } catch {
    return false;
  }
}

function currentFullAccessRemote(config: GitConfigEntry[], name: string): GitWriteRemoteApproval {
  if (!REMOTE_NAME.test(name)) throw new GitWriteError("INVALID_REMOTE");
  const urls = remoteValues(config, name, "url");
  const pushUrls = remoteValues(config, name, "pushurl");
  if (urls.length !== 1 || pushUrls.length > 1 ||
      (pushUrls.length === 1 && pushUrls[0] !== urls[0]) ||
      !exactHttpsRemoteUrl(urls[0])) throw new GitWriteError("INVALID_REMOTE");
  return { name, url: urls[0] };
}

function normalizeFullAccessProxy(value: string): string {
  if (value.length > 2048 || value.trim() !== value || /[\0\r\n]/.test(value)) {
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || (parsed.port !== "" && Number(parsed.port) === 0)) {
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  return parsed.origin;
}

function fullAccessHttpsProxy(): string | null {
  for (const names of [
    ["HTTPS_PROXY", "https_proxy"],
    ["HTTP_PROXY", "http_proxy"],
    ["ALL_PROXY", "all_proxy"],
  ]) {
    const configured = names
      .map((name) => process.env[name])
      .filter((value): value is string => value !== undefined && value !== "");
    if (configured.length === 0) continue;
    const normalized = [...new Set(configured.map(normalizeFullAccessProxy))];
    if (normalized.length !== 1) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    return normalized[0]!;
  }
  return null;
}
function gitBundleRoot(executable: string): string {
  const canonical = path.resolve(executable).replace(/\\/g, "/");
  const lower = canonical.toLowerCase();
  if (lower.endsWith("/mingw64/bin/git.exe")) return path.dirname(path.dirname(path.dirname(canonical)));
  if (lower.endsWith("/bin/git.exe") || lower.endsWith("/cmd/git.exe")) return path.dirname(path.dirname(canonical));
  throw new GitWriteError("INVALID_ARGUMENTS");
}

function fullAccessCredentialHelper(
  executable: GitExecutable,
  config: GitConfigEntry[],
  needsRemote: boolean,
): GitWriteCredentialHelper | null {
  if (!needsRemote) return null;
  const configured = config.filter((entry) => entry.key.toLowerCase() === "credential.helper")
    .map((entry) => entry.value.trim()).filter(Boolean);
  const expected = path.join(gitBundleRoot(executable.path), "mingw64", "bin", "git-credential-manager.exe");
  if (configured.length === 0) {
    try {
      return readFileMaterial(expected);
    } catch {
      return null;
    }
  }
  const requested = configured[configured.length - 1];
  const recognized = ["manager", "manager-core"].includes(requested.toLowerCase()) ||
    path.isAbsolute(requested) && norm(path.resolve(requested)) === norm(path.resolve(expected));
  if (configured.length > 1 || !recognized) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  try {
    return readFileMaterial(expected);
  } catch {
    throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
  }
}

function fullAccessAuthor(config: GitConfigEntry[], shouldCommit: boolean): { name: string; email: string } | null {
  const name = configUserValue(config, "user.name");
  const email = configUserValue(config, "user.email");
  if (!name || !email) {
    if (shouldCommit) throw new GitWriteError("INVALID_ARGUMENTS");
    return null;
  }
  if (name.length > 256 || email.length > 320 || /[\0\r\n]/.test(name) || /[\0\r\n]/.test(email)) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  return { name, email };
}

function fullAccessBranches(operation: GitWriteOperation): string[] {
  const branches = new Set<string>();
  if (operation.expectedBranch) branches.add(operation.expectedBranch);
  switch (operation.kind) {
    case "push":
    case "pull_ff_only":
      branches.add(operation.branch);
      break;
    case "fetch":
      for (const branch of operation.branches ?? []) branches.add(branch);
      break;
    case "branch_create":
      branches.add(operation.name);
      if (operation.startPoint) branches.add(operation.startPoint);
      break;
    case "switch":
      branches.add(operation.name);
      break;
  }
  return [...branches];
}

function fullAccessGitPolicy(
  repository: ReturnType<typeof resolveRepositoryIdentity>,
  executable: GitExecutable,
  config: GitConfigEntry[],
  operation: GitWriteOperation,
): GitWritePolicy {
  const remoteName = "remote" in operation ? operation.remote : null;
  const fullAccessRemote = remoteName ? currentFullAccessRemote(config, remoteName) : null;
  const approvedProxy = fullAccessRemote ? fullAccessHttpsProxy() : null;
  const branches = fullAccessBranches(operation);
  const common = buildCommonGitArgs(config, null);
  for (const branch of branches) {
    if (branch === "HEAD") continue;
    if (!validBranchName(branch) || branch.includes("..") || branch.includes("//") ||
        branch.endsWith("/") || branch.endsWith(".") || branch.includes("@{")) {
      throw new GitWriteError("INVALID_BRANCH");
    }
    const check = runVerifiedGit(executable, repository.canonicalPath, [
      ...common, "check-ref-format", "refs/heads/" + branch,
    ], { maxBuffer: 4096 });
    if (check.code !== 0) throw new GitWriteError("INVALID_BRANCH");
  }
  return {
    allowedOperations: [operation.kind],
    allowedBranches: branches,
    allowedRemotes: fullAccessRemote ? [fullAccessRemote] : [],
    approvedProxy,
    credentialHelper: fullAccessCredentialHelper(executable, config, remoteName !== null),
    author: fullAccessAuthor(config, operation.kind === "commit"),
    bundleMaterials: captureGitBundleCriticalMaterials(executable, repository.canonicalPath),
  };
}

function assertExpectedState(operation: GitWriteOperation, state: GitWriteStateSnapshot): void {
  if (state.head !== operation.expectedHead || state.branch !== operation.expectedBranch ||
      (operation.expectedStatusHash !== undefined && state.statusHash !== operation.expectedStatusHash)) {
    throw new GitWriteError("EXPECTED_STATE_CHANGED");
  }
}

function lexicalRepositoryPath(repositoryRoot: string, input: string): string {
  const value = requireString(input, 1024).replace(/\\/g, "/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^workspace:/i.test(value) ||
      value.split("/").some((part) => part === ".." || part === "")) {
    if (value === ".") return "";
    throw new GitWriteError("INVALID_PATH");
  }
  if (value === ".") return "";
  return value;
}

function assertNoPathReparse(repositoryRoot: string, relative: string, allowMissingTail = true): string {
  const absolute = path.resolve(repositoryRoot, ...relative.split("/").filter(Boolean));
  const root = path.resolve(repositoryRoot);
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new GitWriteError("INVALID_PATH");
  return assertNoReparsePath(absolute, allowMissingTail);
}

function isSensitive(workspace: Workspace, repoRules: IgnoreRules, repositoryRoot: string, candidate: string): boolean {
  const repositoryRelative = candidate;
  if (repoRules.isSensitive(repositoryRelative)) return true;
  const absolute = path.resolve(repositoryRoot, ...candidate.split("/"));
  const workspaceRelative = path.relative(workspace.root, absolute).split(path.sep).join("/");
  return workspaceRelative !== "" && workspace.ignoreRules.isSensitive(workspaceRelative);
}

function expandAddPaths(
  workspace: Workspace,
  repositoryPath: string,
  repositoryRoot: string,
  executable: GitExecutable,
  config: GitConfigEntry[],
  operation: Extract<GitWriteOperation, { kind: "add" }>,
): string[] {
  const scopes = operation.paths.map((input) => lexicalRepositoryPath(repositoryRoot, input));
  if (new Set(scopes).size !== scopes.length) throw new GitWriteError("INVALID_PATH");
  const scopeResolved = scopes.map((scope, index) => {
    const source = operation.paths[index];
    try {
      const resolved = workspace.resolveRepositoryScope(repositoryPath, source);
      assertNoPathReparse(repositoryRoot, scope, true);
      const relative = path.relative(repositoryRoot, resolved.abs).split(path.sep).join("/");
      if (relative !== scope) throw new GitWriteError("INVALID_PATH");
      if (isSensitive(workspace, new IgnoreRules(repositoryRoot), repositoryRoot, relative)) {
        throw new GitWriteError("SENSITIVE_PATH");
      }
      return relative;
    } catch (error) {
      if (error instanceof GitWriteError) throw error;
      throw new GitWriteError("INVALID_PATH");
    }
  });
  const common = buildCommonGitArgs(config, null);
  const inventory = decodeGitPaths(requireGitSuccess(runVerifiedGit(executable, repositoryRoot, [
    ...common, "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ])));
  const repoRules = new IgnoreRules(repositoryRoot);
  const selected = new Set<string>();
  for (const candidate of inventory) {
    const rel = candidate.replace(/\\/g, "/");
    if (rel.startsWith("/") || rel.split("/").some((part) => part === ".." || part === "")) continue;
    const inScope = scopeResolved.some((scope) => !scope || rel === scope || rel.startsWith(`${scope}/`));
    if (!inScope || isSensitive(workspace, repoRules, repositoryRoot, rel)) continue;
    try {
      assertNoPathReparse(repositoryRoot, rel, true);
      const absolute = path.resolve(repositoryRoot, ...rel.split("/"));
      if (fs.existsSync(absolute) && !fs.lstatSync(absolute).isFile()) continue;
      selected.add(rel);
    } catch (error) {
      // A directory add skips links and other reparse entries. A direct path
      // that is a reparse point is rejected instead of silently staged.
      const direct = scopeResolved.some((scope) => scope === rel);
      if (direct) throw error instanceof GitWriteError ? error : new GitWriteError("REPARSE_POINT");
    }
  }
  if (selected.size === 0) throw new GitWriteError("INVALID_PATH");
  const paths = [...selected].sort((a, b) => a.localeCompare(b));
  const bytes = paths.reduce((sum, item) => sum + Buffer.byteLength(item, "utf8") + 1, 0);
  if (paths.length > MAX_ADD_PATHS || bytes > MAX_ADD_PATH_BYTES) throw new GitWriteError("INVALID_PATH");
  return paths;
}

function requireRemoteBranches(approval: GitWritePolicy, requested: string[] | undefined): string[] {
  const branches = requested ?? approval.allowedBranches;
  if (branches.length < 1 || new Set(branches).size !== branches.length) throw new GitWriteError("INVALID_BRANCH");
  for (const branch of branches) requireAllowedBranch(approval, branch);
  return [...branches];
}

function validateBranchExists(
  executable: GitExecutable,
  root: string,
  config: GitConfigEntry[],
  branch: string,
): boolean {
  const common = buildCommonGitArgs(config, null);
  const result = runVerifiedGit(executable, root, [...common, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { maxBuffer: 4096 });
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new GitWriteError("STATE_UNAVAILABLE");
}

function validateStartPoint(
  executable: GitExecutable,
  root: string,
  config: GitConfigEntry[],
  approval: GitWritePolicy,
  startPoint: string,
): string {
  if (startPoint === "HEAD") return "HEAD";
  if (validBranchName(startPoint) && approval.allowedBranches.includes(startPoint)) {
    if (!validateBranchExists(executable, root, config, startPoint)) throw new GitWriteError("INVALID_BRANCH");
    return `refs/heads/${startPoint}`;
  }
  if (HEX.test(startPoint)) {
    const common = buildCommonGitArgs(config, null);
    const result = runVerifiedGit(executable, root, [...common, "cat-file", "-e", `${startPoint}^{commit}`], { maxBuffer: 4096 });
    if (result.code === 0) return startPoint;
  }
  throw new GitWriteError("INVALID_BRANCH");
}

function validateStagedCommit(
  workspace: Workspace,
  root: string,
  executable: GitExecutable,
  config: GitConfigEntry[],
): void {
  const common = buildCommonGitArgs(config, null);
  const unmerged = requireGitSuccess(runVerifiedGit(executable, root, [
    ...common, "ls-files", "--unmerged", "-z",
  ]));
  if (unmerged.byteLength > 0) throw new GitWriteError("INVALID_ARGUMENTS");
  const staged = decodeGitPaths(requireGitSuccess(runVerifiedGit(executable, root, [
    ...common, "diff", "--cached", "--name-only", "--no-renames", "-z",
  ])));
  if (staged.length === 0) throw new GitWriteError("INVALID_ARGUMENTS");
  const repoRules = new IgnoreRules(root);
  for (const candidate of staged) {
    if (candidate.startsWith("/") || candidate.split("/").some((part) => part === ".." || part === "")) {
      throw new GitWriteError("INVALID_PATH");
    }
    if (isSensitive(workspace, repoRules, root, candidate)) throw new GitWriteError("SENSITIVE_PATH");
  }
}

function assertNoUnmergedIndex(executable: GitExecutable, root: string, config: GitConfigEntry[]): void {
  const common = buildCommonGitArgs(config, null);
  const unmerged = requireGitSuccess(runVerifiedGit(executable, root, [
    ...common, "ls-files", "--unmerged", "-z",
  ]));
  if (unmerged.byteLength > 0) throw new GitWriteError("INVALID_ARGUMENTS");
}

function assertCleanWorktree(executable: GitExecutable, root: string, config: GitConfigEntry[]): void {
  const common = buildCommonGitArgs(config, null);
  const status = requireGitSuccess(runVerifiedGit(executable, root, [
    ...common, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none",
  ]));
  if (status.byteLength > 0) throw new GitWriteError("EXPECTED_STATE_CHANGED");
}

function assertNoCommitInProgress(executable: GitExecutable, root: string, config: GitConfigEntry[]): void {
  const common = buildCommonGitArgs(config, null);
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
  for (const marker of markers) {
    const relative = runText(executable, root, ["rev-parse", "--git-path", marker], common);
    if (!relative || relative.includes("\n") || relative.includes("\r")) throw new GitWriteError("STATE_UNAVAILABLE");
    const absolute = path.resolve(root, relative);
    assertNoReparsePath(absolute, true);
    if (fs.existsSync(absolute)) throw new GitWriteError("INVALID_ARGUMENTS");
  }
}

function buildOperationArgs(
  workspace: Workspace,
  repositoryPath: string,
  repositoryRoot: string,
  executable: GitExecutable,
  config: GitConfigEntry[],
  approval: GitWritePolicy,
  operation: GitWriteOperation,
): { args: string[]; remoteBinding: { name: string; url: string } | null; sourcePaths: string[] } {
  const needsRemote = operation.kind === "push" || operation.kind === "fetch" || operation.kind === "pull_ff_only";
  const helperCommand = credentialHelperCommand(approval, needsRemote);
  const common = buildCommonGitArgs(config, helperCommand, needsRemote ? approval.approvedProxy : null);
  const remoteBinding = needsRemote ? approvedRemote(approval, config, operation.remote) : null;
  let args: string[] = [];
  let sourcePaths: string[] = [];
  switch (operation.kind) {
    case "add": {
      const paths = expandAddPaths(workspace, repositoryPath, repositoryRoot, executable, config, operation);
      sourcePaths = paths.map((item) => path.resolve(repositoryRoot, ...item.split("/")));
      args = [...common, "add", "--", ...paths];
      break;
    }
    case "commit": {
      requireString(operation.message, 8192);
      if (/\0/.test(operation.message) || Buffer.byteLength(operation.message, "utf8") > 8192) throw new GitWriteError("INVALID_ARGUMENTS");
      if (!approval.author) throw new GitWriteError("APPROVAL_INVALID");
      validateStagedCommit(workspace, repositoryRoot, executable, config);
      args = [
        ...common,
        "-c", `user.name=${approval.author.name}`,
        "-c", `user.email=${approval.author.email}`,
        "commit", "--no-verify", "--no-gpg-sign", "-m", operation.message,
      ];
      break;
    }
    case "push": {
      requireAllowedBranch(approval, operation.branch);
      if (operation.expectedHead === null || !HEX.test(operation.expectedHead)) throw new GitWriteError("INVALID_ARGUMENTS");
      if (operation.branch !== operation.expectedBranch || !remoteBinding) throw new GitWriteError("INVALID_BRANCH");
      args = [...common, "push", "--porcelain", "--no-follow-tags", "--no-verify", "--signed=false",
        "--recurse-submodules=no", "--", remoteBinding.name,
        `${operation.expectedHead}:refs/heads/${operation.branch}`];
      break;
    }
    case "fetch": {
      const branches = requireRemoteBranches(approval, operation.branches);
      const refspecs = branches.map((branch) => `refs/heads/${branch}:refs/remotes/${remoteBinding!.name}/${branch}`);
      args = [...common, "fetch", "--no-tags", "--no-prune", "--no-write-fetch-head", "--no-recurse-submodules",
        "--", remoteBinding!.name, ...refspecs];
      break;
    }
    case "branch_list": {
      const refs = approval.allowedBranches.map((branch) => `refs/heads/${branch}`);
      if (refs.length === 0) refs.push("refs/heads/__c2c_no_allowed_branches__");
      args = [...common, "for-each-ref", "--format=%(refname:short)%09%(objectname)", ...refs];
      break;
    }
    case "branch_create": {
      requireAllowedBranch(approval, operation.name);
      const startPoint = validateStartPoint(executable, repositoryRoot, config, approval, operation.startPoint ?? "HEAD");
      if (validateBranchExists(executable, repositoryRoot, config, operation.name)) throw new GitWriteError("INVALID_BRANCH");
      args = [...common, "branch", "--no-track", "--", operation.name, startPoint];
      break;
    }
    case "switch": {
      assertCleanWorktree(executable, repositoryRoot, config);
      requireAllowedBranch(approval, operation.name);
      if (!validateBranchExists(executable, repositoryRoot, config, operation.name)) throw new GitWriteError("INVALID_BRANCH");
      args = [...common, "switch", "--no-guess", "--no-recurse-submodules", "--", operation.name];
      break;
    }
    case "pull_ff_only": {
      assertCleanWorktree(executable, repositoryRoot, config);
      requireAllowedBranch(approval, operation.branch);
      if (operation.branch !== operation.expectedBranch || !remoteBinding) throw new GitWriteError("INVALID_BRANCH");
      args = [...common, "pull", "--ff-only", "--no-rebase", "--no-autostash", "--no-tags", "--no-verify", "--no-verify-signatures", "--no-prune", "--no-recurse-submodules",
        "--", remoteBinding.name, `refs/heads/${operation.branch}`];
      break;
    }
  }
  if (args.length > 256) throw new GitWriteError("INVALID_ARGUMENTS");
  return { args, remoteBinding, sourcePaths };
}

function optionalPathStat(input: string): fs.Stats | null {
  const absolute = assertNoReparsePath(input, true);
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GitWriteError("STATE_UNAVAILABLE");
  }
}

/** Reject object stores that can fetch or resolve objects outside the approved repository. */
function assertNoAlternateOrPromisorObjects(repository: ReturnType<typeof resolveRepositoryIdentity>): void {
  const directories = new Map([repository.gitDirectory, repository.commonGitDirectory].map((directory) => [norm(directory), directory]));
  let visited = 0;
  for (const gitDirectory of directories.values()) {
    const objects = path.join(gitDirectory, "objects");
    const objectsStat = optionalPathStat(objects);
    if (!objectsStat) continue;
    if (!objectsStat.isDirectory()) throw new GitWriteError("UNSAFE_GIT_CONFIG");

    const alternates = path.join(objects, "info", "alternates");
    if (optionalPathStat(alternates)) throw new GitWriteError("UNSAFE_GIT_CONFIG");

    const packDirectory = path.join(objects, "pack");
    const packStat = optionalPathStat(packDirectory);
    if (!packStat) continue;
    if (!packStat.isDirectory()) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    let directory: fs.Dir;
    try {
      directory = fs.opendirSync(packDirectory);
    } catch {
      throw new GitWriteError("STATE_UNAVAILABLE");
    }
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        visited += 1;
        if (visited > 100_000) throw new GitWriteError("UNSAFE_GIT_CONFIG");
        if (entry.name.toLowerCase().endsWith(".promisor")) throw new GitWriteError("UNSAFE_GIT_CONFIG");
      }
    } finally {
      try { directory.closeSync(); } catch { /* a completed read may close the handle */ }
    }
  }
}

function captureHeadMaterial(repository: ReturnType<typeof resolveRepositoryIdentity>, state: GitWriteStateSnapshot): GitWriteMaterial {
  const headPath = path.join(repository.gitDirectory, "HEAD");
  assertNoReparsePath(headPath);
  let contents: Buffer;
  try {
    contents = fs.readFileSync(headPath);
  } catch {
    throw new GitWriteError("STATE_UNAVAILABLE");
  }
  const expected = state.branch !== null
    ? `ref: refs/heads/${state.branch}\n`
    : state.head !== null ? `${state.head}\n` : null;
  if (expected === null || contents.toString("utf8") !== expected) throw new GitWriteError("EXPECTED_STATE_CHANGED");
  const material = readFileMaterial(headPath, 4096);
  if (material.hash !== sha256(contents)) throw new GitWriteError("EXPECTED_STATE_CHANGED");
  return material;
}

function collectAttributeMaterials(
  root: string,
  repository: ReturnType<typeof resolveRepositoryIdentity>,
): GitWriteMaterial[] {
  const paths: string[] = [
    path.join(repository.gitDirectory, "info", "attributes"),
    path.join(repository.commonGitDirectory, "info", "attributes"),
  ];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let handle: fs.Dir;
    try {
      handle = fs.opendirSync(directory);
    } catch {
      throw new GitWriteError("STATE_UNAVAILABLE");
    }
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        visited += 1;
        if (visited > 100_000) throw new GitWriteError("UNSAFE_GIT_CONFIG");
        if (entry.name.toLowerCase() === ".git") continue;
        const candidate = path.join(directory, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(candidate);
        } catch {
          throw new GitWriteError("STATE_UNAVAILABLE");
        }
        if (entry.name.toLowerCase() === ".gitattributes") {
          if (stat.isSymbolicLink() || !stat.isFile()) throw new GitWriteError("REPARSE_POINT");
          paths.push(candidate);
          if (paths.length > MAX_GIT_MATERIALS) throw new GitWriteError("UNSAFE_GIT_CONFIG");
          continue;
        }
        if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(candidate);
      }
    } finally {
      try { handle.closeSync(); } catch { /* a completed read may close the handle */ }
    }
  }
  return makeMaterials(paths);
}

function collectIndexMaterial(executable: GitExecutable, root: string, config: GitConfigEntry[]): GitWriteMaterial[] {
  const common = buildCommonGitArgs(config, null);
  const indexPath = runText(executable, root, ["rev-parse", "--git-path", "index"], common);
  if (!indexPath || indexPath.includes("\n") || indexPath.includes("\r")) throw new GitWriteError("STATE_UNAVAILABLE");
  const absolute = path.resolve(root, indexPath);
  if (!fs.existsSync(absolute)) return [];
  return [readFileMaterial(absolute, 128 * 1024 * 1024)];
}

function collectMaterials(
  repository: ReturnType<typeof resolveRepositoryIdentity>,
  executable: GitExecutable,
  config: GitConfigEntry[],
  approval: GitWritePolicy,
  sourcePaths: string[],
  headMaterial: GitWriteMaterial,
  lockHead: boolean,
): { materials: GitWriteMaterial[]; snapshotMaterials: GitWriteMaterial[] } {
  const materials = [
    ...configFilesAsMaterials(config, repository.canonicalPath),
    ...collectAttributeMaterials(repository.canonicalPath, repository),
    ...makeSourceMaterials(sourcePaths),
    ...approval.bundleMaterials,
    { path: executable.path, fileIdentity: executable.fileIdentity, hash: executable.hash },
    ...(lockHead ? [headMaterial] : []),
  ];
  if (approval.credentialHelper) materials.push({ ...approval.credentialHelper });
  const unique = new Map<string, GitWriteMaterial>();
  for (const item of materials) unique.set(norm(item.path), item);
  if (unique.size > MAX_GIT_MATERIALS) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  return {
    materials: [...unique.values()].sort((a, b) => norm(a.path).localeCompare(norm(b.path))),
    snapshotMaterials: [
      ...collectIndexMaterial(executable, repository.canonicalPath, config),
      ...(!lockHead ? [headMaterial] : []),
    ],
  };
}

function describe(operation: GitWriteOperation): string {
  switch (operation.kind) {
    case "add": return "Stage selected repository files";
    case "commit": return "Commit staged changes";
    case "push": return `Push ${operation.branch} to ${operation.remote}`;
    case "fetch": return `Fetch approved branches from ${operation.remote}`;
    case "branch_list": return "List approved local branches";
    case "branch_create": return `Create branch ${operation.name}`;
    case "switch": return `Switch to branch ${operation.name}`;
    case "pull_ff_only": return `Fast-forward ${operation.branch} from ${operation.remote}`;
  }
}

function immutableOperation(operation: GitWriteOperation): GitWriteOperation {
  return JSON.parse(JSON.stringify(operation)) as GitWriteOperation;
}

export function planGitWrite(
  workspace: Workspace,
  repositoryPath: string,
  input: GitWriteOperation,
  requestedAuthorization?: GitWritePlanAuthorization,
): GitWritePlan {
  validateOperationShape(input);
  let authorization: GitWritePlanAuthorization | undefined;
  if (requestedAuthorization !== undefined) {
    if (requestedAuthorization.source === "repository_approval" &&
        Object.keys(requestedAuthorization).length === 1) {
      authorization = { source: "repository_approval" };
    } else if (requestedAuthorization.source === "full_access" &&
        requestedAuthorization.permissionMode === "level2" &&
        /^[a-f0-9]{64}$/.test(requestedAuthorization.sessionGrantFingerprint) &&
        /^[a-f0-9]{64}$/.test(requestedAuthorization.sessionGrantId) &&
        Object.keys(requestedAuthorization).length === 4) {
      authorization = {
        source: "full_access",
        permissionMode: "level2",
        sessionGrantFingerprint: requestedAuthorization.sessionGrantFingerprint,
        sessionGrantId: requestedAuthorization.sessionGrantId,
      };
    } else {
      throw new GitWriteError("INVALID_ARGUMENTS");
    }
  }
  let repository: ReturnType<typeof resolveRepositoryIdentity>;
  try {
    repository = resolveRepositoryIdentity(workspace, repositoryPath);
  } catch (error) {
    if (error instanceof RepositoryIdentityError && error.code === "REPARSE_POINT") throw new GitWriteError("REPARSE_POINT");
    throw new GitWriteError("INVALID_REPOSITORY");
  }

  let approval: GitRepositoryApproval | null = null;
  let executable: GitExecutable;
  if (authorization?.source === "full_access") {
    executable = resolveGitExecutable();
  } else {
    approval = findGitRepositoryApproval(workspace.id, repository.identity, repository.canonicalPath);
    executable = {
      path: approval.executable,
      fileIdentity: approval.executableFileIdentity,
      hash: approval.executableHash,
    };
  }
  verifyExecutable(executable);
  const config = loadGitConfig(executable, repository.canonicalPath);
  validateGitConfig(config);
  verifyIdentityWithExecutable(repository, executable, config);
  assertNoAlternateOrPromisorObjects(repository);
  if (input.kind !== "branch_list") assertNoUnmergedIndex(executable, repository.canonicalPath, config);
  if (input.kind === "commit") assertNoCommitInProgress(executable, repository.canonicalPath, config);
  let policy: GitWritePolicy;
  if (approval) {
    policy = approval;
  } else {
    policy = fullAccessGitPolicy(repository, executable, config, input);
  }
  if (!policy.allowedOperations.includes(input.kind)) throw new GitWriteError("NOT_APPROVED");
  const { args, remoteBinding, sourcePaths } = buildOperationArgs(
    workspace,
    repository.workspaceRelativePath,
    repository.canonicalPath,
    executable,
    config,
    policy,
    input,
  );
  const helper = input.kind === "push" || input.kind === "fetch" || input.kind === "pull_ff_only" ? policy.credentialHelper : null;
  const helperCommand = credentialHelperCommand(policy, helper !== null);
  const state = stateSnapshot(repository.identity, executable, repository.canonicalPath, config, helperCommand);
  assertExpectedState(input, state);
  const headMaterial = captureHeadMaterial(repository, state);
  if (input.kind === "add" || input.kind === "commit") {
    if (!state.branch || !policy.allowedBranches.includes(state.branch)) throw new GitWriteError("NOT_APPROVED");
  }
  if (input.kind === "switch" && state.branch !== null && !policy.allowedBranches.includes(state.branch)) {
    throw new GitWriteError("NOT_APPROVED");
  }
  if (input.kind === "pull_ff_only" && state.branch !== input.branch) throw new GitWriteError("INVALID_BRANCH");
  if (input.kind === "push" && state.branch !== input.branch) throw new GitWriteError("INVALID_BRANCH");

  const reviewed = input.kind === "commit" ? reviewedIndexTree(repository, executable, config) : null;
  const tree = reviewed?.tree ?? null;
  if (tree !== null && !HEX.test(tree)) throw new GitWriteError("STATE_UNAVAILABLE");
  const { materials, snapshotMaterials } = collectMaterials(
    repository, executable, config, policy, sourcePaths, headMaterial, input.kind !== "switch",
  );
  if (reviewed) {
    const index = snapshotMaterials.find(item => norm(item.path) === norm(reviewed.source.path));
    if (!index || index.hash !== reviewed.source.hash || index.fileIdentity !== reviewed.source.fileIdentity) throw new GitWriteError("EXPECTED_STATE_CHANGED");
  }
  const before: GitWriteBefore = {
    repositoryIdentity: repository.identity,
    executable: executable.path,
    executableFileIdentity: executable.fileIdentity,
    executableHash: executable.hash,
    head: state.head,
    branch: state.branch,
    statusHash: state.statusHash,
    refsHash: state.refsHash,
  };
  const operation = immutableOperation({
    ...input,
    expectedStatusHash: input.expectedStatusHash ?? state.statusHash,
  } as GitWriteOperation);
  const environment = getGitWriteEnvironment();
  const policyHash = approval
    ? gitWritePolicyHash(approval)
    : sha256(JSON.stringify({ authorization, policy: {
        allowedOperations: policy.allowedOperations,
        allowedBranches: policy.allowedBranches,
        allowedRemotes: policy.allowedRemotes,
        approvedProxy: policy.approvedProxy,
        credentialHelper: policy.credentialHelper,
        author: policy.author,
        bundleMaterials: policy.bundleMaterials,
      } }));
  const commitBinding = tree && state.branch ? { tree, parent: state.head, branch: state.branch } : undefined;
  const switchBinding = input.kind === "switch"
    ? { head: runText(executable, repository.canonicalPath,
        ["rev-parse", "--verify", "refs/heads/" + input.name + "^{commit}"], buildCommonGitArgs(config, null)) }
    : undefined;
  const digestMaterial = {
    commitBinding,
    switchBinding,
    repository: repository.identity,
    executable: { path: executable.path, fileIdentity: executable.fileIdentity, hash: executable.hash },
    args,
    environment,
    clearEnvironment: GIT_WRITE_CLEAR_ENVIRONMENT,
    before,
    materials,
    operation,
    remoteBinding,
    snapshotMaterials,
    credentialHelper: helper,
    policyHash,
    ...(authorization ? { authorization } : {}),
  };
  const digest = sha256(JSON.stringify(digestMaterial));
  return {
    ...(commitBinding ? { commitBinding } : {}),
    ...(switchBinding ? { switchBinding } : {}),
    repository,
    executable: executable.path,
    executableFileIdentity: executable.fileIdentity,
    executableHash: executable.hash,
    args,
    environment,
    clearEnvironment: [...GIT_WRITE_CLEAR_ENVIRONMENT],
    digest,
    before,
    description: describe(input),
    materials,
    snapshotMaterials,
    operation,
    ...(authorization ? { authorization } : {}),
    remoteBinding,
    credentialHelper: helper ? { ...helper } : null,
  };
}/** Verify operation-specific postconditions while the C2C writer lock is held.
 * This detects unexpected outcomes; it never rolls back external user data. */
export function verifyGitPostconditions(workspace: Workspace, repositoryPath: string, plan: GitWritePlan): boolean {
  const repository = resolveRepositoryIdentity(workspace, repositoryPath);
  if (repository.identity !== plan.repository.identity) return false;
  const executable: GitExecutable = { path: plan.executable, fileIdentity: plan.executableFileIdentity, hash: plan.executableHash };
  const config = loadGitConfig(executable, repository.canonicalPath); validateGitConfig(config);
  const common = buildCommonGitArgs(config, null);
  const after = stateSnapshot(repository.identity, executable, repository.canonicalPath, config, null);
  if (plan.operation.kind === "commit") {
    if (!plan.commitBinding || after.branch !== plan.commitBinding.branch || !after.head) return false;
    const actual = requireGitSuccess(runVerifiedGit(executable, repository.canonicalPath, [...common, "log", "-1", "--format=%P%n%T", after.head])).toString("utf8").trimEnd().split(/\r?\n/);
    return actual[0] === (plan.commitBinding.parent ?? "") && actual[1] === plan.commitBinding.tree;
  }
  if (plan.operation.kind === "switch") {
    if (!plan.switchBinding || after.branch !== plan.operation.name || after.head !== plan.switchBinding.head || after.refsHash !== plan.before.refsHash) return false;
    assertCleanWorktree(executable, repository.canonicalPath, config); return true;
  }
  if (plan.operation.kind === "pull_ff_only") {
    if (after.branch !== plan.before.branch || !after.head) return false;
    if (plan.before.head && runVerifiedGit(executable, repository.canonicalPath, [...common, "merge-base", "--is-ancestor", plan.before.head, after.head]).code !== 0) return false;
    assertCleanWorktree(executable, repository.canonicalPath, config); return true;
  }
  return after.head === plan.before.head && after.branch === plan.before.branch;
}

export function confirmGitWriteState(
  workspace: Workspace,
  repositoryPath: string,
  before: GitWriteBefore,
): ConfirmGitWriteStateResult {
  let repository: ReturnType<typeof resolveRepositoryIdentity>;
  try {
    repository = resolveRepositoryIdentity(workspace, repositoryPath);
  } catch {
    return { state: "identity_changed", before, repositoryIdentity: null };
  }
  if (repository.identity !== before.repositoryIdentity) {
    return { state: "identity_changed", before, repositoryIdentity: repository.identity };
  }
  try {
    const executable: GitExecutable = {
      path: before.executable,
      fileIdentity: before.executableFileIdentity,
      hash: before.executableHash,
    };
    verifyExecutable(executable);
    const config = loadGitConfig(executable, repository.canonicalPath);
    validateGitConfig(config);
    verifyIdentityWithExecutable(repository, executable, config);
    assertNoAlternateOrPromisorObjects(repository);
    const state = stateSnapshot(repository.identity, executable, repository.canonicalPath, config, null);
    captureHeadMaterial(repository, state);
    const result: GitWriteStateSnapshot = state;
    const changed = result.head !== before.head || result.branch !== before.branch ||
      result.statusHash !== before.statusHash || result.refsHash !== before.refsHash;
    return { state: changed ? "changed" : "confirmed", before, after: result };
  } catch {
    return { state: "unavailable", before };
  }
}
