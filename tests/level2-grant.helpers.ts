/**
 * Shared fixtures for the C2C Local V1.4 Level 2 session-grant suite (P01..P16).
 *
 * Design notes (why this file is shaped the way it is):
 * - `src/permission/session-identity.ts` resolves the Windows identity from the
 *   OS. `loadPermission()` stages the tuple with `vi.doMock` + a dynamic import
 *   (the same pattern as the repository's baseline tests), so the REAL store,
 *   policy and fingerprint normaliser run while only the OS call is replaced.
 * - The staged value always comes from the real `fingerprintWindowsSessionIdentity`,
 *   so a test can never invent a digest the normaliser would reject.
 * - State isolation uses `C2C_STATE_DIR` pointed at an isolated temp directory,
 *   which is how the codebase isolates persistent state everywhere else.
 * - Constants (tokens, phrases) are exported so the launcher suite and the Bridge
 *   suite assert the SAME contract in one place.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { makeTmpDir } from "./helpers.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The workspace the production launcher targets. */
export const PRODUCTION_WORKSPACE_ID = "9e005ae5cc15";

/** Identifiers that must never appear in a success payload. */
export const SUCCESS_PHRASE = "本机权限命令执行成功";

/** Launcher failure tokens (task-1 SCOPE B contract). */
export const LAUNCHER_TOKENS = Object.freeze({
  level2: "LEVEL2_BRIDGE_VERIFICATION_FAILED",
  level1: "LEVEL1_BRIDGE_VERIFICATION_FAILED",
  unavailable: "BRIDGE_UNAVAILABLE",
  identity: "BRIDGE_IDENTITY_MISMATCH",
  workspace: "BRIDGE_WORKSPACE_MISMATCH",
});

export interface StagedIdentity {
  bootId: string;
  bootTime: string;
  userSid: string;
  sessionId: number;
  logonId: string;
}

/**
 * The real Windows tuple as observed on this machine during the root-cause
 * investigation (boot GUID, sub-millisecond boot FILETIME text, user SID,
 * terminal-services session 1, token AuthenticationId LUID).
 */
const CURRENT_IDENTITY: StagedIdentity = {
  bootId: "8f5a1c92-3f5e-4a67-9b21-6c0d1e2f3a4b",
  bootTime: "2026-10-23T07:14:40.5000000Z",
  userSid: "S-1-5-21-3879413424-3396630506-2536446151-1001",
  sessionId: 1,
  logonId: "000000000001234a",
};

export function currentIdentity(): StagedIdentity {
  return { ...CURRENT_IDENTITY };
}

/** A new logon session on the same Windows session ID and user (the P02 case). */
export function differentLogonIdentity(): StagedIdentity {
  return {
    ...CURRENT_IDENTITY,
    logonId: "0000000000099999",
  };
}

/** A different boot (reboot) on the same user and session ID. */
export function differentBootIdentity(): StagedIdentity {
  return {
    ...CURRENT_IDENTITY,
    bootId: "11111111-2222-4333-8444-555555555555",
    bootTime: "2026-10-24T09:00:00.0000000Z",
  };
}

export type PermissionModule = typeof import("../src/permission/store.js") & typeof import("../src/permission/session-identity.js");

export interface LoadPermissionOptions {
  /**
   * How the process-local Windows identity is resolved.
   * - an identity object -> a stable fingerprint
   * - null -> "identity cannot be confirmed" (every resolver fails closed)
   * - "unavailable" -> same as null
   * Default: `currentIdentity()`.
   */
  identity?: StagedIdentity | null | "unavailable";
  /** Override the raw OS payload the fingerprint function receives (P09 shape tests). */
  rawIdentity?: unknown;
}

