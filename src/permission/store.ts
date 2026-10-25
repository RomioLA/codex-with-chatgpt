import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { getCurrentSessionIdentityFingerprint } from "./session-identity.js";
import { isPermissionMode, type PermissionBaselineMode, type PermissionMode } from "./mode.js";

const LEGACY_PERMISSION_STATE_VERSION = 1;
const PERMISSION_STATE_VERSION = 2;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{12}$/;
const SESSION_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

interface LegacyPersistedPermission {
  version: typeof LEGACY_PERMISSION_STATE_VERSION;
  workspaceId: string;
  mode: PermissionMode;
  updatedAt: string;
}

interface SessionGrant {
  identityFingerprint: string;
  grantId: string;
  createdAt: string;
}

interface PersistedPermission {
  version: typeof PERMISSION_STATE_VERSION;
  workspaceId: string;
  baselineMode: PermissionBaselineMode;
  sessionGrant?: unknown;
  authorizationEpoch?: number;
  updatedAt: string;
}

export interface PermissionStatus {
  /** Compatibility alias for the effective file permission mode. */
  mode: PermissionMode;
  baselineMode: PermissionBaselineMode;
  effectiveMode: PermissionMode;
  sessionElevation: {
    active: boolean;
    expiresOn: "logout-or-reboot" | null;
  };
}

export class PermissionStateBusyError extends Error {
  readonly code = "PERMISSION_STATE_BUSY";
  constructor() {
    super("Permission state is being updated by another C2C process.");
    this.name = "PermissionStateBusyError";
  }
}

function permissionDirectory(): string {
  return path.join(getStateDir(), "permissions");
}

function permissionFile(workspaceId: string): string {
  return path.join(permissionDirectory(), `${workspaceId}.json`);
}

function permissionLockFile(workspaceId: string): string {
  return `${permissionFile(workspaceId)}.lock`;
}

