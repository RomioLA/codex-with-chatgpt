import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";
import { isProtectedStatePath } from "../workspace/protected-state.js";
import { GitWriteError, type GitWriteMaterial } from "./types.js";

export interface GitConfigEntry {
  origin: string;
  key: string;
  value: string;
}

export interface GitExecutable extends GitWriteMaterial {
  path: string;
}

const NULL_DEVICE = process.platform === "win32" ? "NUL" : os.devNull;

const GIT_WRITE_ENVIRONMENT_BASE: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_KEY_1: "credential.helper",
  GIT_CONFIG_VALUE_1: "",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: ":",
  GIT_SEQUENCE_EDITOR: ":",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GCM_INTERACTIVE: "Never",
  PAGER: "cat",
};

function preflightHooksDirectory(): string {
  const absolute = path.resolve(getStateDir(), "git-write", "preflight");
  const root = path.parse(absolute).root;
  let current = root;
  try {
    for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || norm(fs.realpathSync.native(current)) !== norm(current)) {
        throw new Error("unsafe hooks path");
      }
    }
    const directory = fs.opendirSync(absolute);
    try {
      if (directory.readSync() !== null) throw new Error("hooks path must stay empty");
    } finally {
      try { directory.closeSync(); } catch { /* a completed read may close the handle */ }
    }
    return absolute;
  } catch {
    throw new GitWriteError("STATE_UNAVAILABLE");
  }
}

export function getGitWriteEnvironment(): Record<string, string> {
  return { ...GIT_WRITE_ENVIRONMENT_BASE, GIT_CONFIG_VALUE_0: preflightHooksDirectory() };
}

export const GIT_WRITE_CLEAR_ENVIRONMENT = [
  "GIT_ASKPASS",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
];

export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_GIT_MATERIALS = 256;
const MAX_MATERIALS = MAX_GIT_MATERIALS;
const MAX_MATERIAL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_GIT_PATH_ENTRIES = 100_000;
const MAX_CONFIG_ENTRIES = 20_000;
const SAFE_FILTER_KEY = /^filter\.[A-Za-z0-9._-]+\.(?:clean|smudge|process)$/i;
const SAFE_DIFF_TEXTCONV_KEY = /^diff\.[A-Za-z0-9._-]+\.textconv$/i;

function norm(value: string): string {
  return process.platform === "win32" || process.platform === "darwin" ? value.toLowerCase() : value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertNoReparsePath(input: string, allowMissingTail = false): string {
  const absolute = path.resolve(input);
  const root = path.parse(absolute).root;
  const components = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingTail && (error as NodeJS.ErrnoException).code === "ENOENT") return absolute;
      throw new GitWriteError("INVALID_ARGUMENTS");
    }
    if (stat.isSymbolicLink()) throw new GitWriteError("REPARSE_POINT");
  }
  let real: string;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    if (allowMissingTail) return absolute;
    throw new GitWriteError("INVALID_ARGUMENTS");
  }
  if (norm(real) !== norm(absolute)) throw new GitWriteError("REPARSE_POINT");
  return absolute;
}

