import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BatchContractError,
  MCP_PAGE_MAX_BYTES,
  SnapshotRegistry,
  canonicalSha256,
  type SearchStopReason,
} from "./batch.js";
import {
  SEARCH_MAX_BYTES,
  SEARCH_MAX_DEADLINE_MS,
  SEARCH_MAX_FILES,
  SEARCH_MAX_FILE_BYTES,
  compareSearchMatches,
  normalizeSearchBudget,
  searchWorkspaceBounded,
  type BoundedSearchResult,
  type SearchBudget,
  type SearchMatch,
  type SearchRuntime,
} from "./search.js";
import { Workspace, WorkspaceError, type WorkspaceErrorCode } from "./manager.js";

export const BATCH_SEARCH_MAX_QUERIES = 8;
export const BATCH_SEARCH_MAX_PATHS = 16;
export const BATCH_SEARCH_DEFAULT_MATCHES = 20;
export const BATCH_SEARCH_MAX_MATCHES_PER_QUERY = 50;
export const BATCH_SEARCH_MAX_MATCHES = 100;
export const BATCH_SEARCH_MAX_PAGE_BYTES = MCP_PAGE_MAX_BYTES;
export const BATCH_SEARCH_MAX_QUERY_CHARS = 512;
export const BATCH_SEARCH_MAX_GLOB_CHARS = 512;

const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_ERROR_MESSAGE_CHARS = 1024;
const MAX_ERROR_PATH_CHARS = 256;
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

export type BatchSearchErrorCode = WorkspaceErrorCode | "ENGINE_UNAVAILABLE" | "INVALID_PATTERN" | "PROCESS_ERROR" | "QUERY_TOO_SHORT";

export interface BatchSearchQuery {
  id: string;
  query: string;
  mode: "literal" | "regex";
  paths?: string[];
  glob?: string;
  max_matches?: number;
}

export interface BatchSearchRequest {
  queries: BatchSearchQuery[];
  cursor?: string;
}

export interface BatchSearchContext {
  ownerId: string;
  registry: SnapshotRegistry;
  /** Internal runtime seam; caller budgets can only lower the documented hard caps. */
  runtime?: SearchRuntime;
}

export interface BatchSearchQueryError {
  code: BatchSearchErrorCode;
  message: string;
  path?: string;
}

export interface BatchSearchQuerySummary {
  id: string;
  mode: "literal" | "regex";
  engine: BoundedSearchResult["engine"] | "mixed";
  /** True when every requested scope for this query was scanned to completion. */
  scanComplete: boolean;
  /** True when all observed matches survived per-query and whole-batch selection caps. */
  resultsComplete: boolean;
  /** True only when both scanning and result selection completed without omissions. */
  complete: boolean;
  truncated: boolean;
  /** Actual for completed scans; may conservatively account reserved bytes when rg is interrupted. */
  bytesScanned: number;
  filesConsidered: number;
  filesScanned: number;
  matchesObserved: number;
  matchesReturned: number;
  elapsedMs: number;
  stopReasons: SearchStopReason[];
  errors: BatchSearchQueryError[];
}

export interface BatchSearchMatch extends SearchMatch {
  id: string;
  untrusted: true;
}

export interface BatchSearchPage {
  queries: BatchSearchQuerySummary[];
  matches: BatchSearchMatch[];
  /** Aggregate scan accounting for the whole snapshot, repeated on every page. */
  /** Actual for completed scans; may conservatively account reserved bytes when rg is interrupted. */
  bytesScanned: number;
  filesConsidered: number;
  filesScanned: number;
  matchesObserved: number;
  /** Number of selected results in this page. */
  returnedMatches: number;
  /** Number of selected results in the complete snapshot. */
  totalMatches: number;
  /** Snapshot-level scan status; unchanged when this response is one page. */
  scanComplete: boolean;
  /** Snapshot-level result selection status; unchanged when this response is one page. */
  resultsComplete: boolean;
  /** Snapshot is complete only when scanning and result selection are complete. */
  complete: boolean;
  truncated: boolean;
  nextCursor?: string;
}

