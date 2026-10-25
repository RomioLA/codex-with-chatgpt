/**
 * C2C Local V1.4 - Level 2 session grant: authorization semantics (P01..P03, P06..P10, P16).
 *
 * These tests exercise the REAL permission store (`src/permission/store.ts`) and the
 * REAL identity normaliser (`src/permission/session-identity.ts`). The only replaced
 * input is the OS call behind `getCurrentSessionIdentityFingerprint()`.
 *
 * Staging rules (learned the hard way in this sandbox - see level2-grant.helpers.ts):
 *  1. The namespace import of `session-identity` below MUST appear BEFORE `vi.mock`.
 *     A later `import()` returns a different module proxy here, so the namespace is
 *     the only object that shares the mock registry with the store's static import.
 *     `stage()` writes through that namespace, which is why the store sees it.
 *  2. The real store is imported ONCE at module top level, after the mock, so its
 *     static `session-identity` import resolves to the staged namespace.
 *  3. No `vi.resetModules()` in this file: it would re-resolve the store against the
 *     real identity module and silently invalidate the staging.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as identity from "../src/permission/session-identity.js";

// The staged value lives in a hoisted holder so the mock factory can close over it.
const staged = vi.hoisted(() => ({ fingerprint: null as string | null }));

vi.mock("../src/permission/session-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/permission/session-identity.js")>();
  return {
    ...actual,
    // The identity NORMALISER stays the real implementation.
    fingerprintWindowsSessionIdentity: (value: unknown) => actual.fingerprintWindowsSessionIdentity(value),
    // Only the OS call is staged.
    getCurrentSessionIdentityFingerprint: () => staged.fingerprint,
  };
});

const permission = await import("../src/permission/store.js");
const {
  makeRun, isolateStateDir, currentIdentity, differentBootIdentity, differentLogonIdentity,
  validGrantState, GRANT_FIELD_KEYS,
} = await import("./level2-grant.helpers.js");
type RunFs = import("./level2-grant.helpers.js").RunFs;
type IdentityTuple = import("./level2-grant.helpers.js").StagedIdentity;

/** Stage a tuple (or no identity at all) for the whole loaded graph. */
function stage(selected: IdentityTuple | null, rawIdentity?: unknown): void {
  staged.fingerprint = selected === null
    ? null
    : identity.fingerprintWindowsSessionIdentity(rawIdentity !== undefined ? rawIdentity : selected);
}

function fingerprintOf(tuple: IdentityTuple): string {
  const value = identity.fingerprintWindowsSessionIdentity(tuple);
  if (!value) throw new Error("fixture identity is not a valid Windows session identity");
  return value;
}

let run: RunFs;
let restoreEnv: () => void;
const permissionFileOf = (workspaceId: string): string => path.join(run.stateDir, "permissions", `${workspaceId}.json`);
const readFileOf = (workspaceId: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(permissionFileOf(workspaceId), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  run = makeRun("store");
  restoreEnv = isolateStateDir(run.stateDir);
});

afterEach(() => {
  restoreEnv();
});