export function readFileMaterial(input: string, maxBytes = Number.POSITIVE_INFINITY): GitWriteMaterial {
  const absolute = assertNoReparsePath(input);
  let handle: number | undefined;
  try {
    const beforePath = fs.lstatSync(absolute, { bigint: true });
    if (!beforePath.isFile() || (Number.isFinite(maxBytes) && beforePath.size > BigInt(maxBytes))) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    handle = fs.openSync(absolute, "r");
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.dev === 0n || before.ino === 0n ||
        (Number.isFinite(maxBytes) && before.size > BigInt(maxBytes))) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(handle, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    return {
      path: absolute,
      fileIdentity: `${before.dev.toString(16)}:${before.ino.toString(16)}`,
      hash: hash.digest("hex"),
    };
  } catch (error) {
    if (error instanceof GitWriteError) throw error;
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function pathHasNoReparseComponents(input: string): boolean {
  try {
    assertNoReparsePath(input);
    return true;
  } catch {
    return false;
  }
}

export function resolveGitExecutable(): GitExecutable {
  const pathValue = process.env.PATH ?? "";
  const candidates = pathValue.split(path.delimiter).slice(0, 1024);
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const folder of candidates) {
    if (!folder) continue;
    for (const name of names) {
      const candidate = path.resolve(folder, name);
      try {
        const canonical = fs.realpathSync.native(candidate);
        if (!pathHasNoReparseComponents(canonical)) continue;
        const material = readFileMaterial(canonical);
        return { ...material, path: canonical };
      } catch {
        // Continue through the captured PATH. The chosen executable is always
        // returned as an absolute canonical path and is bound by its hash.
      }
    }
  }
  throw new GitWriteError("INVALID_REPOSITORY");
}

function gitBundleRoot(executablePath: string): string {
  if (process.platform !== "win32") throw new GitWriteError("UNSAFE_GIT_CONFIG");
  const canonical = path.resolve(executablePath).replace(/\\/g, "/");
  const lower = canonical.toLowerCase();
  if (lower.endsWith("/mingw64/bin/git.exe")) return path.dirname(path.dirname(path.dirname(canonical)));
  for (const suffix of ["/bin/git.exe", "/cmd/git.exe"]) {
    if (lower.endsWith(suffix)) return path.dirname(path.dirname(canonical));
  }
  throw new GitWriteError("UNSAFE_GIT_CONFIG");
}

/** Capture executables Git for Windows may dispatch after its PATH-facing wrapper. */
export function captureGitBundleCriticalMaterials(executable: GitExecutable, cwd: string): GitWriteMaterial[] {
  if (process.platform !== "win32") return [];
  const bundle = gitBundleRoot(executable.path);
  assertNoReparsePath(bundle);
  const result = runVerifiedGit(executable, cwd, ["--exec-path"], { maxBuffer: 4096 });
  const execPathText = requireGitSuccess(result).toString("utf8").trim();
  if (!execPathText || execPathText.includes("\n") || execPathText.includes("\r")) {
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  const execPath = assertNoReparsePath(path.resolve(execPathText));
  const expectedExecPath = path.join(bundle, "mingw64", "libexec", "git-core");
  if (norm(fs.realpathSync.native(execPath)) !== norm(fs.realpathSync.native(expectedExecPath))) {
    throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  const criticalPaths = [
    path.join(bundle, "mingw64", "bin", "git.exe"),
    path.join(execPath, "git.exe"),
    path.join(execPath, "git-remote-https.exe"),
    path.join(bundle, "bin", "sh.exe"),
    path.join(bundle, "usr", "bin", "sh.exe"),
  ];
  const materials = criticalPaths.map((candidate) => readFileMaterial(candidate));
  if (materials.length > 16) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  return materials;
}

export function verifyExecutable(expected: GitExecutable): GitExecutable {
  const current = readFileMaterial(expected.path);
  if (current.fileIdentity !== expected.fileIdentity || current.hash !== expected.hash) {
    throw new GitWriteError("GIT_EXECUTABLE_CHANGED");
  }
  return { ...current, path: expected.path };
}

export function buildCommonGitArgs(
  config: GitConfigEntry[],
  credentialHelperCommand: string | null,
  approvedProxy: string | null = null,
): string[] {
  const args = [
    "--no-pager",
    "-c", "core.fsmonitor=false",
    "-c", "core.pager=cat",
    "-c", "core.editor=:",
    "-c", "sequence.editor=:",
    "-c", `core.attributesFile=${os.devNull}`,
    "-c", "core.askPass=",
    "-c", "credential.interactive=false",
    "-c", "credential.guiPrompt=false",
    "-c", "credential.helper=",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgSign=false",
    "-c", "push.followTags=false",
    "-c", "push.gpgSign=false",
    "-c", "push.recurseSubmodules=false",
    "-c", "diff.external=",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "http.sslVerify=true",
    "-c", "http.saveCookies=false",
    "-c", "merge.ff=only",
    "-c", "merge.verifySignatures=false",
    "--literal-pathspecs",
  ];
  const filterKeys = [...new Set(config
    .map((entry) => entry.key)
    .filter((key) => SAFE_FILTER_KEY.test(key)))];
  if (filterKeys.length > 128) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  const overridesBytes = filterKeys.reduce((sum, key) => sum + Buffer.byteLength(key, "utf8") + 4, 0);
  if (overridesBytes > 16 * 1024) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  for (const key of filterKeys) args.push("-c", `${key}=`);
  const textconvKeys = [...new Set(config
    .map((entry) => entry.key)
    .filter((key) => SAFE_DIFF_TEXTCONV_KEY.test(key)))];
  if (textconvKeys.length > 128) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  const textconvBytes = textconvKeys.reduce((sum, key) => sum + Buffer.byteLength(key, "utf8") + 4, 0);
  if (textconvBytes > 16 * 1024) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  for (const key of textconvKeys) {
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    args.push("-c", `${key}=`);
  }
  if (credentialHelperCommand !== null) args.push("-c", `credential.helper=${credentialHelperCommand}`);
  if (approvedProxy !== null) args.push("-c", `http.proxy=${approvedProxy}`);
  return args;
}

export interface GitProcessResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function runVerifiedGit(
  executable: GitExecutable,
  cwd: string,
  args: string[],
  options: { maxBuffer?: number; timeoutMs?: number; indexFile?: string } = {},
): GitProcessResult {
  verifyExecutable(executable);
  if (options.indexFile && (!isProtectedStatePath(assertNoReparsePath(options.indexFile)) || !fs.lstatSync(options.indexFile).isFile())) throw new GitWriteError("INVALID_PATH");
  let result: ReturnType<typeof spawnSync>;
  const clear = new Set(GIT_WRITE_CLEAR_ENVIRONMENT.map((name) => name.toUpperCase()));
  try {
    result = spawnSync(executable.path, args, {
      cwd,
      encoding: "buffer",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) =>
          !name.toUpperCase().startsWith("GIT_") && !clear.has(name.toUpperCase())
        )),
        ...getGitWriteEnvironment(),
        ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
      },
      maxBuffer: options.maxBuffer ?? MAX_GIT_OUTPUT_BYTES,
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
      shell: false,
    });
  } catch {
    throw new GitWriteError("STATE_UNAVAILABLE");
  }
  if (result.error || result.signal || result.status === null) throw new GitWriteError("STATE_UNAVAILABLE");
  return {
    code: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
  };
}

