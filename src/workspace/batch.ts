import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CanonicalJsonLimitError, canonicalJson, canonicalSha256 } from "../shared/canonical-json.js";

export const READ_ITEM_DEFAULT_BYTES = 32 * 1024;
export const READ_ITEM_HARD_MAX_BYTES = 64 * 1024;
export const READ_BATCH_DEFAULT_BYTES = 256 * 1024;
export const READ_BATCH_HARD_MAX_BYTES = 512 * 1024;
/** Leave headroom for the Streamable HTTP JSON-RPC envelope around a page. */
export const MCP_PAGE_MAX_BYTES = READ_BATCH_DEFAULT_BYTES - 8 * 1024;

export const SNAPSHOT_MAX_PER_WORKSPACE = 4;
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_TTL_MS = 10 * 60 * 1000;

// Per-workspace limits alone would still allow an unbounded registry as the
// number of workspaces grows. These process-wide ceilings bound both entries
// and serialized payload storage.
export const SNAPSHOT_MAX_GLOBAL_COUNT = 128;
export const SNAPSHOT_MAX_GLOBAL_BYTES = 64 * 1024 * 1024;

export type BatchErrorCode =
  | "SOURCE_CHANGED"
  | "BYTE_LIMIT"
  | "ITEM_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "DEADLINE"
  | "MATCH_LIMIT"
  | "CURSOR_EXPIRED"
  | "CURSOR_INVALID"
  | "CURSOR_CAPACITY"
  | "ENGINE_UNAVAILABLE"
  | "INVALID_BUDGET";

export type SearchStopReason =
  | "SCAN_BYTE_LIMIT"
  | "ITEM_LIMIT"
  | "DEADLINE"
  | "MATCH_LIMIT"
  | "ENGINE_UNAVAILABLE"
  | "PROCESS_ERROR";

export class BatchContractError extends Error {
  constructor(public readonly code: BatchErrorCode, message: string) {
    super(message);
    this.name = "BatchContractError";
  }
}

export interface SnapshotBinding {
  workspaceId: string;
  ownerId: string;
  requestHash: string;
  sourceHashes?: readonly string[];
}

export interface SnapshotInput<T> extends SnapshotBinding {
  payload: T;
}

export interface ResolvedSnapshot<T> extends SnapshotBinding {
  snapshotId: string;
  position: number;
  expiresAt: number;
  payload: T;
  sourceHashes: string[];
}

interface SnapshotEntry {
  snapshotId: string;
  workspaceId: string;
  ownerId: string;
  requestHash: string;
  sourceHashes: string[];
  sourceHashesHash: string;
  serialized: string;
  sizeBytes: number;
  expiresAt: number;
}

interface CursorPayload {
  version: 1;
  snapshotId: string;
  workspaceId: string;
  ownerId: string;
  requestHash: string;
  sourceHashesHash: string;
  position: number;
  expiresAt: number;
}

function validateBinding(binding: SnapshotBinding): void {
  if (!binding.workspaceId || binding.workspaceId.length > 256) {
    throw new BatchContractError("CURSOR_INVALID", "Invalid workspace binding");
  }
  if (!binding.ownerId || binding.ownerId.length > 256) {
    throw new BatchContractError("CURSOR_INVALID", "Invalid owner binding");
  }
  if (!/^[a-f0-9]{64}$/.test(binding.requestHash)) {
    throw new BatchContractError("CURSOR_INVALID", "Request hash must be a lowercase SHA-256 hex digest");
  }
  const hashes = binding.sourceHashes ?? [];
  if (hashes.length > 10_000 || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new BatchContractError("CURSOR_INVALID", "Invalid source hash list");
  }
}

function validatePosition(position: number): void {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new BatchContractError("CURSOR_INVALID", "Cursor position must be a non-negative safe integer");
  }
}

/**
 * Bounded in-memory snapshot storage for future batch read/search pagination.
 * Cursor tokens contain no caller-editable offset: each position is covered by
 * an HMAC and can only be issued by this registry.
 */
