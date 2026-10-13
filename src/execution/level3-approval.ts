import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { StreamingSanitizer } from "./stream-sanitize.js";
import { resolveRepositoryIdentity, type RepositoryIdentity } from "./repository-identity.js";
import type { Workspace } from "../workspace/manager.js";
import { isProtectedStatePath } from "../workspace/protected-state.js";
import { bindLevel3ScriptEntries } from "./script-entry-binding.js";
import { archiveRecord, readArchivedRecord } from "./record-archive.js";
import { atomicReplace } from "./atomic-replace.js";

export const LEVEL3_REQUEST_TTL_MS = 10 * 60 * 1000;
export const MAX_LEVEL3_PENDING_REQUESTS = 50;
export const MAX_LEVEL3_REQUEST_HISTORY = 256;
export const MAX_LEVEL3_MATERIALS = 32;
export const MAX_LEVEL3_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_LEVEL3_TOTAL_MATERIAL_BYTES = 256 * 1024 * 1024;

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_SPEC_TEXT_BYTES = 64 * 1024;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 8192;
const TERMINAL_STATES = new Set<Level3RequestStatus>(["completed", "failed", "expired", "revoked"]);

export type Level3Engine = "powershell" | "cmd" | "program";
export type Level3Risk = "development" | "destructive-system";
export type Level3RequestStatus = "pending" | "approved" | "consumed" | "launching" |
  "completed" | "failed" | "expired" | "revoked";

interface Level3SpecBase {
  repositoryPath: string;
  executable: string;
  cwd: string;
  timeoutSeconds: number;
  materials: string[];
  entryBinding?: { kind: "literal_entries" | "dynamic_code"; uncertainties: string[] };
}

export type Level3Spec = Level3SpecBase & (
  | { engine: "program"; args: string[]; command?: never }
  | { engine: "powershell" | "cmd"; args?: []; command: string }
);

export interface Level3MaterialSnapshot {
  /** Canonical absolute path passed to the native helper. */
  path: string;
  /** Workspace-relative name shown in the local approval UI. */
  relativePath: string;
  fileIdentity: string;
  hash: string;
  sizeBytes: number;
}

export interface Level3ExecutionSnapshot {
  executable: string;
  executableFileIdentity: string;
  executableHash: string;
  cwd: string;
  cwdFileIdentity: string;
  materials: Level3MaterialSnapshot[];
}

export interface Level3RequestRecord {
  requestId: string;
  workspaceId: string;
  clientId: string;
  repositoryPath: string;
  repositoryIdentity: string;
  spec: Level3Spec;
  snapshot: Level3ExecutionSnapshot;
  digest: string;
  status: Level3RequestStatus;
  createdAt: string;
  expiresAt: string;
  risk: Level3Risk | null;
  allowSystem: boolean;
  allowDynamic?: boolean;
  cleanupConfirmedAt?: string;
  approvalId: string | null;
  approvedAt: string | null;
  launchExpiresAt: string | null;
  manifestPath: string | null;
  manifestFileIdentity: string | null;
  manifestHash: string | null;
  consumedAt: string | null;
  launchingAt: string | null;
  finishedAt: string | null;
}

export interface Level3RequestReceipt {
  requestId: string;
  digest: string;
  status: "pending";
  expiresAt: string;
}

export interface Level3RequestPreview {
  requestId: string;
  repositoryPath: string;
  spec: Level3Spec;
  status: Level3RequestStatus | "expired";
  createdAt: string;
  expiresAt: string;
  digest: string;
  risk: Level3Risk | null;
}

export interface GenericCommandMaterial {
  path: string;
  fileIdentity: string;
  hash: string;
}

/** Execution contract shared with the generic native runner. */
export interface GenericCommand {
  mode: "direct" | "cmd" | "powershell";
  executable: string;
  executableFileIdentity: string;
  executableHash: string;
  args: string[];
  commandText?: string;
  cwd: string;
  cwdFileIdentity: string;
  approvalManifest: string;
  approvalManifestFileIdentity: string;
  approvalManifestHash: string;
  materials: GenericCommandMaterial[];
}

export interface Level3ExecutionAuthorization {
  request: Level3RequestRecord;
  repository: RepositoryIdentity;
  genericCommand: GenericCommand;
}

export type Level3Request = Level3RequestRecord;

interface Level3Manifest {
  version: 1;
  workspaceId: string;
  requestId: string;
  approvalId: string;
  clientId: string;
  digest: string;
  risk: Level3Risk;
  allowSystem: boolean;
  allowDynamic: boolean;
  repositoryPath: string;
  repositoryIdentity: string;
  spec: Level3Spec;
  snapshot: Level3ExecutionSnapshot;
  approvedAt: string;
  launchExpiresAt: string;
}

interface Level3State {
  version: 1;
  workspaceId: string;
  enabled: boolean;
  requests: Level3RequestRecord[];
}

