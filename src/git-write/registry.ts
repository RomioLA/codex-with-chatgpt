import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { resolveRepositoryIdentity, type RepositoryIdentity } from "../execution/repository-identity.js";
import type { Workspace } from "../workspace/manager.js";
import {
  GitWriteError,
  GIT_WRITE_OPERATION_KINDS,
  type GitWriteMaterial,
  type GitWriteOperationKind,
} from "./types.js";
import {
  assertNoReparsePath,
  buildCommonGitArgs,
  captureGitBundleCriticalMaterials,
  configUserValue,
  loadGitConfig,
  readFileMaterial,
  remoteValues,
  resolveGitExecutable,
  runVerifiedGit,
  validateGitConfig,
  type GitConfigEntry,
  type GitExecutable,
} from "./security.js";

const REGISTRY_VERSION = 3;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const MAX_REGISTRY_APPROVALS = 512;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HEX = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

export interface GitWriteRemoteApproval {
  name: string;
  url: string;
}

export interface GitWriteCredentialHelper extends GitWriteMaterial {}

export interface GitRepositoryApproval {
  workspaceId: string;
  repositoryIdentity: string;
  canonicalRepositoryPath: string;
  gitDirectory: string;
  commonGitDirectory: string;
  gitEntryType: RepositoryIdentity["gitEntryType"];
  gitEntryHash: string;
  fileIdentities: RepositoryIdentity["fileIdentities"];
  executable: string;
  executableFileIdentity: string;
  executableHash: string;
  bundleMaterials: GitWriteMaterial[];
  approvedProxy: string | null;
  allowedRemotes: GitWriteRemoteApproval[];
  allowedBranches: string[];
  allowedOperations: GitWriteOperationKind[];
  credentialHelper: GitWriteCredentialHelper | null;
  author: { name: string; email: string } | null;
  approvedAt: string;
  approvalSource: "local-cli";
}

export interface GitRepositoryApprovalPreview extends Omit<GitRepositoryApproval, "approvedAt" | "approvalSource"> {
  digest: string;
}

interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  workspaceId: string;
  approvals: GitRepositoryApproval[];
}

export interface ApproveGitRepositoryInput {
  localApproval: true;
  allowedRemotes: GitWriteRemoteApproval[];
  allowedBranches: string[];
  allowedOperations: GitWriteOperationKind[];
  approvedCredentialHelper?: string;
  approvedProxy?: string;
}

export type GitRepositoryApprovalPolicy = Omit<ApproveGitRepositoryInput, "localApproval">;

function registryPath(workspaceId: string): string {
  if (!/^[a-f0-9]{12}$/i.test(workspaceId)) throw new GitWriteError("INVALID_ARGUMENTS");
  return path.join(getStateDir(), "git-write", "approvals", `${workspaceId}.json`);
}

function registryDirectory(workspaceId: string): string {
  return path.dirname(registryPath(workspaceId));
}

function ensureRegistryDirectory(workspaceId: string): string {
  const absolute = registryDirectory(workspaceId);
  const root = path.parse(absolute).root;
  let current = root;
  try {
    for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || normPath(fs.realpathSync.native(current)) !== normPath(current)) {
        throw new Error("unsafe registry directory");
      }
    }
    assertNoReparsePath(absolute);
    return absolute;
  } catch {
    throw new GitWriteError("APPROVAL_INVALID");
  }
}

function emptyRegistry(workspaceId: string): RegistryFile {
  return { version: REGISTRY_VERSION, workspaceId, approvals: [] };
}

function normPath(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 &&
    path.isAbsolute(value) && !value.includes("\0");
}

function isStoredBranch(value: unknown): value is string {
  return typeof value === "string" && BRANCH_NAME.test(value) && !value.includes("..") &&
    !value.includes("//") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("@{");
}

function isApprovedLoopbackProxy(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/.exec(value);
  if (!match || Number(match[2]) > 65_535) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && parsed.username === "" && parsed.password === "" &&
      parsed.hostname === match[1] && parsed.port === match[2] && parsed.pathname === "/" &&
      parsed.search === "" && parsed.hash === "" && parsed.href === `${value}/`;
  } catch {
    return false;
  }
}