export class SnapshotRegistry {
  private readonly entries = new Map<string, SnapshotEntry>();
  private readonly secret = randomBytes(32);
  private readonly incarnation = randomBytes(12).toString("hex");
  private storedBytes = 0;

  get size(): number {
    return this.entries.size;
  }

  get bytesStored(): number {
    return this.storedBytes;
  }

  create<T>(input: SnapshotInput<T>, position = 0, now = Date.now()): string {
    return this.createWithSnapshotId(input, position, now).cursor;
  }

  /** Internal lifecycle variant that returns the identity needed to roll back a failed first-page build. */
  createWithSnapshotId<T>(
    input: SnapshotInput<T>,
    position = 0,
    now = Date.now()
  ): { cursor: string; snapshotId: string } {
    validateBinding(input);
    validatePosition(position);
    const sourceHashes = [...(input.sourceHashes ?? [])];
    let serialized: string;
    try {
      serialized = canonicalJson({
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        requestHash: input.requestHash,
        sourceHashes,
        payload: input.payload,
      }, { maxBytes: SNAPSHOT_MAX_BYTES });
    } catch (error) {
      if (error instanceof CanonicalJsonLimitError) {
        throw new BatchContractError("CURSOR_CAPACITY", "Snapshot exceeds the per-snapshot byte limit");
      }
      throw error;
    }
    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    if (sizeBytes > SNAPSHOT_MAX_BYTES) {
      throw new BatchContractError("CURSOR_CAPACITY", "Snapshot exceeds the per-snapshot byte limit");
    }

    this.pruneExpired(now);
    const workspaceEntries = [...this.entries.values()].filter((entry) => entry.workspaceId === input.workspaceId).length;
    if (
      workspaceEntries >= SNAPSHOT_MAX_PER_WORKSPACE ||
      this.entries.size >= SNAPSHOT_MAX_GLOBAL_COUNT ||
      this.storedBytes + sizeBytes > SNAPSHOT_MAX_GLOBAL_BYTES
    ) {
      throw new BatchContractError("CURSOR_CAPACITY", "Snapshot registry capacity reached");
    }

    const snapshotId = randomBytes(16).toString("hex");
    const entry: SnapshotEntry = {
      snapshotId,
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      requestHash: input.requestHash,
      sourceHashes,
      sourceHashesHash: canonicalSha256(sourceHashes),
      serialized,
      sizeBytes,
      expiresAt: now + SNAPSHOT_TTL_MS,
    };
    const cursor = this.issue(entry, position);
    this.entries.set(snapshotId, entry);
    this.storedBytes += sizeBytes;
    return { cursor, snapshotId };
  }

  /** Remove a just-created snapshot when its first response page cannot be delivered. */
  discard(snapshotId: string): void {
    const entry = this.entries.get(snapshotId);
    if (entry) this.remove(entry);
  }

