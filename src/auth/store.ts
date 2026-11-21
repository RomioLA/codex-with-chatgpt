import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { incrementAuthorizationEpoch } from "../permission/store.js";

// Newly authorized connections receive only this explicitly approved scope set.
export const DEFAULT_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "system.read",
  "workspace.write",
  "workspace.delete",
  "filesystem.external.read",
  "filesystem.external.write",
  "execution.jobs.read",
  "execution.run",
  "execution.cancel",
  "offline_access",
] as const;

// Future additions to SUPPORTED_SCOPES must not silently expand DEFAULT_SCOPES.
export const SUPPORTED_SCOPES = [
  ...DEFAULT_SCOPES,
  "git.write",
  "execution.level3",
] as const;

export type Scope = (typeof SUPPORTED_SCOPES)[number];

export type TokenEndpointAuthMethod = "none" | "client_secret_post" | "client_secret_basic";

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
  clientSecretHash?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  trustedLocalClient?: boolean;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    const data = readJsonIfExists<PersistedAuthState>(this.file);
    if (!data) return;
    const now = Date.now();
    for (const client of data.clients ?? []) this.clients.set(client.clientId, client);
    for (const token of data.tokens ?? []) {
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
  }

  private persistState(
    clientsMap: Map<string, ClientRegistration>,
    tokensMap: Map<string, TokenRecord>
  ): void {
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...clientsMap.values()],
      tokens: [...tokensMap.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: {
    clientName?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
    clientSecret?: string;
    trustedLocalClient?: boolean;
  }): ClientRegistration & { clientSecret?: string } {
    const authMethod = input.tokenEndpointAuthMethod;
    const isConfidential = authMethod === "client_secret_post" || authMethod === "client_secret_basic";
    const plainSecret = isConfidential
      ? (input.clientSecret && input.clientSecret.length > 0
          ? input.clientSecret
          : `c2c_cs_${randomBytes(24).toString("base64url")}`)
      : undefined;

    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
      ...(authMethod !== undefined ? { tokenEndpointAuthMethod: authMethod } : {}),
      ...(plainSecret !== undefined ? { clientSecretHash: sha256hex(plainSecret) } : {}),
      ...(input.trustedLocalClient === true ? { trustedLocalClient: true } : {}),
    };
    const nextClients = new Map(this.clients);
    nextClients.set(client.clientId, client);
    this.persistState(nextClients, this.tokens);
    this.clients = nextClients;
    return plainSecret !== undefined ? { ...client, clientSecret: plainSecret } : { ...client };
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  verifyClientCredentials(
    clientId: string,
    clientSecret?: string,
    authSource: "basic" | "post" | "none" = "none"
  ):
    | { ok: true; client: ClientRegistration }
    | { ok: false; reason: "unknown_client" | "invalid_client"; challengeBasic?: boolean } {
    if (typeof clientId !== "string" || clientId.length === 0) {
      return { ok: false, reason: "unknown_client", challengeBasic: authSource === "basic" };
    }
    const client = this.clients.get(clientId);
    if (!client) {
      return { ok: false, reason: "unknown_client", challengeBasic: authSource === "basic" };
    }
    const expectedMethod: TokenEndpointAuthMethod =
      client.tokenEndpointAuthMethod ?? (client.clientSecretHash ? "client_secret_basic" : "none");
    if (expectedMethod === "none") {
      if (authSource !== "none" || clientSecret !== undefined) {
        return { ok: false, reason: "invalid_client", challengeBasic: authSource === "basic" };
      }
      return { ok: true, client };
    }
    if (expectedMethod === "client_secret_basic") {
      if (
        authSource === "basic" &&
        !!client.clientSecretHash &&
        typeof clientSecret === "string" &&
        safeEqual(sha256hex(clientSecret), client.clientSecretHash)
      ) {
        return { ok: true, client };
      }
      return { ok: false, reason: "invalid_client", challengeBasic: true };
    }
    if (
      authSource === "post" &&
      !!client.clientSecretHash &&
      typeof clientSecret === "string" &&
      safeEqual(sha256hex(clientSecret), client.clientSecretHash)
    ) {
      return { ok: true, client };
    }
    return { ok: false, reason: "invalid_client", challengeBasic: authSource === "basic" };
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  private prepareIssuedTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): {
    result: { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] };
    records: TokenRecord[];
  } {
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    const records: TokenRecord[] = [
      {
        hash: sha256hex(accessToken),
        kind: "access",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + accessTtl,
        revoked: false,
      },
    ];

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      records.push({
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }

    return {
      result: {
        accessToken,
        refreshToken,
        expiresIn: Math.floor(accessTtl / 1000),
        scopes: input.scopes,
      },
      records,
    };
  }

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    const { result, records } = this.prepareIssuedTokens(input);
    const nextTokens = new Map(this.tokens);
    for (const record of records) {
      nextTokens.set(record.hash, record);
    }
    this.persistState(this.clients, nextTokens);
    this.tokens = nextTokens;
    return result;
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    const { result, records } = this.prepareIssuedTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    const nextTokens = new Map(this.tokens);
    nextTokens.delete(record.hash);
    for (const nextRecord of records) {
      nextTokens.set(nextRecord.hash, nextRecord);
    }
    this.persistState(this.clients, nextTokens);
    record.revoked = true;
    this.tokens = nextTokens;
    return { ok: true, tokens: result };
  }

  revokeToken(token: string): boolean {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    const nextTokens = new Map(this.tokens);
    nextTokens.delete(record.hash);
    this.persistState(this.clients, nextTokens);
    record.revoked = true;
    this.tokens = nextTokens;
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    const count = this.tokens.size;
    this.persistState(this.clients, new Map());
    // Revoke persisted Tasks even when this AuthStore is used by the offline
    // `c2c unpair` path. The workspace epoch survives Bridge restarts.
    incrementAuthorizationEpoch(this.workspaceId);
    this.tokens.clear();
    this.authCodes.clear();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  /**
   * True when this OAuth client still has a non-expired token family carrying
   * every scope bound to a persistent Task. This is used only for restart and
   * background-resume revalidation; MCP requests still check their own token.
   */
  hasActiveAuthorization(clientId: string, requiredScopes: readonly string[]): boolean {
    if (typeof clientId !== "string" || clientId.length < 1 || !Array.isArray(requiredScopes)) return false;
    const now = Date.now();
    for (const token of this.tokens.values()) {
      if (!token.revoked && token.expiresAt > now && token.workspaceId === this.workspaceId && token.clientId === clientId) {
        if (requiredScopes.every((scope) => token.scopes.includes(scope))) return true;
      }
    }
    return false;
  }

  static deleteStateFile(workspaceId: string): void {
    incrementAuthorizationEpoch(workspaceId);
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: unknown): string[] {
  if (requested === undefined) return [...DEFAULT_SCOPES];
  if (typeof requested !== "string") return [];
  if (requested.trim() === "") return [...DEFAULT_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  // Explicit requests never fall back to defaults or gain unrequested capabilities.
  return [...new Set(asked.filter((scope) => (SUPPORTED_SCOPES as readonly string[]).includes(scope)))];
}
