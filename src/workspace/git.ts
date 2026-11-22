import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IgnoreRules } from "./ignore.js";
import { Workspace, WorkspaceError } from "./manager.js";
import {
  assertNoReparsePath,
  readFileMaterialWithStat,
  resolveGitExecutable,
  verifyExecutableWithStat,
  type GitExecutable,
} from "../git-write/security.js";
import { beginEventLoopTraceSpan, isEventLoopTraceEnabled } from "../diagnostics/event-loop-trace.js";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface GitReadOptions {
  /** Absolute performance.now() deadline shared by a bounded read operation. */
  deadlineAt?: number;
}

function assertGitDeadline(options: GitReadOptions): void {
  if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt) {
    throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
  }
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;

const SAFE_GIT_GLOBAL_ARGS = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.editor=:",
  "-c", "sequence.editor=:",
  "-c", `core.attributesFile=${NULL_DEVICE}`,
  "-c", "credential.interactive=false",
  "-c", "submodule.recurse=false",
  "-c", "status.submodulesummary=false",
  "-c", "diff.submodule=short",
  "-c", "protocol.allow=never",
];

const SAFE_FILTER_CONFIG_OVERRIDE_PATTERN = /^filter\.[A-Za-z0-9._-]+\.(?:clean|process)$/i;
const INCLUDE_CONFIG_KEY_PATTERN = /^(?:include|includeif)\./i;
const FILTER_EXECUTION_KEY_PATTERN = /^filter\.[\s\S]*\.(?:clean|process)$/i;
const PROMISOR_CONFIG_KEY_PATTERN =
  /^(?:extensions\.(?:[\s\S]*\.)?partialclone|remote\.[\s\S]*\.(?:promisor|partialclonefilter))$/i;
const MAX_FILTER_CONFIG_OVERRIDES = 128;
const MAX_FILTER_CONFIG_OVERRIDE_BYTES = 16 * 1024;
const MAX_PROMISOR_CONFIG_KEYS = 128;
const MAX_PROMISOR_CONFIG_KEY_BYTES = 4096;
const DIRECT_REV_PARSE_ARGS = new Set([
  "--is-inside-work-tree",
  "--show-toplevel",
  "--show-prefix",
  "--absolute-git-dir",
  "--git-common-dir",
  "--abbrev-ref",
  "--short",
  "HEAD",
]);

function needsControlledGitView(args: string[]): boolean {
  const subcommand = args[0];
  if (subcommand === "diff" || subcommand === "status") return true;
  if (subcommand === "rev-parse") {
    return args.length < 2 || !args.slice(1).every((arg) => DIRECT_REV_PARSE_ARGS.has(arg));
  }
  return false;
}
const MAX_GIT_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_CONTROLLED_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_CONTROLLED_PACKED_REFS_BYTES = 32 * 1024 * 1024;
const MAX_CONTROLLED_SMALL_FILE_BYTES = 64 * 1024;
const MAX_CONTROLLED_CONFIG_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_SYMREF_HOPS = 4;
const MAX_GIT_DISCOVERY_DEPTH = 64;

interface CachedGitExecutable {
  executable: GitExecutable;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const TRUSTED_GIT_MATERIALS = new Map<string, CachedGitExecutable>();
const SAFE_GIT_COMMANDS = new Set(["rev-parse", "status", "diff", "config"]);

function createGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.toUpperCase().startsWith("GIT_")) {
      env[name] = value;
    }
  }

  // Do not inherit Git's repository/config authority. Preserve normal process
  // startup variables (PATH, SystemRoot, etc.) and install fixed query policy.
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: ":",
    GIT_SEQUENCE_EDITOR: ":",
    PAGER: "cat",
  });
  delete env.C2C_TRUSTED_GIT_EXECUTABLE;
  return env;
}

function trustedGitCandidates(): string[] {
  const candidates: string[] = [];
  const configured = process.env.C2C_TRUSTED_GIT_EXECUTABLE?.trim();
  if (configured) candidates.push(configured);
  if (process.platform === "win32") {
    for (const programFiles of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!programFiles || !path.win32.isAbsolute(programFiles)) continue;
      for (const relative of ["Git\\cmd\\git.exe", "Git\\bin\\git.exe", "Git\\mingw64\\bin\\git.exe"]) {
        candidates.push(path.win32.join(programFiles, relative));
      }
    }
    candidates.push(path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "cmd", "git.exe"));
    return candidates;
  }
  try { candidates.push(resolveGitExecutable().path); } catch { /* handled as an unavailable trusted executable */ }
  return candidates;
}