export type Level3ApprovalErrorCode =
  | "INVALID_ARGUMENTS"
  | "LEVEL3_DISABLED"
  | "LEVEL3_REQUEST_NOT_FOUND"
  | "LEVEL3_CLIENT_MISMATCH"
  | "LEVEL3_DIGEST_MISMATCH"
  | "LEVEL3_REQUEST_EXPIRED"
  | "LEVEL3_REQUEST_NOT_PENDING"
  | "LEVEL3_REQUEST_NOT_APPROVED"
  | "LEVEL3_REQUEST_ALREADY_USED"
  | "LEVEL3_RISK_APPROVAL_REQUIRED"
  | "LEVEL3_MATERIAL_CHANGED"
  | "LEVEL3_REPOSITORY_CHANGED"
  | "LEVEL3_EXECUTABLE_UNAVAILABLE"
  | "LEVEL3_STORE_CORRUPT"
  | "LEVEL3_STORE_BUSY"
  | "LEVEL3_REVOKE_BUSY"
  | "LEVEL3_STORE_FULL";

export class Level3ApprovalError extends Error {
  constructor(readonly code: Level3ApprovalErrorCode) {
    super(code);
    this.name = "Level3ApprovalError";
  }
}

function fail(code: Level3ApprovalErrorCode): never {
  throw new Level3ApprovalError(code);
}

function hashBytes(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const rootKey = normPath(root);
  const candidateKey = normPath(candidate);
  return candidateKey === rootKey || candidateKey.startsWith(rootKey + path.sep);
}

function validWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validClientId(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\0\r\n]/.test(value);
}

function stateDirectory(workspaceId: string): string {
  if (!validWorkspaceId(workspaceId)) fail("INVALID_ARGUMENTS");
  const stateRootPath = path.resolve(getStateDir());
  const dir = path.join(stateRootPath, "execution", "level3", workspaceId);
  try {
    fs.mkdirSync(stateRootPath, { recursive: true, mode: 0o700 });
    let current = stateRootPath;
    for (const component of ["execution", "level3", workspaceId]) {
      current = path.join(current, component);
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("LEVEL3_STORE_CORRUPT");
    }
    const stateRoot = fs.realpathSync.native(stateRootPath);
    const resolved = fs.realpathSync.native(dir);
    if (!isWithin(stateRoot, resolved) || !isProtectedStatePath(path.join(resolved, "state.json"))) {
      fail("LEVEL3_STORE_CORRUPT");
    }
  } catch (error) {
    if (error instanceof Level3ApprovalError) throw error;
    fail("LEVEL3_STORE_CORRUPT");
  }
  return dir;
}

function stateFile(workspaceId: string): string {
  return path.join(stateDirectory(workspaceId), "state.json");
}

function lockFile(workspaceId: string): string {
  return path.join(stateDirectory(workspaceId), "state.lock");
}

function manifestFile(workspaceId: string, requestId: string): string {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) fail("INVALID_ARGUMENTS");
  return path.join(stateDirectory(workspaceId), `${requestId}.manifest.json`);
}

function invalidateLaunchPermit(record: Level3RequestRecord): void {
  if (!record.manifestPath) return;
  const permit = `${manifestFile(record.workspaceId, record.requestId)}.permit`;
  try {
    const stat = fs.lstatSync(permit);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64 || fs.readFileSync(permit, "utf8") !== record.manifestHash) fail("LEVEL3_STORE_CORRUPT");
    // Native holds a no-write/no-delete handle from the final check through
    // ResumeThread. A sharing conflict is BUSY, never a successful revoke.
    fs.renameSync(permit, `${permit}.revoked`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof Level3ApprovalError) throw error;
    fail("LEVEL3_REVOKE_BUSY");
  }
}

function emptyState(workspaceId: string): Level3State {
  return { version: STATE_VERSION, workspaceId, enabled: false, requests: [] };
}

function isLevel3Status(value: unknown): value is Level3RequestStatus {
  return value === "pending" || value === "approved" || value === "consumed" || value === "launching" ||
    value === "completed" || value === "failed" || value === "expired" || value === "revoked";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(value);
}

function validStoredRecord(value: unknown, workspaceId: string): value is Level3RequestRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<Level3RequestRecord>;
  return record.workspaceId === workspaceId &&
    typeof record.requestId === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(record.requestId) &&
    validClientId(record.clientId ?? "") &&
    typeof record.repositoryPath === "string" && typeof record.repositoryIdentity === "string" &&
    /^[a-f0-9]{64}$/.test(record.repositoryIdentity) && isSha256(record.digest) &&
    isLevel3Status(record.status) && typeof record.createdAt === "string" && typeof record.expiresAt === "string" &&
    typeof record.allowSystem === "boolean" &&
    (record.risk === null || record.risk === "development" || record.risk === "destructive-system") &&
    (record.approvalId === null || (typeof record.approvalId === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(record.approvalId))) &&
    (record.manifestPath === null || typeof record.manifestPath === "string") &&
    (record.manifestFileIdentity === null || isIdentity(record.manifestFileIdentity)) &&
    (record.manifestHash === null || isSha256(record.manifestHash)) &&
    !!record.spec && typeof record.spec === "object" && !!record.snapshot && typeof record.snapshot === "object";
}