function validateRegistry(value: unknown, workspaceId: string): RegistryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitWriteError("APPROVAL_INVALID");
  const candidate = value as Partial<RegistryFile>;
  if (candidate.version !== REGISTRY_VERSION || candidate.workspaceId !== workspaceId || !Array.isArray(candidate.approvals) ||
      candidate.approvals.length > MAX_REGISTRY_APPROVALS) {
    throw new GitWriteError("APPROVAL_INVALID");
  }
  for (const approval of candidate.approvals) {
    if (!approval || typeof approval !== "object" || approval.workspaceId !== workspaceId ||
        !HEX.test(approval.repositoryIdentity) || !isAbsolutePath(approval.canonicalRepositoryPath) ||
        !isAbsolutePath(approval.gitDirectory) || !isAbsolutePath(approval.commonGitDirectory) ||
        (approval.gitEntryType !== "file" && approval.gitEntryType !== "directory") ||
        !/^[a-f0-9]{64}$/i.test(approval.gitEntryHash) ||
        !approval.fileIdentities || !isIdentity(approval.fileIdentities.repository) ||
        !isIdentity(approval.fileIdentities.gitDirectory) || !isIdentity(approval.fileIdentities.commonGitDirectory) ||
        !isIdentity(approval.fileIdentities.gitEntry) ||
        !isAbsolutePath(approval.executable) || !isIdentity(approval.executableFileIdentity) ||
        !/^[a-f0-9]{64}$/i.test(approval.executableHash) || approval.approvalSource !== "local-cli" ||
        !Array.isArray(approval.bundleMaterials) || approval.bundleMaterials.length > 16 ||
        approval.bundleMaterials.some((item) => !item || !isAbsolutePath(item.path) ||
          !isIdentity(item.fileIdentity) || !/^[a-f0-9]{64}$/i.test(item.hash)) ||
        !(approval.approvedProxy === null || isApprovedLoopbackProxy(approval.approvedProxy)) ||
        typeof approval.approvedAt !== "string" || !Number.isFinite(Date.parse(approval.approvedAt)) ||
        !Array.isArray(approval.allowedRemotes) || approval.allowedRemotes.length > 32 ||
        !Array.isArray(approval.allowedBranches) || approval.allowedBranches.length > 256 ||
        !Array.isArray(approval.allowedOperations) || approval.allowedOperations.length > GIT_WRITE_OPERATION_KINDS.length ||
        (approval.author !== null && (!approval.author || typeof approval.author !== "object" ||
          typeof approval.author.name !== "string" || approval.author.name.length > 256 ||
          typeof approval.author.email !== "string" || approval.author.email.length > 320))) {
      throw new GitWriteError("APPROVAL_INVALID");
    }
    if (approval.allowedOperations.some((item) => !GIT_WRITE_OPERATION_KINDS.includes(item)) ||
        new Set(approval.allowedOperations).size !== approval.allowedOperations.length ||
        approval.allowedBranches.some((branch) => !isStoredBranch(branch)) ||
        new Set(approval.allowedBranches).size !== approval.allowedBranches.length ||
        approval.allowedRemotes.some((remote) => !remote || typeof remote !== "object" ||
          !REMOTE_NAME.test(remote.name) || !validateExactHttpsUrl(remote.url)) ||
        new Set(approval.allowedRemotes.map((remote) => remote.name.toLowerCase())).size !== approval.allowedRemotes.length) {
      throw new GitWriteError("APPROVAL_INVALID");
    }
    if (approval.credentialHelper !== null && (!approval.credentialHelper ||
        !isAbsolutePath(approval.credentialHelper.path) ||
        !isIdentity(approval.credentialHelper.fileIdentity) ||
        !/^[a-f0-9]{64}$/i.test(approval.credentialHelper.hash))) {
      throw new GitWriteError("APPROVAL_INVALID");
    }
  }
  return candidate as RegistryFile;
}

