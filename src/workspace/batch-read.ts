import { performance } from "node:perf_hooks";
import {
  READ_BATCH_DEFAULT_BYTES,
  READ_BATCH_HARD_MAX_BYTES,
  READ_ITEM_DEFAULT_BYTES,
  READ_ITEM_HARD_MAX_BYTES,
  MCP_PAGE_MAX_BYTES,
  BatchContractError,
  SnapshotRegistry,
  canonicalSha256,
} from "./batch.js";
import { Workspace, WorkspaceError, type WorkspaceErrorCode } from "./manager.js";

const MAX_BATCH_ITEMS = 16;
const MAX_PAGE_BYTES = MCP_PAGE_MAX_BYTES;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SOURCE_HASH_PATTERN = /^[a-f0-9]{64}$/;

export const BATCH_READ_MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
export const BATCH_READ_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const BATCH_READ_MAX_DEADLINE_MS = 10_000;

export interface BatchReadItemRequest {
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  offsetBytes?: number;
  expectedSourceHash?: string;
  maxBytes?: number;
}

export interface BatchReadRequest {
  items: BatchReadItemRequest[];
  maxTotalBytes?: number;
  cursor?: string;
}

export interface BatchReadContext {
  ownerId: string;
  registry: SnapshotRegistry;
  /** Internal runtime seam; limits may only lower the documented hard caps. */
  runtime?: {
    maxSourceBytesPerFile?: number;
    maxSourceBytes?: number;
    deadlineMs?: number;
  };
}

export type BatchReadRequestErrorCode = "INVALID_REQUEST" | "ITEM_LIMIT";

export class BatchReadRequestError extends Error {
  constructor(public readonly code: BatchReadRequestErrorCode, message: string) {
    super(message);
    this.name = "BatchReadRequestError";
  }
}

export interface BatchReadItemSuccess {
  id: string;
  path: string;
  ok: true;
  sizeBytes: number;
  sourceHash: string;
  sourceBytesScanned: number;
  startOffsetBytes: number;
  nextOffsetBytes: number;
  returnedBytes: number;
  content: string;
  truncated: boolean;
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  nextStartLine?: number | null;
}

export interface BatchReadItemFailure {
  id: string;
  path: string;
  ok: false;
  error: { code: WorkspaceErrorCode | "READ_ERROR"; message: string };
  sourceBytesScanned: number;
  truncated?: true;
}

export type BatchReadItemResult = BatchReadItemSuccess | BatchReadItemFailure;

export interface BatchReadPage {
  results: BatchReadItemResult[];
  /** UTF-8 bytes of content returned in this response page. */
  returnedBytes: number;
  /** Actual source bytes scanned across the complete request, including failures. */
  sourceBytesScanned: number;
  /** True when an item is truncated or more item results are available. */
  truncated: boolean;
  nextCursor?: string;
}

interface NormalizedItem {
  id: string;
  path: string;
  mode: "lines" | "bytes";
  startLine: number;
  endLine?: number;
  offsetBytes?: number;
  expectedSourceHash?: string;
  maxBytes: number;
}

interface NormalizedRequest {
  items: NormalizedItem[];
  maxTotalBytes: number;
  cursor?: string;
  requestHash: string;
}

interface SnapshotPayload {
  results: BatchReadItemResult[];
  sourceBytesScanned: number;
}

function invalid(message: string): never {
  throw new BatchReadRequestError("INVALID_REQUEST", message);
}