function readState(workspaceId: string): Level3State {
  const file = stateFile(workspaceId);
  if (!isProtectedStatePath(file)) fail("LEVEL3_STORE_CORRUPT");
  let bytes: Buffer;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) fail("LEVEL3_STORE_CORRUPT");
    bytes = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(workspaceId);
    if (error instanceof Level3ApprovalError) throw error;
    fail("LEVEL3_STORE_CORRUPT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("LEVEL3_STORE_CORRUPT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("LEVEL3_STORE_CORRUPT");
  const state = parsed as Partial<Level3State>;
  if (state.version !== STATE_VERSION || state.workspaceId !== workspaceId || typeof state.enabled !== "boolean" ||
      !Array.isArray(state.requests) || state.requests.length > MAX_LEVEL3_REQUEST_HISTORY ||
      !state.requests.every((record) => validStoredRecord(record, workspaceId))) {
    fail("LEVEL3_STORE_CORRUPT");
  }
  return state as Level3State;
}

function atomicWrite(file: string, value: unknown): void {
  if (!isProtectedStatePath(file)) fail("LEVEL3_STORE_CORRUPT");
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) fail("LEVEL3_STORE_FULL");
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
    try { fs.chmodSync(temporary, 0o600); } catch { /* best effort on Windows */ }
    atomicReplace(temporary, file);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* preserve the original write error */ }
    fail("LEVEL3_STORE_CORRUPT");
  }
}

function fileIdentity(stat: fs.BigIntStats): string {
  if (stat.dev === 0n || stat.ino === 0n) fail("LEVEL3_MATERIAL_CHANGED");
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function pathWithoutReparsePoints(absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
    if (stat.isSymbolicLink()) fail("LEVEL3_MATERIAL_CHANGED");
    if (index < parts.length - 1 && !stat.isDirectory()) fail("LEVEL3_MATERIAL_CHANGED");
  }
  let canonical: string;
  try { canonical = fs.realpathSync.native(resolved); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
  if (normPath(canonical) !== normPath(resolved)) fail("LEVEL3_MATERIAL_CHANGED");
  return canonical;
}

function hashRegularFile(inputPath: string): { path: string; fileIdentity: string; hash: string; sizeBytes: number } {
  const canonical = pathWithoutReparsePoints(inputPath);
  let fd: number;
  try { fd = fs.openSync(canonical, "r"); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_LEVEL3_FILE_BYTES)) {
      fail("LEVEL3_MATERIAL_CHANGED");
    }
    const identity = fileIdentity(before);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const received = fs.readSync(fd, buffer, 0, buffer.byteLength, position);
      if (received === 0) break;
      digest.update(buffer.subarray(0, received));
      position += received;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    let pathStat: fs.BigIntStats;
    try { pathStat = fs.lstatSync(canonical, { bigint: true }); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || identity !== fileIdentity(after) ||
        identity !== fileIdentity(pathStat) || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || after.size !== BigInt(position)) {
      fail("LEVEL3_MATERIAL_CHANGED");
    }
    return { path: canonical, fileIdentity: identity, hash: digest.digest("hex"), sizeBytes: position };
  } finally {
    fs.closeSync(fd);
  }
}

function hashDirectory(absolutePath: string): { path: string; fileIdentity: string } {
  const canonical = pathWithoutReparsePoints(absolutePath);
  let stat: fs.BigIntStats;
  try { stat = fs.statSync(canonical, { bigint: true }); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
  if (!stat.isDirectory()) fail("LEVEL3_MATERIAL_CHANGED");
  return { path: canonical, fileIdentity: fileIdentity(stat) };
}

function workspaceRelativeInput(workspace: Workspace, value: string): { abs: string; rel: string; lexical: string } {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024 || value.includes("\0") || path.isAbsolute(value)) {
    fail("INVALID_ARGUMENTS");
  }
  const lexical = path.resolve(workspace.root, value.replace(/[\\/]/g, path.sep));
  if (!isWithin(workspace.root, lexical)) fail("INVALID_ARGUMENTS");
  let resolved: { abs: string; rel: string };
  try { resolved = workspace.resolve(value); } catch { fail("INVALID_ARGUMENTS"); }
  if (!isWithin(workspace.root, lexical) || !isWithin(workspace.root, resolved.abs)) fail("INVALID_ARGUMENTS");
  return { abs: resolved.abs, rel: resolved.rel || ".", lexical };
}

function containsKnownCredential(value: string): boolean {
  if (/(?:^|[^A-Za-z0-9])(?:authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|api[_-]?key|apikey|token)(?:\s*[:=]|\s+\S)/i.test(value)) {
    return true;
  }
  const sanitizer = new StreamingSanitizer();
  const sanitized = sanitizer.push(value) + sanitizer.finish();
  // Home-path privacy substitutions are not credentials. Count newly inserted
  // credential markers so a literal placeholder cannot conceal another token.
  const credentialMarkers = (text: string) => text.split("[REDACTED]").length - 1;
  return sanitizer.restrictedReason !== undefined || credentialMarkers(sanitized) > credentialMarkers(value);
}