export type BatchSearchRequestErrorCode = "INVALID_REQUEST" | "QUERY_LIMIT";

export class BatchSearchRequestError extends Error {
  constructor(public readonly code: BatchSearchRequestErrorCode, message: string) {
    super(message);
    this.name = "BatchSearchRequestError";
  }
}

interface ResolvedScope {
  requested: string;
  rel?: string;
  abs?: string;
  error?: BatchSearchQueryError;
}

interface NormalizedQuery {
  id: string;
  query: string;
  mode: "literal" | "regex";
  glob?: string;
  maxMatches: number;
  requestPaths: string[];
  scopes: ResolvedScope[];
}

interface NormalizedRequest {
  queries: NormalizedQuery[];
  cursor?: string;
  requestHash: string;
}

interface SnapshotPayload {
  queries: BatchSearchQuerySummary[];
  matches: BatchSearchMatch[];
  bytesScanned: number;
  filesConsidered: number;
  filesScanned: number;
  matchesObserved: number;
  scanComplete: boolean;
  resultsComplete: boolean;
  complete: boolean;
  truncated: boolean;
}

function invalid(message: string): never {
  throw new BatchSearchRequestError("INVALID_REQUEST", message);
}

function safeInteger(value: unknown, field: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    invalid(`${field} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function relativePathInput(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.length > 0 &&
    !normalized.includes("\0") &&
    !normalized.startsWith("/") &&
    !/^[a-z]:/i.test(normalized) &&
    !/^workspace:/i.test(normalized);
}

function canonicalPathKey(abs: string): string {
  const resolved = path.resolve(abs);
  return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorForScope(error: unknown, requested: string): BatchSearchQueryError {
  if (error instanceof WorkspaceError) {
    return {
      code: error.code,
      message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
      path: requested.slice(0, MAX_ERROR_PATH_CHARS),
    };
  }
  return {
    code: "INVALID_PATH",
    message: "Search path is invalid",
    path: requested.slice(0, MAX_ERROR_PATH_CHARS),
  };
}

function normalizeScopes(workspace: Workspace, paths: string[]): ResolvedScope[] {
  const byKey = new Map<string, ResolvedScope>();
  for (const requested of paths) {
    if (typeof requested !== "string" || requested.length > 32_768 || !relativePathInput(requested)) {
      const safe = typeof requested === "string" ? requested.slice(0, MAX_ERROR_PATH_CHARS) : "";
      const scope: ResolvedScope = {
        requested: safe,
        error: { code: "INVALID_PATH", message: "Path must be workspace-relative", path: safe },
      };
      byKey.set(`invalid:${requested}`, scope);
      continue;
    }
      // Match the established Workspace.resolve() behavior, which trims input.
      const normalizedRequested = requested.trim().replace(/\\/g, "/") || ".";
    try {
      // Resolve with sensitive access only to canonicalize and collapse covered scopes.
      // Sensitive selections are retained as per-query errors after ancestor folding.
      const resolved = workspace.resolve(normalizedRequested, { allowSensitive: true });
      const rel = resolved.rel || ".";
      const scope: ResolvedScope = {
        requested: normalizedRequested,
        rel,
        abs: resolved.abs,
      };
      if (rel !== "." && workspace.ignoreRules.isSensitive(rel)) {
        scope.error = {
          code: "ACCESS_DENIED_SENSITIVE_FILE",
          message: `ACCESS_DENIED_SENSITIVE_FILE: '${rel}' matches the sensitive-file policy and cannot be searched.`.slice(0, MAX_ERROR_MESSAGE_CHARS),
          path: rel.slice(0, MAX_ERROR_PATH_CHARS),
        };
      }
      byKey.set(`path:${canonicalPathKey(resolved.abs)}`, scope);
    } catch (error) {
      const scope = { requested: normalizedRequested, error: errorForScope(error, normalizedRequested) };
      const invalidKey = CASE_INSENSITIVE ? normalizedRequested.toLowerCase() : normalizedRequested;
      byKey.set(`invalid:${invalidKey}`, scope);
    }
  }

  const valid = [...byKey.values()].filter((scope): scope is ResolvedScope & { abs: string; rel: string } => !!scope.abs && !!scope.rel);
  valid.sort((left, right) => compareText(canonicalPathKey(left.abs), canonicalPathKey(right.abs)));
  const collapsed: ResolvedScope[] = [];
  for (const scope of valid) {
    // Keep an explicitly requested sensitive path visible as a per-query error,
    // even when a broader allowed scope also covers it.
    if (scope.error) {
      collapsed.push(scope);
      continue;
    }
    const key = canonicalPathKey(scope.abs);
    const covered = collapsed.some((parent) => {
      if (!parent.abs || parent.error) return false;
      const parentKey = canonicalPathKey(parent.abs);
      return key === parentKey || key.startsWith(parentKey.endsWith(path.sep) ? parentKey : `${parentKey}${path.sep}`);
    });
    if (!covered) {
      collapsed.push(scope);
    }
  }
  const invalidScopes = [...byKey.values()].filter((scope) => !scope.abs);
  invalidScopes.sort((left, right) => compareText(left.requested, right.requested));
  return [...collapsed, ...invalidScopes];
}

function normalizeRequest(workspace: Workspace, request: BatchSearchRequest): NormalizedRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("Request must be an object");
  if (!Array.isArray(request.queries) || request.queries.length < 1) invalid("queries must contain at least one query");
  if (request.queries.length > BATCH_SEARCH_MAX_QUERIES) {
    throw new BatchSearchRequestError("QUERY_LIMIT", `queries must contain at most ${BATCH_SEARCH_MAX_QUERIES} queries`);
  }
  if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 16_384)) {
    invalid("cursor must be a string of at most 16384 characters");
  }

  const ids = new Set<string>();
  const queries = request.queries.map((raw, index): NormalizedQuery => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`queries[${index}] must be an object`);
    if (typeof raw.id !== "string" || !ITEM_ID_PATTERN.test(raw.id)) invalid(`queries[${index}].id has an invalid format`);
    if (ids.has(raw.id)) invalid(`Duplicate query id: ${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.query !== "string" || raw.query.length > BATCH_SEARCH_MAX_QUERY_CHARS || raw.query.includes("\0")) {
      invalid(`queries[${index}].query must be a string of at most ${BATCH_SEARCH_MAX_QUERY_CHARS} characters without NUL`);
    }
    if (raw.mode !== "literal" && raw.mode !== "regex") invalid(`queries[${index}].mode must be literal or regex`);
    if (raw.glob !== undefined && (typeof raw.glob !== "string" || raw.glob.length === 0 || raw.glob.length > BATCH_SEARCH_MAX_GLOB_CHARS || raw.glob.includes("\0"))) {
      invalid(`queries[${index}].glob must be a string of at most ${BATCH_SEARCH_MAX_GLOB_CHARS} characters without NUL`);
    }
    const rawPaths = raw.paths === undefined ? ["."] : raw.paths;
    if (!Array.isArray(rawPaths) || rawPaths.length < 1 || rawPaths.length > BATCH_SEARCH_MAX_PATHS) {
      invalid(`queries[${index}].paths must contain 1 to ${BATCH_SEARCH_MAX_PATHS} paths`);
    }
    const pathInputs = rawPaths.map((requested) => {
      if (typeof requested !== "string") return "";
      const normalized = requested.trim().replace(/\\/g, "/");
      return (relativePathInput(normalized) ? path.posix.normalize(normalized) : normalized).slice(0, 32_768);
    });
    const uniquePathInputs = new Map<string, string>();
    for (const pathInput of pathInputs) {
      const key = CASE_INSENSITIVE ? pathInput.toLowerCase() : pathInput;
      if (!uniquePathInputs.has(key)) uniquePathInputs.set(key, pathInput);
    }
    const requestPaths = [...uniquePathInputs.values()].sort(compareText);
    const maxMatches = Math.min(
      raw.max_matches === undefined ? BATCH_SEARCH_DEFAULT_MATCHES : safeInteger(raw.max_matches, `queries[${index}].max_matches`),
      BATCH_SEARCH_MAX_MATCHES_PER_QUERY,
    );
    return {
      id: raw.id,
      query: raw.query,
      mode: raw.mode,
      ...(raw.glob === undefined ? {} : { glob: raw.glob }),
      maxMatches,
      requestPaths,
      scopes: normalizeScopes(workspace, rawPaths),
    };
  });

  const requestHash = canonicalSha256({
    queries: queries.map((query) => ({
      id: query.id,
      query: query.query,
      mode: query.mode,
      ...(query.glob === undefined ? {} : { glob: query.glob }),
      maxMatches: query.maxMatches,
      paths: query.requestPaths,
    })),
  });

  return {
    queries,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    requestHash,
  };
}