function positiveSafeInteger(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${field} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function normalizeRequest(request: BatchReadRequest): NormalizedRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("Request must be an object");
  if (!Array.isArray(request.items)) invalid("items must be an array");
  if (request.items.length < 1) invalid("items must contain at least one item");
  if (request.items.length > MAX_BATCH_ITEMS) {
    throw new BatchReadRequestError("ITEM_LIMIT", `items must contain at most ${MAX_BATCH_ITEMS} items`);
  }
  if (request.cursor !== undefined && typeof request.cursor !== "string") invalid("cursor must be a string");

  const maxTotalBytes = Math.min(
    positiveSafeInteger(request.maxTotalBytes === undefined ? READ_BATCH_DEFAULT_BYTES : request.maxTotalBytes, "maxTotalBytes", 4),
    READ_BATCH_HARD_MAX_BYTES
  );
  const ids = new Set<string>();
  const items: NormalizedItem[] = request.items.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`items[${index}] must be an object`);
    if (typeof raw.id !== "string" || !ITEM_ID_PATTERN.test(raw.id)) invalid(`items[${index}].id has an invalid format`);
    if (ids.has(raw.id)) invalid(`Duplicate item id: ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.path !== "string" || raw.path.length > 32_768) invalid(`items[${index}].path must be a string of at most 32768 characters`);

    const lineMode = raw.startLine !== undefined || raw.endLine !== undefined;
    const byteMode = raw.offsetBytes !== undefined;
    if (lineMode && byteMode) invalid(`items[${index}] cannot combine line range and byte offset`);
    if (lineMode) {
      const startLine = raw.startLine === undefined ? 1 : positiveSafeInteger(raw.startLine, `items[${index}].startLine`);
      const endLine = raw.endLine === undefined ? undefined : positiveSafeInteger(raw.endLine, `items[${index}].endLine`);
      if (endLine !== undefined && endLine < startLine) invalid(`items[${index}].endLine must be >= startLine`);
      return normalizedItem(raw, index, "lines", startLine, endLine);
    }
    if (byteMode) {
      if (typeof raw.offsetBytes !== "number" || !Number.isSafeInteger(raw.offsetBytes) || raw.offsetBytes < 0) {
        invalid(`items[${index}].offsetBytes must be a non-negative safe integer`);
      }
      return normalizedItem(raw, index, "bytes", 1, undefined, raw.offsetBytes);
    }
    return normalizedItem(raw, index, "lines", 1);
  });

  const hashInput = {
    maxTotalBytes,
    items: items.map((item) => ({
      id: item.id,
      path: item.path.replace(/\\/g, "/"),
      mode: item.mode,
      ...(item.mode === "lines"
        ? { startLine: item.startLine, ...(item.endLine === undefined ? {} : { endLine: item.endLine }) }
        : { offsetBytes: item.offsetBytes }),
      ...(item.expectedSourceHash === undefined ? {} : { expectedSourceHash: item.expectedSourceHash }),
      maxBytes: item.maxBytes,
    })),
  };

  return {
    items,
    maxTotalBytes,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    requestHash: canonicalSha256(hashInput),
  };
}

function normalizedItem(
  raw: BatchReadItemRequest,
  index: number,
  mode: NormalizedItem["mode"],
  startLine: number,
  endLine?: number,
  offsetBytes?: number
): NormalizedItem {
  const maxBytes = Math.min(
    positiveSafeInteger(raw.maxBytes === undefined ? READ_ITEM_DEFAULT_BYTES : raw.maxBytes, `items[${index}].maxBytes`, 4),
    READ_ITEM_HARD_MAX_BYTES
  );
  if (raw.expectedSourceHash !== undefined &&
    (typeof raw.expectedSourceHash !== "string" || !SOURCE_HASH_PATTERN.test(raw.expectedSourceHash))) {
    invalid(`items[${index}].expectedSourceHash must be a lowercase SHA-256 hex digest`);
  }
  return {
    id: raw.id,
    path: raw.path,
    mode,
    startLine,
    ...(endLine === undefined ? {} : { endLine }),
    ...(offsetBytes === undefined ? {} : { offsetBytes }),
    ...(raw.expectedSourceHash === undefined ? {} : { expectedSourceHash: raw.expectedSourceHash }),
    maxBytes,
  };
}

function isWorkspaceRelativePath(value: string): boolean {
  return value.length > 0 &&
    !value.includes("\0") &&
    !pathIsAbsolute(value) &&
    !/^[a-z]:/i.test(value) &&
    !/^workspace:/i.test(value);
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-z]:[\\/]/i.test(value);
}

function failure(
  id: string,
  requestedPath: string,
  code: WorkspaceErrorCode | "READ_ERROR",
  message: string,
  truncated = false,
  sourceBytesScanned = 0,
): BatchReadItemFailure {
  return {
    id,
    path: requestedPath,
    ok: false,
    error: { code, message: message.slice(0, 2048) },
    sourceBytesScanned,
    ...(truncated ? { truncated: true } : {}),
  };
}

function page(
  results: BatchReadItemResult[],
  hasMore: boolean,
  sourceBytesScanned: number,
  nextCursor?: string,
): BatchReadPage {
  const response: BatchReadPage = {
    results,
    returnedBytes: results.reduce((total, result) => total + (result.ok ? result.returnedBytes : 0), 0),
    sourceBytesScanned,
    truncated: hasMore || results.some((result) => result.ok ? result.truncated : result.truncated === true),
    ...(hasMore && nextCursor !== undefined ? { nextCursor } : {}),
  };
  return response;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cursorPage(
  results: BatchReadItemResult[],
  start: number,
  snapshotId: string,
  registry: SnapshotRegistry,
  sourceBytesScanned: number,
): BatchReadPage {
  let best: BatchReadPage | undefined;
  for (let end = start + 1; end <= results.length; end++) {
    const hasMore = end < results.length;
    const nextCursor = hasMore ? registry.issueCursor(snapshotId, end) : undefined;
    const candidate = page(results.slice(start, end), hasMore, sourceBytesScanned, nextCursor);
    if (serializedBytes(candidate) > MAX_PAGE_BYTES) break;
    best = candidate;
  }
  if (!best) throw new BatchContractError("CURSOR_CAPACITY", "A batch_read result cannot fit in a response page");
  return best;
}

export async function batchRead(
  workspace: Workspace,
  request: BatchReadRequest,
  context: BatchReadContext
): Promise<BatchReadPage> {
  if (!context || typeof context !== "object" || !(context.registry instanceof SnapshotRegistry)) {
    invalid("A SnapshotRegistry must be injected");
  }
  if (typeof context.ownerId !== "string" || context.ownerId.length === 0 || context.ownerId.length > 256) {
    invalid("ownerId must be a non-empty string of at most 256 characters");
  }

  const normalized = normalizeRequest(request);
  const runtime = context.runtime ?? {};
  const lowerLimit = (value: number | undefined, hardLimit: number, label: string, allowZero = false): number => {
    if (value === undefined) return hardLimit;
    const minimum = allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} must be a safe integer of at least ${minimum}`);
    return Math.min(value, hardLimit);
  };
  const maxSourceBytesPerFile = lowerLimit(
    runtime.maxSourceBytesPerFile,
    BATCH_READ_MAX_SOURCE_FILE_BYTES,
    "maxSourceBytesPerFile",
    true,
  );
  const maxSourceBytes = lowerLimit(runtime.maxSourceBytes, BATCH_READ_MAX_SOURCE_BYTES, "maxSourceBytes", true);
  const deadlineMs = lowerLimit(runtime.deadlineMs, BATCH_READ_MAX_DEADLINE_MS, "deadlineMs");
  const deadlineAt = performance.now() + deadlineMs;
  const binding = {
    workspaceId: workspace.id,
    ownerId: context.ownerId,
    requestHash: normalized.requestHash,
  };

  if (normalized.cursor !== undefined) {
    const resolved = context.registry.resolve<SnapshotPayload>(normalized.cursor, binding);
    const payload = resolved.payload;
    if (!payload || !Array.isArray(payload.results) || !Number.isSafeInteger(payload.sourceBytesScanned) || payload.sourceBytesScanned < 0) {
      throw new BatchContractError("CURSOR_INVALID", "Snapshot payload is invalid");
    }
    return cursorPage(payload.results, resolved.position, resolved.snapshotId, context.registry, payload.sourceBytesScanned);
  }

  const results: BatchReadItemResult[] = [];
  const sourceHashes: string[] = [];
  let remainingBytes = normalized.maxTotalBytes;
  let remainingSourceBytes = maxSourceBytes;
  let sourceBytesScanned = 0;

  for (const item of normalized.items) {
    if (!isWorkspaceRelativePath(item.path)) {
      results.push(failure(item.id, item.path, "INVALID_PATH", "Path must be workspace-relative"));
      continue;
    }

    const maxBytes = Math.min(item.maxBytes, remainingBytes);
    if (maxBytes < 4) {
      results.push(failure(item.id, item.path, "BYTE_LIMIT", "The remaining batch byte budget cannot safely advance this item", true));
      continue;
    }

    if (performance.now() >= deadlineAt) {
      results.push(failure(item.id, item.path, "DEADLINE", "The shared batch source-scan deadline was reached", true));
      continue;
    }

    let itemSourceBytesScanned = 0;
    const onSourceBytesScanned = (bytes: number): void => {
      itemSourceBytesScanned += bytes;
      sourceBytesScanned += bytes;
      remainingSourceBytes = Math.max(0, remainingSourceBytes - bytes);
    };
    const maxItemSourceBytes = Math.min(maxSourceBytesPerFile, remainingSourceBytes);

    try {
      if (item.mode === "bytes") {
        const read = await workspace.readFileBytes(item.path, {
          offsetBytes: item.offsetBytes,
          maxBytes,
          expectedSourceHash: item.expectedSourceHash,
          maxSourceBytes: maxItemSourceBytes,
          deadlineAt,
          onSourceBytesScanned,
        });
        results.push({
          id: item.id,
          path: read.path,
          ok: true,
          sizeBytes: read.sizeBytes,
          sourceHash: read.sourceHash,
          sourceBytesScanned: read.sourceBytesScanned,
          startOffsetBytes: read.startOffsetBytes,
          nextOffsetBytes: read.nextOffsetBytes,
          returnedBytes: read.returnedBytes,
          content: read.content,
          truncated: read.truncated,
        });
        sourceHashes.push(read.sourceHash);
        remainingBytes -= read.returnedBytes;
      } else {
        const read = await workspace.readFileLinesBounded(item.path, {
          startLine: item.startLine,
          endLine: item.endLine,
          maxBytes,
          expectedSourceHash: item.expectedSourceHash,
          maxSourceBytes: maxItemSourceBytes,
          deadlineAt,
          onSourceBytesScanned,
        });
        results.push({
          id: item.id,
          path: read.path,
          ok: true,
          sizeBytes: read.sizeBytes,
          sourceHash: read.sourceHash,
          sourceBytesScanned: read.sourceBytesScanned,
          startOffsetBytes: read.startOffsetBytes,
          nextOffsetBytes: read.nextOffsetBytes,
          returnedBytes: read.returnedBytes,
          content: read.content,
          truncated: read.truncated,
          totalLines: read.totalLines,
          startLine: read.startLine,
          endLine: read.endLine,
          nextStartLine: read.nextStartLine,
        });
        sourceHashes.push(read.sourceHash);
        remainingBytes -= read.returnedBytes;
      }
    } catch (error) {
      if (error instanceof WorkspaceError) {
        const partial = error.code === "SOURCE_SCAN_LIMIT" || error.code === "DEADLINE";
        results.push(failure(item.id, item.path, error.code, error.message, partial, itemSourceBytesScanned));
      } else {
        results.push(failure(item.id, item.path, "READ_ERROR", "File could not be read", false, itemSourceBytesScanned));
      }
    }
  }

  const completePage = page(results, false, sourceBytesScanned);
  if (serializedBytes(completePage) <= MAX_PAGE_BYTES) return completePage;

  const initialCursor = context.registry.create({
    ...binding,
    sourceHashes,
    payload: { results, sourceBytesScanned } satisfies SnapshotPayload,
  });
  const snapshot = context.registry.resolve<SnapshotPayload>(initialCursor, { ...binding, sourceHashes });
  return cursorPage(results, 0, snapshot.snapshotId, context.registry, sourceBytesScanned);
}