function canonicalizeSpec(workspace: Workspace, raw: Level3Spec): {
  spec: Level3Spec;
  repositoryPath: string;
  repositoryIdentity: string;
  snapshot: Level3ExecutionSnapshot;
} {
  if (!raw || typeof raw !== "object" || !["powershell", "cmd", "program"].includes(raw.engine)) fail("INVALID_ARGUMENTS");
  if (typeof raw.repositoryPath !== "string" || raw.repositoryPath.length === 0 || path.isAbsolute(raw.repositoryPath)) {
    fail("INVALID_ARGUMENTS");
  }
  if (!Number.isSafeInteger(raw.timeoutSeconds) || raw.timeoutSeconds < 1 || raw.timeoutSeconds > 3600) fail("INVALID_ARGUMENTS");
  if (!Array.isArray(raw.materials) || raw.materials.length > MAX_LEVEL3_MATERIALS ||
      raw.materials.some((item) => typeof item !== "string" || item.length === 0 || path.isAbsolute(item))) {
    fail("INVALID_ARGUMENTS");
  }

  let repository;
  try { repository = resolveRepositoryIdentity(workspace, raw.repositoryPath); } catch { fail("LEVEL3_REPOSITORY_CHANGED"); }
  if (repository.workspaceRelativePath !== raw.repositoryPath.replace(/\\/g, "/").replace(/^\.\//, "") && raw.repositoryPath !== ".") {
    const supplied = workspaceRelativeInput(workspace, raw.repositoryPath);
    if (normPath(supplied.abs) !== normPath(repository.canonicalPath)) fail("INVALID_ARGUMENTS");
  }
  const executableInput = raw.executable;
  if (typeof executableInput !== "string" || !path.isAbsolute(executableInput) || !/\.exe$/i.test(executableInput) ||
      (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(executableInput))) {
    fail("INVALID_ARGUMENTS");
  }
  const executableMaterial = hashRegularFile(executableInput);
  const executableName = path.basename(executableMaterial.path).toLowerCase();
  if (raw.engine === "program" && ["cmd.exe", "pwsh.exe", "powershell.exe"].includes(executableName)) {
    // Known Windows shells must use the explicit fixed-profile shell modes.
    fail("INVALID_ARGUMENTS");
  }
  if ((raw.engine === "powershell" && executableName !== "pwsh.exe") ||
      (raw.engine === "cmd" && executableName !== "cmd.exe")) {
    fail("INVALID_ARGUMENTS");
  }

  const cwdInput = workspaceRelativeInput(workspace, raw.cwd);
  const cwd = hashDirectory(cwdInput.lexical);
  if (normPath(cwd.path) !== normPath(cwdInput.abs) || !isWithin(repository.canonicalPath, cwd.path)) fail("INVALID_ARGUMENTS");

  let args: string[] = [];
  let command: string | undefined;
  if (raw.engine === "program") {
    if (!Array.isArray(raw.args) || raw.args.length > MAX_ARGUMENTS || raw.command !== undefined) fail("INVALID_ARGUMENTS");
    args = raw.args.map((arg) => {
      if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg, "utf8") > MAX_ARGUMENT_BYTES || containsKnownCredential(arg)) {
        fail("INVALID_ARGUMENTS");
      }
      return arg;
    });
  } else {
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.length !== 0) ||
        typeof raw.command !== "string" || raw.command.trim() === "" || raw.command.includes("\0") ||
        Buffer.byteLength(raw.command, "utf8") > MAX_SPEC_TEXT_BYTES || containsKnownCredential(raw.command)) {
      fail("INVALID_ARGUMENTS");
    }
    command = raw.command;
  }
  if (Buffer.byteLength(executableMaterial.path, "utf8") > MAX_SPEC_TEXT_BYTES || containsKnownCredential(executableMaterial.path)) {
    fail("INVALID_ARGUMENTS");
  }
  const totalArgumentBytes = args.reduce((sum, arg) => sum + Buffer.byteLength(arg, "utf8"), 0) +
    (command ? Buffer.byteLength(command, "utf8") : 0);
  if (totalArgumentBytes > MAX_SPEC_TEXT_BYTES) fail("INVALID_ARGUMENTS");

  const normalizedMaterials: Level3MaterialSnapshot[] = [];
  const seen = new Set<string>();
  let totalMaterialBytes = 0;
  const entries = bindLevel3ScriptEntries({ engine: raw.engine, workspaceRoot: workspace.root, cwd: cwd.path,
    executable: executableMaterial.path, args, command });
  const allMaterials = [...new Set([...raw.materials, ...entries.materials])];
  if (allMaterials.length > MAX_LEVEL3_MATERIALS) fail("INVALID_ARGUMENTS");
  for (const materialInput of allMaterials) {
    const resolved = workspaceRelativeInput(workspace, materialInput);
    if (!isWithin(repository.canonicalPath, resolved.abs) ||
        !isWithin(repository.canonicalPath, resolved.lexical)) fail("INVALID_ARGUMENTS");
    const material = hashRegularFile(resolved.lexical);
    if (normPath(material.path) !== normPath(resolved.abs)) fail("LEVEL3_MATERIAL_CHANGED");
    const key = normPath(material.path);
    if (seen.has(key)) continue;
    seen.add(key);
    totalMaterialBytes += material.sizeBytes;
    if (totalMaterialBytes > MAX_LEVEL3_TOTAL_MATERIAL_BYTES) fail("INVALID_ARGUMENTS");
    normalizedMaterials.push({ ...material, relativePath: resolved.rel });
  }
  normalizedMaterials.sort((a, b) => normPath(a.path).localeCompare(normPath(b.path)));

  const spec: Level3Spec = raw.engine === "program"
    ? {
      engine: "program",
      repositoryPath: repository.workspaceRelativePath || ".",
      executable: executableMaterial.path,
      args,
      cwd: cwdInput.rel,
      timeoutSeconds: raw.timeoutSeconds,
      materials: normalizedMaterials.map((item) => item.relativePath),
    }
    : {
      engine: raw.engine,
      repositoryPath: repository.workspaceRelativePath || ".",
      executable: executableMaterial.path,
      args: [],
      command: command!,
      cwd: cwdInput.rel,
      timeoutSeconds: raw.timeoutSeconds,
      materials: normalizedMaterials.map((item) => item.relativePath),
    };
  const snapshot: Level3ExecutionSnapshot = {
    executable: executableMaterial.path,
    executableFileIdentity: executableMaterial.fileIdentity,
    executableHash: executableMaterial.hash,
    cwd: cwd.path,
    cwdFileIdentity: cwd.fileIdentity,
    materials: normalizedMaterials,
  };
  spec.entryBinding = { kind: entries.hasUnresolvedSemantics ? "dynamic_code" : "literal_entries", uncertainties: entries.uncertainties };
  return {
    spec,
    repositoryPath: repository.workspaceRelativePath || ".",
    repositoryIdentity: repository.identity,
    snapshot,
  };
}