function permissionLockBlocksRead(workspaceId: string): boolean {
  const file = permissionLockFile(workspaceId);
  let observed: ReturnType<typeof fs.lstatSync>;
  try {
    observed = fs.lstatSync(file);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (!observed.isFile() || observed.isSymbolicLink()) return true;

  let owner: string;
  try { owner = fs.readFileSync(file, "utf8"); }
  catch { return true; }
  try {
    const current = fs.lstatSync(file);
    if (current.dev !== observed.dev || current.ino !== observed.ino || !current.isFile() || current.isSymbolicLink()) {
      return true;
    }
  } catch (error) {
    // A lock that disappeared after its owner record was read has been released.
    // Callers verify the lock again after reading permission state.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }

  // A live Native launch permit holds this same exclusive lock only across
  // permission validation and ResumeThread. It does not mutate the manifest,
  // so read-only authorization checks must continue to see the stable grant.
  const launchOwner = /^launch:([1-9][0-9]*)\r?\n?$/.exec(owner);
  if (!launchOwner) return true;
  const pid = Number(launchOwner[1]);
  if (!Number.isSafeInteger(pid)) return true;
  try { process.kill(pid, 0); return false; }
  catch {
    // The Native helper can release its launch permit between the identity
    // check above and this PID probe. Only treat the failed probe as blocking
    // while a lock path still exists; replaced or unreadable locks stay closed.
    try {
      fs.lstatSync(file);
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
}

function removeStalePermissionLock(file: string): boolean {
  let observed: ReturnType<typeof fs.lstatSync>;
  try { observed = fs.lstatSync(file); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  if (!observed.isFile() || observed.isSymbolicLink()) return false;

  let pid: number;
  try {
    const owner = /^(?:launch:)?([1-9][0-9]*)\r?\n?$/.exec(fs.readFileSync(file, "utf8"));
    if (!owner) return false;
    pid = Number(owner[1]);
  }
  catch { return false; }
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
  }

  try {
    const current = fs.lstatSync(file);
    if (current.dev !== observed.dev || current.ino !== observed.ino || !current.isFile() || current.isSymbolicLink()) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBaselineMode(value: unknown): value is PermissionBaselineMode {
  return value === "readonly" || value === "level1";
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  try { return new Date(value).toISOString() === value; }
  catch { return false; }
}

function isSessionGrant(value: unknown): value is SessionGrant {
  if (!isRecord(value)) return false;
  return typeof value.identityFingerprint === "string" && SESSION_FINGERPRINT_PATTERN.test(value.identityFingerprint) &&
    typeof value.grantId === "string" && SESSION_FINGERPRINT_PATTERN.test(value.grantId) &&
    isCanonicalIsoTimestamp(value.createdAt);
}

function isPreGenerationSessionGrant(value: unknown): value is Omit<SessionGrant, "grantId"> {
  if (!isRecord(value)) return false;
  return typeof value.identityFingerprint === "string" && SESSION_FINGERPRINT_PATTERN.test(value.identityFingerprint) &&
    isCanonicalIsoTimestamp(value.createdAt);
}

function isLegacyState(value: unknown, workspaceId: string): value is LegacyPersistedPermission {
  if (!isRecord(value)) return false;
  return value.version === LEGACY_PERMISSION_STATE_VERSION && value.workspaceId === workspaceId &&
    isPermissionMode(value.mode) && typeof value.updatedAt === "string" && value.updatedAt.length > 0;
}

function isCurrentState(value: unknown, workspaceId: string): value is PersistedPermission {
  if (!isRecord(value)) return false;
  return value.version === PERMISSION_STATE_VERSION && value.workspaceId === workspaceId &&
    isBaselineMode(value.baselineMode) && typeof value.updatedAt === "string" && value.updatedAt.length > 0;
}

function makeStatus(baselineMode: PermissionBaselineMode, elevated: boolean): PermissionStatus {
  const effectiveMode: PermissionMode = elevated ? "level2" : baselineMode;
  return {
    mode: effectiveMode,
    baselineMode,
    effectiveMode,
    sessionElevation: {
      active: elevated,
      expiresOn: elevated ? "logout-or-reboot" : null,
    },
  };
}

function statusForCurrentState(state: PersistedPermission): PermissionStatus {
  const grant = state.baselineMode === "level1" && isSessionGrant(state.sessionGrant) ? state.sessionGrant : null;
  const currentIdentity = grant ? getCurrentSessionIdentityFingerprint() : null;
  return makeStatus(state.baselineMode, Boolean(grant && currentIdentity === grant.identityFingerprint));
}

function baselineForLegacyState(state: LegacyPersistedPermission): PermissionBaselineMode {
  return state.mode === "readonly" ? "readonly" : "level1";
}

/** Read-only status lookup. Legacy level2 is never trusted without local migration. */
export function readPermissionStatus(workspaceId: string): PermissionStatus {
  const readonly = makeStatus("readonly", false);
  if (!isWorkspaceId(workspaceId)) return readonly;

  const value = readJsonIfExists<unknown>(permissionFile(workspaceId));
  if (isCurrentState(value, workspaceId)) {
    if (permissionLockBlocksRead(workspaceId)) return makeStatus(value.baselineMode, false);
    const status = statusForCurrentState(value);
    return permissionLockBlocksRead(workspaceId) ? makeStatus(value.baselineMode, false) : status;
  }
  if (isLegacyState(value, workspaceId)) return makeStatus(baselineForLegacyState(value), false);
  return readonly;
}

/** Compatibility API used by all file and execution policy gates. */
export function readPermission(workspaceId: string): PermissionMode {
  return readPermissionStatus(workspaceId).effectiveMode;
}

function writePermissionState(file: string, state: PersistedPermission): void {
  ensureDir(path.dirname(file));
  // Writers hold the per-workspace lock; readers fail closed while it exists.
  // A torn write is malformed state and therefore resolves to readonly.
  writeSecureJson(file, state);
}

function withPermissionLock<T>(workspaceId: string, action: () => T): T {
  ensureDir(permissionDirectory());
  const lockFile = permissionLockFile(workspaceId);
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !removeStalePermissionLock(lockFile)) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PermissionStateBusyError();
      throw error;
    }
    try { descriptor = fs.openSync(lockFile, "wx", 0o600); }
    catch { throw new PermissionStateBusyError(); }
  }
  const held = fs.fstatSync(descriptor, { bigint: true });
  try {
    fs.writeSync(descriptor, String(process.pid));
    return action();
  } finally {
    try {
      const current = fs.lstatSync(lockFile, { bigint: true });
      if (current.dev === held.dev && current.ino === held.ino && current.isFile() && !current.isSymbolicLink()) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // Keep a leftover lock as a fail-closed signal if its identity no longer matches.
    }
    fs.closeSync(descriptor);
  }
}

function buildState(
  workspaceId: string,
  baselineMode: PermissionBaselineMode,
  identityFingerprint?: string,
  authorizationEpoch = 0,
): PersistedPermission {
  const state: PersistedPermission = {
    version: PERMISSION_STATE_VERSION,
    workspaceId,
    baselineMode,
    authorizationEpoch,
    updatedAt: new Date().toISOString(),
  };
  if (identityFingerprint && SESSION_FINGERPRINT_PATTERN.test(identityFingerprint)) {
    state.sessionGrant = {
      identityFingerprint,
      grantId: randomBytes(32).toString("hex"),
      createdAt: new Date().toISOString(),
    };
  }
  return state;
}

export interface CurrentSessionGrant {
  identityFingerprint: string;
  grantId: string;
}

/** Return the current revocable grant identity only while its state is stable. */
export function readCurrentSessionGrant(workspaceId: string): CurrentSessionGrant | null {
  if (!isWorkspaceId(workspaceId) || permissionLockBlocksRead(workspaceId)) return null;
  try {
    const value = readJsonIfExists<unknown>(permissionFile(workspaceId));
    if (!isCurrentState(value, workspaceId) || !isSessionGrant(value.sessionGrant) ||
        value.baselineMode !== "level1" ||
        value.sessionGrant.identityFingerprint !== getCurrentSessionIdentityFingerprint() ||
        permissionLockBlocksRead(workspaceId)) {
      return null;
    }
    return {
      identityFingerprint: value.sessionGrant.identityFingerprint,
      grantId: value.sessionGrant.grantId,
    };
  } catch {
    return null;
  }
}

function readAuthorizationEpochFile(workspaceId: string): number | null {
  const file = permissionFile(workspaceId);
  let stat: ReturnType<typeof fs.lstatSync>;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
  const value = readJsonIfExists<unknown>(file);
  if (isCurrentState(value, workspaceId)) {
    if (value.authorizationEpoch === undefined) return 0;
    return Number.isSafeInteger(value.authorizationEpoch) && value.authorizationEpoch >= 0
      ? value.authorizationEpoch
      : null;
  }
  if (isLegacyState(value, workspaceId)) return 0;
  return null;
}

/**
 * Monotonic workspace authorization version. Every Level1/Level2 transition bumps
 * it so any consumer that binds an authorization generation observes a change.
 * A malformed or busy permission record is unverifiable and therefore null.
 */
export function readAuthorizationEpoch(workspaceId: string): number | null {
  if (!isWorkspaceId(workspaceId) || permissionLockBlocksRead(workspaceId)) return null;
  const epoch = readAuthorizationEpochFile(workspaceId);
  return permissionLockBlocksRead(workspaceId) ? null : epoch;
}

/** Persist one strong authorization revocation/reset under the permission lock. */
export function incrementAuthorizationEpoch(workspaceId: string): number {
  if (!isWorkspaceId(workspaceId)) throw new TypeError("Invalid workspaceId");
  return withPermissionLock(workspaceId, () => {
    const current = readAuthorizationEpochFile(workspaceId);
    if (current === null || current >= Number.MAX_SAFE_INTEGER) {
      throw new Error("AUTHORIZATION_EPOCH_UNAVAILABLE");
    }
    const file = permissionFile(workspaceId);
    const value = readJsonIfExists<unknown>(file);
    let next: PersistedPermission;
    if (isCurrentState(value, workspaceId)) {
      next = { ...value, authorizationEpoch: current + 1, updatedAt: new Date().toISOString() };
    } else if (isLegacyState(value, workspaceId)) {
      next = buildState(workspaceId, baselineForLegacyState(value), undefined, current + 1);
    } else {
      let exists = true;
      try { fs.lstatSync(file); }
      catch (error) { exists = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
      if (exists) throw new Error("AUTHORIZATION_EPOCH_UNAVAILABLE");
      next = buildState(workspaceId, "readonly", undefined, current + 1);
    }
    writePermissionState(file, next);
    return current + 1;
  });
}

/**
 * Local startup/CLI migration only. MCP status reads never call this function,
 * so a remote read cannot create a Level 2 session grant from legacy state.
 *
 * Migration never elevates. It only upgrades the persisted *shape* (v1 -> v2) and
 * always lands on a non-elevated baseline, so a legacy v1 `mode=level2` record
 * cannot carry Level 2 across into a new Windows logon session.
 */
export function ensurePermissionMigrated(workspaceId: string): PermissionStatus {
  if (!isWorkspaceId(workspaceId)) return makeStatus("readonly", false);

  try {
    return withPermissionLock(workspaceId, () => {
      const file = permissionFile(workspaceId);
      const value = readJsonIfExists<unknown>(file);
      if (isCurrentState(value, workspaceId)) {
        if (isSessionGrant(value.sessionGrant)) return statusForCurrentState(value);

        // Upgrade pre-generation grants once, preserving only an authorization
        // that is still bound to this Windows logon session.
        const previousGrant = value.sessionGrant;
        const identity = value.baselineMode === "level1" && isPreGenerationSessionGrant(previousGrant)
          ? getCurrentSessionIdentityFingerprint()
          : null;
        if (!identity || !isPreGenerationSessionGrant(previousGrant) || identity !== previousGrant.identityFingerprint) {
          return makeStatus(value.baselineMode, false);
        }
        const epoch = Number.isSafeInteger(value.authorizationEpoch) && Number(value.authorizationEpoch) >= 0
          ? Number(value.authorizationEpoch)
          : 0;
        const upgraded = buildState(workspaceId, value.baselineMode, identity, epoch);
        try {
          writePermissionState(file, upgraded);
        } catch {
          return makeStatus(value.baselineMode, false);
        }
        return statusForCurrentState(upgraded);
      }
      if (!isLegacyState(value, workspaceId)) return makeStatus("readonly", false);

      const baselineMode = baselineForLegacyState(value);
      // Legacy v1 mode=level2 predates session binding, so it cannot prove that the
      // local user elevated Level 2 in *this* Windows logon session. Migrating it
      // into a session grant would silently satisfy the "each new logon session
      // must re-enable Level 2 manually" requirement, so the legacy bit is dropped:
      // the state is rewritten as a plain baseline and no sessionGrant is created.
      const migrated = buildState(workspaceId, baselineMode);
      try {
        writePermissionState(file, migrated);
      } catch {
        // Even if the rewrite fails, nothing is elevated.
        return makeStatus(baselineMode, false);
      }
      return makeStatus(baselineMode, false);
    });
  } catch {
    // Busy, unreadable, or otherwise unverifiable state stays at its baseline.
    return readPermissionStatus(workspaceId);
  }
}

/** Local CLI control-plane mutation. It is intentionally not exposed through MCP. */
export function setPermission(workspaceId: string, mode: PermissionMode): PermissionMode {
  if (!isWorkspaceId(workspaceId)) throw new TypeError("Invalid workspaceId");
  if (!isPermissionMode(mode)) throw new TypeError("Invalid permission mode");

  const baselineMode: PermissionBaselineMode = mode === "readonly" ? "readonly" : "level1";
  const fingerprint = mode === "level2" ? getCurrentSessionIdentityFingerprint() : null;
  return withPermissionLock(workspaceId, () => {
    const epoch = readAuthorizationEpochFile(workspaceId);
    if (epoch === null || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("AUTHORIZATION_EPOCH_UNAVAILABLE");
    const previous = readJsonIfExists<unknown>(permissionFile(workspaceId));
    const previousGrant = isCurrentState(previous, workspaceId) && isSessionGrant(previous.sessionGrant) ||
      isLegacyState(previous, workspaceId) && previous.mode === "level2";
    const authorizationEpoch = epoch + (mode === "level2" || previousGrant ? 1 : 0);
    const state = buildState(workspaceId, baselineMode, fingerprint ?? undefined, authorizationEpoch);
    writePermissionState(permissionFile(workspaceId), state);
    return statusForCurrentState(state).effectiveMode;
  });
}

/**
 * An explicitly named control-plane failure. `code` is a stable machine token a
 * local caller can report; `status` is the HTTP status the Bridge should use.
 * No message ever contains identity values, SIDs, LUIDs, or file contents.
 */
export class PermissionControlError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 409) {
    super(message);
    this.name = "PermissionControlError";
    this.code = code;
    this.status = status;
  }
}

export interface AppliedPermission {
  /** Mode requested by the caller, before any session binding is checked. */
  requestedMode: PermissionMode;
  /** Mirrors `status.effectiveMode` for convenience. */
  effectiveMode: PermissionMode;
  baselineMode: PermissionBaselineMode;
  sessionElevation: PermissionStatus["sessionElevation"];
  status: PermissionStatus;
}

/** Map store errors onto stable machine codes without leaking internals. */
function toControlError(error: unknown): PermissionControlError {
  if (error instanceof PermissionControlError) return error;
  if (error instanceof PermissionStateBusyError) {
    return new PermissionControlError(
      "PERMISSION_STATE_BUSY",
      "Permission state is being updated by another C2C process; nothing was changed.",
      409
    );
  }
  if (error instanceof Error && error.message === "AUTHORIZATION_EPOCH_UNAVAILABLE") {
    return new PermissionControlError(
      "PERMISSION_STATE_MALFORMED",
      "Stored permission state is malformed or unreadable; refusing to change it.",
      500
    );
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM") {
    return new PermissionControlError(
      "PERMISSION_STATE_UNWRITABLE",
      "Permission state could not be written; nothing was changed.",
      500
    );
  }
  return new PermissionControlError(
    "PERMISSION_STATE_UNAVAILABLE",
    "Permission state could not be updated; nothing was confirmed.",
    500
  );
}

/**
 * Grant or revoke the current-session Level 2 authority, reporting only the state
 * that was actually persisted and re-verified from disk. This is the single
 * control-plane entry point for the Bridge's loopback admin surface and the CLI.
 *
 * Semantics (deliberately stricter than a bare setPermission call):
 *  - The baseline is never persisted as level2; `level2` only ever writes a
 *    persistent level1 baseline plus a session grant bound to this process's own
 *    Windows logon identity (`getCurrentSessionIdentityFingerprint()`).
 *  - When that identity cannot be confirmed, NOTHING is written and
 *    `SESSION_IDENTITY_UNVERIFIED` is raised.
 *  - When the caller asked for level2 and the re-read effective mode is not
 *    level2, `LEVEL2_NOT_EFFECTIVE` is raised instead of reporting success.
 *  - Busy, malformed, or unwritable state raises a PermissionControlError with a
 *    stable code; the previous state is left untouched where possible.
 *  - The authorization epoch is bumped by setPermission itself.
 */
export function applyPermission(workspaceId: string, mode: PermissionMode): AppliedPermission {
  if (!isWorkspaceId(workspaceId)) throw new TypeError("Invalid workspaceId");
  if (!isPermissionMode(mode)) throw new TypeError("Invalid permission mode");

  if (mode === "level2" && getCurrentSessionIdentityFingerprint() === null) {
    throw new PermissionControlError(
      "SESSION_IDENTITY_UNVERIFIED",
      "The current Windows logon session identity could not be confirmed; Level 2 was not enabled and nothing was changed.",
      409
    );
  }

  let appliedMode: PermissionMode;
  try {
    appliedMode = setPermission(workspaceId, mode);
  } catch (error) {
    throw toControlError(error);
  }

  let status: PermissionStatus;
  try {
    status = readPermissionStatus(workspaceId);
  } catch (error) {
    throw toControlError(error);
  }
  if (permissionLockBlocksRead(workspaceId)) {
    throw new PermissionControlError(
      "PERMISSION_STATE_BUSY",
      "Permission state could not be re-verified after the update; treat the change as unconfirmed.",
      409
    );
  }
  if ((status.baselineMode as string) === "level2") {
    throw new PermissionControlError(
      "PERMISSION_BASELINE_INVALID",
      "Persisted baseline is invalid; refusing to confirm the change.",
      500
    );
  }
  if (mode === "level2" && status.effectiveMode !== "level2") {
    throw new PermissionControlError(
      "LEVEL2_NOT_EFFECTIVE",
      `Level 2 was not effective after the update (effective mode is ${status.effectiveMode}).`,
      409
    );
  }
  if (status.effectiveMode !== appliedMode) {
    throw new PermissionControlError(
      "PERMISSION_STATE_INCONSISTENT",
      "Permission state changed while it was being confirmed; treat the change as unconfirmed.",
      409
    );
  }

  return {
    requestedMode: mode,
    effectiveMode: status.effectiveMode,
    baselineMode: status.baselineMode,
    sessionElevation: status.sessionElevation,
    status,
  };
}