function createSummary(query: NormalizedQuery): BatchSearchQuerySummary {
  return {
    id: query.id,
    mode: query.mode,
    engine: "none",
    scanComplete: true,
    resultsComplete: true,
    complete: true,
    truncated: false,
    bytesScanned: 0,
    filesConsidered: 0,
    filesScanned: 0,
    matchesObserved: 0,
    matchesReturned: 0,
    elapsedMs: 0,
    stopReasons: [],
    errors: [],
  };
}

function addStopReason(summary: BatchSearchQuerySummary, reason: SearchStopReason): void {
  if (!summary.stopReasons.includes(reason)) summary.stopReasons.push(reason);
}

function setQueryError(summary: BatchSearchQuerySummary, error: BatchSearchQueryError): void {
  const key = `${error.code}\0${error.path ?? ""}\0${error.message}`;
  if (!summary.errors.some((existing) => `${existing.code}\0${existing.path ?? ""}\0${existing.message}` === key)) {
    summary.errors.push(error);
  }
  summary.scanComplete = false;
  refreshComplete(summary);
  summary.truncated = true;
}

function refreshComplete(summary: BatchSearchQuerySummary): void {
  summary.complete = summary.scanComplete && summary.resultsComplete;
}

function aggregateEngine(summary: BatchSearchQuerySummary, engine: BoundedSearchResult["engine"]): void {
  if (summary.engine === "none") summary.engine = engine;
  else if (engine !== "none" && summary.engine !== engine) summary.engine = "mixed";
}