describe("Level2 session grant (store)", () => {
  it("P01 CLI identity == Bridge identity -> Level2 PASS", () => {
    // The CLI process writes the grant from its Windows tuple.
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");

    // "New Bridge process": the same tuple, resolved again.
    stage(currentIdentity());
    expect(permission.readPermissionStatus(run.workspaceId)).toEqual({
      mode: "level2",
      baselineMode: "level1",
      effectiveMode: "level2",
      sessionElevation: { active: true, expiresOn: "logout-or-reboot" },
    });
    expect(permission.readPermission(run.workspaceId)).toBe("level2");
    expect(permission.readCurrentSessionGrant(run.workspaceId)).not.toBeNull();
  });

  it("P02 logonId differs (userSid + sessionId equal) -> old grant mechanism yields an inert grant", () => {
    const tuple = currentIdentity();
    const otherLogon = differentLogonIdentity();
    expect(otherLogon.userSid).toBe(tuple.userSid);
    expect(otherLogon.sessionId).toBe(tuple.sessionId);
    expect(otherLogon.logonId).not.toBe(tuple.logonId);
    expect(fingerprintOf(otherLogon)).not.toBe(fingerprintOf(tuple));

    // The CLI grants Level 2 inside logon session A.
    stage(tuple);
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");
    const grantFingerprint = fingerprintOf(tuple);

    // The Bridge resolves a DIFFERENT logon LUID; only the fingerprint is compared.
    stage(otherLogon);
    const status = permission.readPermissionStatus(run.workspaceId);
    expect(status.effectiveMode).toBe("level1");
    expect(status.sessionElevation).toEqual({ active: false, expiresOn: null });
    expect(status.baselineMode).toBe("level1");
    expect(permission.readCurrentSessionGrant(run.workspaceId)).toBeNull();
    // The persisted record is untouched: the grant exists but can never match -
    // exactly the symptom the launcher must report instead of claiming success.
    expect((readFileOf(run.workspaceId).sessionGrant as { identityFingerprint: string }).identityFingerprint)
      .toBe(grantFingerprint);
  });

  it("P03 the new local authorization flow -> Bridge effectiveMode = level2", () => {
    // Step 1: the local CLI sets the level1 baseline (no elevation).
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level1")).toBe("level1");
    expect(permission.readPermissionStatus(run.workspaceId).effectiveMode).toBe("level1");

    // Step 2: the Bridge process itself creates the session grant, so the identity
    // bound into it is the Bridge's own tuple - the flow behind
    // POST /admin/permission (verified end-to-end in the bridge suite).
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");
    expect(permission.readPermissionStatus(run.workspaceId)).toMatchObject({
      baselineMode: "level1",
      effectiveMode: "level2",
      sessionElevation: { active: true, expiresOn: "logout-or-reboot" },
    });
    expect(permission.readCurrentSessionGrant(run.workspaceId)?.identityFingerprint)
      .toBe(fingerprintOf(currentIdentity()));

    // Step 3: a later independent reader (the MCP-facing Bridge) agrees.
    stage(currentIdentity());
    expect(permission.readPermission(run.workspaceId)).toBe("level2");
  });

  it("P06 the Level2 grant is bound to the current Bridge/logon identity", () => {
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");

    const expectedFingerprint = fingerprintOf(currentIdentity());
    const persisted = readFileOf(run.workspaceId) as {
      sessionGrant: { identityFingerprint: string; grantId: string; createdAt: string };
    };
    expect(persisted.sessionGrant.identityFingerprint).toBe(expectedFingerprint);
    expect(persisted.sessionGrant.grantId).toMatch(/^[a-f0-9]{64}$/);
    expect(new Date(persisted.sessionGrant.createdAt).toISOString()).toBe(persisted.sessionGrant.createdAt);

    expect(permission.readCurrentSessionGrant(run.workspaceId)).toEqual({
      identityFingerprint: expectedFingerprint,
      grantId: persisted.sessionGrant.grantId,
    });

    // A record bound to a different identity is not "current" for this process.
    run.writePersisted(validGrantState(run.workspaceId, "c".repeat(64)));
    expect(permission.readCurrentSessionGrant(run.workspaceId)).toBeNull();
    expect(permission.readPermissionStatus(run.workspaceId).effectiveMode).not.toBe("level2");
  });

  it("P07 logout/reboot identity change -> Level2 no longer effective (baseline preserved)", () => {
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");
    expect(permission.readPermissionStatus(run.workspaceId).effectiveMode).toBe("level2");

    // Reboot: same user, same terminal-services session, different boot tuple.
    stage(differentBootIdentity());
    expect(permission.readPermissionStatus(run.workspaceId)).toEqual({
      mode: "level1",
      baselineMode: "level1",
      effectiveMode: "level1",
      sessionElevation: { active: false, expiresOn: null },
    });
    expect(permission.readCurrentSessionGrant(run.workspaceId)).toBeNull();
    // Revocation is non-destructive: the persistent baseline is what survives.
    expect(readFileOf(run.workspaceId)).toMatchObject({ version: 2, baselineMode: "level1" });
  });

  it("P08 stale grant (another boot's valid record) -> baseline level1", () => {
    run.writePersisted(validGrantState(run.workspaceId, fingerprintOf(differentBootIdentity())));

    stage(currentIdentity());
    const status = permission.readPermissionStatus(run.workspaceId);
    expect(status.baselineMode).toBe("level1");
    expect(status.effectiveMode).toBe("level1");
    expect(status.sessionElevation.active).toBe(false);

    // A stale grant never upgrades a readonly baseline either.
    run.writePersisted(validGrantState(run.workspaceId, "d".repeat(64), { baselineMode: "readonly" }));
    expect(permission.readPermissionStatus(run.workspaceId).effectiveMode).toBe("readonly");
  });

  it("P09 malformed grant (bad fingerprint/grantId/createdAt/version/torn JSON) -> fail closed", () => {
    const fingerprint = fingerprintOf(currentIdentity());
    const seeded = validGrantState(run.workspaceFor("shape"), fingerprint);
    const sessionGrant = seeded.sessionGrant as Record<string, unknown>;

    const cases: Array<[string, unknown]> = [
      ["bad fingerprint", { ...seeded, sessionGrant: { ...sessionGrant, identityFingerprint: "not-a-digest" } }],
      ["bad grantId", { ...seeded, sessionGrant: { ...sessionGrant, grantId: "deadbeef" } }],
      ["bad createdAt", { ...seeded, sessionGrant: { ...sessionGrant, createdAt: "2026-10-23" } }],
      ["unknown version", { ...seeded, version: 3 }],
      ["torn JSON", JSON.stringify(seeded).slice(0, 60)],
      ["sessionGrant is not an object", { ...seeded, sessionGrant: "level2" }],
      ["missing updatedAt", (() => { const copy: Record<string, unknown> = { ...seeded }; delete copy.updatedAt; return copy; })()],
      // version 1 is the LEGACY record: its `mode: level2` bit must never be honoured
      // by a read-only path (migration is covered separately in P16b).
      ["wrong version (legacy v1 level2)", { version: 1, workspaceId: run.workspaceId, mode: "level2", updatedAt: "legacy" }],
    ];

    stage(currentIdentity());

    // Stored under the production workspace ID: a record claiming another workspace
    // is not this workspace's grant.
    run.writePersisted({ ...seeded, workspaceId: "000000000000" });
    expect(permission.readPermissionStatus(run.workspaceId).effectiveMode).not.toBe("level2");
    expect(permission.readCurrentSessionGrant(run.workspaceId)).toBeNull();

    for (const [name, caseValue] of cases) {
      // Each malformed shape gets its own workspace ID so cases cannot mask each
      // other. Only the shape under test varies.
      const workspaceId = run.workspaceFor(name);
      const file = permissionFileOf(workspaceId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const shaped = typeof caseValue === "string"
        ? caseValue
        : JSON.stringify({ ...(caseValue as Record<string, unknown>), workspaceId });
      fs.writeFileSync(file, shaped);

      const status = permission.readPermissionStatus(workspaceId);
      expect(status.effectiveMode, `case: ${name}`).not.toBe("level2");
      expect(status.sessionElevation.active, `case: ${name}`).toBe(false);
      expect(permission.readCurrentSessionGrant(workspaceId), `case: ${name}`).toBeNull();

      // The control plane either refuses (stable machine code, record untouched) or
      // writes a fresh, fully verified state. A silent "grant kept but inactive" is
      // exactly what must not happen.
      const outcome = (() => {
        try { return { mode: permission.setPermission(workspaceId, "level2") as string }; }
        catch (error) { return { error: String((error as { code?: string }).code ?? (error as Error).message) }; }
      })();
      if ("error" in outcome) {
        expect(outcome.error, `case: ${name}`).toMatch(/^(PERMISSION_STATE_|AUTHORIZATION_EPOCH_UNAVAILABLE)/);
        expect(fs.readFileSync(file, "utf8"), `case: ${name}`).toBe(shaped);
      } else {
        expect(outcome.mode, `case: ${name}`).toBe("level2");
        expect(permission.readCurrentSessionGrant(workspaceId), `case: ${name}`).not.toBeNull();
      }
    }

    // Recovery: a clean workspace ID still reaches a verified level2.
    const clean = run.workspaceFor("recovered");
    expect(permission.setPermission(clean, "level2")).toBe("level2");
    expect(permission.readPermission(clean)).toBe("level2");
  });

  it("P10 permission 1 -> Bridge reports level1 (and a later grant cannot self-upgrade)", () => {
    stage(currentIdentity());
    expect(permission.setPermission(run.workspaceId, "level2")).toBe("level2");
    const upgradedGrantId = permission.readCurrentSessionGrant(run.workspaceId)?.grantId;
    expect(upgradedGrantId).toMatch(/^[a-f0-9]{64}$/);

    // `permission 1` is the local downgrade: it revokes the session grant.
    expect(permission.setPermission(run.workspaceId, "level1")).toBe("level1");
    const persisted = readFileOf(run.workspaceId) as { baselineMode: string; sessionGrant?: unknown; authorizationEpoch?: number };
    expect(persisted.baselineMode).toBe("level1");
    expect(persisted.sessionGrant).toBeUndefined();
    expect(persisted.authorizationEpoch).toBeGreaterThan(0);

    // The Bridge, resolving the very same identity, must report level1.
    stage(currentIdentity());
    expect(permission.readPermissionStatus(run.workspaceId)).toEqual({
      mode: "level1",
      baselineMode: "level1",
      effectiveMode: "level1",
      sessionElevation: { active: false, expiresOn: null },
    });
  });

  it("P16a the identity tuple still requires all five fields (guard)", () => {
    const tuple = currentIdentity();
    expect(Object.keys(tuple).sort()).toEqual([...GRANT_FIELD_KEYS].sort());

    const baseline = identity.fingerprintWindowsSessionIdentity(tuple);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);

    for (const field of GRANT_FIELD_KEYS) {
      const missing: Record<string, unknown> = { ...tuple };
      delete missing[field];
      expect(identity.fingerprintWindowsSessionIdentity(missing), `missing ${field}`).toBeNull();
      // Every field participates: none can be dropped from the digest.
      const changed = { ...tuple, [field]: field === "sessionId" ? tuple.sessionId + 1 : "zzzz-changed" };
      expect(identity.fingerprintWindowsSessionIdentity(changed), `changed ${field}`).not.toBe(baseline);
    }

    // Extra material cannot substitute for a real tuple; junk shapes fail closed.
    expect(identity.fingerprintWindowsSessionIdentity(null)).toBeNull();
    expect(identity.fingerprintWindowsSessionIdentity([])).toBeNull();
    expect(identity.fingerprintWindowsSessionIdentity("S-1-5-21-1-2-3-1001")).toBeNull();
    expect(identity.fingerprintWindowsSessionIdentity({ ...tuple, extra: "ignored-but-harmless" })).toBe(baseline);

    // Guard against a future "convenience" seam: the shipped module must not expose
    // a way for a test (or anything else) to inject a fingerprint. Staging belongs
    // in tests (this file's vi.mock), never in product code.
    expect("setCachedSessionFingerprintForTests" in identity).toBe(false);
    expect("setSessionFingerprint" in identity).toBe(false);
  });

  it("P16b a missing/absent fingerprint can never yield level2 (guard)", () => {
    const fingerprint = fingerprintOf(currentIdentity());
    const isolated = run.workspaceFor("p16b");

    // (1) Identity unresolvable in this process: the elevation request fails closed
    //     and persists only the level1 baseline - never a level2 grant.
    stage(null);
    expect(identity.getCurrentSessionIdentityFingerprint()).toBeNull();
    expect(permission.setPermission(isolated, "level2")).toBe("level1");
    expect(permission.readPermission(isolated)).toBe("level1");
    const persisted = readFileOf(isolated) as { version: number; baselineMode: string; sessionGrant?: unknown };
    expect(persisted).toMatchObject({ version: 2, baselineMode: "level1" });
    expect(persisted.sessionGrant).toBeUndefined();
    expect(permission.readCurrentSessionGrant(isolated)).toBeNull();

    // (1b) The explicit control-plane entry point refuses to write anything at all.
    const refused = (() => {
      try { permission.applyPermission(isolated, "level2"); return null; }
      catch (error) { return error as { code?: string }; }
    })();
    expect(refused?.code).toBe("SESSION_IDENTITY_UNVERIFIED");

    // (2) A grant whose fingerprint key is absent is not a grant.
    stage(currentIdentity());
    run.writePersisted({
      ...validGrantState(isolated, fingerprint),
      sessionGrant: { grantId: "e".repeat(64), createdAt: "2026-10-23T07:20:00.000Z" },
    });
    expect(permission.readPermissionStatus(isolated).effectiveMode).toBe("level1");
    expect(permission.readCurrentSessionGrant(isolated)).toBeNull();

    // (3) Legacy v1 `mode: level2` is not trusted by a read-only status path.
    run.writePersisted({ version: 1, workspaceId: isolated, mode: "level2", updatedAt: "legacy" });
    expect(permission.readPermissionStatus(isolated).effectiveMode).toBe("level1");

    // (4) A legacy level2 record with no resolvable identity must not migrate to level2.
    stage(null);
    expect(permission.ensurePermissionMigrated(isolated)).toMatchObject({
      baselineMode: "level1",
      effectiveMode: "level1",
      sessionElevation: { active: false },
    });
    expect((readFileOf(isolated) as { sessionGrant?: unknown }).sessionGrant).toBeUndefined();
  });

  it("P16c legacy v1 mode=level2 migrates to baseline level1 and never mints a sessionGrant", () => {
    // A real Windows login session IS resolvable in this process, so the pre-fix
    // behaviour would have minted a Level 2 grant for it. The migration must not.
    stage(currentIdentity());
    const workspaceId = run.workspaceFor("p16c-identity-present");
    run.writePersisted({ version: 1, workspaceId, mode: "level2", updatedAt: "legacy" }, workspaceId);

    // The migration itself: baseline level1, no elevation, no grant.
    expect(permission.ensurePermissionMigrated(workspaceId)).toMatchObject({
      mode: "level1",
      baselineMode: "level1",
      effectiveMode: "level1",
      sessionElevation: { active: false, expiresOn: null },
    });

    // On disk: a v2 record with no sessionGrant whatsoever.
    const persisted = readFileOf(workspaceId) as { version: number; baselineMode: string; sessionGrant?: unknown };
    expect(persisted).toMatchObject({ version: 2, baselineMode: "level1" });
    expect(persisted.sessionGrant).toBeUndefined();
    expect(permission.readCurrentSessionGrant(workspaceId)).toBeNull();

    // A read of the migrated state still reports level1 - the legacy bit is gone.
    expect(permission.readPermissionStatus(workspaceId).effectiveMode).toBe("level1");
    expect(permission.readPermission(workspaceId)).toBe("level1");

    // Re-running the migration is a no-op: it can never resurrect the legacy level2.
    expect(permission.ensurePermissionMigrated(workspaceId)).toMatchObject({ baselineMode: "level1", effectiveMode: "level1" });
    expect((readFileOf(workspaceId) as { sessionGrant?: unknown }).sessionGrant).toBeUndefined();

    // Legacy readonly still maps to a readonly baseline, unchanged by this fix.
    const readonlyId = run.workspaceFor("p16c-readonly");
    run.writePersisted({ version: 1, workspaceId: readonlyId, mode: "readonly", updatedAt: "legacy" }, readonlyId);
    expect(permission.ensurePermissionMigrated(readonlyId)).toMatchObject({ baselineMode: "readonly", effectiveMode: "readonly" });
    expect((readFileOf(readonlyId) as { sessionGrant?: unknown }).sessionGrant).toBeUndefined();
  });

  it("P02b (root cause) an unstable bootTime text alone breaks CLI->Bridge grant matching", () => {
    const workspaceId = run.workspaceFor("p02b");

    // The CLI wrote its grant from bootTime text ".5000000Z".
    stage(currentIdentity());
    expect(permission.setPermission(workspaceId, "level2")).toBe("level2");
    const cliGrant = (readFileOf(workspaceId) as { sessionGrant: { identityFingerprint: string } }).sessionGrant;

    // The Bridge resolves the SAME boot to text ".4000000Z" (observed drift).
    const drifted = { ...currentIdentity(), bootTime: "2026-10-23T07:14:40.4000000Z" };
    expect(fingerprintOf(currentIdentity())).not.toBe(identity.fingerprintWindowsSessionIdentity(drifted));
    stage(currentIdentity(), drifted);
    expect(permission.readPermissionStatus(workspaceId).effectiveMode).toBe("level1");
    expect(permission.readCurrentSessionGrant(workspaceId)).toBeNull();

    // Only the boot-time text changed; every other identity field still matches.
    expect(drifted.bootId).toBe(currentIdentity().bootId);
    expect(drifted.userSid).toBe(currentIdentity().userSid);
    expect(drifted.sessionId).toBe(currentIdentity().sessionId);
    expect(drifted.logonId).toBe(currentIdentity().logonId);
    expect(cliGrant.identityFingerprint).toBe(fingerprintOf(currentIdentity()));

    // Proof this is the settled root cause and not a logon change: the exact same
    // ".5000000Z" tuple still matches on both sides.
    stage(currentIdentity());
    expect(permission.readPermission(workspaceId)).toBe("level2");
    expect(fs.existsSync(permissionFileOf(workspaceId))).toBe(true);
  });
});