function resolveTrustedGitExecutable(root: string): GitExecutable | null {
  for (const candidate of trustedGitCandidates()) {
    const validName = process.platform === "win32"
      ? /^git\.exe$/i.test(path.basename(candidate))
      : path.basename(candidate) === "git";
    if (!path.isAbsolute(candidate) || !validName) continue;
    const absolute = path.resolve(candidate);
    if (isWithinPath(root, absolute)) continue;
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    const bound = TRUSTED_GIT_MATERIALS.get(key);
    if (bound) {
      try {
        assertNoReparsePath(bound.executable.path);
        const stat = fs.lstatSync(bound.executable.path, { bigint: true });
        const identity = `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
        if (
          !stat.isSymbolicLink() &&
          stat.isFile() &&
          identity === bound.executable.fileIdentity &&
          stat.size === bound.size &&
          stat.mtimeNs === bound.mtimeNs &&
          stat.ctimeNs === bound.ctimeNs
        ) {
          return bound.executable;
        }
        const verified = verifyExecutableWithStat(bound.executable);
        const executable: GitExecutable = {
          path: verified.path,
          fileIdentity: verified.fileIdentity,
          hash: verified.hash,
        };
        TRUSTED_GIT_MATERIALS.set(key, {
          executable,
          size: verified.size,
          mtimeNs: verified.mtimeNs,
          ctimeNs: verified.ctimeNs,
        });
        return executable;
      } catch {
        TRUSTED_GIT_MATERIALS.delete(key);
        continue;
      }
    }
    try {
      const material = readFileMaterialWithStat(absolute);
      const trusted: GitExecutable = {
        path: material.path,
        fileIdentity: material.fileIdentity,
        hash: material.hash,
      };
      TRUSTED_GIT_MATERIALS.set(key, {
        executable: trusted,
        size: material.size,
        mtimeNs: material.mtimeNs,
        ctimeNs: material.ctimeNs,
      });
      return trusted;
    } catch {
      // Untrusted, missing, replaced, or reparse-backed candidates are skipped.
    }
  }
  return null;
}

function reverifyExecutableBinding(root: string, expected: GitExecutable): boolean {
  const key = process.platform === "win32" ? expected.path.toLowerCase() : expected.path;
  const bound = TRUSTED_GIT_MATERIALS.get(key);
  if (!bound) return false;
  const current = resolveTrustedGitExecutable(root);
  if (!current) return false;
  const currentKey = process.platform === "win32" ? current.path.toLowerCase() : current.path;
  return (
    currentKey === key &&
    current.fileIdentity === expected.fileIdentity &&
    current.hash === expected.hash
  );
}

interface ControlledRepositoryLayout {
  canonicalRoot: string;
  workTree: string;
  gitDir: string;
  commonDir: string;
}

type ControlledLayoutResolution =
  | { kind: "not_repo" }
  | { kind: "unsafe" }
  | { kind: "repo"; layout: ControlledRepositoryLayout };

type BoundedReadResult =
  | { status: "ok"; data: Buffer }
  | { status: "missing" }
  | { status: "unsafe" };

interface ControlledGitView {
  viewDir: string;
  viewEnv: NodeJS.ProcessEnv;
  configFiles: readonly string[];
  currentBranch: string | null;
  copyLooseRefIfPresent: (relRef: string) => { status: "copied"; data: Buffer } | { status: "missing" } | { status: "unsafe" };
  cleanup: () => void;
}

function hasNoSymlinkComponents(targetPath: string): boolean {
  const absolute = path.resolve(targetPath);
  const rootPart = path.parse(absolute).root;
  const segments = absolute.slice(rootPart.length).split(path.sep).filter(Boolean);
  let current = rootPart;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function readBoundedRegularFile(filePath: string, maxBytes: number): BoundedReadResult {
  let handle: number | undefined;
  try {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
      return { status: "unsafe" };
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > BigInt(maxBytes)) {
      return { status: "unsafe" };
    }
    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = fs.openSync(filePath, openFlags);
    const fstat = fs.fstatSync(handle, { bigint: true });
    if (!fstat.isFile() || fstat.size > BigInt(maxBytes)) {
      return { status: "unsafe" };
    }
    if (stat.dev !== 0n && stat.ino !== 0n && (fstat.dev !== stat.dev || fstat.ino !== stat.ino)) {
      return { status: "unsafe" };
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1024, maxBytes + 1)));
    for (;;) {
      const bytesRead = fs.readSync(handle, scratch, 0, scratch.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) return { status: "unsafe" };
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
    return { status: "ok", data: Buffer.concat(chunks, totalBytes) };
  } catch {
    return { status: "unsafe" };
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch { /* ignore close error */ }
    }
  }
}

function readBoundedRepoRelativeFile(baseDir: string, relSegments: string[], maxBytes: number): BoundedReadResult {
  if (relSegments.length === 0) return { status: "unsafe" };
  let current = baseDir;
  for (let i = 0; i < relSegments.length - 1; i += 1) {
    current = path.join(current, relSegments[i]!);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "unsafe" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
      return { status: "unsafe" };
    }
  }
  return readBoundedRegularFile(path.join(current, relSegments[relSegments.length - 1]!), maxBytes);
}

function checkOptionalRegularFile(filePath: string): "ok" | "missing" | "unsafe" {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return "unsafe";
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unsafe";
  }
}

function checkRequiredDirectory(dirPath: string): "ok" | "missing" | "unsafe" {
  try {
    const stat = fs.lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
    return "ok";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    return "unsafe";
  }
}

function isSafeRelRef(relRef: string): boolean {
  if (!relRef.startsWith("refs/") || relRef.includes("\0") || relRef.includes("\\")) return false;
  const parts = relRef.split("/");
  if (parts.length < 2) return false;
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && !/[\x00-\x1f\x7f~^:?*[\]\\]/.test(part)
  );
}

function parseSymrefTarget(
  data: Buffer
): { kind: "oid" } | { kind: "symref"; target: string } | { kind: "invalid" } {
  const text = data.toString("utf8").replace(/\r?\n$/, "");
  if (text.includes("\0") || text.includes("\n") || text.includes("\r")) return { kind: "invalid" };
  if (!text.startsWith("ref:")) return { kind: "oid" };
  const target = text.slice("ref:".length).trim();
  return isSafeRelRef(target) ? { kind: "symref", target } : { kind: "invalid" };
}

function resolveControlledRepositoryLayout(root: string): ControlledLayoutResolution {
  const resolvedInput = path.resolve(root);
  let inputStat: fs.Stats;
  try {
    inputStat = fs.lstatSync(resolvedInput);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "not_repo" };
    return { kind: "unsafe" };
  }
  if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) return { kind: "unsafe" };

  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(resolvedInput);
  } catch {
    return { kind: "unsafe" };
  }

  let current = canonicalRoot;
  let workTree: string | null = null;
  let gitDir: string | null = null;

  for (let depth = 0; depth < MAX_GIT_DISCOVERY_DEPTH; depth += 1) {
    const dotGitPath = path.join(current, ".git");
    let dotGitStat: fs.BigIntStats;
    try {
      dotGitStat = fs.lstatSync(dotGitPath, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        const parent = path.dirname(current);
        if (parent === current) return { kind: "not_repo" };
        current = parent;
        continue;
      }
      return { kind: "unsafe" };
    }

    if (dotGitStat.isSymbolicLink()) return { kind: "unsafe" };

    if (dotGitStat.isDirectory()) {
      workTree = current;
      gitDir = dotGitPath;
      break;
    }

    if (dotGitStat.isFile()) {
      const gitFile = readBoundedRegularFile(dotGitPath, MAX_CONTROLLED_SMALL_FILE_BYTES);
      if (gitFile.status !== "ok") return { kind: "unsafe" };
      const text = gitFile.data.toString("utf8").replace(/\r?\n$/, "");
      if (text.includes("\0") || text.includes("\n") || text.includes("\r")) return { kind: "unsafe" };
      const match = /^gitdir:[ \t]*(.+)$/i.exec(text);
      const rawGitDir = match?.[1]?.trim();
      if (!rawGitDir) return { kind: "unsafe" };
      const candidateGitDir = path.resolve(current, rawGitDir);
      if (!hasNoSymlinkComponents(candidateGitDir) || checkRequiredDirectory(candidateGitDir) !== "ok") {
        return { kind: "unsafe" };
      }
      try {
        gitDir = fs.realpathSync.native(candidateGitDir);
      } catch {
        return { kind: "unsafe" };
      }
      workTree = current;
      break;
    }

    return { kind: "unsafe" };
  }

  if (!workTree || !gitDir) return { kind: "not_repo" };

  let commonDir = gitDir;
  const commonDirFile = readBoundedRegularFile(path.join(gitDir, "commondir"), MAX_CONTROLLED_SMALL_FILE_BYTES);
  if (commonDirFile.status === "unsafe") return { kind: "unsafe" };
  if (commonDirFile.status === "ok") {
    const rawCommonDir = commonDirFile.data.toString("utf8").replace(/\r?\n$/, "").trim();
    if (!rawCommonDir || rawCommonDir.includes("\0") || rawCommonDir.includes("\n") || rawCommonDir.includes("\r")) {
      return { kind: "unsafe" };
    }
    const candidateCommonDir = path.resolve(gitDir, rawCommonDir);
    if (!hasNoSymlinkComponents(candidateCommonDir) || checkRequiredDirectory(candidateCommonDir) !== "ok") {
      return { kind: "unsafe" };
    }
    try {
      commonDir = fs.realpathSync.native(candidateCommonDir);
    } catch {
      return { kind: "unsafe" };
    }
  }

  const headCheck = checkOptionalRegularFile(path.join(gitDir, "HEAD"));
  if (headCheck === "missing") return { kind: "not_repo" };
  if (headCheck === "unsafe") return { kind: "unsafe" };

  const objectsCheck = checkRequiredDirectory(path.join(commonDir, "objects"));
  if (objectsCheck === "missing") return { kind: "not_repo" };
  if (objectsCheck === "unsafe") return { kind: "unsafe" };

  if (checkOptionalRegularFile(path.join(gitDir, "index")) === "unsafe") return { kind: "unsafe" };
  if (checkOptionalRegularFile(path.join(commonDir, "config")) === "unsafe") return { kind: "unsafe" };
  if (checkOptionalRegularFile(path.join(gitDir, "config.worktree")) === "unsafe") return { kind: "unsafe" };

  return {
    kind: "repo",
    layout: { canonicalRoot, workTree, gitDir, commonDir },
  };
}

function createControlledGitView(
  layout: ControlledRepositoryLayout,
  baseEnv: NodeJS.ProcessEnv
): ControlledGitView | null {
  let tmpRoot: string;
  let viewDir: string;
  try {
    tmpRoot = fs.realpathSync.native(os.tmpdir());
    viewDir = fs.mkdtempSync(path.join(tmpRoot, "c2c-git-view-"));
  } catch {
    return null;
  }

  const createdDirs: string[] = [viewDir];
  const createdDirSet = new Set<string>([""]);
  const createdFiles: string[] = [];
  const writtenRelFiles = new Set<string>();

  const cleanup = (): void => {
    for (let i = createdFiles.length - 1; i >= 0; i -= 1) {
      try { fs.unlinkSync(createdFiles[i]!); } catch { /* best-effort cleanup */ }
    }
    for (let i = createdDirs.length - 1; i >= 0; i -= 1) {
      try { fs.rmdirSync(createdDirs[i]!); } catch { /* best-effort cleanup */ }
    }
  };

  const ensureRelDir = (segments: string[]): void => {
    let relKey = "";
    let current = viewDir;
    for (const segment of segments) {
      relKey = relKey ? `${relKey}/${segment}` : segment;
      current = path.join(current, segment);
      if (!createdDirSet.has(relKey)) {
        fs.mkdirSync(current, { mode: 0o700 });
        createdDirSet.add(relKey);
        createdDirs.push(current);
      }
    }
  };

  const writeRelFile = (segments: string[], data: Buffer): void => {
    const relKey = segments.join("/");
    if (writtenRelFiles.has(relKey)) return;
    if (segments.length > 1) ensureRelDir(segments.slice(0, -1));
    const absFile = path.join(viewDir, ...segments);
    fs.writeFileSync(absFile, data, { flag: "wx", mode: 0o600 });
    writtenRelFiles.add(relKey);
    createdFiles.push(absFile);
  };

  const copyOptionalFile = (sourceBase: string, relSegments: string[], maxBytes: number): boolean => {
    const res = readBoundedRepoRelativeFile(sourceBase, relSegments, maxBytes);
    if (res.status === "unsafe") return false;
    if (res.status === "ok") writeRelFile(relSegments, res.data);
    return true;
  };

  const copyLooseRefIfPresent = (
    relRef: string
  ): { status: "copied"; data: Buffer } | { status: "missing" } | { status: "unsafe" } => {
    if (!isSafeRelRef(relRef)) return { status: "unsafe" };
    const parts = relRef.split("/");
    if (layout.gitDir !== layout.commonDir) {
      const worktreeRef = readBoundedRepoRelativeFile(layout.gitDir, parts, MAX_CONTROLLED_SMALL_FILE_BYTES);
      if (worktreeRef.status === "unsafe") return { status: "unsafe" };
      if (worktreeRef.status === "ok") {
        writeRelFile(parts, worktreeRef.data);
        return { status: "copied", data: worktreeRef.data };
      }
    }
    const commonRef = readBoundedRepoRelativeFile(layout.commonDir, parts, MAX_CONTROLLED_SMALL_FILE_BYTES);
    if (commonRef.status === "unsafe") return { status: "unsafe" };
    if (commonRef.status === "ok") {
      writeRelFile(parts, commonRef.data);
      return { status: "copied", data: commonRef.data };
    }
    return { status: "missing" };
  };

  try {
    ensureRelDir(["objects"]);
    ensureRelDir(["refs"]);
    ensureRelDir(["info"]);

    const configFiles: string[] = [];
    if (!copyOptionalFile(layout.commonDir, ["config"], MAX_CONTROLLED_CONFIG_BYTES)) {
      cleanup();
      return null;
    }
    if (writtenRelFiles.has("config")) {
      const viewConfigPath = path.join(viewDir, "config");
      configFiles.push(viewConfigPath);
      createdFiles.push(`${viewConfigPath}.lock`);
    }
    if (!copyOptionalFile(layout.gitDir, ["config.worktree"], MAX_CONTROLLED_CONFIG_BYTES)) {
      cleanup();
      return null;
    }
    if (writtenRelFiles.has("config.worktree")) {
      const viewWorktreeConfigPath = path.join(viewDir, "config.worktree");
      configFiles.push(viewWorktreeConfigPath);
      createdFiles.push(`${viewWorktreeConfigPath}.lock`);
    }

    const headRead = readBoundedRegularFile(path.join(layout.gitDir, "HEAD"), MAX_CONTROLLED_SMALL_FILE_BYTES);
    if (headRead.status !== "ok") {
      cleanup();
      return null;
    }
    writeRelFile(["HEAD"], headRead.data);

    let currentBranch: string | null = null;
    let symrefBuffer = headRead.data;
    const visitedRefs = new Set<string>();
    for (let hop = 0; hop < MAX_SYMREF_HOPS; hop += 1) {
      const parsed = parseSymrefTarget(symrefBuffer);
      if (parsed.kind === "invalid") {
        cleanup();
        return null;
      }
      if (parsed.kind === "oid") break;
      if (visitedRefs.has(parsed.target)) {
        cleanup();
        return null;
      }
      visitedRefs.add(parsed.target);
      if (hop === 0 && parsed.target.startsWith("refs/heads/")) {
        currentBranch = parsed.target.slice("refs/heads/".length);
      }
      const copied = copyLooseRefIfPresent(parsed.target);
      if (copied.status === "unsafe") {
        cleanup();
        return null;
      }
      if (copied.status === "missing") break;
      const nextParsed = parseSymrefTarget(copied.data);
      if (nextParsed.kind === "symref" && hop === MAX_SYMREF_HOPS - 1) {
        cleanup();
        return null;
      }
      symrefBuffer = copied.data;
    }

    if (
      !copyOptionalFile(layout.commonDir, ["packed-refs"], MAX_CONTROLLED_PACKED_REFS_BYTES) ||
      !copyOptionalFile(layout.commonDir, ["shallow"], MAX_CONTROLLED_CONFIG_BYTES) ||
      !copyOptionalFile(layout.commonDir, ["info", "exclude"], MAX_CONTROLLED_CONFIG_BYTES) ||
      !copyOptionalFile(layout.gitDir, ["MERGE_HEAD"], MAX_CONTROLLED_SMALL_FILE_BYTES) ||
      !copyOptionalFile(layout.gitDir, ["CHERRY_PICK_HEAD"], MAX_CONTROLLED_SMALL_FILE_BYTES) ||
      !copyOptionalFile(layout.gitDir, ["REVERT_HEAD"], MAX_CONTROLLED_SMALL_FILE_BYTES) ||
      !copyOptionalFile(layout.gitDir, ["BISECT_LOG"], MAX_CONTROLLED_CONFIG_BYTES)
    ) {
      cleanup();
      return null;
    }

    const commonAttrs = readBoundedRepoRelativeFile(
      layout.commonDir,
      ["info", "attributes"],
      MAX_CONTROLLED_CONFIG_BYTES
    );
    if (commonAttrs.status === "unsafe") {
      cleanup();
      return null;
    }
    const gitDirAttrs =
      layout.gitDir !== layout.commonDir
        ? readBoundedRepoRelativeFile(layout.gitDir, ["info", "attributes"], MAX_CONTROLLED_CONFIG_BYTES)
        : ({ status: "missing" } as const);
    if (gitDirAttrs.status === "unsafe") {
      cleanup();
      return null;
    }
    if (commonAttrs.status === "ok" && gitDirAttrs.status === "ok") {
      if (commonAttrs.data.byteLength + gitDirAttrs.data.byteLength + 1 > MAX_CONTROLLED_CONFIG_BYTES) {
        cleanup();
        return null;
      }
      writeRelFile(["info", "attributes"], Buffer.concat([commonAttrs.data, Buffer.from("\n", "utf8"), gitDirAttrs.data]));
    } else if (commonAttrs.status === "ok") {
      writeRelFile(["info", "attributes"], commonAttrs.data);
    } else if (gitDirAttrs.status === "ok") {
      writeRelFile(["info", "attributes"], gitDirAttrs.data);
    }

    const gitDirSparse = readBoundedRepoRelativeFile(
      layout.gitDir,
      ["info", "sparse-checkout"],
      MAX_CONTROLLED_CONFIG_BYTES
    );
    if (gitDirSparse.status === "unsafe") {
      cleanup();
      return null;
    }
    if (gitDirSparse.status === "ok") {
      writeRelFile(["info", "sparse-checkout"], gitDirSparse.data);
    } else if (layout.gitDir !== layout.commonDir) {
      if (!copyOptionalFile(layout.commonDir, ["info", "sparse-checkout"], MAX_CONTROLLED_CONFIG_BYTES)) {
        cleanup();
        return null;
      }
    }

    const viewEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      GIT_DIR: viewDir,
      GIT_WORK_TREE: layout.workTree,
      GIT_INDEX_FILE: path.join(layout.gitDir, "index"),
      GIT_OBJECT_DIRECTORY: path.join(layout.commonDir, "objects"),
    };

    return {
      viewDir,
      viewEnv,
      configFiles,
      currentBranch,
      copyLooseRefIfPresent,
      cleanup,
    };
  } catch {
    cleanup();
    return null;
  }
}

type GitOperationClass = "rev-parse" | "status" | "diff" | "config" | "other";

function classifyGitOperation(args: string[]): GitOperationClass {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (SAFE_GIT_COMMANDS.has(arg)) return arg as GitOperationClass;
    break;
  }
  return "other";
}

function classifyExitStatus(
  status: number | null,
  signal: NodeJS.Signals | null,
  error: Error | undefined,
  timedOut: boolean,
): "success" | "nonzero" | "signal" | "timeout" | "spawn_error" | "unknown" {
  if (timedOut) return "timeout";
  if (error) return "spawn_error";
  if (signal) return "signal";
  if (status === 0) return "success";
  return status === null ? "unknown" : "nonzero";
}

function spawnGit(
  executable: string,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadlineAt?: number
) {
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
  }
  const remainingMs = deadlineAt === undefined ? 30_000 : Math.max(1, Math.floor(deadlineAt - performance.now()));
  const options = {
    cwd: root,
    encoding: "utf8" as const,
    env,
    maxBuffer: MAX_GIT_BUFFER_BYTES,
    timeout: remainingMs,
    windowsHide: true,
    shell: false,
  };
  if (!isEventLoopTraceEnabled()) {
    if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    return spawnSync(executable, args, options);
  }

  const operationClass = classifyGitOperation(args);
  const span = beginEventLoopTraceSpan("git_sync", { operationClass });
  try {
    if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    const result = spawnSync(executable, args, options);
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = errorCode === "ETIMEDOUT";
    const exitStatusCategory = classifyExitStatus(result.status, result.signal, result.error, timedOut);
    span({ exitStatusCategory, timedOut });
    return result;
  } catch (error) {
    span({ exitStatusCategory: "spawn_error", timedOut: false });
    throw error;
  }
}

interface AsyncSpawnOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
  bufferExceeded: boolean;
}

function spawnGitAsync(
  executable: GitExecutable,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadlineAt?: number
): Promise<AsyncSpawnOutcome> {
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return Promise.reject(new WorkspaceError("DEADLINE", "Git read deadline exceeded"));
  }
  if (!reverifyExecutableBinding(root, executable)) {
    return Promise.reject(new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Unable to establish a trusted Git executable."));
  }
  const remainingMs = deadlineAt === undefined ? 30_000 : Math.max(1, Math.floor(deadlineAt - performance.now()));
  const span = isEventLoopTraceEnabled()
    ? beginEventLoopTraceSpan("git_async" as Parameters<typeof beginEventLoopTraceSpan>[0], {
        operationClass: classifyGitOperation(args),
      })
    : null;

  return new Promise<AsyncSpawnOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;
    let spawnError: Error | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable.path, args, {
        cwd: root,
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      span?.({ exitStatusCategory: "spawn_error", timedOut: false });
      resolve({ status: null, signal: null, stdout: "", stderr: "", error: spawnError, timedOut: false, bufferExceeded: false });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const effectiveStatus = timedOut || bufferExceeded || spawnError ? null : code;
      const exitStatusCategory = bufferExceeded
        ? "signal"
        : classifyExitStatus(effectiveStatus, signal, spawnError, timedOut);
      span?.({ exitStatusCategory, timedOut });
      if (bufferExceeded) {
        resolve({
          status: null,
          signal,
          stdout: "",
          stderr: "Git output exceeded maxBuffer",
          error: new Error("maxBuffer exceeded"),
          timedOut: false,
          bufferExceeded: true,
        });
        return;
      }
      resolve({
        status: effectiveStatus,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        error: spawnError,
        timedOut,
        bufferExceeded: false,
      });
    };

    const onStdoutData = (chunk: Buffer): void => handleChunk(chunk, true);
    const onStderrData = (chunk: Buffer): void => handleChunk(chunk, false);

    const terminateAndSettle = (reason: "timeout" | "maxBuffer"): void => {
      if (settled) return;
      if (reason === "timeout") {
        timedOut = true;
      } else {
        bufferExceeded = true;
      }
      stdoutChunks.length = 0;
      stderrChunks.length = 0;
      child.stdout?.off("data", onStdoutData);
      child.stderr?.off("data", onStderrData);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      try {
        if (!child.kill("SIGKILL")) child.kill();
      } catch {
        try { child.kill(); } catch { /* process may already have exited */ }
      }
      finish(null, "SIGKILL");
    };

    const handleChunk = (chunk: Buffer, isStdout: boolean): void => {
      if (settled || bufferExceeded) return;
      if (isStdout) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_GIT_BUFFER_BYTES) {
          terminateAndSettle("maxBuffer");
          return;
        }
        stdoutChunks.push(chunk);
      } else {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_GIT_BUFFER_BYTES) {
          terminateAndSettle("maxBuffer");
          return;
        }
        stderrChunks.push(chunk);
      }
    };

    timer = setTimeout(() => {
      terminateAndSettle("timeout");
    }, remainingMs);
    timer.unref?.();

    child.stdout?.on("data", onStdoutData);
    child.stderr?.on("data", onStderrData);
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

const CONTROLLED_CONFIG_LIST_ARGS = [
  ...SAFE_GIT_GLOBAL_ARGS,
  "config",
  "--no-includes",
  "--null",
  "--list",
];

type ControlledConfigParseResult =
  | { kind: "unstable" }
  | { kind: "unsafe_filter" }
  | { kind: "ok"; filterKeys: string[]; promisorKeys: string[]; upstreamRelRef: string | null };

function parseControlledGitConfig(
  status: number | null,
  stdout: string,
  targetBranch: string | null
): ControlledConfigParseResult {
  if (status !== 0) return { kind: "unstable" };
  if (Buffer.byteLength(stdout, "utf8") > MAX_CONTROLLED_CONFIG_STDOUT_BYTES) {
    return { kind: "unstable" };
  }

  const rawFilterKeys: string[] = [];
  const rawPromisorKeys: string[] = [];
  let branchRemote: string | null = null;
  let branchMerge: string | null = null;
  const remoteKey = targetBranch !== null ? `branch.${targetBranch}.remote` : null;
  const mergeKey = targetBranch !== null ? `branch.${targetBranch}.merge` : null;

  if (stdout.length > 0) {
    const records = stdout.split("\0");
    // `--null` output terminates each entry with NUL, producing a single trailing empty element.
    const count = records[records.length - 1] === "" ? records.length - 1 : records.length;
    for (let i = 0; i < count; i += 1) {
      const record = records[i]!;
      const nlIndex = record.indexOf("\n");
      const key = nlIndex === -1 ? record : record.slice(0, nlIndex);
      const value = nlIndex === -1 ? null : record.slice(nlIndex + 1);
      if (key.length === 0) return { kind: "unstable" };
      if (INCLUDE_CONFIG_KEY_PATTERN.test(key)) {
        return { kind: "unstable" };
      }
      // Match across line/paragraph separators such as U+2028 so unusual
      // subsection names are always surfaced to strict override validation.
      if (FILTER_EXECUTION_KEY_PATTERN.test(key)) {
        rawFilterKeys.push(key);
      }
      if (PROMISOR_CONFIG_KEY_PATTERN.test(key)) {
        rawPromisorKeys.push(key);
      }
      if (value !== null) {
        if (remoteKey !== null && key === remoteKey) branchRemote = value;
        else if (mergeKey !== null && key === mergeKey) branchMerge = value;
      }
    }
  }

  const filterKeys = [...new Set(rawFilterKeys)];
  // `-c key=` parses the key using config syntax. Restrict names to the
  // unambiguous subset we can represent exactly on the command line.
  if (filterKeys.some((key) => !SAFE_FILTER_CONFIG_OVERRIDE_PATTERN.test(key))) {
    return { kind: "unsafe_filter" };
  }
  const overrideBytes = filterKeys.reduce((total, key) => total + Buffer.byteLength(key, "utf8") + 4, 0);
  if (filterKeys.length > MAX_FILTER_CONFIG_OVERRIDES || overrideBytes > MAX_FILTER_CONFIG_OVERRIDE_BYTES) {
    return { kind: "unsafe_filter" };
  }

  const promisorKeys = [...new Set(rawPromisorKeys)];
  if (
    promisorKeys.length > MAX_PROMISOR_CONFIG_KEYS ||
    promisorKeys.some((key) => key.startsWith("-") || Buffer.byteLength(key, "utf8") > MAX_PROMISOR_CONFIG_KEY_BYTES)
  ) {
    return { kind: "unstable" };
  }

  let upstreamRelRef: string | null = null;
  if (branchRemote && branchMerge && branchMerge.startsWith("refs/heads/")) {
    const candidate = branchRemote === "."
      ? branchMerge
      : `refs/remotes/${branchRemote}/${branchMerge.slice("refs/heads/".length)}`;
    if (isSafeRelRef(candidate)) upstreamRelRef = candidate;
  }

  return { kind: "ok", filterKeys, promisorKeys, upstreamRelRef };
}

function unstableConfigPolicyError(options: GitReadOptions, message = "Unable to establish a stable Git configuration policy"): GitCommandResult {
  assertGitDeadline(options);
  return {
    ok: false,
    stdout: "",
    stderr: message,
    code: null,
  };
}

function prepareGitExecution(root: string, options: GitReadOptions): { executable: GitExecutable; env: NodeJS.ProcessEnv } {
  if (options.deadlineAt !== undefined && (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= 0)) {
    throw new RangeError("deadlineAt must be a positive finite performance.now() timestamp");
  }
  if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt) {
    throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
  }
  const executable = resolveTrustedGitExecutable(root);
  assertGitDeadline(options);
  if (!executable) {
    throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Unable to establish a trusted Git executable.");
  }
  return { executable, env: createGitEnvironment() };
}

function buildFilteredGitArgs(args: string[], filterKeys: string[]): string[] {
  const filterOverrides = filterKeys.flatMap((key) => ["-c", `${key}=`]);
  if (args[0] === "diff") {
    return [
      ...SAFE_GIT_GLOBAL_ARGS,
      ...filterOverrides,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--submodule=short",
      "--ignore-submodules=dirty",
      ...args.slice(1),
    ];
  }
  if (args[0] === "status") {
    return [
      ...SAFE_GIT_GLOBAL_ARGS,
      ...filterOverrides,
      "status",
      "--ignore-submodules=dirty",
      ...args.slice(1),
    ];
  }
  return [...SAFE_GIT_GLOBAL_ARGS, ...filterOverrides, ...args];
}

function prepareControlledExecution(
  root: string,
  options: GitReadOptions,
  env: NodeJS.ProcessEnv
): { layout: ControlledRepositoryLayout; view: ControlledGitView } | GitCommandResult {
  const layoutResolution = resolveControlledRepositoryLayout(root);
  assertGitDeadline(options);
  if (layoutResolution.kind === "not_repo") {
    return { ok: false, stdout: "", stderr: "not a git repository", code: 128 };
  }
  if (layoutResolution.kind === "unsafe") {
    return unstableConfigPolicyError(options);
  }
  const view = createControlledGitView(layoutResolution.layout, env);
  if (!view) {
    return unstableConfigPolicyError(options);
  }
  return { layout: layoutResolution.layout, view };
}

function buildPromisorUnsetArgs(configFile: string, key: string): string[] {
  return [...SAFE_GIT_GLOBAL_ARGS, "config", "--no-includes", "--file", configFile, "--unset-all", key];
}

function finalizeControlledPolicyArgs(
  root: string,
  args: string[],
  executable: GitExecutable,
  view: ControlledGitView,
  configStatus: number | null,
  configStdout: string,
  options: GitReadOptions
): { ok: true; safeArgs: string[]; promisorKeys: string[] } | { ok: false; result: GitCommandResult } {
  const parsed = parseControlledGitConfig(
    configStatus,
    configStdout,
    args[0] === "status" ? view.currentBranch : null
  );
  if (parsed.kind !== "ok") {
    return {
      ok: false,
      result: unstableConfigPolicyError(
        options,
        parsed.kind === "unsafe_filter"
          ? "Unable to establish a safe Git filter policy"
          : "Unable to establish a stable Git configuration policy"
      ),
    };
  }

  if (args[0] === "status" && parsed.upstreamRelRef) {
    if (view.copyLooseRefIfPresent(parsed.upstreamRelRef).status === "unsafe") {
      return { ok: false, result: unstableConfigPolicyError(options) };
    }
  }

  if (!reverifyExecutableBinding(root, executable)) {
    throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Unable to establish a trusted Git executable.");
  }

  return { ok: true, safeArgs: buildFilteredGitArgs(args, parsed.filterKeys), promisorKeys: parsed.promisorKeys };
}

function stripPromisorConfigSync(
  root: string,
  layout: ControlledRepositoryLayout,
  executable: GitExecutable,
  view: ControlledGitView,
  promisorKeys: string[],
  options: GitReadOptions
): GitCommandResult | null {
  if (promisorKeys.length === 0) return null;
  if (view.configFiles.length === 0) return unstableConfigPolicyError(options);

  for (const key of promisorKeys) {
    let unsetMatched = false;
    for (const configFile of view.configFiles) {
      assertGitDeadline(options);
      const unsetResult = spawnGit(
        executable.path,
        layout.canonicalRoot,
        buildPromisorUnsetArgs(configFile, key),
        view.viewEnv,
        options.deadlineAt
      );
      const unsetTimedOut = (unsetResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
      if (options.deadlineAt !== undefined && (unsetTimedOut || performance.now() >= options.deadlineAt)) {
        throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
      }
      if (unsetResult.status === 0) {
        unsetMatched = true;
      } else if (unsetResult.status !== 5) {
        return unstableConfigPolicyError(options);
      }
    }
    if (!unsetMatched) return unstableConfigPolicyError(options);
  }

  if (!reverifyExecutableBinding(root, executable)) {
    throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Unable to establish a trusted Git executable.");
  }
  return null;
}

async function stripPromisorConfigAsync(
  root: string,
  layout: ControlledRepositoryLayout,
  executable: GitExecutable,
  view: ControlledGitView,
  promisorKeys: string[],
  options: GitReadOptions
): Promise<GitCommandResult | null> {
  if (promisorKeys.length === 0) return null;
  if (view.configFiles.length === 0) return unstableConfigPolicyError(options);

  for (const key of promisorKeys) {
    let unsetMatched = false;
    for (const configFile of view.configFiles) {
      assertGitDeadline(options);
      const unsetResult = await spawnGitAsync(
        executable,
        layout.canonicalRoot,
        buildPromisorUnsetArgs(configFile, key),
        view.viewEnv,
        options.deadlineAt
      );
      if (options.deadlineAt !== undefined && (unsetResult.timedOut || performance.now() >= options.deadlineAt)) {
        throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
      }
      if (unsetResult.bufferExceeded) {
        return unstableConfigPolicyError(options);
      }
      if (unsetResult.status === 0) {
        unsetMatched = true;
      } else if (unsetResult.status !== 5) {
        return unstableConfigPolicyError(options);
      }
    }
    if (!unsetMatched) return unstableConfigPolicyError(options);
  }

  if (!reverifyExecutableBinding(root, executable)) {
    throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Unable to establish a trusted Git executable.");
  }
  return null;
}

export function runGit(root: string, args: string[], options: GitReadOptions = {}): GitCommandResult {
  const { executable, env } = prepareGitExecution(root, options);
  const useControlledView = needsControlledGitView(args);

  if (!useControlledView) {
    const safeArgs = [...SAFE_GIT_GLOBAL_ARGS, ...args];
    assertGitDeadline(options);
    const result = spawnGit(executable.path, root, safeArgs, env, options.deadlineAt);
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (options.deadlineAt !== undefined && (timedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  }

  const prepared = prepareControlledExecution(root, options, env);
  if ("ok" in prepared) return prepared;
  const { layout, view } = prepared;

  try {
    assertGitDeadline(options);
    const configResult = spawnGit(
      executable.path,
      layout.canonicalRoot,
      CONTROLLED_CONFIG_LIST_ARGS,
      view.viewEnv,
      options.deadlineAt
    );
    const configTimedOut = (configResult.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (options.deadlineAt !== undefined && (configTimedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }

    const finalized = finalizeControlledPolicyArgs(
      root,
      args,
      executable,
      view,
      configResult.status,
      configResult.stdout ?? "",
      options
    );
    if (!finalized.ok) return finalized.result;

    const stripError = stripPromisorConfigSync(
      root,
      layout,
      executable,
      view,
      finalized.promisorKeys,
      options
    );
    if (stripError) return stripError;

    assertGitDeadline(options);
    const result = spawnGit(executable.path, layout.canonicalRoot, finalized.safeArgs, view.viewEnv, options.deadlineAt);
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    if (options.deadlineAt !== undefined && (timedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.status,
    };
  } finally {
    view.cleanup();
  }
}

export async function runGitAsync(root: string, args: string[], options: GitReadOptions = {}): Promise<GitCommandResult> {
  const { executable, env } = prepareGitExecution(root, options);
  const useControlledView = needsControlledGitView(args);

  if (!useControlledView) {
    const safeArgs = [...SAFE_GIT_GLOBAL_ARGS, ...args];
    assertGitDeadline(options);
    const result = await spawnGitAsync(executable, root, safeArgs, env, options.deadlineAt);
    if (options.deadlineAt !== undefined && (result.timedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    if (result.bufferExceeded) {
      return { ok: false, stdout: "", stderr: result.stderr, code: null };
    }
    return {
      ok: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.status,
    };
  }

  const prepared = prepareControlledExecution(root, options, env);
  if ("ok" in prepared) return prepared;
  const { layout, view } = prepared;

  try {
    assertGitDeadline(options);
    const configResult = await spawnGitAsync(
      executable,
      layout.canonicalRoot,
      CONTROLLED_CONFIG_LIST_ARGS,
      view.viewEnv,
      options.deadlineAt
    );
    if (options.deadlineAt !== undefined && (configResult.timedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }

    const finalized = finalizeControlledPolicyArgs(
      root,
      args,
      executable,
      view,
      configResult.bufferExceeded ? null : configResult.status,
      configResult.stdout,
      options
    );
    if (!finalized.ok) return finalized.result;

    const stripError = await stripPromisorConfigAsync(
      root,
      layout,
      executable,
      view,
      finalized.promisorKeys,
      options
    );
    if (stripError) return stripError;

    assertGitDeadline(options);
    const result = await spawnGitAsync(
      executable,
      layout.canonicalRoot,
      finalized.safeArgs,
      view.viewEnv,
      options.deadlineAt
    );
    if (options.deadlineAt !== undefined && (result.timedOut || performance.now() >= options.deadlineAt)) {
      throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
    }
    if (result.bufferExceeded) {
      return { ok: false, stdout: "", stderr: result.stderr, code: null };
    }
    return {
      ok: result.status === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.status,
    };
  } finally {
    view.cleanup();
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  /** `null` means status could not be safely established. */
  dirty: boolean | null;
}

export function gitInfo(root: string): GitInfo {
  const check = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const branch = runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = runGit(root, ["rev-parse", "--short", "HEAD"]);
  // Pathspec confines the result to the workspace subtree even when the
  // workspace root sits inside a larger repository.
  const status = runGit(root, ["status", "--porcelain", "--", "."]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
  };
}

export async function gitInfoAsync(root: string): Promise<GitInfo> {
  const check = await runGitAsync(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!check.ok || check.stdout.trim() !== "true") {
    return { isRepo: false, branch: null, commit: null, dirty: false };
  }
  const [branch, commit, status] = await Promise.all([
    runGitAsync(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGitAsync(root, ["rev-parse", "--short", "HEAD"]),
    // Pathspec confines the result to the workspace subtree even when the
    // workspace root sits inside a larger repository.
    runGitAsync(root, ["status", "--porcelain", "--", "."]),
  ]);
  return {
    isRepo: true,
    branch: branch.ok ? branch.stdout.trim() : null,
    commit: commit.ok ? commit.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
  };
}

export interface WorkspaceLike {
  root: string;
  ignoreRules?: SensitivePathPolicy;
}

export interface SensitivePathPolicy {
  isSensitive(relPath: string): boolean;
}

export type GitTarget = string | WorkspaceLike;

export interface GitRepositorySelection {
  target: WorkspaceLike;
  explicit: boolean;
  isRepo: boolean;
  requestedRepositoryPath: string;
  repositoryPath: string;
  topLevel: string | null;
}

const normPath = (value: string): string =>
  process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function createNestedSensitivePolicy(workspace: Workspace, repositoryRoot: string): SensitivePathPolicy {
  const repositoryRules = new IgnoreRules(repositoryRoot);
  return {
    isSensitive(repositoryRelativePath: string): boolean {
      let absolutePath: string;
      try {
        absolutePath = path.resolve(repositoryRoot, repositoryRelativePath);
      } catch {
        return true;
      }
      if (!isWithinPath(repositoryRoot, absolutePath) || !isWithinPath(workspace.root, absolutePath)) {
        return true;
      }

      const repositoryRelative = path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
      if (repositoryRules.isSensitive(repositoryRelative)) return true;

      const workspaceRelative = path.relative(workspace.root, absolutePath).split(path.sep).join("/");
      return workspaceRelative !== "" && workspace.ignoreRules.isSensitive(workspaceRelative);
    },
  };
}

function prepareGitRepositoryTarget(
  workspace: Workspace,
  requestedRepositoryPath?: string
): { explicit: boolean; resolved: { abs: string; rel: string }; target: WorkspaceLike } {
  const explicit = requestedRepositoryPath !== undefined;
  const resolved = explicit
    ? workspace.resolveRepositoryPath(requestedRepositoryPath)
    : { abs: workspace.root, rel: "" };
  const root = resolved.abs;
  const target: WorkspaceLike = explicit
    ? { root, ignoreRules: createNestedSensitivePolicy(workspace, root) }
    : workspace;
  return { explicit, resolved, target };
}

function finalizeGitRepositorySelection(
  workspace: Workspace,
  prepared: ReturnType<typeof prepareGitRepositoryTarget>,
  topResult: GitCommandResult
): GitRepositorySelection {
  let topAbs: string | null = null;
  let topLevel: string | null = null;
  if (topResult.ok) {
    try {
      const canonicalTop = workspace.resolve(topResult.stdout.trim(), { allowSensitive: true });
      topAbs = canonicalTop.abs;
      topLevel = canonicalTop.rel || ".";
    } catch (error) {
      // A parent repository outside the connected workspace is not a valid
      // explicit target, and its path must not be returned to the caller.
      if (!(error instanceof WorkspaceError)) throw error;
    }
  }
  const isRepo = prepared.explicit
    ? topAbs !== null && normPath(topAbs) === normPath(prepared.target.root)
    : topResult.ok;
  return {
    target: prepared.target,
    explicit: prepared.explicit,
    isRepo,
    requestedRepositoryPath: prepared.resolved.rel || ".",
    repositoryPath: prepared.resolved.rel || ".",
    topLevel: isRepo ? topLevel : null,
  };
}

/** Resolve an optional workspace-relative repository selector without allowing parent-repo fallback. */
export function selectGitRepository(
  workspace: Workspace,
  requestedRepositoryPath?: string,
  options: GitReadOptions = {}
): GitRepositorySelection {
  assertGitDeadline(options);
  const prepared = prepareGitRepositoryTarget(workspace, requestedRepositoryPath);
  const topResult = runGit(prepared.target.root, ["rev-parse", "--show-toplevel"], options);
  assertGitDeadline(options);
  return finalizeGitRepositorySelection(workspace, prepared, topResult);
}

/** Async version of {@link selectGitRepository}. */
export async function selectGitRepositoryAsync(
  workspace: Workspace,
  requestedRepositoryPath?: string,
  options: GitReadOptions = {}
): Promise<GitRepositorySelection> {
  assertGitDeadline(options);
  const prepared = prepareGitRepositoryTarget(workspace, requestedRepositoryPath);
  const topResult = await runGitAsync(prepared.target.root, ["rev-parse", "--show-toplevel"], options);
  assertGitDeadline(options);
  return finalizeGitRepositorySelection(workspace, prepared, topResult);
}

export interface GitRepositoryInfo {
  isRepo: boolean;
  requestedRepositoryPath: string;
  repositoryPath: string;
  topLevel: string | null;
  branch: string | null;
  head: string | null;
  /** `null` means status could not be safely established. */
  dirty: boolean | null;
}

function emptyGitRepositoryInfo(selection: GitRepositorySelection): GitRepositoryInfo {
  return {
    isRepo: false,
    requestedRepositoryPath: selection.requestedRepositoryPath,
    repositoryPath: selection.repositoryPath,
    topLevel: null,
    branch: null,
    head: null,
    dirty: false,
  };
}

export function gitRepositoryInfo(selection: GitRepositorySelection, options: GitReadOptions = {}): GitRepositoryInfo {
  assertGitDeadline(options);
  const empty = emptyGitRepositoryInfo(selection);
  if (!selection.isRepo) return empty;

  const branch = runGit(selection.target.root, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  assertGitDeadline(options);
  const head = runGit(selection.target.root, ["rev-parse", "HEAD"], options);
  assertGitDeadline(options);
  const status = runGit(selection.target.root, ["status", "--porcelain", "--", "."], options);
  assertGitDeadline(options);
  return {
    ...empty,
    isRepo: true,
    topLevel: selection.topLevel,
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
  };
}

/** Async version of {@link gitRepositoryInfo}. */
export async function gitRepositoryInfoAsync(
  selection: GitRepositorySelection,
  options: GitReadOptions = {}
): Promise<GitRepositoryInfo> {
  assertGitDeadline(options);
  const empty = emptyGitRepositoryInfo(selection);
  if (!selection.isRepo) return empty;

  const [branch, head, status] = await Promise.all([
    runGitAsync(selection.target.root, ["rev-parse", "--abbrev-ref", "HEAD"], options),
    runGitAsync(selection.target.root, ["rev-parse", "HEAD"], options),
    runGitAsync(selection.target.root, ["status", "--porcelain", "--", "."], options),
  ]);
  assertGitDeadline(options);
  return {
    ...empty,
    isRepo: true,
    topLevel: selection.topLevel,
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    dirty: status.ok ? status.stdout.trim().length > 0 : null,
  };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  conflicted: string[];
  /** Sensitive entries withheld. `conflicts` stays separate so a merge is not reported as clean. */
  hidden: { changes: number; conflicts: number };
}

function emptyGitStatus(): GitStatusResult {
  return {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
    hidden: { changes: 0, conflicts: 0 },
  };
}

function parseGitStatusResult(
  statusStdout: string,
  prefixStdout: string,
  ignoreRules: SensitivePathPolicy,
  options: GitReadOptions
): GitStatusResult {
  const empty = emptyGitStatus();
  const repositoryPrefix = prefixStdout.replace(/\r?\n$/, "");
  const toWorkspacePath = (repositoryPath: string): string | null => {
    if (!repositoryPrefix) return repositoryPath;
    return repositoryPath.startsWith(repositoryPrefix)
      ? repositoryPath.slice(repositoryPrefix.length)
      : null;
  };
  const out: GitStatusResult = { ...empty, hidden: { ...empty.hidden }, isRepo: true };
  const withheld = (paths: string[]): boolean => paths.some((p) => isSensitiveGitPath(ignoreRules, p));

  const fields = (record: string, separatorCount: number): string[] | null => {
    const values: string[] = [];
    let start = 0;
    for (let i = 0; i < separatorCount; i += 1) {
      const separator = record.indexOf(" ", start);
      if (separator < 0) return null;
      values.push(record.slice(start, separator));
      start = separator + 1;
    }
    values.push(record.slice(start));
    return values;
  };

  const records = statusStdout.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    assertGitDeadline(options);
    const line = records[i] ?? "";
    if (line.startsWith("# branch.head ")) {
      out.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        out.ahead = parseInt(m[1], 10);
        out.behind = parseInt(m[2], 10);
      }
    } else if (line.startsWith("1 ")) {
      const parts = fields(line, 8);
      if (!parts || parts.length !== 9 || parts[1]?.length !== 2 || !parts[8]) return empty;
      const xy = parts[1] ?? "";
      const filePath = toWorkspacePath(parts[8] ?? "");
      if (!filePath) return empty;
      if (withheld([filePath])) {
        out.hidden.changes += (xy[0] !== "." ? 1 : 0) + (xy[1] !== "." ? 1 : 0);
        continue;
      }
      if (xy[0] !== ".") out.staged.push({ path: filePath, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: filePath, change: xy[1] });
    } else if (line.startsWith("2 ")) {
      const parts = fields(line, 9);
      if (!parts || parts.length !== 10 || parts[1]?.length !== 2 || !parts[9]) return empty;
      const xy = parts[1] ?? "";
      const destination = toWorkspacePath(parts[9] ?? "");
      const origin = toWorkspacePath(records[i + 1] ?? "");
      if (!destination || !origin) return empty;
      i += 1;
      if (withheld([destination, origin])) {
        out.hidden.changes += (xy[0] !== "." ? 1 : 0) + (xy[1] !== "." ? 1 : 0);
        continue;
      }
      const filePath = `${origin} -> ${destination}`;
      if (xy[0] !== ".") out.staged.push({ path: filePath, change: xy[0] });
      if (xy[1] !== ".") out.unstaged.push({ path: filePath, change: xy[1] });
    } else if (line.startsWith("? ")) {
      if (line.length <= 2) return empty;
      const filePath = toWorkspacePath(line.slice(2));
      if (!filePath) return empty;
      if (withheld([filePath])) out.hidden.changes += 1;
      else out.untracked.push(filePath);
    } else if (line.startsWith("u ")) {
      const parts = fields(line, 10);
      if (!parts || parts.length !== 11 || parts[1]?.length !== 2 || !parts[10]) return empty;
      const filePath = toWorkspacePath(parts[10] ?? "");
      if (!filePath) return empty;
      if (withheld([filePath])) out.hidden.conflicts += 1;
      else out.conflicted.push(filePath);
    } else if (line && !line.startsWith("#")) {
      return empty;
    }
  }
  assertGitDeadline(options);
  return out;
}

export function gitStatus(target: GitTarget, options: GitReadOptions = {}): GitStatusResult {
  assertGitDeadline(options);
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const result = runGit(root, ["status", "--porcelain=v2", "-z", "--branch", "--", "."], options);
  assertGitDeadline(options);
  if (!result.ok) return emptyGitStatus();
  const prefixResult = runGit(root, ["rev-parse", "--show-prefix"], options);
  assertGitDeadline(options);
  if (!prefixResult.ok) return emptyGitStatus();
  return parseGitStatusResult(result.stdout, prefixResult.stdout, ignoreRules, options);
}

/** Async version of {@link gitStatus}. */
export async function gitStatusAsync(target: GitTarget, options: GitReadOptions = {}): Promise<GitStatusResult> {
  assertGitDeadline(options);
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules ? target.ignoreRules : new IgnoreRules(root);
  const [result, prefixResult] = await Promise.all([
    runGitAsync(root, ["status", "--porcelain=v2", "-z", "--branch", "--", "."], options),
    runGitAsync(root, ["rev-parse", "--show-prefix"], options),
  ]);
  assertGitDeadline(options);
  if (!result.ok || !prefixResult.ok) return emptyGitStatus();
  return parseGitStatusResult(result.stdout, prefixResult.stdout, ignoreRules, options);
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

function getDiffModeArgs(mode: DiffMode): string[] {
  if (mode === "staged") return ["--cached"];
  if (mode === "head") return ["HEAD"];
  return [];
}

function chunkSafePaths(paths: string[], maxCount = 50, maxBytes = 32 * 1024): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentBytes = 0;

  for (const p of paths) {
    const pBytes = Buffer.byteLength(p, "utf8") + 12; // overhead for ":(literal)"
    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxCount || currentBytes + pBytes > maxBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }
    currentBatch.push(p);
    currentBytes += pBytes;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches;
}

function isPathInScope(filePath: string, scope?: string): boolean {
  if (!scope || scope === ".") return true;
  return filePath === scope || filePath.startsWith(scope + "/");
}

function isSensitiveGitPath(ignoreRules: SensitivePathPolicy, filePath: string): boolean {
  if (ignoreRules.isSensitive(filePath)) return true;
  // Windows filesystems are normally case-insensitive. Match the policy after
  // folding the candidate so historical names such as `.ENV` cannot bypass a
  // `.env` rule when Git preserves their original casing.
  return process.platform === "win32" && ignoreRules.isSensitive(filePath.toLowerCase());
}

function emptyGitDiff(mode: DiffMode): GitDiffResult {
  return {
    isRepo: false,
    mode,
    totalBytes: 0,
    offset: 0,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
  };
}

function extractSafeDiffPaths(
  stdout: string,
  ignoreRules: SensitivePathPolicy,
  relPath: string | undefined,
  options: GitReadOptions
): string[] {
  const tokens = stdout.split("\0");
  const safePaths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    assertGitDeadline(options);
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) {
        // Layer 1: Security - EITHER side sensitive -> completely unsafe
        const isSafe = !isSensitiveGitPath(ignoreRules, oldPath) && !isSensitiveGitPath(ignoreRules, newPath);
        // Layer 2: Scope - EITHER side in scope -> relevant
        const isRelevant = isPathInScope(oldPath, relPath) || isPathInScope(newPath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(oldPath, newPath);
        }
      }
    } else {
      const filePath = tokens[i++];
      if (filePath) {
        const isSafe = !isSensitiveGitPath(ignoreRules, filePath);
        const isRelevant = isPathInScope(filePath, relPath);
        if (isSafe && isRelevant) {
          safePaths.push(filePath);
        }
      }
    }
  }
  return safePaths;
}

function paginateGitDiff(
  combinedDiff: string,
  mode: DiffMode,
  offset: number,
  maxBytes: number,
  options: GitReadOptions
): GitDiffResult {
  const page = paginateCompareDiff(combinedDiff, offset, maxBytes);
  assertGitDeadline(options);
  return {
    isRepo: true,
    mode,
    ...page,
  };
}

export function gitDiff(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string,
  options: GitReadOptions = {}
): GitDiffResult {
  assertGitDeadline(options);
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const modeArgs = getDiffModeArgs(mode);

  // 1. Full-workspace inventory using NUL separation and global rename detection
  const listArgs = [
    "diff",
    "--relative",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = runGit(root, listArgs, options);
  assertGitDeadline(options);
  if (!listResult.ok) return emptyGitDiff(mode);

  const safePaths = extractSafeDiffPaths(listResult.stdout, ignoreRules, relPath, options);
  if (safePaths.length === 0) {
    assertGitDeadline(options);
    return { ...emptyGitDiff(mode), isRepo: true };
  }

  // 2. Fetch diffs for safe paths in bounded batches (path count + argv bytes)
  const batches = chunkSafePaths(safePaths);
  let combinedDiff = "";
  let totalAggregateBytes = 0;

  for (const batch of batches) {
    assertGitDeadline(options);
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--relative",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = runGit(root, diffArgs, options);
    assertGitDeadline(options);
    if (!diffResult.ok) return emptyGitDiff(mode);
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_GIT_BUFFER_BYTES) return emptyGitDiff(mode);
      combinedDiff += diffResult.stdout;
      totalAggregateBytes += chunkBytes;
    }
  }

  return paginateGitDiff(combinedDiff, mode, offset, maxBytes, options);
}

/** Async version of {@link gitDiff}. */
export async function gitDiffAsync(
  target: GitTarget,
  opts: GitDiffOptions = {},
  relPath?: string,
  options: GitReadOptions = {}
): Promise<GitDiffResult> {
  assertGitDeadline(options);
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));
  const modeArgs = getDiffModeArgs(mode);

  const listArgs = [
    "diff",
    "--relative",
    "--name-status",
    "-z",
    "--find-renames=1%",
    ...modeArgs,
    "--",
    ".",
  ];
  const listResult = await runGitAsync(root, listArgs, options);
  assertGitDeadline(options);
  if (!listResult.ok) return emptyGitDiff(mode);

  const safePaths = extractSafeDiffPaths(listResult.stdout, ignoreRules, relPath, options);
  if (safePaths.length === 0) {
    assertGitDeadline(options);
    return { ...emptyGitDiff(mode), isRepo: true };
  }

  const batches = chunkSafePaths(safePaths);
  let combinedDiff = "";
  let totalAggregateBytes = 0;

  for (const batch of batches) {
    assertGitDeadline(options);
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffArgs = [
      "diff",
      "--relative",
      "--no-color",
      "--find-renames=1%",
      ...modeArgs,
      "--",
      ...pathspecs,
    ];
    const diffResult = await runGitAsync(root, diffArgs, options);
    assertGitDeadline(options);
    if (!diffResult.ok) return emptyGitDiff(mode);
    if (diffResult.stdout) {
      const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
      if (totalAggregateBytes + chunkBytes > MAX_GIT_BUFFER_BYTES) return emptyGitDiff(mode);
      combinedDiff += diffResult.stdout;
      totalAggregateBytes += chunkBytes;
    }
  }

  return paginateGitDiff(combinedDiff, mode, offset, maxBytes, options);
}


const COMMIT_INPUT_RE = /^[a-fA-F0-9]{7,64}$/;
const FULL_COMMIT_RE = /^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/;

export function resolveGitCommit(root: string, commit: string): string | null {
  if (!COMMIT_INPUT_RE.test(commit)) return null;
  const resolved = runGit(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (!resolved.ok) return null;
  const value = resolved.stdout.trim();
  return FULL_COMMIT_RE.test(value) ? value.toLowerCase() : null;
}

/** Async version of {@link resolveGitCommit}. */
export async function resolveGitCommitAsync(root: string, commit: string): Promise<string | null> {
  if (!COMMIT_INPUT_RE.test(commit)) return null;
  const resolved = await runGitAsync(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
  if (!resolved.ok) return null;
  const value = resolved.stdout.trim();
  return FULL_COMMIT_RE.test(value) ? value.toLowerCase() : null;
}

export interface GitCompareFile {
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCompareOptions {
  baseCommit: string;
  headCommit: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitCompareResult {
  isRepo: boolean;
  baseCommit: string;
  headCommit: string;
  files: GitCompareFile[];
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

interface CompareInventoryEntry {
  path: string;
  previousPath: string | null;
  status: string;
  safePaths: string[];
}

interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

function emptyGitCompare(baseCommit: string, headCommit: string): GitCompareResult {
  return {
    isRepo: false,
    baseCommit,
    headCommit,
    files: [],
    totalBytes: 0,
    offset: 0,
    returnedBytes: 0,
    hasMore: false,
    nextOffset: null,
    diff: "",
  };
}

function compareKey(pathValue: string, previousPath: string | null): string {
  return previousPath === null ? `P\0${pathValue}` : `R\0${previousPath}\0${pathValue}`;
}

function parseCompareInventory(
  stdout: string,
  ignoreRules: SensitivePathPolicy,
  relPath?: string
): CompareInventoryEntry[] | null {
  const tokens = stdout.split("\0");
  const entries: CompareInventoryEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (!oldPath || !newPath) return null;
      const safe = !isSensitiveGitPath(ignoreRules, oldPath) && !isSensitiveGitPath(ignoreRules, newPath);
      const relevant = isPathInScope(oldPath, relPath) || isPathInScope(newPath, relPath);
      if (safe && relevant) {
        entries.push({
          path: newPath,
          previousPath: oldPath,
          status,
          safePaths: [oldPath, newPath],
        });
      }
    } else {
      const filePath = tokens[i++];
      if (!filePath) return null;
      const safe = !isSensitiveGitPath(ignoreRules, filePath);
      const relevant = isPathInScope(filePath, relPath);
      if (safe && relevant) {
        entries.push({
          path: filePath,
          previousPath: null,
          status,
          safePaths: [filePath],
        });
      }
    }
  }
  return entries;
}

function parseNumstat(stdout: string): Map<string, NumstatEntry> | null {
  const tokens = stdout.split("\0");
  const stats = new Map<string, NumstatEntry>();
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i++];
    if (!token) break;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (!match) return null;
    const additions = match[1] === "-" ? null : Number.parseInt(match[1], 10);
    const deletions = match[2] === "-" ? null : Number.parseInt(match[2], 10);
    const binary = additions === null || deletions === null;
    const inlinePath = match[3];
    if (inlinePath) {
      stats.set(compareKey(inlinePath, null), { additions, deletions, binary });
      continue;
    }
    const oldPath = tokens[i++];
    const newPath = tokens[i++];
    if (!oldPath || !newPath) return null;
    stats.set(compareKey(newPath, oldPath), { additions, deletions, binary });
  }
  return stats;
}

function paginateCompareDiff(
  combinedDiff: string,
  offsetInput?: number,
  maxBytesInput?: number
): Pick<GitCompareResult, "totalBytes" | "offset" | "returnedBytes" | "hasMore" | "nextOffset" | "diff"> {
  const full = Buffer.from(combinedDiff, "utf8");
  const requestedOffset = Number.isFinite(offsetInput) ? Math.floor(offsetInput ?? 0) : 0;
  let offset = Math.min(full.length, Math.max(0, requestedOffset));
  // Pages always begin at a UTF-8 boundary, including when a caller supplies
  // an arbitrary byte offset rather than a returned nextOffset.
  while (offset > 0 && offset < full.length && (full[offset]! & 0xc0) === 0x80) offset -= 1;

  const requestedMaxBytes = Number.isFinite(maxBytesInput) ? Math.floor(maxBytesInput ?? 64 * 1024) : 64 * 1024;
  const maxBytes = Math.min(256 * 1024, Math.max(1024, requestedMaxBytes));
  let end = Math.min(full.length, offset + maxBytes);
  if (end < full.length) {
    const newline = full.lastIndexOf(0x0a, end - 1);
    if (newline >= offset) {
      end = newline + 1;
    } else {
      // A diff line can be longer than the page size. Split that line only at
      // a UTF-8 code-point boundary so concatenated pages stay exact.
      while (end > offset && (full[end]! & 0xc0) === 0x80) end -= 1;
    }
  }
  const slice = full.subarray(offset, end);
  const diff = slice.toString("utf8");
  const sliceLen = slice.length;
  const hasMore = end < full.length;
  return {
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? end : null,
    diff,
  };
}

function chunkComparePaths(
  entries: readonly CompareInventoryEntry[],
  maxCount = 50,
  maxBytes = 32 * 1024
): string[][] | null {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const group = [...new Set(entry.safePaths)];
    const groupBytes = group.reduce((total, item) => total + Buffer.byteLength(item, "utf8") + 12, 0);
    // Keep a rename/copy pair together so each diff batch sees both endpoints.
    if (groupBytes > maxBytes) return null;
    if (current.length > 0 && (current.length + group.length > maxCount || currentBytes + groupBytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(...group);
    currentBytes += groupBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function buildCompareFiles(
  inventory: readonly CompareInventoryEntry[],
  stats: Map<string, NumstatEntry>
): GitCompareFile[] | null {
  const files: GitCompareFile[] = [];
  for (const entry of inventory) {
    const stat = stats.get(compareKey(entry.path, entry.previousPath));
    // The inventory and numstat views are generated from the same exact commit
    // pair. A mismatch means we cannot truthfully classify the file, so fail
    // closed instead of returning guessed binary/stat metadata.
    if (!stat) return null;
    files.push({
      path: entry.path,
      previousPath: entry.previousPath,
      status: entry.status,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
    });
  }
  return files;
}

/**
 * Compare two exact historical commits without exposing arbitrary Git arguments.
 * Commit inputs must be hexadecimal object IDs (unique abbreviations accepted).
 * The function resolves both commits to full IDs before diffing and applies the
 * same sensitive-path/filter protections as gitDiff.
 */
export function gitCompare(
  target: GitTarget,
  opts: GitCompareOptions,
  relPath?: string
): GitCompareResult {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const baseCommit = resolveGitCommit(root, opts.baseCommit);
  const headCommit = resolveGitCommit(root, opts.headCommit);
  if (!baseCommit || !headCommit) {
    return emptyGitCompare(opts.baseCommit, opts.headCommit);
  }

  const inventoryResult = runGit(root, [
    "diff",
    "--relative",
    "--name-status",
    "-z",
    "--find-renames=1%",
    baseCommit,
    headCommit,
    "--",
    ".",
  ]);
  if (!inventoryResult.ok) return emptyGitCompare(baseCommit, headCommit);

  const inventory = parseCompareInventory(inventoryResult.stdout, ignoreRules, relPath);
  if (inventory === null) return emptyGitCompare(baseCommit, headCommit);

  const numstatResult = runGit(root, [
    "diff",
    "--relative",
    "--numstat",
    "-z",
    "--find-renames=1%",
    baseCommit,
    headCommit,
    "--",
    ".",
  ]);
  if (!numstatResult.ok) return emptyGitCompare(baseCommit, headCommit);
  const stats = parseNumstat(numstatResult.stdout);
  if (stats === null) return emptyGitCompare(baseCommit, headCommit);

  const files = buildCompareFiles(inventory, stats);
  if (files === null) return emptyGitCompare(baseCommit, headCommit);

  if (inventory.length === 0) {
    return {
      isRepo: true,
      baseCommit,
      headCommit,
      files,
      ...paginateCompareDiff("", opts.offset, opts.maxBytes),
    };
  }

  const batches = chunkComparePaths(inventory);
  if (batches === null) return emptyGitCompare(baseCommit, headCommit);
  let combinedDiff = "";
  let totalAggregateBytes = 0;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffResult = runGit(root, [
      "diff",
      "--relative",
      "--no-color",
      "--find-renames=1%",
      baseCommit,
      headCommit,
      "--",
      ...pathspecs,
    ]);
    if (!diffResult.ok) return emptyGitCompare(baseCommit, headCommit);
    const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
    if (totalAggregateBytes + chunkBytes > MAX_GIT_BUFFER_BYTES) {
      return emptyGitCompare(baseCommit, headCommit);
    }
    combinedDiff += diffResult.stdout;
    totalAggregateBytes += chunkBytes;
  }

  return {
    isRepo: true,
    baseCommit,
    headCommit,
    files,
    ...paginateCompareDiff(combinedDiff, opts.offset, opts.maxBytes),
  };
}

/** Async version of {@link gitCompare}. */
export async function gitCompareAsync(
  target: GitTarget,
  opts: GitCompareOptions,
  relPath?: string
): Promise<GitCompareResult> {
  const root = typeof target === "string" ? target : target.root;
  const ignoreRules =
    typeof target === "object" && target.ignoreRules
      ? target.ignoreRules
      : new IgnoreRules(root);

  const [baseCommit, headCommit] = await Promise.all([
    resolveGitCommitAsync(root, opts.baseCommit),
    resolveGitCommitAsync(root, opts.headCommit),
  ]);
  if (!baseCommit || !headCommit) {
    return emptyGitCompare(opts.baseCommit, opts.headCommit);
  }

  const [inventoryResult, numstatResult] = await Promise.all([
    runGitAsync(root, [
      "diff",
      "--relative",
      "--name-status",
      "-z",
      "--find-renames=1%",
      baseCommit,
      headCommit,
      "--",
      ".",
    ]),
    runGitAsync(root, [
      "diff",
      "--relative",
      "--numstat",
      "-z",
      "--find-renames=1%",
      baseCommit,
      headCommit,
      "--",
      ".",
    ]),
  ]);
  if (!inventoryResult.ok || !numstatResult.ok) return emptyGitCompare(baseCommit, headCommit);

  const inventory = parseCompareInventory(inventoryResult.stdout, ignoreRules, relPath);
  if (inventory === null) return emptyGitCompare(baseCommit, headCommit);
  const stats = parseNumstat(numstatResult.stdout);
  if (stats === null) return emptyGitCompare(baseCommit, headCommit);

  const files = buildCompareFiles(inventory, stats);
  if (files === null) return emptyGitCompare(baseCommit, headCommit);

  if (inventory.length === 0) {
    return {
      isRepo: true,
      baseCommit,
      headCommit,
      files,
      ...paginateCompareDiff("", opts.offset, opts.maxBytes),
    };
  }

  const batches = chunkComparePaths(inventory);
  if (batches === null) return emptyGitCompare(baseCommit, headCommit);
  let combinedDiff = "";
  let totalAggregateBytes = 0;

  for (const batch of batches) {
    const pathspecs = batch.map((p) => `:(literal)${p}`);
    const diffResult = await runGitAsync(root, [
      "diff",
      "--relative",
      "--no-color",
      "--find-renames=1%",
      baseCommit,
      headCommit,
      "--",
      ...pathspecs,
    ]);
    if (!diffResult.ok) return emptyGitCompare(baseCommit, headCommit);
    const chunkBytes = Buffer.byteLength(diffResult.stdout, "utf8");
    if (totalAggregateBytes + chunkBytes > MAX_GIT_BUFFER_BYTES) {
      return emptyGitCompare(baseCommit, headCommit);
    }
    combinedDiff += diffResult.stdout;
    totalAggregateBytes += chunkBytes;
  }

  return {
    isRepo: true,
    baseCommit,
    headCommit,
    files,
    ...paginateCompareDiff(combinedDiff, opts.offset, opts.maxBytes),
  };
}