function matchIdentity(match: SearchMatch): string {
  return `${match.path}\0${match.line}\0${match.text}`;
}

function compareBatchMatches(left: BatchSearchMatch, right: BatchSearchMatch, queryOrder: Map<string, number>): number {
  return (queryOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (queryOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER) ||
    compareSearchMatches(left, right);
}

function selectTopMatches(matches: BatchSearchMatch[], max: number, queryOrder: Map<string, number>): BatchSearchMatch[] {
  const unique = new Map<string, BatchSearchMatch>();
  for (const match of matches) {
    const key = `${match.id}\0${matchIdentity(match)}`;
    if (!unique.has(key)) unique.set(key, match);
  }
  return [...unique.values()].sort((left, right) => compareBatchMatches(left, right, queryOrder)).slice(0, max);
}

function appendResult(summary: BatchSearchQuerySummary, result: BoundedSearchResult): void {
  summary.bytesScanned += result.bytesScanned;
  summary.filesConsidered += result.filesConsidered;
  summary.filesScanned += result.filesScanned;
  summary.matchesObserved += result.matchesObserved;
  summary.elapsedMs += result.elapsedMs;
  aggregateEngine(summary, result.engine);
  if (result.stopReason !== null) addStopReason(summary, result.stopReason);
  if (result.errorCode) {
    setQueryError(summary, {
      code: result.errorCode,
      message: result.errorCode === "INVALID_PATTERN"
        ? "The regular expression is invalid"
        : result.errorCode === "ENGINE_UNAVAILABLE"
          ? "A bounded ripgrep engine is unavailable for regex search"
          : "The search process did not complete successfully",
    });
  }
  if (result.stopReason === "MATCH_LIMIT") summary.resultsComplete = false;
  else if (result.stopReason !== null) summary.scanComplete = false;
  if (result.truncated) summary.truncated = true;
  refreshComplete(summary);
}

function addSkippedForBudget(summary: BatchSearchQuerySummary, reason: SearchStopReason): void {
  addStopReason(summary, reason);
  summary.scanComplete = false;
  refreshComplete(summary);
  summary.truncated = true;
}

async function runQueries(
  workspace: Workspace,
  request: NormalizedRequest,
  runtime: SearchRuntime,
): Promise<SnapshotPayload> {
  const budget = normalizeSearchBudget(runtime.budget);
  const startedAt = performance.now();
  const deadlineAt = startedAt + Math.min(budget.deadlineMs, SEARCH_MAX_DEADLINE_MS);
  let remainingBytes = Math.min(budget.maxBytesScanned, SEARCH_MAX_BYTES);
  let remainingFiles = Math.min(budget.maxFilesConsidered, SEARCH_MAX_FILES);
  let globalStopReason: SearchStopReason | null = null;
  const queryOrder = new Map(request.queries.map((item, index) => [item.id, index]));
  const queries: BatchSearchQuerySummary[] = [];
  const allMatches: BatchSearchMatch[] = [];
  let bytesScanned = 0;
  let filesConsidered = 0;
  let filesScanned = 0;
  let matchesObserved = 0;

  for (const query of request.queries) {
    const summary = createSummary(query);
    queries.push(summary);
    let queryCandidates: BatchSearchMatch[] = [];
    let stopFollowingScopes = false;

    // The existing primitive silently no-ops for short queries. Surface that
    // constraint as an explicit per-query error instead of reporting success.
    if (query.query.length < 2) {
      setQueryError(summary, {
        code: "QUERY_TOO_SHORT",
        message: "The bounded search primitive requires a query of at least 2 characters",
      });
      continue;
    }

    for (const scope of query.scopes) {
      if (scope.error) {
        setQueryError(summary, scope.error);
        continue;
      }
      if (stopFollowingScopes) continue;
      if (globalStopReason !== null) {
        addSkippedForBudget(summary, globalStopReason);
        stopFollowingScopes = true;
        continue;
      }
      const now = performance.now();
      const remainingMs = Math.floor(deadlineAt - now);
      if (remainingMs <= 0) {
        globalStopReason = "DEADLINE";
        addSkippedForBudget(summary, "DEADLINE");
        stopFollowingScopes = true;
        continue;
      }
      if (remainingBytes <= 0) {
        globalStopReason = "SCAN_BYTE_LIMIT";
        addSkippedForBudget(summary, "SCAN_BYTE_LIMIT");
        stopFollowingScopes = true;
        continue;
      }
      if (remainingFiles <= 0) {
        globalStopReason = "ITEM_LIMIT";
        addSkippedForBudget(summary, "ITEM_LIMIT");
        stopFollowingScopes = true;
        continue;
      }

      try {
        const result = await searchWorkspaceBounded(workspace, {
          query: query.query,
          regex: query.mode === "regex",
          ...(query.glob === undefined ? {} : { glob: query.glob }),
          path: scope.rel ?? ".",
          limit: query.maxMatches,
          budget: {
            maxBytesScanned: remainingBytes,
            maxFilesConsidered: remainingFiles,
            deadlineMs: Math.min(remainingMs, SEARCH_MAX_DEADLINE_MS),
            maxFileBytes: Math.min(budget.maxFileBytes, SEARCH_MAX_FILE_BYTES),
          } satisfies SearchBudget,
        }, runtime);
        appendResult(summary, result);
        remainingBytes = Math.max(0, remainingBytes - result.bytesScanned);
        remainingFiles = Math.max(0, remainingFiles - result.filesConsidered);
        if (result.stopReason === "ITEM_LIMIT") {
          // The bounded primitive may stop during path enumeration before it
          // can report a reliable filesConsidered count. Treat ITEM_LIMIT as
          // exhausting the shared file-entry budget for later scopes/queries.
          remainingFiles = 0;
          globalStopReason = "ITEM_LIMIT";
        } else if (result.stopReason === "DEADLINE") {
          globalStopReason = "DEADLINE";
        } else if (remainingBytes <= 0) {
          globalStopReason = "SCAN_BYTE_LIMIT";
        } else if (remainingFiles <= 0) {
          globalStopReason = "ITEM_LIMIT";
        } else if (performance.now() >= deadlineAt) {
          globalStopReason = "DEADLINE";
        }
        bytesScanned += result.bytesScanned;
        filesConsidered += result.filesConsidered;
        filesScanned += result.filesScanned;
        matchesObserved += result.matchesObserved;
        const scopeCandidates = result.matches.map((match) => ({ id: query.id, untrusted: true as const, ...match }));
        // Each scope already contributes its own top-K. Merging and trimming
        // after every scope keeps the cross-scope collector bounded by K.
        queryCandidates = selectTopMatches([...queryCandidates, ...scopeCandidates], query.maxMatches, queryOrder);
        if (result.errorCode === "ENGINE_UNAVAILABLE" || result.errorCode === "INVALID_PATTERN") {
          stopFollowingScopes = true;
        }
      } catch (error) {
        if (error instanceof WorkspaceError) {
          setQueryError(summary, {
            code: error.code,
            message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS),
            path: (scope.rel ?? scope.requested).slice(0, MAX_ERROR_PATH_CHARS),
          });
        } else {
          setQueryError(summary, { code: "PROCESS_ERROR", message: "The search could not be completed" });
        }
      }
    }

    summary.matchesReturned = queryCandidates.length;
    if (summary.matchesObserved > queryCandidates.length) {
      addStopReason(summary, "MATCH_LIMIT");
      summary.resultsComplete = false;
      refreshComplete(summary);
      summary.truncated = true;
    }
    allMatches.push(...queryCandidates);
    const selectedOverall = selectTopMatches(allMatches, BATCH_SEARCH_MAX_MATCHES, queryOrder);
    allMatches.splice(0, allMatches.length, ...selectedOverall);
  }

  const selectedMatches = allMatches;
  const selectedById = new Map<string, number>();
  for (const match of selectedMatches) selectedById.set(match.id, (selectedById.get(match.id) ?? 0) + 1);
  for (const summary of queries) {
    const returned = selectedById.get(summary.id) ?? 0;
    if (returned < summary.matchesReturned) {
      addStopReason(summary, "MATCH_LIMIT");
      summary.resultsComplete = false;
      refreshComplete(summary);
      summary.truncated = true;
    }
    summary.matchesReturned = returned;
  }

  const scanComplete = queries.every((query) => query.scanComplete);
  const resultsComplete = queries.every((query) => query.resultsComplete);
  const complete = scanComplete && resultsComplete;
  const truncated = !complete || queries.some((query) => query.truncated) || selectedMatches.length < allMatches.length;
  return {
    queries,
    matches: selectedMatches,
    bytesScanned,
    filesConsidered,
    filesScanned,
    matchesObserved,
    scanComplete,
    resultsComplete,
    complete,
    truncated,
  };
}

