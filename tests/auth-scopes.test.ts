import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStore, DEFAULT_SCOPES, SUPPORTED_SCOPES, filterScopes } from "../src/auth/store.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const V1_SCOPES = ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"];
const APPROVED_DEFAULT_SCOPES = ["workspace.read", "workspace.search", "git.read", "execution.read", "system.read", "workspace.write", "workspace.delete", "filesystem.external.read", "filesystem.external.write", "execution.jobs.read", "execution.run", "execution.cancel", "offline_access"];
const NEW_SCOPES = ["workspace.write", "workspace.delete", "filesystem.external.read", "filesystem.external.write"];
const HOST_OBSERVATION_SCOPE = "system.read";
const EXECUTION_SCOPES = ["execution.jobs.read", "execution.run", "execution.cancel"];

describe("OAuth scope filtering", () => {
  it("pins the approved default set and requires every default to be supported", () => {
    expect([...DEFAULT_SCOPES]).toEqual(APPROVED_DEFAULT_SCOPES);
    expect(new Set(DEFAULT_SCOPES).size).toBe(DEFAULT_SCOPES.length);
    expect(DEFAULT_SCOPES.every((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope))).toBe(true);
  });

  it.each([undefined, "", " ", "\t\n"])("defaults %j to the current approved grant", (requested) => {
    expect(filterScopes(requested)).toEqual(APPROVED_DEFAULT_SCOPES);
  });

  it.each([...NEW_SCOPES, ...EXECUTION_SCOPES, HOST_OBSERVATION_SCOPE])("preserves explicit narrow scope %s", (scope) => {
    expect(filterScopes(scope)).toEqual([scope]);
    expect(filterScopes(`workspace.read ${scope}`)).toEqual(["workspace.read", scope]);
  });

  it.each(["unknown", "+", "+++", "workspace.WRITE", "workspace.write,workspace.delete", null, 0, false, {}, ["workspace.write"]])(
    "does not grant anything for unsupported or malformed input %j",
    (requested) => {
      expect(filterScopes(requested)).toEqual([]);
    }
  );

  it("keeps only requested known scopes and deduplicates space/plus separators", () => {
    expect(filterScopes(` unknown + workspace.read\tsystem.read++workspace.write++workspace.write \nunknown `)).toEqual([
      "workspace.read", "system.read", "workspace.write",
    ]);
  });
});

describe("persisted OAuth scopes", () => {
  it.each([
    V1_SCOPES,
    [...V1_SCOPES, ...NEW_SCOPES],
    ["workspace.read", "offline_access"],
    ...NEW_SCOPES.map((scope) => ["workspace.read", scope, "offline_access"]),
    ...EXECUTION_SCOPES.map((scope) => ["workspace.read", scope, "offline_access"]),
  ])(
    "preserves persisted access and refresh grants without upgrading their scopes: %j",
    (...scopes) => {
      const root = makeTmpDir("auth-scopes");
      const workspaceId = "oauth-scope-test";
      const clientId = "existing-client";
      const accessToken = "c2c_at_existing";
      const refreshToken = "c2c_rt_existing";
      const now = Date.now();
      const token = (value: string, kind: "access" | "refresh") => ({
        hash: createHash("sha256").update(value).digest("hex"),
        kind,
        clientId,
        workspaceId,
        scopes,
        issuedAt: now - 1000,
        expiresAt: now + 60_000,
        revoked: false,
      });
      const file = write(root, "store.json", JSON.stringify({
        clients: [],
        tokens: [token(accessToken, "access"), token(refreshToken, "refresh")],
      }));

      try {
        const store = new AuthStore(workspaceId, { file });
        expect(store.verifyAccessToken(accessToken)).toMatchObject({ ok: true, record: { scopes } });
        const rotated = store.refresh(refreshToken, clientId);
        expect(rotated.ok).toBe(true);
        if (!rotated.ok) throw new Error(rotated.reason);
        expect(rotated.tokens.scopes).toEqual(scopes);
        expect(store.refresh(refreshToken, clientId).ok).toBe(false);

        const reloaded = new AuthStore(workspaceId, { file: path.join(root, "store.json") });
        expect(reloaded.verifyAccessToken(rotated.tokens.accessToken)).toMatchObject({ ok: true, record: { scopes } });
        const second = reloaded.refresh(rotated.tokens.refreshToken!, clientId);
        expect(second.ok).toBe(true);
        if (!second.ok) throw new Error(second.reason);
        expect(second.tokens.scopes).toEqual(scopes);
        expect(reloaded.verifyAccessToken(accessToken)).toMatchObject({ ok: true, record: { scopes } });
      } finally {
        cleanup(root);
      }
    }
  );
});
