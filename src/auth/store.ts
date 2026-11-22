import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { atomicReplace, AtomicReplaceError } from "../execution/atomic-replace.js";
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

export class AuthStoreCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthStoreCorruptError";
  }
}

function isValidClientRegistration(value: unknown): value is ClientRegistration {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const client = value as Partial<ClientRegistration>;
  if (typeof client.clientId !== "string" || client.clientId.length === 0) return false;
  if (!Array.isArray(client.redirectUris) || !client.redirectUris.every((u) => typeof u === "string")) return false;
  if (typeof client.createdAt !== "string") return false;
  if (client.clientName !== undefined && typeof client.clientName !== "string") return false;
  if (client.clientSecretHash !== undefined && typeof client.clientSecretHash !== "string") return false;
  if (
    client.tokenEndpointAuthMethod !== undefined &&
    client.tokenEndpointAuthMethod !== "none" &&
    client.tokenEndpointAuthMethod !== "client_secret_post" &&
    client.tokenEndpointAuthMethod !== "client_secret_basic"
  ) {
    return false;
  }
  if (client.trustedLocalClient !== undefined && typeof client.trustedLocalClient !== "boolean") return false;
  return true;
}

function isValidTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const token = value as Partial<TokenRecord>;
  return typeof token.hash === "string" && token.hash.length > 0 &&
    (token.kind === "access" || token.kind === "refresh") &&
    typeof token.clientId === "string" && token.clientId.length > 0 &&
    typeof token.workspaceId === "string" &&
    Array.isArray(token.scopes) && token.scopes.every((s) => typeof s === "string") &&
    typeof token.issuedAt === "number" && Number.isFinite(token.issuedAt) &&
    typeof token.expiresAt === "number" && Number.isFinite(token.expiresAt) &&
    typeof token.revoked === "boolean";
}

