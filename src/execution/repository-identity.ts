import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "../workspace/git.js";
import { Workspace, WorkspaceError } from "../workspace/manager.js";

const normPath = (value: string): string =>
  process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;

export interface RepositoryIdentity {
  identity: string;
  canonicalPath: string;
  workspaceRelativePath: string;
  gitDirectory: string;
  commonGitDirectory: string;
  gitEntryType: "file" | "directory";
  gitEntryHash: string;
  fileIdentities: {
    repository: string;
    gitDirectory: string;
    commonGitDirectory: string;
    gitEntry: string;
  };
}

export class RepositoryIdentityError extends Error {
  constructor(public readonly code: "INVALID_REPOSITORY" | "REPARSE_POINT" | "PATH_CHANGED") {
    super(code);
    this.name = "RepositoryIdentityError";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Reject symlinks/junctions at every workspace path component used for execution. */
function assertNoReparseComponents(workspaceRoot: string, candidate: string): void {
  const root = fs.realpathSync.native(workspaceRoot);
  const lexicalCandidate = path.resolve(candidate);
  if (!isWithin(root, lexicalCandidate)) throw new RepositoryIdentityError("PATH_CHANGED");

  // Inspect the caller's lexical path before realpath can erase evidence that
  // a symlink, junction, or other reparse component was used to select it.
  const relative = path.relative(root, lexicalCandidate);
  let current = root;
  const components = relative === "" ? [] : relative.split(path.sep);
  for (const component of components) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw new RepositoryIdentityError("PATH_CHANGED");
    }
    if (stat.isSymbolicLink()) throw new RepositoryIdentityError("REPARSE_POINT");
  }

  const target = fs.realpathSync.native(lexicalCandidate);
  if (!isWithin(root, target) || normPath(target) !== normPath(lexicalCandidate)) {
    throw new RepositoryIdentityError("PATH_CHANGED");
  }
}

function requestedRepositoryPath(workspaceRoot: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || requestedPath.includes("\0")) {
    throw new RepositoryIdentityError("INVALID_REPOSITORY");
  }
  let value = requestedPath.trim().replace(/\\/g, "/");
  value = value.replace(/^workspace:\/*/i, "");
  if (value === "" || value === "/") value = ".";
  return path.resolve(workspaceRoot, value);
}

function realDirectory(value: string, base: string): string {
  const resolved = path.resolve(base, value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new RepositoryIdentityError("INVALID_REPOSITORY");
  return fs.realpathSync.native(resolved);
}

function directoryFileIdentity(value: string): string {
  const stat = fs.statSync(value, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n || stat.dev === 0n) {
    throw new RepositoryIdentityError("INVALID_REPOSITORY");
  }
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

/** Resolve an existing in-workspace Git repository/worktree and fingerprint its canonical identity. */
export function resolveRepositoryIdentity(workspace: Workspace, requestedPath: string): RepositoryIdentity {
  let selected: { abs: string; rel: string };
  try {
    const lexicalPath = requestedRepositoryPath(workspace.root, requestedPath);
    assertNoReparseComponents(workspace.root, lexicalPath);
    selected = workspace.resolveRepositoryPath(requestedPath);
  } catch (error) {
    if (error instanceof RepositoryIdentityError) throw error;
    if (error instanceof WorkspaceError) throw new RepositoryIdentityError("INVALID_REPOSITORY");
    throw error;
  }
  assertNoReparseComponents(workspace.root, selected.abs);

  const top = runGit(selected.abs, ["rev-parse", "--show-toplevel"]);
  const gitDir = runGit(selected.abs, ["rev-parse", "--absolute-git-dir"]);
  const commonDir = runGit(selected.abs, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !gitDir.ok || !commonDir.ok) throw new RepositoryIdentityError("INVALID_REPOSITORY");

  let canonicalTop: string;
  let canonicalGitDir: string;
  let canonicalCommon: string;
  try {
    canonicalTop = fs.realpathSync.native(path.resolve(top.stdout.trim()));
    canonicalGitDir = realDirectory(gitDir.stdout.trim(), selected.abs);
    canonicalCommon = realDirectory(commonDir.stdout.trim(), selected.abs);
  } catch {
    throw new RepositoryIdentityError("INVALID_REPOSITORY");
  }
  if (normPath(canonicalTop) !== normPath(selected.abs)) {
    throw new RepositoryIdentityError("INVALID_REPOSITORY");
  }
  assertNoReparseComponents(workspace.root, canonicalTop);

  const gitEntryPath = path.join(canonicalTop, ".git");
  let gitEntryType: "file" | "directory";
  let gitEntryHash = "0".repeat(64);
  let gitEntryFileIdentity: string;
  try {
    const gitEntry = fs.lstatSync(gitEntryPath, { bigint: true });
    if (gitEntry.isSymbolicLink()) throw new RepositoryIdentityError("REPARSE_POINT");
    if (gitEntry.isDirectory()) {
      gitEntryType = "directory";
    } else if (gitEntry.isFile()) {
      gitEntryType = "file";
      gitEntryHash = createHash("sha256").update(fs.readFileSync(gitEntryPath)).digest("hex");
    } else {
      throw new RepositoryIdentityError("INVALID_REPOSITORY");
    }
    gitEntryFileIdentity = `${gitEntry.dev.toString(16)}:${gitEntry.ino.toString(16)}`;
  } catch (error) {
    if (error instanceof RepositoryIdentityError) throw error;
    throw new RepositoryIdentityError("INVALID_REPOSITORY");
  }
  const fileIdentities = {
    repository: directoryFileIdentity(canonicalTop),
    gitDirectory: directoryFileIdentity(canonicalGitDir),
    commonGitDirectory: directoryFileIdentity(canonicalCommon),
    gitEntry: gitEntryFileIdentity,
  };
  const material = JSON.stringify([
    workspace.id,
    normPath(canonicalTop),
    normPath(canonicalGitDir),
    normPath(canonicalCommon),
    fileIdentities.repository,
    fileIdentities.gitDirectory,
    fileIdentities.commonGitDirectory,
    gitEntryType,
    fileIdentities.gitEntry,
    gitEntryHash,
  ]);
  const identity = createHash("sha256").update(material).digest("hex");
  return {
    identity,
    canonicalPath: canonicalTop,
    workspaceRelativePath: selected.rel || ".",
    gitDirectory: canonicalGitDir,
    commonGitDirectory: canonicalCommon,
    gitEntryType,
    gitEntryHash,
    fileIdentities,
  };
}
