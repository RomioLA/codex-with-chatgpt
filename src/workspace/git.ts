import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IgnoreRules } from "./ignore.js";
import { Workspace, WorkspaceError } from "./manager.js";
import {
  assertNoReparsePath,
  readFileMaterial,
  resolveGitExecutable,
  verifyExecutable,
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

const SAFE_GIT_GLOBAL_ARGS = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.editor=:",
  "-c", "sequence.editor=:",
  "-c", "credential.interactive=false",
];

const SAFE_FILTER_CONFIG_OVERRIDE_PATTERN = /^filter\.[A-Za-z0-9._-]+\.(?:clean|process)$/i;
const MAX_FILTER_CONFIG_OVERRIDES = 128;
const MAX_FILTER_CONFIG_OVERRIDE_BYTES = 16 * 1024;
const MAX_GIT_BUFFER_BYTES = 64 * 1024 * 1024;

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
        const verified = verifyExecutable(bound.executable);
        const freshStat = fs.lstatSync(verified.path, { bigint: true });
        TRUSTED_GIT_MATERIALS.set(key, {
          executable: verified,
          size: freshStat.size,
          mtimeNs: freshStat.mtimeNs,
          ctimeNs: freshStat.ctimeNs,
        });
        return verified;
      } catch {
        TRUSTED_GIT_MATERIALS.delete(key);
        continue;
      }
    }
    try {
      const material = readFileMaterial(absolute);
      const trusted = { ...material, path: material.path };
      const stat = fs.lstatSync(trusted.path, { bigint: true });
      TRUSTED_GIT_MATERIALS.set(key, {
        executable: trusted,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
        ctimeNs: stat.ctimeNs,
      });
      return trusted;
    } catch {
      // Untrusted, missing, replaced, or reparse-backed candidates are skipped.
    }
  }
  return null;
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
  executable: string,
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  deadlineAt?: number
): Promise<AsyncSpawnOutcome> {
  if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
    return Promise.reject(new WorkspaceError("DEADLINE", "Git read deadline exceeded"));
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
      child = spawn(executable, args, {
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

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* process may already have exited */ }
    }, remainingMs);
    timer.unref?.();

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

    const handleChunk = (chunk: Buffer, isStdout: boolean): void => {
      if (settled || bufferExceeded) return;
      if (isStdout) {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_GIT_BUFFER_BYTES) {
          bufferExceeded = true;
          stdoutChunks.length = 0;
          stderrChunks.length = 0;
          try { child.kill(); } catch { /* process may already have exited */ }
          return;
        }
        stdoutChunks.push(chunk);
      } else {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_GIT_BUFFER_BYTES) {
          bufferExceeded = true;
          stdoutChunks.length = 0;
          stderrChunks.length = 0;
          try { child.kill(); } catch { /* process may already have exited */ }
          return;
        }
        stderrChunks.push(chunk);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => handleChunk(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => handleChunk(chunk, false));
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

const FILTER_CONFIG_ARGS = [
  ...SAFE_GIT_GLOBAL_ARGS,
  "config",
  "--null",
  "--name-only",
  "--get-regexp",
  "^filter\\..*\\.(clean|process)$",
];

function parseFilterExecutionConfigKeys(status: number | null, stdout: string): string[] | null {
  // `git config --get-regexp` returns 1 when there are no matching keys.
  if (status !== 0 && status !== 1) return null;

  // Git's regexp selected the relevant config keys. Do not pre-filter its
  // output with a broader JS regexp: characters such as U+2028 can be treated
  // as line terminators by JS and silently hide an unsafe key from validation.
  const keys = [...new Set(stdout.split("\0").filter((key) => key.length > 0))];
  // `-c key=` parses the key using config syntax. Restrict names to the
  // unambiguous subset we can represent exactly on the command line.
  if (keys.some((key) => !SAFE_FILTER_CONFIG_OVERRIDE_PATTERN.test(key))) return null;
  const overrideBytes = keys.reduce((total, key) => total + Buffer.byteLength(key, "utf8") + 4, 0);
  if (keys.length > MAX_FILTER_CONFIG_OVERRIDES || overrideBytes > MAX_FILTER_CONFIG_OVERRIDE_BYTES) {
    return null;
  }
  return keys;
}

/** Find configured clean/process filters so worktree queries can disable their commands. */
function getFilterExecutionConfigKeys(
  root: string,
  env: NodeJS.ProcessEnv,
  executable: string,
  deadlineAt?: number
): string[] | null {
  const result = spawnGit(executable, root, FILTER_CONFIG_ARGS, env, deadlineAt);
  return parseFilterExecutionConfigKeys(result.status, result.stdout ?? "");
}

async function getFilterExecutionConfigKeysAsync(
  root: string,
  env: NodeJS.ProcessEnv,
  executable: string,
  deadlineAt?: number
): Promise<string[] | null> {
  const result = await spawnGitAsync(executable, root, FILTER_CONFIG_ARGS, env, deadlineAt);
  if (result.bufferExceeded) return null;
  return parseFilterExecutionConfigKeys(result.status, result.stdout);
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
  return args[0] === "diff"
    ? [
        ...SAFE_GIT_GLOBAL_ARGS,
        ...filterOverrides,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ...args.slice(1),
      ]
    : [...SAFE_GIT_GLOBAL_ARGS, ...filterOverrides, ...args];
}

export function runGit(root: string, args: string[], options: GitReadOptions = {}): GitCommandResult {
  const { executable, env } = prepareGitExecution(root, options);
  let safeArgs = [...SAFE_GIT_GLOBAL_ARGS, ...args];

  if (args[0] === "diff" || args[0] === "status") {
    const filterKeys = getFilterExecutionConfigKeys(root, env, executable.path, options.deadlineAt);
    if (filterKeys === null) {
      assertGitDeadline(options);
      return {
        ok: false,
        stdout: "",
        stderr: "Unable to establish a safe Git filter policy",
        code: null,
      };
    }
    safeArgs = buildFilteredGitArgs(args, filterKeys);
  }

  assertGitDeadline(options);
  const result = spawnGit(executable.path, root, safeArgs, env, options.deadlineAt);
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (options.deadlineAt !== undefined &&
    (timedOut || performance.now() >= options.deadlineAt)) {
    throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

export async function runGitAsync(root: string, args: string[], options: GitReadOptions = {}): Promise<GitCommandResult> {
  const { executable, env } = prepareGitExecution(root, options);
  let safeArgs = [...SAFE_GIT_GLOBAL_ARGS, ...args];

  if (args[0] === "diff" || args[0] === "status") {
    const filterKeys = await getFilterExecutionConfigKeysAsync(root, env, executable.path, options.deadlineAt);
    if (filterKeys === null) {
      assertGitDeadline(options);
      return {
        ok: false,
        stdout: "",
        stderr: "Unable to establish a safe Git filter policy",
        code: null,
      };
    }
    safeArgs = buildFilteredGitArgs(args, filterKeys);
  }

  assertGitDeadline(options);
  const result = await spawnGitAsync(executable.path, root, safeArgs, env, options.deadlineAt);
  if (options.deadlineAt !== undefined &&
    (result.timedOut || performance.now() >= options.deadlineAt)) {
    throw new WorkspaceError("DEADLINE", "Git read deadline exceeded");
  }
  if (result.bufferExceeded) {
    return {
      ok: false,
      stdout: "",
      stderr: result.stderr,
      code: null,
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.status,
  };
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
  const full = Buffer.from(combinedDiff, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  assertGitDeadline(options);
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
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