function tempFileStillPresent(tempFile: string): boolean {
  try {
    const stat = fs.lstatSync(tempFile);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private stateUncertain = false;
  private epochUncertain = false;
  private pendingRevokeAllHash: string | null = null;
  private pendingRevokeAllApplied = false;
  private readonly file: string;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private readDiskSnapshot(): {
    clients: Map<string, ClientRegistration>;
    tokens: Map<string, TokenRecord>;
    rawHash: string | null;
  } {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { clients: new Map(), tokens: new Map(), rawHash: null };
      }
      throw new AuthStoreCorruptError("Cannot inspect OAuth store file.");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AuthStoreCorruptError("OAuth store path must be a regular file.");
    }

    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      throw new AuthStoreCorruptError("Cannot read OAuth store file.");
    }
    const rawHash = sha256hex(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new AuthStoreCorruptError("OAuth store file contains invalid JSON.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AuthStoreCorruptError("OAuth store file must contain a JSON object.");
    }
    const record = parsed as { clients?: unknown; tokens?: unknown };
    if (!Array.isArray(record.clients) || !Array.isArray(record.tokens)) {
      throw new AuthStoreCorruptError("OAuth store file must contain clients and tokens arrays.");
    }

    const clients: ClientRegistration[] = [];
    for (const client of record.clients) {
      if (!isValidClientRegistration(client)) {
        throw new AuthStoreCorruptError("OAuth store file contains an invalid client record.");
      }
      clients.push(client);
    }
    const tokens: TokenRecord[] = [];
    for (const token of record.tokens) {
      if (!isValidTokenRecord(token)) {
        throw new AuthStoreCorruptError("OAuth store file contains an invalid token record.");
      }
      tokens.push(token);
    }

    const now = Date.now();
    const clientsMap = new Map<string, ClientRegistration>();
    const tokensMap = new Map<string, TokenRecord>();
    for (const client of clients) clientsMap.set(client.clientId, client);
    for (const token of tokens) {
      if (!token.revoked && token.expiresAt > now) tokensMap.set(token.hash, token);
    }
    return { clients: clientsMap, tokens: tokensMap, rawHash };
  }

  private load(): void {
    const snapshot = this.readDiskSnapshot();
    this.clients = snapshot.clients;
    this.tokens = snapshot.tokens;
  }

  /**
   * Reconcile in-memory state with authoritative disk state after an uncertain
   * atomicReplace or interrupted epoch bump before allowing further reads/writes.
   */
  private ensureReconciled(): void {
    if (this.stateUncertain) {
      const snapshot = this.readDiskSnapshot();
      for (const [hash, previous] of this.tokens) {
        if (!snapshot.tokens.has(hash)) previous.revoked = true;
      }
      const revokeAllLanded =
        this.pendingRevokeAllApplied ||
        (this.pendingRevokeAllHash !== null &&
          (snapshot.rawHash === this.pendingRevokeAllHash || snapshot.tokens.size === 0));
      if (revokeAllLanded) {
        this.authCodes.clear();
        this.epochUncertain = true;
      } else {
        for (const [code, authCode] of this.authCodes) {
          if (!snapshot.clients.has(authCode.clientId)) this.authCodes.delete(code);
        }
      }
      this.clients = snapshot.clients;
      this.tokens = snapshot.tokens;
      this.pendingRevokeAllHash = null;
      this.pendingRevokeAllApplied = false;
      this.stateUncertain = false;
    }
    if (this.epochUncertain) {
      incrementAuthorizationEpoch(this.workspaceId);
      this.epochUncertain = false;
    }
  }

  private tryReconcile(): boolean {
    if (!this.stateUncertain && !this.epochUncertain) return true;
    try {
      this.ensureReconciled();
      return true;
    } catch {
      return false;
    }
  }

  private persistState(
    clientsMap: Map<string, ClientRegistration>,
    tokensMap: Map<string, TokenRecord>,
    opts: {
      onUncertainPublish?: (info: { expectedNewHash: string; operationApplied: boolean }) => void;
    } = {}
  ): void {
    this.ensureReconciled();
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...clientsMap.values()],
      tokens: [...tokensMap.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    ensureDir(path.dirname(this.file));
    const bytes = Buffer.from(JSON.stringify(state, null, 2), "utf8");
    const expectedNewHash = createHash("sha256").update(bytes).digest("hex");
    const tempFile = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let published = false;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tempFile, "wx", 0o600);
      try {
        // Keep fs.writeFileSync(fd, bytes) so existing disk-failure tests spying on fs.writeFileSync continue to intercept writes.
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
        fd = undefined;
      }
      try {
        fs.chmodSync(tempFile, 0o600);
      } catch {
        // best effort on platforms without POSIX chmod semantics
      }
      try {
        atomicReplace(tempFile, this.file, { expectedNewHash });
        published = true;
      } catch (error) {
        const confirmedUnpublished =
          error instanceof AtomicReplaceError &&
          !error.operationApplied &&
          tempFileStillPresent(tempFile);
        if (!confirmedUnpublished) {
          this.stateUncertain = true;
          opts.onUncertainPublish?.({
            expectedNewHash,
            operationApplied: error instanceof AtomicReplaceError && error.operationApplied,
          });
        }
        throw error;
      }
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (!published) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // ignore if temp file was not created or already moved
        }
      }
    }
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: {
    clientName?: string;
    redirectUris: string[];
    tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
    clientSecret?: string;
    trustedLocalClient?: boolean;
  }): ClientRegistration & { clientSecret?: string } {
    this.ensureReconciled();
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
    this.ensureReconciled();
    return this.clients.get(clientId);
  }

  verifyClientCredentials(
    clientId: string,
    clientSecret?: string,
    authSource: "basic" | "post" | "none" = "none"
  ):
    | { ok: true; client: ClientRegistration }
    | { ok: false; reason: "unknown_client" | "invalid_client"; challengeBasic?: boolean } {
    this.ensureReconciled();
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
    this.ensureReconciled();
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
    this.ensureReconciled();
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
    this.ensureReconciled();
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
    if (!this.tryReconcile()) return { ok: false, reason: "unknown" };
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
    this.ensureReconciled();
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
    this.ensureReconciled();
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
    this.ensureReconciled();
    const count = this.tokens.size;
    this.persistState(this.clients, new Map(), {
      onUncertainPublish: ({ expectedNewHash, operationApplied }) => {
        this.pendingRevokeAllHash = expectedNewHash;
        this.pendingRevokeAllApplied = operationApplied;
      },
    });
    for (const record of this.tokens.values()) {
      record.revoked = true;
    }
    this.tokens.clear();
    this.authCodes.clear();
    // Revoke persisted Tasks even when this AuthStore is used by the offline
    // `c2c unpair` path. The workspace epoch survives Bridge restarts.
    try {
      incrementAuthorizationEpoch(this.workspaceId);
    } catch (error) {
      this.epochUncertain = true;
      throw error;
    }
    return count;
  }

  tokenCount(): number {
    if (!this.tryReconcile()) return 0;
    return this.tokens.size;
  }

  /**
   * True when this OAuth client still has a non-expired token family carrying
   * every scope bound to a persistent Task. This is used only for restart and
   * background-resume revalidation; MCP requests still check their own token.
   */
  hasActiveAuthorization(clientId: string, requiredScopes: readonly string[]): boolean {
    if (!this.tryReconcile()) return false;
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