  /** Issue the next opaque cursor for an existing snapshot at a safe position. */
  issueCursor(snapshotId: string, position: number, now = Date.now()): string {
    validatePosition(position);
    this.pruneExpired(now);
    const entry = this.entries.get(snapshotId);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.remove(entry);
      throw new BatchContractError("CURSOR_EXPIRED", "Snapshot has expired");
    }
    return this.issue(entry, position);
  }

  resolve<T>(cursor: string, expected: SnapshotBinding, now = Date.now()): ResolvedSnapshot<T> {
    validateBinding(expected);
    if (typeof cursor !== "string" || cursor.length > 16_384) {
      throw new BatchContractError("CURSOR_INVALID", "Malformed cursor");
    }
    const parts = cursor.split(".");
    if (parts.length !== 3 || !/^[a-f0-9]{24}$/.test(parts[0]!)) {
      throw new BatchContractError("CURSOR_INVALID", "Malformed cursor");
    }
    const [incarnation, encoded, signatureText] = parts as [string, string, string];
    if (incarnation !== this.incarnation) {
      // A valid token from a prior Bridge incarnation refers to an in-memory
      // snapshot that no longer exists, so restart has the same public result
      // as TTL expiry.
      throw new BatchContractError("CURSOR_EXPIRED", "Snapshot is no longer available");
    }
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signatureText)) {
      throw new BatchContractError("CURSOR_INVALID", "Malformed cursor");
    }
    const body = Buffer.from(encoded, "base64url");
    const signature = Buffer.from(signatureText, "base64url");
    if (body.toString("base64url") !== encoded || signature.toString("base64url") !== signatureText) {
      throw new BatchContractError("CURSOR_INVALID", "Malformed cursor encoding");
    }
    const expectedSignature = createHmac("sha256", this.secret).update(`${incarnation}.${encoded}`).digest();
    if (signature.length !== expectedSignature.length || !timingSafeEqual(signature, expectedSignature)) {
      throw new BatchContractError("CURSOR_INVALID", "Cursor signature is invalid");
    }

    let token: CursorPayload;
    try {
      token = JSON.parse(body.toString("utf8")) as CursorPayload;
    } catch {
      throw new BatchContractError("CURSOR_INVALID", "Cursor payload is invalid");
    }
    if (
      token === null || typeof token !== "object" || Array.isArray(token) ||
      token.version !== 1 ||
      typeof token.snapshotId !== "string" ||
      typeof token.workspaceId !== "string" ||
      typeof token.ownerId !== "string" ||
      !/^[a-f0-9]{64}$/.test(token.requestHash) ||
      !/^[a-f0-9]{64}$/.test(token.sourceHashesHash) ||
      !Number.isSafeInteger(token.position) || token.position < 0 ||
      !Number.isSafeInteger(token.expiresAt)
    ) {
      throw new BatchContractError("CURSOR_INVALID", "Cursor payload fields are invalid");
    }
    if (token.expiresAt <= now) {
      const expired = this.entries.get(token.snapshotId);
      if (expired) this.remove(expired);
      throw new BatchContractError("CURSOR_EXPIRED", "Snapshot has expired");
    }

    const entry = this.entries.get(token.snapshotId);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.remove(entry);
      throw new BatchContractError("CURSOR_EXPIRED", "Snapshot has expired or was discarded");
    }
    if (
      token.workspaceId !== expected.workspaceId ||
      token.ownerId !== expected.ownerId ||
      token.requestHash !== expected.requestHash ||
      (expected.sourceHashes !== undefined && canonicalSha256([...expected.sourceHashes]) !== token.sourceHashesHash) ||
      entry.workspaceId !== token.workspaceId ||
      entry.ownerId !== token.ownerId ||
      entry.requestHash !== token.requestHash ||
      entry.sourceHashesHash !== token.sourceHashesHash ||
      entry.expiresAt !== token.expiresAt
    ) {
      throw new BatchContractError("CURSOR_INVALID", "Cursor binding does not match this request");
    }

    const stored = JSON.parse(entry.serialized) as { payload: T };
    return {
      snapshotId: entry.snapshotId,
      workspaceId: entry.workspaceId,
      ownerId: entry.ownerId,
      requestHash: entry.requestHash,
      sourceHashes: [...entry.sourceHashes],
      position: token.position,
      expiresAt: entry.expiresAt,
      payload: stored.payload,
    };
  }

  private issue(entry: SnapshotEntry, position: number): string {
    const payload: CursorPayload = {
      version: 1,
      snapshotId: entry.snapshotId,
      workspaceId: entry.workspaceId,
      ownerId: entry.ownerId,
      requestHash: entry.requestHash,
      sourceHashesHash: entry.sourceHashesHash,
      position,
      expiresAt: entry.expiresAt,
    };
    const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(`${this.incarnation}.${encoded}`).digest("base64url");
    return `${this.incarnation}.${encoded}.${signature}`;
  }

  private pruneExpired(now: number): void {
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) this.remove(entry);
    }
  }

  private remove(entry: SnapshotEntry): void {
    if (this.entries.delete(entry.snapshotId)) this.storedBytes -= entry.sizeBytes;
  }
}

export { canonicalJson, canonicalSha256 };