function readRegistry(workspaceId: string): RegistryFile {
  const file = registryPath(workspaceId);
  const directory = path.dirname(file);
  try {
    assertNoReparsePath(directory, true);
    let beforePath: fs.BigIntStats;
    try { beforePath = fs.lstatSync(file, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry(workspaceId);
      throw error;
    }
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size > BigInt(MAX_REGISTRY_BYTES)) {
      throw new GitWriteError("APPROVAL_INVALID");
    }
    assertNoReparsePath(file);
    const descriptor = fs.openSync(file, "r");
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== beforePath.dev || opened.ino !== beforePath.ino ||
          opened.size > BigInt(MAX_REGISTRY_BYTES)) throw new GitWriteError("APPROVAL_INVALID");
      const content = fs.readFileSync(descriptor, "utf8");
      const after = fs.fstatSync(descriptor, { bigint: true });
      let afterPath: fs.BigIntStats;
      try { afterPath = fs.lstatSync(file, { bigint: true }); }
      catch { throw new GitWriteError("APPROVAL_INVALID"); }
      if (content.length > MAX_REGISTRY_BYTES || after.dev !== opened.dev || after.ino !== opened.ino ||
          after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs ||
          afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.isSymbolicLink()) {
        throw new GitWriteError("APPROVAL_INVALID");
      }
      return validateRegistry(JSON.parse(content) as unknown, workspaceId);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof GitWriteError) throw error;
    throw new GitWriteError("APPROVAL_INVALID");
  }
}

function writeRegistry(file: string, registry: RegistryFile): void {
  const directory = ensureRegistryDirectory(registry.workspaceId);
  if (path.dirname(file) !== directory) throw new GitWriteError("APPROVAL_INVALID");
  const temporary = path.join(directory, `${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(temporary, 0o600); } catch { /* Windows ACLs inherit from the state directory. */ }
    assertNoReparsePath(directory);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* preserve original failure */ }
    throw error;
  }
}

function withRegistryLock<T>(workspaceId: string, action: () => T): T {
  const directory = ensureRegistryDirectory(workspaceId);
  const lockFile = path.join(directory, `${workspaceId}.lock`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GitWriteError("APPROVAL_BUSY");
    throw new GitWriteError("APPROVAL_INVALID");
  }
  const held = fs.fstatSync(descriptor, { bigint: true });
  try {
    return action();
  } finally {
    try {
      const current = fs.lstatSync(lockFile, { bigint: true });
      if (current.dev === held.dev && current.ino === held.ino && current.isFile() && !current.isSymbolicLink()) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Keep a leftover lock as a fail-closed signal when its identity no longer matches.
    }
    fs.closeSync(descriptor);
  }
}

function validateExactHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\0\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 &&
      parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" &&
      parsed.href === value;
  } catch {
    return false;
  }
}

function validateBranch(executable: GitExecutable, root: string, config: GitConfigEntry[], branch: string): void {
  if (typeof branch !== "string" || !BRANCH_NAME.test(branch) || branch.includes("..") ||
      branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("@{")) {
    throw new GitWriteError("INVALID_BRANCH");
  }
  const common = buildCommonGitArgs(config, null);
  const check = runVerifiedGit(executable, root, [...common, "check-ref-format", `refs/heads/${branch}`], { maxBuffer: 4096 });
  if (check.code !== 0) throw new GitWriteError("INVALID_BRANCH");
}

function repositoryConfig(executable: GitExecutable, root: string): GitConfigEntry[] {
  const config = loadGitConfig(executable, root);
  validateGitConfig(config);
  return config;
}

function validateRemotes(config: GitConfigEntry[], allowed: GitWriteRemoteApproval[]): void {
  if (!Array.isArray(allowed) || allowed.length > 32) throw new GitWriteError("INVALID_REMOTE");
  const names = new Set<string>();
  for (const remote of allowed) {
    if (!remote || typeof remote !== "object" || !REMOTE_NAME.test(remote.name) || !validateExactHttpsUrl(remote.url) ||
        names.has(remote.name.toLowerCase())) throw new GitWriteError("INVALID_REMOTE");
    names.add(remote.name.toLowerCase());
    const urls = remoteValues(config, remote.name, "url");
    const pushUrls = remoteValues(config, remote.name, "pushurl");
    if (urls.length !== 1 || urls[0] !== remote.url || pushUrls.length > 1 ||
        (pushUrls.length === 1 && pushUrls[0] !== remote.url)) throw new GitWriteError("INVALID_REMOTE");
  }
}

function gitBundleRoot(executable: string): string {
  if (process.platform !== "win32") throw new GitWriteError("INVALID_ARGUMENTS");
  const canonical = path.resolve(executable).replace(/\\/g, "/");
  const lower = canonical.toLowerCase();
  if (lower.endsWith("/mingw64/bin/git.exe")) return path.dirname(path.dirname(path.dirname(canonical)));
  for (const suffix of ["/bin/git.exe", "/cmd/git.exe"]) {
    if (lower.endsWith(suffix)) return path.dirname(path.dirname(canonical));
  }
  if (lower.endsWith("/mingw64/bin/git.exe")) return path.dirname(path.dirname(path.dirname(canonical)));
  throw new GitWriteError("INVALID_ARGUMENTS");
}

function captureApprovedCredentialHelper(executable: GitExecutable, input: string | undefined): GitWriteCredentialHelper | null {
  if (input === undefined) return null;
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new GitWriteError("INVALID_ARGUMENTS");
  const helper = path.resolve(input);
  const bundle = gitBundleRoot(executable.path);
  const expected = path.join(bundle, "mingw64", "bin", "git-credential-manager.exe");
  if (path.resolve(helper).toLowerCase() !== path.resolve(expected).toLowerCase() ||
      path.basename(helper).toLowerCase() !== "git-credential-manager.exe" ||
      /[\0\r\n"'`$&|<>^%!;(){}\[\]]/.test(helper)) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  const material = readFileMaterial(helper);
  return material;
}