function digestRequest(input: {
  workspaceId: string;
  clientId: string;
  repositoryPath: string;
  repositoryIdentity: string;
  spec: Level3Spec;
  snapshot: Level3ExecutionSnapshot;
}): string {
  return hashBytes(JSON.stringify([
    input.workspaceId,
    input.clientId,
    input.repositoryPath,
    input.repositoryIdentity,
    input.spec.engine,
    input.spec.executable,
    input.spec.engine === "program" ? input.spec.args : [],
    input.spec.engine === "program" ? null : input.spec.command,
    input.spec.cwd,
    input.spec.timeoutSeconds,
    input.spec.materials,
    input.snapshot.executableFileIdentity,
    input.snapshot.executableHash,
    input.snapshot.cwdFileIdentity,
    input.snapshot.materials.map((material) => [material.relativePath, material.path, material.fileIdentity, material.hash, material.sizeBytes]),
  ]));
}

function recordExpired(record: Level3RequestRecord, now: number): boolean {
  const expiry = record.launchExpiresAt && (record.status === "approved" || record.status === "consumed")
    ? record.launchExpiresAt
    : record.expiresAt;
  const expires = Date.parse(expiry);
  return !Number.isFinite(expires) || now >= expires;
}

function normalizeExpiry(state: Level3State, now = Date.now()): void {
  for (const record of state.requests) {
    if (["pending", "approved", "consumed"].includes(record.status) && recordExpired(record, now)) {
      record.status = "expired";
      record.finishedAt = new Date(now).toISOString();
    }
  }
}

function writeState(workspaceId: string, state: Level3State): void {
  atomicWrite(stateFile(workspaceId), state);
}

function withStateTransaction<T>(workspaceId: string, action: (state: Level3State) => T): T {
  const file = lockFile(workspaceId);
  if (!isProtectedStatePath(file)) fail("LEVEL3_STORE_CORRUPT");
  let lockFd: number;
  try {
    lockFd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) fail("LEVEL3_STORE_CORRUPT");
        fail("LEVEL3_STORE_BUSY");
      } catch (lockError) {
        if (lockError instanceof Level3ApprovalError) throw lockError;
        fail("LEVEL3_STORE_BUSY");
      }
    } else {
      fail("LEVEL3_STORE_CORRUPT");
    }
  }
  try {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    const state = readState(workspaceId);
    normalizeExpiry(state);
    const result = action(state);
    writeState(workspaceId, state);
    return result;
  } finally {
    try {
      const lockPathStat = fs.lstatSync(file, { bigint: true });
      const lockFdStat = fs.fstatSync(lockFd, { bigint: true });
      if (fileIdentity(lockPathStat) === fileIdentity(lockFdStat)) fs.unlinkSync(file);
    } catch { /* fail closed on the next transaction if a stale lock remains */ }
    fs.closeSync(lockFd);
  }
}

function ensureHistoryCapacity(state: Level3State): void {
  if (state.requests.length < MAX_LEVEL3_REQUEST_HISTORY) return;
  const retained: Level3RequestRecord[] = [];
  for (const record of state.requests) {
    const safe = TERMINAL_STATES.has(record.status) && ((!record.consumedAt && !record.launchingAt) || !!record.cleanupConfirmedAt);
    if (safe) archiveRecord(stateDirectory(state.workspaceId), "level3", record.requestId, record);
    else retained.push(record);
  }
  state.requests = retained;
  if (state.requests.length >= MAX_LEVEL3_REQUEST_HISTORY) fail("LEVEL3_STORE_FULL");
}

function findRequest(state: Level3State, requestId: string): Level3RequestRecord {
  const record = state.requests.find((item) => item.requestId === requestId);
  if (!record) fail("LEVEL3_REQUEST_NOT_FOUND");
  return record;
}

