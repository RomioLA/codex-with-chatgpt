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
    if (current.dev !== observed.dev || current.ino !== observed.ino || !current.isFile() || current.isSymbolicLink()) return true;
  } catch { return true; }

  // A live Native launch permit holds this same exclusive lock only across
  // permission validation and ResumeThread. It does not mutate the manifest,
  // so read-only authorization checks must continue to see the stable grant.
  const launchOwner = /^launch:([1-9][0-9]*)\r?\n?$/.exec(owner);
  if (!launchOwner) return true;
  const pid = Number(launchOwner[1]);
  if (!Number.isSafeInteger(pid)) return true;
  try { process.kill(pid, 0); return false; }
  catch { return true; }
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

function buildState(workspaceId: string, baselineMode: PermissionBaselineMode, identityFingerprint?: string): PersistedPermission {
  const state: PersistedPermission = {
    version: PERMISSION_STATE_VERSION,
    workspaceId,
    baselineMode,
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

/**
 * Local startup/CLI migration only. MCP status reads never call this function,
 * so a remote read cannot create a Level 2 session grant from legacy state.
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
        const upgraded = buildState(workspaceId, value.baselineMode, identity);
        try {
          writePermissionState(file, upgraded);
        } catch {
          return makeStatus(value.baselineMode, false);
        }
        return statusForCurrentState(upgraded);
      }
      if (!isLegacyState(value, workspaceId)) return makeStatus("readonly", false);

      const baselineMode = baselineForLegacyState(value);
      const fingerprint = value.mode === "level2" ? getCurrentSessionIdentityFingerprint() : null;
      const migrated = buildState(workspaceId, baselineMode, fingerprint ?? undefined);
      try {
        writePermissionState(file, migrated);
      } catch {
        // The legacy level2 bit is never honored unless its session grant was persisted.
        return makeStatus(baselineMode, false);
      }
      return makeStatus(baselineMode, Boolean(fingerprint && migrated.sessionGrant));
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
  const state = buildState(workspaceId, baselineMode, fingerprint ?? undefined);
  return withPermissionLock(workspaceId, () => {
    writePermissionState(permissionFile(workspaceId), state);
    return statusForCurrentState(state).effectiveMode;
  });
}