function readApprovedAuthor(config: GitConfigEntry[], shouldCommit: boolean): { name: string; email: string } | null {
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

function validatePolicyLists(input: GitRepositoryApprovalPolicy, executable: GitExecutable, root: string, config: GitConfigEntry[]): void {
  if (!input || typeof input !== "object" || !Array.isArray(input.allowedOperations) || input.allowedOperations.length < 1 ||
      input.allowedOperations.some((kind) => !GIT_WRITE_OPERATION_KINDS.includes(kind)) ||
      new Set(input.allowedOperations).size !== input.allowedOperations.length) throw new GitWriteError("INVALID_ARGUMENTS");
  if (!Array.isArray(input.allowedBranches) || input.allowedBranches.length > 256 ||
      new Set(input.allowedBranches).size !== input.allowedBranches.length) throw new GitWriteError("INVALID_BRANCH");
  for (const branch of input.allowedBranches) validateBranch(executable, root, config, branch);
  validateRemotes(config, input.allowedRemotes);
}

function freeze<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function captureApprovalPreview(
  workspace: Workspace,
  repositoryPath: string,
  input: GitRepositoryApprovalPolicy,
): Omit<GitRepositoryApprovalPreview, "digest"> {
  if (!workspace) throw new GitWriteError("INVALID_ARGUMENTS");
  let repository;
  try {
    repository = resolveRepositoryIdentity(workspace, repositoryPath);
  } catch {
    throw new GitWriteError("INVALID_REPOSITORY");
  }
  const executable = resolveGitExecutable();
  const config = repositoryConfig(executable, repository.canonicalPath);
  validatePolicyLists(input, executable, repository.canonicalPath, config);
  const credentialHelper = captureApprovedCredentialHelper(executable, input.approvedCredentialHelper);
  if (input.approvedProxy !== undefined && !isApprovedLoopbackProxy(input.approvedProxy)) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  const author = readApprovedAuthor(config, input.allowedOperations.includes("commit"));
  return {
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    gitDirectory: repository.gitDirectory,
    commonGitDirectory: repository.commonGitDirectory,
    gitEntryType: repository.gitEntryType,
    gitEntryHash: repository.gitEntryHash,
    fileIdentities: { ...repository.fileIdentities },
    executable: executable.path,
    executableFileIdentity: executable.fileIdentity,
    executableHash: executable.hash,
    bundleMaterials: captureGitBundleCriticalMaterials(executable, repository.canonicalPath),
    approvedProxy: input.approvedProxy ?? null,
    allowedRemotes: input.allowedRemotes.map((item) => ({ name: item.name, url: item.url })),
    allowedBranches: [...input.allowedBranches],
    allowedOperations: [...input.allowedOperations],
    credentialHelper,
    author,
  };
}

export function previewGitRepositoryApproval(
  workspace: Workspace,
  repositoryPath: string,
  input: GitRepositoryApprovalPolicy,
): GitRepositoryApprovalPreview {
  const captured = captureApprovalPreview(workspace, repositoryPath, input);
  const digest = createHash("sha256").update(JSON.stringify(captured)).digest("hex");
  return freeze({ ...captured, digest });
}

export function approveGitRepository(
  workspace: Workspace,
  repositoryPath: string,
  input: ApproveGitRepositoryInput,
  expectedPreviewDigest: string,
): GitRepositoryApproval {
  if (!workspace || input?.localApproval !== true) throw new GitWriteError("NOT_APPROVED");
  if (typeof expectedPreviewDigest !== "string" || !/^[a-f0-9]{64}$/i.test(expectedPreviewDigest)) {
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  const captured = captureApprovalPreview(workspace, repositoryPath, input);
  const digest = createHash("sha256").update(JSON.stringify(captured)).digest("hex");
  if (digest !== expectedPreviewDigest.toLowerCase()) throw new GitWriteError("APPROVAL_PREVIEW_CHANGED");
  const approval: GitRepositoryApproval = {
    ...captured,
    approvedAt: new Date().toISOString(),
    approvalSource: "local-cli",
  };
  const file = registryPath(workspace.id);
  return withRegistryLock(workspace.id, () => {
    const registry = readRegistry(workspace.id);
    registry.approvals = registry.approvals.filter((item) => item.repositoryIdentity !== approval.repositoryIdentity);
    if (registry.approvals.length >= MAX_REGISTRY_APPROVALS) throw new GitWriteError("APPROVAL_INVALID");
    registry.approvals.push(approval);
    writeRegistry(file, registry);
    return freeze(approval);
  });
}

export function findGitRepositoryApproval(
  workspaceId: string,
  repositoryIdentity: string,
  canonicalRepositoryPath: string,
): GitRepositoryApproval {
  const approval = readRegistry(workspaceId).approvals.find((item) =>
    item.workspaceId === workspaceId && item.repositoryIdentity === repositoryIdentity &&
    item.canonicalRepositoryPath === canonicalRepositoryPath && item.approvalSource === "local-cli"
  );
  if (!approval) throw new GitWriteError("NOT_APPROVED");
  const current = readFileMaterial(approval.executable);
  if (current.fileIdentity !== approval.executableFileIdentity || current.hash !== approval.executableHash) {
    throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
  }
  if (approval.credentialHelper) {
    const helper = readFileMaterial(approval.credentialHelper.path);
    if (helper.fileIdentity !== approval.credentialHelper.fileIdentity || helper.hash !== approval.credentialHelper.hash) {
      throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
    }
  }
  for (const material of approval.bundleMaterials) {
    try {
      const currentMaterial = readFileMaterial(material.path);
      if (currentMaterial.fileIdentity !== material.fileIdentity || currentMaterial.hash !== material.hash) {
        throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
      }
    } catch {
      throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
    }
  }
  return freeze(approval);
}

export function readGitRepositoryApproval(workspace: Workspace, repositoryPath: string): GitRepositoryApproval | null {
  let identity;
  try {
    identity = resolveRepositoryIdentity(workspace, repositoryPath);
  } catch {
    return null;
  }
  try {
    return findGitRepositoryApproval(workspace.id, identity.identity, identity.canonicalPath);
  } catch (error) {
    if (error instanceof GitWriteError && error.code === "NOT_APPROVED") return null;
    throw error;
  }
}

export function listGitRepositoryApprovals(workspaceId: string): GitRepositoryApproval[] {
  return readRegistry(workspaceId).approvals.map(freeze);
}

export function revokeGitRepositoryApproval(
  workspace: Workspace,
  repositoryPath: string,
  input: { localApproval: true },
): boolean {
  if (input?.localApproval !== true) throw new GitWriteError("NOT_APPROVED");
  let identity;
  try {
    identity = resolveRepositoryIdentity(workspace, repositoryPath);
  } catch {
    throw new GitWriteError("INVALID_REPOSITORY");
  }
  const file = registryPath(workspace.id);
  return withRegistryLock(workspace.id, () => {
    const registry = readRegistry(workspace.id);
    const oldLength = registry.approvals.length;
    registry.approvals = registry.approvals.filter((item) => item.repositoryIdentity !== identity.identity);
    if (registry.approvals.length === oldLength) return false;
    writeRegistry(file, registry);
    return true;
  });
}

export function gitWritePolicyHash(approval: GitRepositoryApproval): string {
  return createHash("sha256").update(JSON.stringify(approval)).digest("hex");
}