export function requireGitSuccess(result: GitProcessResult): Buffer {
  if (result.code !== 0) throw new GitWriteError("STATE_UNAVAILABLE");
  return result.stdout;
}

export function loadGitConfig(executable: GitExecutable, root: string, commonArgs: string[] = []): GitConfigEntry[] {
  const result = runVerifiedGit(executable, root, [
    ...commonArgs,
    "config", "--null", "--show-origin", "--list",
  ]);
  if (result.code !== 0 || result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  const records = result.stdout.toString("utf8").split("\0");
  const entries: GitConfigEntry[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    if (!records[index]) continue;
    const origin = records[index];
    const pair = records[index + 1];
    const separator = pair.indexOf("\n");
    if (separator <= 0) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    entries.push({ origin, key: pair.slice(0, separator), value: pair.slice(separator + 1) });
    if (entries.length > MAX_CONFIG_ENTRIES) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  }
  if (records.length % 2 !== 1) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  return entries;
}

export function configFilesAsMaterials(config: GitConfigEntry[], root: string): GitWriteMaterial[] {
  const paths = new Set<string>();
  const environment = getGitWriteEnvironment();
  for (const entry of config) {
    if (entry.origin === "command line:") {
      const key = entry.key.toLowerCase();
      const fixedHooks = key === "core.hookspath" && path.resolve(entry.value) === path.resolve(environment.GIT_CONFIG_VALUE_0);
      const fixedCredential = key === "credential.helper" && entry.value === "";
      if (fixedHooks || fixedCredential) continue;
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    if (!entry.origin.startsWith("file:")) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    const raw = entry.origin.slice("file:".length);
    if (!raw || raw.includes("\0")) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    paths.add(path.resolve(root, raw));
  }
  return makeMaterials(paths);
}

function rejectConfigExecutionKeys(config: GitConfigEntry[]): void {
  const fixedHooksPath = getGitWriteEnvironment().GIT_CONFIG_VALUE_0;
  for (const { origin, key, value } of config) {
    const lower = key.toLowerCase();
    const fixedEnvironmentOverride = origin === "command line:" && (
      (lower === "core.hookspath" && norm(path.resolve(value)) === norm(path.resolve(fixedHooksPath))) ||
      (lower === "credential.helper" && value === "")
    );
    if (fixedEnvironmentOverride) continue;
    if (/^url\..*\.(?:insteadof|pushinsteadof)$/i.test(key) ||
        /^core\.alternaterefscommand$/i.test(key) ||
        /^extensions\.partialclone$/i.test(key) ||
        /^remote\..+\.(?:promisor|partialclonefilter)$/i.test(key) ||
        /^credential\..+\.helper$/i.test(key) ||
        /^remote\..+\.(?:vcs|uploadpack|receivepack|proxy)$/i.test(key) ||
        /^core\.sshcommand$/i.test(key) ||
        /^core\.(?:hookspath|askpass)$/i.test(key) ||
        /^submodule\.recurse$/i.test(key) ||
        /^http(?:\..+)?\.(?:extraheader|proxy|cookiefile|sslcert|sslkey|sslcertpassword|sslcertpasswordprotected|sslcapath|sslcainfo|savecookies|followredirects)$/i.test(key) ||
        /^protocol\..+\.allow$/i.test(key) ||
        /^merge\..*\.driver$/i.test(key) ||
        /^difftool\..*\.cmd$/i.test(key) ||
        /^interactive\.difffilter$/i.test(key)) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    if (/^http(?:\..+)?\.sslverify$/i.test(key) && !/^(?:true|yes|on|1)$/i.test(value.trim())) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    if (/^credential\..+\./i.test(key) && lower !== "credential.helper") {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
  }
}

export function validateGitConfig(config: GitConfigEntry[]): void {
  rejectConfigExecutionKeys(config);
  for (const entry of config) {
    if (/^filter\./i.test(entry.key) && /\.(?:clean|smudge|process)$/i.test(entry.key) && !SAFE_FILTER_KEY.test(entry.key)) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
    if (/^diff\./i.test(entry.key) && /\.textconv$/i.test(entry.key) && !SAFE_DIFF_TEXTCONV_KEY.test(entry.key)) {
      throw new GitWriteError("UNSAFE_GIT_CONFIG");
    }
  }
}

export function remoteValues(config: GitConfigEntry[], remoteName: string, key: "url" | "pushurl"): string[] {
  const expected = `remote.${remoteName}.${key}`.toLowerCase();
  return config.filter((entry) => entry.key.toLowerCase() === expected).map((entry) => entry.value);
}

export function configUserValue(config: GitConfigEntry[], key: "user.name" | "user.email"): string | null {
  const values = config.filter((entry) => entry.key.toLowerCase() === key).map((entry) => entry.value);
  return values.length ? values[values.length - 1] : null;
}

export function decodeGitPaths(buffer: Buffer): string[] {
  if (buffer.byteLength > MAX_GIT_OUTPUT_BYTES) throw new GitWriteError("INVALID_PATH");
  const pieces = buffer.toString("utf8").split("\0");
  if (pieces.at(-1) !== "") throw new GitWriteError("INVALID_PATH");
  const paths = pieces.slice(0, -1);
  if (paths.length > MAX_GIT_PATH_ENTRIES || paths.some((value) => !value || value.includes("\n") || value.includes("\r"))) {
    throw new GitWriteError("INVALID_PATH");
  }
  return paths;
}

export function makeMaterials(paths: Iterable<string>): GitWriteMaterial[] {
  const unique = [...new Set([...paths].map((value) => path.resolve(value)))];
  if (unique.length > MAX_MATERIALS) throw new GitWriteError("UNSAFE_GIT_CONFIG");
  const materials: GitWriteMaterial[] = [];
  let total = 0;
  for (const candidate of unique.sort((a, b) => norm(a).localeCompare(norm(b)))) {
    if (!fs.existsSync(candidate)) continue;
    const material = readFileMaterial(candidate, MAX_MATERIAL_FILE_BYTES);
    const stat = fs.statSync(candidate);
    total += stat.size;
    if (total > MAX_MATERIAL_BYTES) throw new GitWriteError("UNSAFE_GIT_CONFIG");
    materials.push(material);
  }
  return materials;
}

export function makeSourceMaterials(paths: Iterable<string>): GitWriteMaterial[] {
  const unique = [...new Set([...paths].map((value) => path.resolve(value)))];
  if (unique.length > MAX_GIT_MATERIALS) throw new GitWriteError("INVALID_PATH");
  const materials: GitWriteMaterial[] = [];
  let total = 0;
  for (const candidate of unique.sort((a, b) => norm(a).localeCompare(norm(b)))) {
    if (!fs.existsSync(candidate)) continue;
    const material = readFileMaterial(candidate, MAX_SOURCE_FILE_BYTES);
    const stat = fs.statSync(candidate);
    total += stat.size;
    if (total > MAX_SOURCE_BYTES) throw new GitWriteError("INVALID_PATH");
    materials.push(material);
  }
  return materials;
}

export function gitConfigUnsafeForWrite(config: GitConfigEntry[]): boolean {
  try {
    validateGitConfig(config);
    return false;
  } catch {
    return true;
  }
}

export function workspaceRelative(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative.split(path.sep).join("/");
}