function verifyRequestBinding(record: Level3RequestRecord, clientId: string, digest: string): void {
  if (record.clientId !== clientId) fail("LEVEL3_CLIENT_MISMATCH");
  if (record.digest !== digest) fail("LEVEL3_DIGEST_MISMATCH");
  if (recordExpired(record, Date.now())) fail("LEVEL3_REQUEST_EXPIRED");
}

function currentSnapshot(workspace: Workspace, record: Level3RequestRecord): Level3ExecutionSnapshot {
  const current = canonicalizeSpec(workspace, record.spec);
  if (current.repositoryIdentity !== record.repositoryIdentity || current.repositoryPath !== record.repositoryPath) {
    fail("LEVEL3_REPOSITORY_CHANGED");
  }
  if (JSON.stringify(current.snapshot) !== JSON.stringify(record.snapshot)) fail("LEVEL3_MATERIAL_CHANGED");
  return current.snapshot;
}

function toManifest(record: Level3RequestRecord): Level3Manifest {
  if (!record.approvalId || !record.risk || !record.approvedAt || !record.launchExpiresAt) fail("LEVEL3_STORE_CORRUPT");
  return {
    version: 1,
    workspaceId: record.workspaceId,
    requestId: record.requestId,
    approvalId: record.approvalId,
    clientId: record.clientId,
    digest: record.digest,
    risk: record.risk,
    allowSystem: record.allowSystem,
    allowDynamic: record.allowDynamic === true,
    repositoryPath: record.repositoryPath,
    repositoryIdentity: record.repositoryIdentity,
    spec: record.spec,
    snapshot: record.snapshot,
    approvedAt: record.approvedAt,
    launchExpiresAt: record.launchExpiresAt,
  };
}

function verifyManifest(record: Level3RequestRecord): { path: string; fileIdentity: string; hash: string } {
  if (!record.manifestPath || !record.manifestFileIdentity || !record.manifestHash) fail("LEVEL3_STORE_CORRUPT");
  const expectedPath = manifestFile(record.workspaceId, record.requestId);
  if (normPath(record.manifestPath) !== normPath(expectedPath)) fail("LEVEL3_STORE_CORRUPT");
  let material: ReturnType<typeof hashRegularFile>;
  try { material = hashRegularFile(expectedPath); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
  if (material.fileIdentity !== record.manifestFileIdentity || material.hash !== record.manifestHash) fail("LEVEL3_MATERIAL_CHANGED");
  const expectedBytes = Buffer.from(JSON.stringify(toManifest(record)), "utf8");
  let actualBytes: Buffer;
  try { actualBytes = fs.readFileSync(expectedPath); } catch { fail("LEVEL3_MATERIAL_CHANGED"); }
  if (!actualBytes.equals(expectedBytes)) fail("LEVEL3_MATERIAL_CHANGED");
  return { path: expectedPath, fileIdentity: material.fileIdentity, hash: material.hash };
}

function toGenericCommand(record: Level3RequestRecord, manifest: {
  path: string;
  fileIdentity: string;
  hash: string;
}): GenericCommand {
  const { spec, snapshot } = record;
  const command: GenericCommand = {
    mode: spec.engine === "program" ? "direct" : spec.engine,
    executable: snapshot.executable,
    executableFileIdentity: snapshot.executableFileIdentity,
    executableHash: snapshot.executableHash,
    args: spec.engine === "program" ? [...spec.args] : [],
    cwd: snapshot.cwd,
    cwdFileIdentity: snapshot.cwdFileIdentity,
    approvalManifest: manifest.path,
    approvalManifestFileIdentity: manifest.fileIdentity,
    approvalManifestHash: manifest.hash,
    materials: snapshot.materials.map(({ path: materialPath, fileIdentity, hash }) => ({
      path: materialPath,
      fileIdentity,
      hash,
    })),
  };
  if (spec.engine !== "program") command.commandText = spec.command;
  return command;
}

function assertRequestListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEVEL3_PENDING_REQUESTS) fail("INVALID_ARGUMENTS");
}

function preview(record: Level3RequestRecord): Level3RequestPreview {
  const status = ["pending", "approved"].includes(record.status) && recordExpired(record, Date.now())
    ? "expired"
    : record.status;
  return {
    requestId: record.requestId,
    repositoryPath: record.repositoryPath,
    spec: record.spec,
    status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    digest: record.digest,
    risk: record.risk,
  };
}

/** Local CLI only. Level 3 is disabled until this API is called locally. */
export function setLevel3Enabled(workspaceId: string, enabled: boolean, localApproval: true): void {
  if (localApproval !== true || typeof enabled !== "boolean") fail("INVALID_ARGUMENTS");
  withStateTransaction(workspaceId, (state) => {
    state.enabled = enabled;
    if (!enabled) {
      const now = new Date().toISOString();
      for (const request of state.requests) {
        if (["pending", "approved", "consumed", "launching"].includes(request.status)) {
          invalidateLaunchPermit(request);
          request.status = "revoked";
          request.finishedAt = now;
        }
      }
    }
  });
}