function page(
  payload: SnapshotPayload,
  start: number,
  nextCursor?: string,
): BatchSearchPage {
  const matches = payload.matches.slice(start, start + payload.matches.length);
  return {
    queries: payload.queries,
    matches,
    bytesScanned: payload.bytesScanned,
    filesConsidered: payload.filesConsidered,
    filesScanned: payload.filesScanned,
    matchesObserved: payload.matchesObserved,
    returnedMatches: matches.length,
    totalMatches: payload.matches.length,
    scanComplete: payload.scanComplete,
    resultsComplete: payload.resultsComplete,
    complete: payload.complete,
    truncated: payload.truncated || nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function cursorPage(
  payload: SnapshotPayload,
  start: number,
  snapshotId: string,
  registry: SnapshotRegistry,
): BatchSearchPage {
  if (start >= payload.matches.length) {
    const empty = page(payload, start);
    if (serializedBytes(empty) > BATCH_SEARCH_MAX_PAGE_BYTES) {
      throw new BatchContractError("CURSOR_CAPACITY", "A batch_search page cannot fit in a response page");
    }
    return empty;
  }
  let best: BatchSearchPage | undefined;
  for (let end = start + 1; end <= payload.matches.length; end++) {
    const hasMore = end < payload.matches.length;
    const nextCursor = hasMore ? registry.issueCursor(snapshotId, end) : undefined;
    const candidateMatches = payload.matches.slice(start, end);
    const candidate: BatchSearchPage = {
      queries: payload.queries,
      matches: candidateMatches,
      bytesScanned: payload.bytesScanned,
      filesConsidered: payload.filesConsidered,
      filesScanned: payload.filesScanned,
      matchesObserved: payload.matchesObserved,
      returnedMatches: candidateMatches.length,
      totalMatches: payload.matches.length,
      scanComplete: payload.scanComplete,
      resultsComplete: payload.resultsComplete,
      complete: payload.complete,
      truncated: payload.truncated || hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
    if (serializedBytes(candidate) > BATCH_SEARCH_MAX_PAGE_BYTES) break;
    best = candidate;
  }
  if (!best) throw new BatchContractError("CURSOR_CAPACITY", "A batch_search match cannot fit in a response page");
  return best;
}

export async function batchSearch(
  workspace: Workspace,
  request: BatchSearchRequest,
  context: BatchSearchContext,
): Promise<BatchSearchPage> {
  if (!context || typeof context !== "object" || !(context.registry instanceof SnapshotRegistry)) {
    invalid("A SnapshotRegistry must be injected");
  }
  if (typeof context.ownerId !== "string" || context.ownerId.length === 0 || context.ownerId.length > 256) {
    invalid("ownerId must be a non-empty string of at most 256 characters");
  }

  const normalized = normalizeRequest(workspace, request);
  const binding = {
    workspaceId: workspace.id,
    ownerId: context.ownerId,
    requestHash: normalized.requestHash,
  };
  if (normalized.cursor !== undefined) {
    const resolved = context.registry.resolve<SnapshotPayload>(normalized.cursor, binding);
    const payload = resolved.payload;
    if (!payload || !Array.isArray(payload.queries) || !Array.isArray(payload.matches)) {
      throw new BatchContractError("CURSOR_INVALID", "Snapshot payload is invalid");
    }
    return cursorPage(payload, resolved.position, resolved.snapshotId, context.registry);
  }

  const payload = await runQueries(workspace, normalized, context.runtime ?? {});
  const completePage = page(payload, 0);
  if (serializedBytes(completePage) <= BATCH_SEARCH_MAX_PAGE_BYTES) return completePage;

  const cursor = context.registry.create({ ...binding, payload });
  const snapshot = context.registry.resolve<SnapshotPayload>(cursor, binding);
  return cursorPage(payload, 0, snapshot.snapshotId, context.registry);
}