/**
 * Stage the Windows identity for the WHOLE test file and load the real permission
 * module graph against it.
 *
 * Mechanism (the same pattern the repository's baseline tests use):
 * `vi.doMock("../src/permission/session-identity.js", ...)` + a fresh dynamic
 * `import()` of the real store. Every consumer in that module graph - including
 * `store.ts`, which imports the module statically - resolves the mocked module.
 *
 * Invariants:
 *  - The store, the policy layer and the identity NORMALISER are the real,
 *    unmodified implementations (`fingerprintWindowsSessionIdentity` is forwarded
 *    to the actual function); only `getCurrentSessionIdentityFingerprint()` -
 *    i.e. the OS call - is replaced by the staged tuple.
 *  - Call this ONCE per test and do NOT call `vi.resetModules()` afterwards; a
 *    second reset would hand static importers the real module instead of the
 *    staged one, which silently weakens (or inverts) the test.
 *  - `seedIdentity()` lets a test change the staged tuple for an ALREADY loaded
 *    graph, so "the CLI process" and "the Bridge process" can be simulated by
 *    re-staging before observing again.
 */
export interface StagedPermission {
  module: PermissionModule;
  /** Replace the staged tuple for the current graph. */
  seedIdentity(identity: StagedIdentity | null | "unavailable", rawIdentity?: unknown): void;
}

export async function loadPermission(options: LoadPermissionOptions = {}): Promise<StagedPermission> {
  const identityModule = await import("../src/permission/session-identity.js");
  const state = {
    fingerprint: resolveFingerprint(identityModule, options.identity ?? currentIdentity(), options.rawIdentity),
  };

  vi.doMock("../src/permission/session-identity.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/permission/session-identity.js")>();
    return {
      ...actual,
      fingerprintWindowsSessionIdentity: (value: unknown) => actual.fingerprintWindowsSessionIdentity(value),
      getCurrentSessionIdentityFingerprint: () => state.fingerprint,
    };
  });

  const module = await import("../src/permission/store.js") as PermissionModule;
  return {
    module,
    seedIdentity(identity, rawIdentity) {
      state.fingerprint = resolveFingerprintFromLoadedStore(identityModule, identity, rawIdentity);
    },
  };
}

/**
 * Derive the CURRENT session fingerprint exactly the way the store does, i.e. via
 * the module the store itself imported (the mocked `session-identity` inside the
 * loaded graph). Tests that must assert "the grant is bound to this process's
 * identity" use this instead of normalising a fixture by hand.
 */
export async function currentFingerprintOfLoadedGraph(): Promise<string | null> {
  const identityModule = await import("../src/permission/session-identity.js");
  return identityModule.getCurrentSessionIdentityFingerprint();
}

function resolveFingerprint(
  identityModule: typeof import("../src/permission/session-identity.js"),
  selected: StagedIdentity | null | "unavailable",
  rawIdentity: unknown
): string | null {
  if (selected === null || selected === "unavailable") return null;
  const raw = rawIdentity !== undefined ? rawIdentity : selected;
  return identityModule.fingerprintWindowsSessionIdentity(raw);
}

function resolveFingerprintFromLoadedStore(
  identityModule: typeof import("../src/permission/session-identity.js"),
  selected: StagedIdentity | null | "unavailable",
  rawIdentity: unknown
): string | null {
  return resolveFingerprint(identityModule, selected, rawIdentity);
}

/** The fingerprint a given identity resolves to through the real normaliser. */
export async function fingerprintOf(identity: StagedIdentity): Promise<string> {
  const { fingerprintWindowsSessionIdentity } = await import("../src/permission/session-identity.js");
  const value = fingerprintWindowsSessionIdentity(identity);
  if (!value) throw new Error("fixture identity is not a valid Windows session identity");
  return value;
}

/** The fingerprint the OLD (unstable bootTime text) mechanism produced. */
export async function staleBootTimeFingerprint(identity: StagedIdentity = currentIdentity()): Promise<string> {
  const { fingerprintWindowsSessionIdentity } = await import("../src/permission/session-identity.js");
  // The observed cross-process drift: .5000000Z was sometimes read as .4000000Z
  // or truncated to a whole second, which changed the canonical ISO text.
  const value = fingerprintWindowsSessionIdentity({ ...identity, bootTime: "2026-10-23T07:14:40.4000000Z" });
  if (!value) throw new Error("stale fixture identity is not valid");
  return value;
}