/** Local CLI only: revoke one outstanding request or queued launch authorization. */
export function revokeLevel3Request(workspaceId: string, requestId: string, localApproval: true): boolean {
  if (localApproval !== true || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) fail("INVALID_ARGUMENTS");
  return withStateTransaction(workspaceId, (state) => {
    const record = state.requests.find((item) => item.requestId === requestId);
    if (!record || TERMINAL_STATES.has(record.status)) return false;
    invalidateLaunchPermit(record);
    record.status = "revoked";
    record.finishedAt = new Date().toISOString();
    return true;
  });
}

export function isLevel3Enabled(workspaceId: string): boolean {
  try { return readState(workspaceId).enabled; } catch { return false; }
}

/** Remote-facing call: create a pending request only. No execution authority is returned. */
export function createLevel3Request(workspace: Workspace, clientId: string, rawSpec: Level3Spec): Level3RequestReceipt {
  if (!workspace || !validClientId(clientId)) fail("INVALID_ARGUMENTS");
  const normalized = canonicalizeSpec(workspace, rawSpec);
  const digest = digestRequest({
    workspaceId: workspace.id,
    clientId,
    repositoryPath: normalized.repositoryPath,
    repositoryIdentity: normalized.repositoryIdentity,
    spec: normalized.spec,
    snapshot: normalized.snapshot,
  });
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + LEVEL3_REQUEST_TTL_MS).toISOString();
  const requestId = randomBytes(24).toString("base64url");
  const record: Level3RequestRecord = {
    requestId,
    workspaceId: workspace.id,
    clientId,
    repositoryPath: normalized.repositoryPath,
    repositoryIdentity: normalized.repositoryIdentity,
    spec: normalized.spec,
    snapshot: normalized.snapshot,
    digest,
    status: "pending",
    createdAt: now,
    expiresAt,
    risk: null,
    allowSystem: false,
    approvalId: null,
    approvedAt: null,
    launchExpiresAt: null,
    manifestPath: null,
    manifestFileIdentity: null,
    manifestHash: null,
    consumedAt: null,
    launchingAt: null,
    finishedAt: null,
  };
  withStateTransaction(workspace.id, (state) => {
    if (!state.enabled) fail("LEVEL3_DISABLED");
    ensureHistoryCapacity(state);
    const pending = state.requests.filter((item) => item.status === "pending" && !recordExpired(item, nowMs)).length;
    if (pending >= MAX_LEVEL3_PENDING_REQUESTS) fail("LEVEL3_STORE_FULL");
    state.requests.push(record);
  });
  return { requestId, digest, status: "pending", expiresAt };
}

/** Local CLI only: full record includes material hashes and protected manifest path. */
export function getLevel3Request(workspaceId: string, requestId: string): Level3RequestRecord | null {
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(requestId)) fail("INVALID_ARGUMENTS");
  const active = readState(workspaceId).requests.find((item) => item.requestId === requestId);
  if (active) return active;
  const archived = readArchivedRecord<Level3RequestRecord>(stateDirectory(workspaceId), "level3", requestId);
  if (archived && (!validStoredRecord(archived, workspaceId) || archived.requestId !== requestId || !TERMINAL_STATES.has(archived.status))) fail("LEVEL3_STORE_CORRUPT");
  return archived;
}

/** Local CLI only: list is bounded and contains only live, unexpired requests. */
export function listLevel3Requests(workspaceId: string, limit = MAX_LEVEL3_PENDING_REQUESTS): Level3RequestRecord[] {
  assertRequestListLimit(limit);
  const state = readState(workspaceId);
  return state.requests
    .filter((item) => ["pending", "approved"].includes(item.status) && !recordExpired(item, Date.now()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

/** Remote-safe preview; never returns state paths or material hashes. */
export function getLevel3RequestPreview(workspaceId: string, requestId: string, clientId: string): Level3RequestPreview | null {
  if (!validClientId(clientId)) fail("INVALID_ARGUMENTS");
  const record = getLevel3Request(workspaceId, requestId);
  return record?.clientId === clientId ? preview(record) : null;
}

/** Local CLI only. Risk classification is a local decision, never accepted from the remote spec. */
export function approveLevel3Request(
  workspace: Workspace,
  requestId: string,
  expectedDigest: string,
  localApproval: true,
  options: { risk: Level3Risk; allowSystem?: true; allowDynamic?: true },
): Level3RequestRecord {
  if (localApproval !== true || !workspace || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId) || !isSha256(expectedDigest) ||
      !options || (options.risk !== "development" && options.risk !== "destructive-system")) fail("INVALID_ARGUMENTS");
  if (options.risk === "destructive-system" && options.allowSystem !== true) fail("LEVEL3_RISK_APPROVAL_REQUIRED");
  if (options.risk === "development" && options.allowSystem === true) fail("INVALID_ARGUMENTS");
  return withStateTransaction(workspace.id, (state) => {
    if (!state.enabled) fail("LEVEL3_DISABLED");
    const record = findRequest(state, requestId);
    if (record.digest !== expectedDigest) fail("LEVEL3_DIGEST_MISMATCH");
    if (record.status === "expired" || recordExpired(record, Date.now())) fail("LEVEL3_REQUEST_EXPIRED");
    if (record.status !== "pending") fail("LEVEL3_REQUEST_NOT_PENDING");
    if (record.spec.entryBinding?.kind === "dynamic_code" && options.allowDynamic !== true) fail("LEVEL3_RISK_APPROVAL_REQUIRED");
    verifyRequestBinding(record, record.clientId, expectedDigest);
    currentSnapshot(workspace, record);
    const approvedAt = new Date().toISOString();
    const launchExpiresAt = new Date(Date.now() + LEVEL3_REQUEST_TTL_MS).toISOString();
    const approvalId = randomBytes(24).toString("base64url");
    record.status = "approved";
    record.risk = options.risk;
    record.allowSystem = options.allowSystem === true;
    record.allowDynamic = options.allowDynamic === true;
    record.approvalId = approvalId;
    record.approvedAt = approvedAt;
    record.launchExpiresAt = launchExpiresAt;
    record.manifestPath = manifestFile(workspace.id, requestId);
    const bytes = Buffer.from(JSON.stringify(toManifest(record)), "utf8");
    try {
      fs.writeFileSync(record.manifestPath, bytes, { mode: 0o600, flag: "wx" });
      try { fs.chmodSync(record.manifestPath, 0o600); } catch { /* best effort on Windows */ }
    } catch {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      fail("LEVEL3_STORE_CORRUPT");
    }
    const material = hashRegularFile(record.manifestPath);
    record.manifestFileIdentity = material.fileIdentity;
    record.manifestHash = material.hash;
    fs.writeFileSync(`${record.manifestPath}.permit`, material.hash, { mode: 0o600, flag: "wx" });
    return record;
  });
}

function assertCommandSnapshot(workspace: Workspace, record: Level3RequestRecord): RepositoryIdentity {
  const repository = resolveRepositoryIdentity(workspace, record.repositoryPath);
  if (repository.identity !== record.repositoryIdentity) {
    fail("LEVEL3_REPOSITORY_CHANGED");
  }
  currentSnapshot(workspace, record);
  return repository;
}

/** Consume exactly once when a queued job is created. Intended for the local supervisor. */
export function consumeLevel3Request(
  workspace: Workspace,
  requestId: string,
  clientId: string,
  expectedDigest: string,
): Level3ExecutionAuthorization {
  if (!workspace || !validClientId(clientId) || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId) || !isSha256(expectedDigest)) {
    fail("INVALID_ARGUMENTS");
  }
  return withStateTransaction(workspace.id, (state) => {
    if (!state.enabled) fail("LEVEL3_DISABLED");
    const record = findRequest(state, requestId);
    verifyRequestBinding(record, clientId, expectedDigest);
    if (record.status !== "approved") {
      if (["consumed", "launching", "completed"].includes(record.status)) fail("LEVEL3_REQUEST_ALREADY_USED");
      fail("LEVEL3_REQUEST_NOT_APPROVED");
    }
    const repository = assertCommandSnapshot(workspace, record);
    verifyManifest(record);
    record.status = "consumed";
    record.consumedAt = new Date().toISOString();
    return {
      request: record,
      repository,
      genericCommand: toGenericCommand(record, {
        path: record.manifestPath!,
        fileIdentity: record.manifestFileIdentity!,
        hash: record.manifestHash!,
      }),
    };
  });
}

/**
 * Recheck queued authorization just before native launch. This transition is
 * one-shot; a service restart never gets a second launch capability.
 */
export function resolveConsumedLevel3Request(
  workspace: Workspace,
  requestId: string,
  clientId: string,
  expectedDigest: string,
): Level3ExecutionAuthorization {
  if (!workspace || !validClientId(clientId) || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId) || !isSha256(expectedDigest)) {
    fail("INVALID_ARGUMENTS");
  }
  return withStateTransaction(workspace.id, (state) => {
    if (!state.enabled) fail("LEVEL3_DISABLED");
    const record = findRequest(state, requestId);
    verifyRequestBinding(record, clientId, expectedDigest);
    if (record.status !== "consumed") {
      if (["launching", "completed"].includes(record.status)) fail("LEVEL3_REQUEST_ALREADY_USED");
      fail("LEVEL3_REQUEST_NOT_APPROVED");
    }
    const repository = assertCommandSnapshot(workspace, record);
    const manifest = verifyManifest(record);
    record.status = "launching";
    record.launchingAt = new Date().toISOString();
    return {
      request: record,
      repository,
      genericCommand: toGenericCommand(record, manifest),
    };
  });
}

/** Mark the single execution attempt complete or failed; manifest is retained for native locks/audit. */
export function completeLevel3Request(
  workspaceId: string,
  requestId: string,
  clientId: string,
  outcome: "completed" | "failed",
  cleanupConfirmed = false,
): boolean {
  if (!validClientId(clientId) || !/^[A-Za-z0-9_-]{24,64}$/.test(requestId) ||
      (outcome !== "completed" && outcome !== "failed")) fail("INVALID_ARGUMENTS");
  return withStateTransaction(workspaceId, (state) => {
    const record = state.requests.find((item) => item.requestId === requestId);
    if (record?.clientId === clientId && cleanupConfirmed) record.cleanupConfirmedAt = new Date().toISOString();
    if (!record || record.clientId !== clientId ||
        (record.status !== "launching" && !(record.status === "consumed" && outcome === "failed"))) return false;
    record.status = outcome;
    record.finishedAt = new Date().toISOString();
    return true;
  });
}