export interface RunFs {
  stateDir: string;
  workspaceId: string;
  /** `permissions/<workspaceId>.json` */
  permissionFile(workspaceId?: string): string;
  readPersisted(workspaceId?: string): Record<string, unknown> | null;
  readPersistedRaw(workspaceId?: string): string | null;
  writePersistedRaw(contents: string, workspaceId?: string): void;
  writePersisted(value: unknown, workspaceId?: string): void;
  runtimeFile(workspaceId?: string): string;
  /**
   * A per-run workspace ID for a named sub-case. Permission state is keyed by
   * workspace ID, so distinct IDs keep cases independent even when a test leaves
   * deliberately malformed state behind.
   */
  workspaceFor(suffix: string): string;
}

/** 12 lowercase hex characters, the only accepted workspace ID shape. */
function deriveWorkspaceId(base: string, suffix: string): string {
  const digest = createHash("sha256").update(`${base}:${suffix}`).digest("hex");
  return digest.slice(0, 12);
}

/** Isolated state dir + workspace id; nothing touches the real C2C state. */
export function makeRun(name: string): RunFs {
  const stateDir = makeTmpDir(`level2-${name}`);
  const workspaceId = PRODUCTION_WORKSPACE_ID;
  const permissionFile = (targetWorkspaceId = workspaceId): string =>
    path.join(stateDir, "permissions", `${targetWorkspaceId}.json`);
  return {
    stateDir,
    workspaceId,
    permissionFile,
    readPersistedRaw: (targetWorkspaceId = workspaceId) => {
      try { return fs.readFileSync(permissionFile(targetWorkspaceId), "utf8"); }
      catch { return null; }
    },
    readPersisted: (targetWorkspaceId = workspaceId) => {
      try { return JSON.parse(fs.readFileSync(permissionFile(targetWorkspaceId), "utf8")) as Record<string, unknown>; }
      catch { return null; }
    },
    writePersistedRaw: (contents: string, targetWorkspaceId = workspaceId) => {
      fs.mkdirSync(path.dirname(permissionFile(targetWorkspaceId)), { recursive: true });
      fs.writeFileSync(permissionFile(targetWorkspaceId), contents);
    },
    writePersisted: (value: unknown, targetWorkspaceId = workspaceId) => {
      fs.mkdirSync(path.dirname(permissionFile(targetWorkspaceId)), { recursive: true });
      fs.writeFileSync(permissionFile(targetWorkspaceId), JSON.stringify(value, null, 2));
    },
    runtimeFile: (targetWorkspaceId = workspaceId) => path.join(stateDir, "runtime", `${targetWorkspaceId}.json`),
    workspaceFor: (suffix: string) => deriveWorkspaceId(workspaceId, suffix),
  };
}

/** Point C2C_STATE_DIR at an isolated dir; returns a restore function. */
export function isolateStateDir(stateDir: string): () => void {
  const previous = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  return () => {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
  };
}

/** A well-formed v2 permission record for the given grant fingerprint. */
export function validGrantState(
  workspaceId: string,
  identityFingerprint: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    version: 2,
    workspaceId,
    baselineMode: "level1",
    sessionGrant: {
      identityFingerprint,
      grantId: "b".repeat(64),
      createdAt: "2026-10-23T07:20:00.000Z",
    },
    authorizationEpoch: 1,
    updatedAt: "2026-10-23T07:20:00.000Z",
    ...overrides,
  };
}

/** Stable-per-run unique name for temp fixtures. */
export function uniqueTmpName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export const GRANT_FIELD_KEYS = Object.freeze([
  "bootId",
  "bootTime",
  "userSid",
  "sessionId",
  "logonId",
] as const);

