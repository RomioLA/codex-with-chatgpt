import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { MAX_OUTPUT_LINES, sanitizeExecutionOutput } from "../execution/sanitize.js";
import { resolveRepositoryIdentity } from "../execution/repository-identity.js";
import { RepositoryIdentityError } from "../execution/repository-identity.js";
import { StreamingSanitizer } from "../execution/stream-sanitize.js";
import type { ExecutionSupervisor } from "../execution/supervisor.js";
import type { OutputStream } from "../execution/job-types.js";
import {
  READ_ITEM_HARD_MAX_BYTES,
  MCP_PAGE_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
  BatchContractError,
  SnapshotRegistry,
  canonicalJson,
  canonicalSha256,
  type SearchStopReason,
} from "./batch.js";
import { BATCH_SEARCH_MAX_GLOB_CHARS, BATCH_SEARCH_MAX_QUERY_CHARS } from "./batch-search.js";
import {
  gitDiff,
  gitRepositoryInfo,
  gitStatus,
  selectGitRepository,
  type DiffMode,
  type GitDiffResult,
  type GitRepositorySelection,
  type GitStatusResult,
} from "./git.js";
import { Workspace, WorkspaceError, type WorkspaceErrorCode } from "./manager.js";
import {
  SEARCH_MAX_BYTES,
  SEARCH_MAX_FILES,
  searchWorkspaceBounded,
  type BoundedSearchOptions,
  type BoundedSearchResult,
  type SearchRuntime,
} from "./search.js";

export const EVIDENCE_MAX_FILES = 16;
export const EVIDENCE_MAX_SEARCHES = 8;
export const EVIDENCE_MAX_REPOSITORIES = 4;
export const EVIDENCE_MAX_EXECUTION_JOBS = 8;
export const EVIDENCE_MAX_RANGES_PER_FILE = 8;
export const EVIDENCE_MAX_MATCHES_PER_SEARCH = 50;
export const EVIDENCE_MAX_TOTAL_MATCHES = 100;
export const EVIDENCE_DEADLINE_MS = 10_000;
export const EVIDENCE_PAGE_MAX_BYTES = MCP_PAGE_MAX_BYTES;
export const EVIDENCE_PACKAGE_MAX_BYTES = SNAPSHOT_MAX_BYTES;
const EVIDENCE_PACKAGE_TRIM_BATCH_SIZE = 16;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_QUERY_CHARS = BATCH_SEARCH_MAX_QUERY_CHARS;
const MAX_GLOB_CHARS = BATCH_SEARCH_MAX_GLOB_CHARS;
const OUTPUT_REFERENCE_BYTES = 1024;
const MAX_SEARCH_RESULT_PATH_CHARS = 128;

export interface EvidenceLineRange {
  startLine: number;
  endLine?: number;
}

export interface EvidenceFilePlan {
  id: string;
  path: string;
  ranges: EvidenceLineRange[];
}

export interface EvidenceSearchPlan {
  id: string;
  query: string;
  path: string;
  glob?: string;
  limit?: number;
}

export interface EvidenceRepositoryPlan {
  id: string;
  path: string;
  /** A diff is collected only when this explicit workspace-relative path is supplied. */
  diffPath?: string;
  diffMode?: DiffMode;
}

export interface EvidenceExecutionJobPlan {
  id: string;
  jobId: string;
}

export interface EvidenceRequest {
  files?: EvidenceFilePlan[];
  searches?: EvidenceSearchPlan[];
  repositories?: EvidenceRepositoryPlan[];
  executionJobs?: EvidenceExecutionJobPlan[];
  cursor?: string;
}

export type EvidenceRecordKind = "file" | "search" | "repository" | "execution_job";

export type EvidenceIssueCode =
  | WorkspaceErrorCode
  | "INVALID_REQUEST"
  | "ITEM_LIMIT"
  | "MATCH_LIMIT"
  | "SCAN_BYTE_LIMIT"
  | "QUERY_TOO_SHORT"
  | "DEADLINE"
  | "PRIVATE_KEY_RESTRICTED"
  | "SEARCH_ERROR"
  | "SEARCH_ENGINE_UNAVAILABLE"
  | "SEARCH_INVALID_PATTERN"
  | "SEARCH_PROCESS_ERROR"
  | "SOURCE_SNAPSHOT_UNAVAILABLE"
  | "NOT_A_REPOSITORY"
  | "GIT_UNAVAILABLE"
  | "PACKAGE_BYTE_LIMIT"
  | "JOB_NOT_FOUND_OR_NOT_OWNED"
  | "SUPERVISOR_UNAVAILABLE"
  | "OUTPUT_RESTRICTED"
  | "OUTPUT_UNAVAILABLE";

export interface EvidenceIssue {
  kind: EvidenceRecordKind;
  id: string;
  path?: string;
  code: EvidenceIssueCode;
}

export interface EvidenceFileRange {
  startLine: number;
  endLine: number;
  startOffsetBytes: number;
  nextOffsetBytes: number;
  nextStartLine: number | null;
  continuationMode: "complete" | "line" | "byte" | "unavailable";
  snippet: string;
  redacted: boolean;
  truncated: boolean;
  status: "ok" | "restricted";
}

export interface EvidenceFile {
  id: string;
  planId: string;
  rangeIndex: number;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
  ranges: EvidenceFileRange[];
  redacted: boolean;
  truncated: boolean;
  status: "ok" | "restricted";
}

export interface EvidenceSearchMatch {
  path: string;
  line: number;
  text: string;
  sourceHash: string;
  sourceHashTiming: "post_search_observation";
  redacted: boolean;
}

export interface EvidenceSearch {
  id: string;
  query: string;
  queryHash: string;
  engine: BoundedSearchResult["engine"];
  matches: EvidenceSearchMatch[];
  sourceFileHashes: Array<{ path: string; sourceHash: string }>;
  scannedBytes: number;
  filesConsidered: number;
  filesScanned: number;
  sourceVerification: "match_set_rechecked" | "unavailable";
  stopReasons: SearchStopReason[];
  truncated: boolean;
  status: "ok" | "partial" | "source_changed" | "restricted";
}

export interface EvidenceRepository {
  id: string;
  path: string;
  repositoryIdentityHash: string;
  branch: string | null;
  head: string | null;
  dirtyStatusHash: string;
  status: GitStatusResult;
  statusTruncated: boolean;
  capturedAt: string;
  diff?: {
    path: string;
    mode: DiffMode;
    diff: string;
    totalBytes: number;
    returnedBytes: number;
    truncated: boolean;
    redacted: boolean;
    status: "ok" | "restricted";
  };
}

export interface EvidenceOutputReference {
  stream: OutputStream;
  offset: number;
  nextOffset: number;
  oldestAvailableOffset: number;
  totalBytes: number;
  retainedBytes: number;
  eof: boolean;
  truncated: boolean;
  pageBytes: number;
}

export interface EvidenceExecutionArtifact {
  id: string;
  jobId: string;
  ownerVerified: true;
  state: string;
  exitCode: number | null;
  failureCode: string | null;
  stdout: EvidenceOutputReference | null;
  stderr: EvidenceOutputReference | null;
}

export interface EvidenceSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  workspaceId: string;
  ownerClientId: string;
  capturedAt: string;
  requestHash: string;
  packageHash: string;
  sourceHashes: string[];
  complete: boolean;
  truncated: boolean;
  files: EvidenceFile[];
  searches: EvidenceSearch[];
  repositories: EvidenceRepository[];
  artifacts: EvidenceExecutionArtifact[];
  omitted: EvidenceIssue[];
  errors: EvidenceIssue[];
}

export interface EvidenceSnapshotPage {
  schemaVersion: 1;
  snapshotId: string;
  workspaceId: string;
  ownerClientId: string;
  capturedAt: string;
  requestHash: string;
  packageHash: string;
  sourceHashes: string[];
  complete: boolean;
  truncated: boolean;
  page: Pick<EvidenceSnapshot, "files" | "searches" | "repositories" | "artifacts" | "omitted" | "errors">;
  nextCursor?: string;
}

export interface EvidenceContext {
  /** Must be injected from the authenticated OAuth client, never copied from the request. */
  ownerId: string;
  registry: SnapshotRegistry;
  executionSupervisor?: ExecutionSupervisor;
}

/** Internal dependency seam used by deterministic domain tests. */
export interface EvidenceRuntime {
  searchWorkspaceBounded?: (
    workspace: Workspace,
    options: BoundedSearchOptions,
    runtime?: SearchRuntime
  ) => Promise<BoundedSearchResult>;
}

export const EVIDENCE_PLAN_DELTAS = [
  "SearchSnapshotHash: the search primitive does not expose a complete candidate-file inventory or hashes from the bytes it scanned. Evidence rechecks the stable match set and stores real post-search source hashes, but marks search results partial with SOURCE_SNAPSHOT_UNAVAILABLE; this is not an atomic filesystem snapshot.",
  "RepositoryDiffHash: sourceHashes excludes sanitized and potentially paginated repository diff content; packageHash still commits the exact diff content returned in the snapshot.",
] as const;

export class EvidenceRequestError extends Error {
  constructor(public readonly code: "INVALID_REQUEST" | "ITEM_LIMIT", message: string) {
    super(message);
    this.name = "EvidenceRequestError";
  }
}

interface NormalizedRequest {
  plan: Omit<EvidenceRequest, "cursor">;
  requestHash: string;
  cursor?: string;
}

interface EvidenceSnapshotPayload {
  snapshot: EvidenceSnapshot;
}

function invalidRequest(message: string): never {
  throw new EvidenceRequestError("INVALID_REQUEST", message);
}

function validId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) invalidRequest(`${field} has an invalid format`);
  return value;
}

function validPathValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) {
    invalidRequest(`${field} must be a non-empty path of at most 32768 characters`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalidRequest(`${field} must be a positive safe integer`);
  }
  return value;
}

function normalizeRequest(request: EvidenceRequest): NormalizedRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalidRequest("Request must be an object");
  if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 16_384)) {
    invalidRequest("cursor must be a string of at most 16384 characters");
  }

  const filesInput = request.files ?? [];
  const searchesInput = request.searches ?? [];
  const repositoriesInput = request.repositories ?? [];
  const executionJobsInput = request.executionJobs ?? [];
  if (!Array.isArray(filesInput) || !Array.isArray(searchesInput) || !Array.isArray(repositoriesInput) || !Array.isArray(executionJobsInput)) {
    invalidRequest("plan sections must be arrays");
  }
  if (filesInput.length > EVIDENCE_MAX_FILES || searchesInput.length > EVIDENCE_MAX_SEARCHES ||
    repositoriesInput.length > EVIDENCE_MAX_REPOSITORIES || executionJobsInput.length > EVIDENCE_MAX_EXECUTION_JOBS) {
    throw new EvidenceRequestError("ITEM_LIMIT", "Evidence plan item limit exceeded");
  }

  const ids = new Set<string>();
  const useId = (value: unknown, field: string): string => {
    const id = validId(value, field);
    if (ids.has(id)) invalidRequest(`Duplicate evidence plan id: ${id}`);
    ids.add(id);
    return id;
  };

  const files: EvidenceFilePlan[] = filesInput.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidRequest(`files[${index}] must be an object`);
    if (!Array.isArray(item.ranges) || item.ranges.length < 1 || item.ranges.length > EVIDENCE_MAX_RANGES_PER_FILE) {
      invalidRequest(`files[${index}].ranges must contain 1 to ${EVIDENCE_MAX_RANGES_PER_FILE} ranges`);
    }
    return {
      id: useId(item.id, `files[${index}].id`),
      path: validPathValue(item.path, `files[${index}].path`),
      ranges: item.ranges.map((range, rangeIndex) => {
        if (!range || typeof range !== "object" || Array.isArray(range)) {
          invalidRequest(`files[${index}].ranges[${rangeIndex}] must be an object`);
        }
        const startLine = positiveInteger(range.startLine, `files[${index}].ranges[${rangeIndex}].startLine`);
        const endLine = range.endLine === undefined
          ? undefined
          : positiveInteger(range.endLine, `files[${index}].ranges[${rangeIndex}].endLine`);
        if (endLine !== undefined && endLine < startLine) invalidRequest("range endLine must be >= startLine");
        return { startLine, ...(endLine === undefined ? {} : { endLine }) };
      }),
    };
  });

  const searches: EvidenceSearchPlan[] = searchesInput.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidRequest(`searches[${index}] must be an object`);
    if (typeof item.query !== "string" || item.query.length > MAX_QUERY_CHARS || item.query.includes("\0")) {
      invalidRequest(`searches[${index}].query must contain at most ${MAX_QUERY_CHARS} characters without NUL`);
    }
    if (item.glob !== undefined && (typeof item.glob !== "string" || item.glob.length === 0 || item.glob.length > MAX_GLOB_CHARS || item.glob.includes("\0"))) {
      invalidRequest(`searches[${index}].glob must contain 1 to ${MAX_GLOB_CHARS} characters without NUL`);
    }
    const limit = item.limit === undefined ? EVIDENCE_MAX_MATCHES_PER_SEARCH : positiveInteger(item.limit, `searches[${index}].limit`);
    if (limit > EVIDENCE_MAX_MATCHES_PER_SEARCH) invalidRequest(`searches[${index}].limit exceeds ${EVIDENCE_MAX_MATCHES_PER_SEARCH}`);
    return {
      id: useId(item.id, `searches[${index}].id`),
      query: item.query,
      path: validPathValue(item.path, `searches[${index}].path`),
      ...(item.glob === undefined ? {} : { glob: item.glob }),
      limit,
    };
  });

  const repositories: EvidenceRepositoryPlan[] = repositoriesInput.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidRequest(`repositories[${index}] must be an object`);
    const diffMode = item.diffMode;
    if (diffMode !== undefined && diffMode !== "unstaged" && diffMode !== "staged" && diffMode !== "head") {
      invalidRequest(`repositories[${index}].diffMode is invalid`);
    }
    return {
      id: useId(item.id, `repositories[${index}].id`),
      path: validPathValue(item.path, `repositories[${index}].path`),
      ...(item.diffPath === undefined ? {} : { diffPath: validPathValue(item.diffPath, `repositories[${index}].diffPath`) }),
      ...(diffMode === undefined ? {} : { diffMode }),
    };
  });

  const executionJobs: EvidenceExecutionJobPlan[] = executionJobsInput.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) invalidRequest(`executionJobs[${index}] must be an object`);
    if (typeof item.jobId !== "string" || !JOB_ID_PATTERN.test(item.jobId)) {
      invalidRequest(`executionJobs[${index}].jobId has an invalid format`);
    }
    return {
      id: useId(item.id, `executionJobs[${index}].id`),
      jobId: item.jobId,
    };
  });

  const plan = { files, searches, repositories, executionJobs };
  return {
    plan,
    requestHash: canonicalSha256(plan),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

function isWorkspaceRelativePath(value: string, allowDot = false): boolean {
  if (!value || value.includes("\0") || value.startsWith("/") || value.startsWith("\\") || /^[a-z]:/i.test(value) || /^workspace:/i.test(value)) {
    return false;
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === "..")) return false;
  return allowDot || value !== ".";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deadlineIssue(kind: EvidenceRecordKind, id: string, path?: string): EvidenceIssue {
  const safePath = path === undefined ? undefined : safeIssuePath(path);
  return { kind, id, ...(safePath === undefined ? {} : { path: safePath }), code: "DEADLINE" };
}

function safeIssuePath(value: string, code?: EvidenceIssueCode): string | undefined {
  if (!isWorkspaceRelativePath(value, true) || code === "ACCESS_DENIED_SENSITIVE_FILE") return undefined;
  return value.slice(0, 1024);
}

function mapWorkspaceError(error: unknown): EvidenceIssueCode {
  if (error instanceof WorkspaceError) return error.code;
  return "SEARCH_ERROR";
}

function assertDeadline(deadlineAt: number): void {
  if (performance.now() >= deadlineAt) throw new WorkspaceError("DEADLINE", "Evidence collection deadline exceeded");
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, Math.floor(deadlineAt - performance.now()));
}

function createPrivateKeyScanner(): { sanitizer: StreamingSanitizer; onChunk: (chunk: string) => void; finish: () => boolean } {
  const sanitizer = new StreamingSanitizer();
  return {
    sanitizer,
    onChunk: (chunk) => { sanitizer.push(chunk); },
    finish: () => {
      sanitizer.finish();
      return sanitizer.restrictedReason === "private_key";
    },
  };
}

function sanitizeSnippet(value: string): { text: string; redacted: boolean; truncated: boolean; restricted: boolean } {
  const result = sanitizeExecutionOutput(value);
  if (!result.allowed) return { text: "", redacted: true, truncated: true, restricted: true };
  return {
    text: result.text,
    redacted: result.text !== value,
    truncated: result.truncated,
    restricted: false,
  };
}

function rangeId(planId: string, rangeIndex: number): string {
  return `${planId}:${rangeIndex + 1}`;
}

async function statWithDeadline(filePath: string, deadlineAt: number): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) throw new WorkspaceError("DEADLINE", "Evidence collection deadline exceeded");
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WorkspaceError("DEADLINE", "Evidence collection deadline exceeded")), remaining);
  });
  try {
    return await Promise.race([fs.stat(filePath), timeout]);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WorkspaceError("FILE_NOT_FOUND", "Evidence file does not exist");
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sameFileObservation(
  left: Awaited<ReturnType<typeof fs.stat>>,
  right: Awaited<ReturnType<typeof fs.stat>>
): boolean {
  return left.isFile() && right.isFile() && left.size === right.size && left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function addFileOmissions(
  files: EvidenceFilePlan[],
  omitted: EvidenceIssue[],
  code: EvidenceIssueCode,
  path?: string
): void {
  for (const file of files) {
    file.ranges.forEach((_range, index) => {
      const safePath = path === undefined ? undefined : safeIssuePath(path, code);
      omitted.push({
        kind: "file",
        id: rangeId(file.id, index),
        ...(safePath === undefined ? {} : { path: safePath }),
        code,
      });
    });
  }
}

interface CollectedLineRange {
  range: EvidenceLineRange;
  snippet: string;
  startLine: number;
  endLine: number;
  startOffsetBytes: number;
  nextOffsetBytes: number;
  nextStartLine: number | null;
  continuationMode: "complete" | "line" | "byte" | "unavailable";
  truncated: boolean;
}

function createLineRangeCollector(ranges: EvidenceLineRange[], sizeBytes: number): {
  onChunk: (chunk: string) => void;
  finish: () => CollectedLineRange[];
} {
  const states = ranges.map((range) => ({
    range,
    parts: [] as string[],
    bytesUsed: 0,
    linesIncluded: 0,
    startOffsetBytes: sizeBytes,
    nextOffsetBytes: sizeBytes,
    endLine: range.startLine - 1,
    continuationMode: "complete" as "complete" | "line" | "byte" | "unavailable",
    truncated: false,
    blocked: false,
    active: false,
    currentLineStart: 0,
    currentLineBytes: 0,
    currentLineLastWasCarriageReturn: false,
  }));
  let lineNumber = 1;
  let byteOffset = 0;
  let lineStartOffset = 0;
  let lineStarted = false;

  const beginLine = (): void => {
    lineStarted = true;
    for (const state of states) {
      state.active = false;
      const inRange = lineNumber >= state.range.startLine &&
        (state.range.endLine === undefined || lineNumber <= state.range.endLine);
      if (lineNumber === state.range.startLine) state.startOffsetBytes = lineStartOffset;
      if (!inRange || state.blocked) continue;
      if (state.linesIncluded >= MAX_OUTPUT_LINES) {
        state.truncated = true;
        state.blocked = true;
        state.nextOffsetBytes = lineStartOffset;
        state.continuationMode = "line";
        continue;
      }
      if (state.linesIncluded > 0) {
        if (state.bytesUsed + 1 > READ_ITEM_HARD_MAX_BYTES) {
          state.truncated = true;
          state.blocked = true;
          state.nextOffsetBytes = lineStartOffset;
          state.continuationMode = "line";
          continue;
        }
        state.parts.push("\n");
        state.bytesUsed += 1;
      }
      state.active = true;
      state.currentLineStart = lineStartOffset;
      state.currentLineBytes = 0;
      state.currentLineLastWasCarriageReturn = false;
    }
  };

  const append = (state: (typeof states)[number], value: string, bytes: number): void => {
    if (!state.active || state.blocked) return;
    if (state.bytesUsed + bytes > READ_ITEM_HARD_MAX_BYTES) {
      state.truncated = true;
      state.blocked = true;
      state.nextOffsetBytes = state.currentLineStart + state.currentLineBytes;
      state.continuationMode = "byte";
      return;
    }
    state.parts.push(value);
    state.bytesUsed += bytes;
    state.currentLineBytes += bytes;
    state.currentLineLastWasCarriageReturn = value === "\r";
  };

  const finishLine = (afterLineOffset: number): void => {
    for (const state of states) {
      if (!state.active) continue;
      if (state.currentLineLastWasCarriageReturn && state.bytesUsed > 0) {
        state.parts.pop();
        state.bytesUsed -= 1;
        state.currentLineBytes -= 1;
        if (state.continuationMode === "byte") {
          state.nextOffsetBytes = state.currentLineStart + state.currentLineBytes;
        }
      }
      state.linesIncluded += 1;
      state.endLine = lineNumber;
      if (state.continuationMode !== "byte") {
        state.nextOffsetBytes = afterLineOffset;
        if (state.truncated) state.continuationMode = "line";
      }
      state.active = false;
    }
  };

  return {
    onChunk(chunk: string): void {
      for (const character of chunk) {
        if (!lineStarted && character !== "\n") beginLine();
        if (character === "\n") {
          if (!lineStarted) beginLine();
          byteOffset += 1;
          finishLine(byteOffset);
          lineNumber += 1;
          lineStartOffset = byteOffset;
          lineStarted = false;
          continue;
        }
        if (!lineStarted) beginLine();
        const bytes = Buffer.byteLength(character, "utf8");
        for (const state of states) append(state, character, bytes);
        byteOffset += bytes;
      }
    },
    finish(): CollectedLineRange[] {
      if (lineStarted || byteOffset < sizeBytes) {
        if (!lineStarted) beginLine();
        finishLine(sizeBytes);
      }
      return states.map((state) => ({
        range: state.range,
        snippet: state.parts.join(""),
        startLine: state.linesIncluded > 0 ? Math.max(state.range.startLine, 1) : state.range.startLine,
        endLine: state.endLine,
        startOffsetBytes: state.startOffsetBytes,
        nextOffsetBytes: state.nextOffsetBytes,
        nextStartLine: state.continuationMode === "byte"
          ? state.endLine
          : state.continuationMode === "line"
            ? state.endLine + 1
            : null,
        continuationMode: state.continuationMode,
        truncated: state.truncated,
      }));
    },
  };
}

async function collectFilePlan(
  workspace: Workspace,
  plan: EvidenceFilePlan,
  deadlineAt: number
): Promise<{ files: EvidenceFile[]; privateKeyDetected: boolean }> {
  if (!isWorkspaceRelativePath(plan.path)) throw new WorkspaceError("INVALID_PATH", "Path must be workspace-relative");
  const resolved = workspace.resolve(plan.path);
  const before = await statWithDeadline(resolved.abs, deadlineAt);
  if (!before.isFile()) throw new WorkspaceError("NOT_A_FILE", "Evidence path is not a regular file");

  const scanner = createPrivateKeyScanner();
  const rangeCollector = createLineRangeCollector(plan.ranges, Number(before.size));
  const read = await workspace.readFileBytes(plan.path, {
    maxBytes: 4,
    deadlineAt,
    onChunk: (chunk) => {
      scanner.onChunk(chunk);
      rangeCollector.onChunk(chunk);
    },
  });
  const privateKeyDetected = scanner.finish();
  const collectedRanges = rangeCollector.finish();
  let after: Awaited<ReturnType<typeof fs.stat>>;
  try {
    after = await statWithDeadline(resolved.abs, deadlineAt);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "FILE_NOT_FOUND") {
      throw new WorkspaceError("SOURCE_CHANGED", "File disappeared during evidence collection");
    }
    throw error;
  }
  if (!sameFileObservation(before, after)) throw new WorkspaceError("SOURCE_CHANGED", "File changed during evidence collection");

  const files: EvidenceFile[] = collectedRanges.map((collected, index) => {
    const sanitized = privateKeyDetected
      ? { text: "", redacted: true, truncated: true, restricted: true }
      : sanitizeSnippet(collected.snippet);
    const sanitizerWithheld = sanitized.truncated || sanitized.restricted;
    const range: EvidenceFileRange = {
      startLine: collected.startLine,
      endLine: collected.endLine,
      startOffsetBytes: collected.startOffsetBytes,
      nextOffsetBytes: sanitizerWithheld ? collected.startOffsetBytes : collected.nextOffsetBytes,
      nextStartLine: sanitizerWithheld ? null : collected.nextStartLine,
      continuationMode: sanitizerWithheld ? "unavailable" : collected.continuationMode,
      snippet: sanitizerWithheld ? "" : sanitized.text,
      redacted: sanitized.redacted || sanitizerWithheld,
      truncated: collected.truncated || sanitizerWithheld,
      status: sanitizerWithheld ? "restricted" : "ok",
    };
    return {
      id: rangeId(plan.id, index),
      planId: plan.id,
      rangeIndex: index,
      path: read.path,
      sizeBytes: read.sizeBytes,
      mtimeMs: Number(before.mtimeMs),
      contentHash: read.sourceHash,
      ranges: [range],
      redacted: sanitized.redacted,
      truncated: range.truncated,
      status: sanitizerWithheld ? "restricted" : "ok",
    };
  });
  return { files, privateKeyDetected };
}

async function collectFiles(
  workspace: Workspace,
  plans: EvidenceFilePlan[],
  deadlineAt: number,
  output: EvidenceFile[],
  omitted: EvidenceIssue[],
  errors: EvidenceIssue[]
): Promise<boolean> {
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (performance.now() >= deadlineAt) {
      addFileOmissions(plans.slice(index), omitted, "DEADLINE");
      return true;
    }
    try {
      const collected = await collectFilePlan(workspace, plan, deadlineAt);
      output.push(...collected.files);
      for (const file of collected.files) {
        if (file.status === "restricted") {
          errors.push({
            kind: "file",
            id: file.id,
            path: file.path,
            code: collected.privateKeyDetected ? "PRIVATE_KEY_RESTRICTED" : "OUTPUT_RESTRICTED",
          });
        }
      }
    } catch (error) {
      const code = mapWorkspaceError(error);
      addFileOmissions([plan], omitted, code, plan.path);
      if (code === "DEADLINE") {
        addFileOmissions(plans.slice(index + 1), omitted, "DEADLINE");
        return true;
      }
    }
  }
  return false;
}

interface VerifiedSearchGroup {
  path: string;
  sourceHash?: string;
  matches: EvidenceSearchMatch[];
  changed: boolean;
  restricted: boolean;
  deadline: boolean;
}

function createSearchLineVerifier(matches: BoundedSearchResult["matches"]): {
  onChunk: (chunk: string) => void;
  finish: () => boolean;
} {
  const expected = new Map<number, string[]>();
  for (const match of matches) {
    const values = expected.get(match.line) ?? [];
    values.push(match.text);
    expected.set(match.line, values);
  }
  let lineNumber = 1;
  let lineUnits = 0;
  let prefix = "";
  let lastNonWhitespaceUnit = -1;
  let matchesCurrentSource = true;

  const finishLine = (): void => {
    const text = prefix.slice(0, Math.min(500, lastNonWhitespaceUnit + 1));
    const wanted = expected.get(lineNumber);
    if (wanted && wanted.some((value) => value !== text)) matchesCurrentSource = false;
    lineNumber += 1;
    lineUnits = 0;
    prefix = "";
    lastNonWhitespaceUnit = -1;
  };

  return {
    onChunk(chunk: string): void {
      for (const character of chunk) {
        if (character === "\n") {
          finishLine();
          continue;
        }
        if (prefix.length < 500) prefix += character.slice(0, 500 - prefix.length);
        const units = character.length;
        if (!/^\s+$/u.test(character)) lastNonWhitespaceUnit = lineUnits + units - 1;
        lineUnits += units;
      }
    },
    finish(): boolean {
      if (lineUnits > 0) finishLine();
      for (const line of expected.keys()) {
        if (line >= lineNumber) matchesCurrentSource = false;
      }
      return matchesCurrentSource;
    },
  };
}

async function verifySearchGroup(
  workspace: Workspace,
  path: string,
  matches: BoundedSearchResult["matches"],
  deadlineAt: number
): Promise<VerifiedSearchGroup> {
  const verified: VerifiedSearchGroup = { path, matches: [], changed: false, restricted: false, deadline: false };
  const scanner = createPrivateKeyScanner();
  const lineVerifier = createSearchLineVerifier(matches);
  try {
    assertDeadline(deadlineAt);
    const read = await workspace.readFileBytes(path, {
      maxBytes: 4,
      deadlineAt,
      onChunk: (chunk) => {
        scanner.onChunk(chunk);
        lineVerifier.onChunk(chunk);
      },
    });
    verified.sourceHash = read.sourceHash;
    if (!lineVerifier.finish()) verified.changed = true;
    verified.restricted = scanner.finish();
    if (!verified.changed && !verified.restricted) {
      for (const match of matches) {
        const sanitized = sanitizeSnippet(match.text);
        if (sanitized.restricted) {
          verified.restricted = true;
          verified.matches = [];
          break;
        }
        verified.matches.push({
          path: read.path,
          line: match.line,
          text: sanitized.text,
          sourceHash: read.sourceHash,
          sourceHashTiming: "post_search_observation",
          redacted: sanitized.redacted,
        });
      }
    }
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "SOURCE_CHANGED") verified.changed = true;
    else if (error instanceof WorkspaceError && error.code === "DEADLINE") verified.deadline = true;
    else verified.changed = true;
  }
  return verified;
}

function searchErrorCode(errorCode: BoundedSearchResult["errorCode"]): EvidenceIssueCode {
  if (errorCode === "ENGINE_UNAVAILABLE") return "SEARCH_ENGINE_UNAVAILABLE";
  if (errorCode === "INVALID_PATTERN") return "SEARCH_INVALID_PATTERN";
  if (errorCode === "PROCESS_ERROR") return "SEARCH_PROCESS_ERROR";
  return "SEARCH_ERROR";
}

function stableGitStatus(status: GitStatusResult): GitStatusResult {
  return {
    ...status,
    staged: [...status.staged].sort((left, right) => left.path.localeCompare(right.path) || left.change.localeCompare(right.change)),
    unstaged: [...status.unstaged].sort((left, right) => left.path.localeCompare(right.path) || left.change.localeCompare(right.change)),
    untracked: [...status.untracked].sort((left, right) => left.localeCompare(right)),
    conflicted: [...status.conflicted].sort((left, right) => left.localeCompare(right)),
  };
}

const MAX_STATUS_ENTRIES = 256;
const MAX_DIFF_BYTES = 64 * 1024;
const MAX_STATUS_JSON_BYTES = 128 * 1024;

function capStatusForPage(statusInput: GitStatusResult): { status: GitStatusResult; truncated: boolean } {
  const status: GitStatusResult = {
    ...statusInput,
    staged: [...statusInput.staged],
    unstaged: [...statusInput.unstaged],
    untracked: [...statusInput.untracked],
    conflicted: [...statusInput.conflicted],
  };
  let truncated = status.staged.length > MAX_STATUS_ENTRIES || status.unstaged.length > MAX_STATUS_ENTRIES ||
    status.untracked.length > MAX_STATUS_ENTRIES || status.conflicted.length > MAX_STATUS_ENTRIES;
  status.staged = status.staged.slice(0, MAX_STATUS_ENTRIES);
  status.unstaged = status.unstaged.slice(0, MAX_STATUS_ENTRIES);
  status.untracked = status.untracked.slice(0, MAX_STATUS_ENTRIES);
  status.conflicted = status.conflicted.slice(0, MAX_STATUS_ENTRIES);
  while (Buffer.byteLength(canonicalJson(status), "utf8") > MAX_STATUS_JSON_BYTES) {
    const collection = [status.untracked, status.conflicted, status.unstaged, status.staged]
      .find((items) => items.length > 0);
    if (!collection) break;
    collection.pop();
    truncated = true;
  }
  return { status, truncated };
}

async function collectRepositoryPlan(
  workspace: Workspace,
  plan: EvidenceRepositoryPlan,
  deadlineAt: number,
  errors: EvidenceIssue[]
): Promise<EvidenceRepository> {
  if (!isWorkspaceRelativePath(plan.path, true)) throw new WorkspaceError("INVALID_PATH", "Repository path must be workspace-relative");
  const identity = resolveRepositoryIdentity(workspace, plan.path, { deadlineAt });
  assertDeadline(deadlineAt);
  const selection: GitRepositorySelection = selectGitRepository(workspace, plan.path, { deadlineAt });
  if (!selection.isRepo) throw new WorkspaceError("NOT_A_DIRECTORY", "Requested path is not a repository root");

  const info = gitRepositoryInfo(selection, { deadlineAt });
  const fullStatus = gitStatus(selection.target, { deadlineAt });
  if (!info.isRepo || !fullStatus.isRepo || !info.head) {
    if (performance.now() >= deadlineAt) throw new WorkspaceError("DEADLINE", "Evidence collection deadline exceeded");
    throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Repository status could not be safely collected");
  }

  const canonicalStatus = stableGitStatus(fullStatus);
  const dirtyStatusHash = canonicalSha256(canonicalStatus);
  const cappedStatus = capStatusForPage(canonicalStatus);
  const status = cappedStatus.status;
  const statusTruncated = cappedStatus.truncated;
  if (statusTruncated) errors.push({ kind: "repository", id: plan.id, code: "ITEM_LIMIT" });

  let diff: EvidenceRepository["diff"];
  if (plan.diffPath !== undefined) {
    if (!isWorkspaceRelativePath(plan.diffPath, true)) throw new WorkspaceError("INVALID_PATH", "Diff path must be workspace-relative");
    const resolvedDiff = workspace.resolveRepositoryScope(selection.repositoryPath, plan.diffPath);
    const mode = plan.diffMode ?? "unstaged";
    const rawDiff: GitDiffResult = gitDiff(
      selection.target,
      { mode, maxBytes: MAX_DIFF_BYTES },
      resolvedDiff.rel || ".",
      { deadlineAt }
    );
    if (!rawDiff.isRepo) {
      if (performance.now() >= deadlineAt) throw new WorkspaceError("DEADLINE", "Evidence collection deadline exceeded");
      throw new WorkspaceError("GIT_EXECUTABLE_UNTRUSTED", "Repository diff could not be safely collected");
    }
    const sanitized = sanitizeSnippet(rawDiff.diff);
    diff = {
      path: resolvedDiff.rel || ".",
      mode,
      diff: sanitized.text,
      totalBytes: rawDiff.totalBytes,
      returnedBytes: rawDiff.returnedBytes,
      truncated: rawDiff.hasMore || sanitized.truncated,
      redacted: sanitized.redacted,
      status: sanitized.restricted ? "restricted" : "ok",
    };
    if (sanitized.restricted) {
      diff.diff = "";
      diff.truncated = true;
      errors.push({ kind: "repository", id: `${plan.id}:diff`, path: resolvedDiff.rel || ".", code: "PRIVATE_KEY_RESTRICTED" });
    }
  }

  assertDeadline(deadlineAt);
  return {
    id: plan.id,
    path: identity.workspaceRelativePath,
    repositoryIdentityHash: identity.identity,
    branch: info.branch,
    head: info.head,
    dirtyStatusHash,
    status,
    statusTruncated,
    capturedAt: new Date().toISOString(),
    ...(diff === undefined ? {} : { diff }),
  };
}

async function collectRepositories(
  workspace: Workspace,
  plans: EvidenceRepositoryPlan[],
  deadlineAt: number,
  output: EvidenceRepository[],
  omitted: EvidenceIssue[],
  errors: EvidenceIssue[]
): Promise<boolean> {
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (performance.now() >= deadlineAt) {
      for (const remaining of plans.slice(index)) omitted.push(deadlineIssue("repository", remaining.id, remaining.path));
      return true;
    }
    try {
      const repository = await collectRepositoryPlan(workspace, plan, deadlineAt, errors);
      output.push(repository);
    } catch (error) {
      const code: EvidenceIssueCode = error instanceof WorkspaceError
        ? error.code
        : error instanceof RepositoryIdentityError
          ? "NOT_A_REPOSITORY"
          : "GIT_UNAVAILABLE";
      const safePath = safeIssuePath(plan.path, code);
      omitted.push({ kind: "repository", id: plan.id, ...(safePath === undefined ? {} : { path: safePath }), code });
      if (code === "DEADLINE") {
        for (const remaining of plans.slice(index + 1)) omitted.push(deadlineIssue("repository", remaining.id, remaining.path));
        return true;
      }
    }
  }
  return false;
}

function collectOutputReference(
  supervisor: ExecutionSupervisor,
  jobId: string,
  ownerId: string,
  stream: OutputStream,
  meta: { totalBytes: number; retainedBytes: number; oldestAvailableOffset: number; truncated: boolean }
): { reference: EvidenceOutputReference | null; error?: EvidenceIssueCode } {
  const page = supervisor.readOutputForClient(jobId, ownerId, stream, meta.oldestAvailableOffset, OUTPUT_REFERENCE_BYTES);
  if (!page.ok) {
    return {
      reference: null,
      error: page.error === "OUTPUT_RESTRICTED" ? "OUTPUT_RESTRICTED" : "OUTPUT_UNAVAILABLE",
    };
  }
  return {
    reference: {
      stream,
      offset: page.offset,
      nextOffset: page.nextOffset,
      oldestAvailableOffset: page.oldestAvailableOffset,
      totalBytes: meta.totalBytes,
      retainedBytes: meta.retainedBytes,
      eof: page.eof,
      truncated: page.truncated || meta.truncated,
      pageBytes: Buffer.byteLength(page.text, "utf8"),
    },
  };
}

function collectExecutionArtifact(
  workspace: Workspace,
  plan: EvidenceExecutionJobPlan,
  ownerId: string,
  supervisor: ExecutionSupervisor,
  deadlineAt: number,
  errors: EvidenceIssue[]
): EvidenceExecutionArtifact {
  assertDeadline(deadlineAt);
  const job = supervisor.getForClient(plan.jobId, ownerId);
  if (!job || job.workspaceId !== workspace.id || job.oauthClientId !== ownerId) {
    throw new Error("JOB_NOT_FOUND_OR_NOT_OWNED");
  }

  const stdout = collectOutputReference(supervisor, job.jobId, ownerId, "stdout", job.stdout);
  assertDeadline(deadlineAt);
  const stderr = collectOutputReference(supervisor, job.jobId, ownerId, "stderr", job.stderr);
  assertDeadline(deadlineAt);
  if (stdout.error) errors.push({ kind: "execution_job", id: `${plan.id}:stdout`, code: stdout.error });
  if (stderr.error) errors.push({ kind: "execution_job", id: `${plan.id}:stderr`, code: stderr.error });
  return {
    id: plan.id,
    jobId: job.jobId,
    ownerVerified: true,
    state: job.state,
    exitCode: job.exitCode,
    failureCode: job.failureCode,
    stdout: stdout.reference,
    stderr: stderr.reference,
  };
}

function collectExecutionJobs(
  workspace: Workspace,
  plans: EvidenceExecutionJobPlan[],
  ownerId: string,
  supervisor: ExecutionSupervisor | undefined,
  deadlineAt: number,
  output: EvidenceExecutionArtifact[],
  omitted: EvidenceIssue[],
  errors: EvidenceIssue[]
): boolean {
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (performance.now() >= deadlineAt) {
      for (const remaining of plans.slice(index)) omitted.push(deadlineIssue("execution_job", remaining.id));
      return true;
    }
    if (!supervisor) {
      omitted.push({ kind: "execution_job", id: plan.id, code: "SUPERVISOR_UNAVAILABLE" });
      continue;
    }
    try {
      output.push(collectExecutionArtifact(workspace, plan, ownerId, supervisor, deadlineAt, errors));
    } catch (error) {
      const code: EvidenceIssueCode = error instanceof WorkspaceError
        ? error.code
        : error instanceof Error && error.message === "JOB_NOT_FOUND_OR_NOT_OWNED"
          ? "JOB_NOT_FOUND_OR_NOT_OWNED"
          : "OUTPUT_UNAVAILABLE";
      omitted.push({ kind: "execution_job", id: plan.id, code });
      if (code === "DEADLINE") {
        for (const remaining of plans.slice(index + 1)) omitted.push(deadlineIssue("execution_job", remaining.id));
        return true;
      }
    }
  }
  return false;
}


interface SharedSearchBudget {
  bytesScanned: number;
  filesConsidered: number;
  matchesReturned: number;
  stopReason: SearchStopReason | null;
}

function searchOptions(plan: EvidenceSearchPlan, deadlineAt: number, budget: SharedSearchBudget): BoundedSearchOptions {
  return {
    query: plan.query,
    path: plan.path,
    ...(plan.glob === undefined ? {} : { glob: plan.glob }),
    limit: Math.min(plan.limit ?? EVIDENCE_MAX_MATCHES_PER_SEARCH, EVIDENCE_MAX_TOTAL_MATCHES - budget.matchesReturned),
    budget: {
      deadlineMs: Math.max(1, remainingMs(deadlineAt)),
      maxBytesScanned: SEARCH_MAX_BYTES - budget.bytesScanned,
      maxFilesConsidered: SEARCH_MAX_FILES - budget.filesConsidered,
    },
  };
}

function addSearchBudget(budget: SharedSearchBudget, result: BoundedSearchResult): void {
  budget.bytesScanned = Math.min(SEARCH_MAX_BYTES, budget.bytesScanned + result.bytesScanned);
  budget.filesConsidered = Math.min(SEARCH_MAX_FILES, budget.filesConsidered + result.filesConsidered);
  if (result.stopReason === "ITEM_LIMIT") budget.filesConsidered = SEARCH_MAX_FILES;
  if (result.stopReason === "SCAN_BYTE_LIMIT") budget.bytesScanned = SEARCH_MAX_BYTES;
  if (["DEADLINE", "ITEM_LIMIT", "SCAN_BYTE_LIMIT"].includes(result.stopReason ?? "")) {
    budget.stopReason = result.stopReason;
  }
}

function sameMatchSet(left: BoundedSearchResult["matches"], right: BoundedSearchResult["matches"]): boolean {
  return canonicalSha256(left.map(({ path, line, text }) => ({ path, line, text }))) ===
    canonicalSha256(right.map(({ path, line, text }) => ({ path, line, text })));
}

function collectSearchStopReasons(
  results: readonly BoundedSearchResult[],
  syntheticReason?: SearchStopReason
): SearchStopReason[] {
  const reasons: SearchStopReason[] = [];
  const seen = new Set<SearchStopReason>();
  for (const result of results) {
    if (result.stopReason && !seen.has(result.stopReason)) {
      seen.add(result.stopReason);
      reasons.push(result.stopReason);
    }
  }
  if (syntheticReason && !seen.has(syntheticReason)) reasons.push(syntheticReason);
  return reasons;
}

function addMatchLimitIssue(
  planId: string,
  stopReasons: readonly SearchStopReason[],
  errors: EvidenceIssue[]
): void {
  if (stopReasons.includes("MATCH_LIMIT") &&
    !errors.some((issue) => issue.kind === "search" && issue.id === planId && issue.code === "MATCH_LIMIT")) {
    errors.push({ kind: "search", id: planId, code: "MATCH_LIMIT" });
  }
}

function searchStopReasonIssueCode(reason: SearchStopReason): EvidenceIssueCode {
  switch (reason) {
    case "SCAN_BYTE_LIMIT": return "SCAN_BYTE_LIMIT";
    case "ITEM_LIMIT": return "ITEM_LIMIT";
    case "DEADLINE": return "DEADLINE";
    case "MATCH_LIMIT": return "MATCH_LIMIT";
    case "ENGINE_UNAVAILABLE": return "SEARCH_ENGINE_UNAVAILABLE";
    case "PROCESS_ERROR": return "SEARCH_PROCESS_ERROR";
  }
}

function searchSummaryWithoutScan(
  plan: EvidenceSearchPlan,
  results: readonly BoundedSearchResult[] = [],
  syntheticReason?: SearchStopReason,
): EvidenceSearch {
  return {
    id: plan.id,
    query: plan.query,
    queryHash: sha256(plan.query),
    engine: results[results.length - 1]?.engine ?? "none",
    matches: [],
    sourceFileHashes: [],
    scannedBytes: results.reduce((sum, result) => sum + result.bytesScanned, 0),
    filesConsidered: results.reduce((sum, result) => sum + result.filesConsidered, 0),
    filesScanned: results.reduce((sum, result) => sum + result.filesScanned, 0),
    sourceVerification: "unavailable",
    stopReasons: collectSearchStopReasons(results, syntheticReason),
    truncated: true,
    status: "partial",
  };
}

async function collectSearchPlan(
  workspace: Workspace,
  plan: EvidenceSearchPlan,
  deadlineAt: number,
  budget: SharedSearchBudget,
  errors: EvidenceIssue[],
  runner: EvidenceRuntime["searchWorkspaceBounded"]
): Promise<EvidenceSearch> {
  if (!isWorkspaceRelativePath(plan.path, true)) throw new WorkspaceError("INVALID_PATH", "Search path must be workspace-relative");
  workspace.resolve(plan.path);
  if (plan.query.length < 2) {
    errors.push({ kind: "search", id: plan.id, code: "QUERY_TOO_SHORT" });
    return searchSummaryWithoutScan(plan);
  }
  if (budget.stopReason !== null) {
    const code = searchStopReasonIssueCode(budget.stopReason);
    errors.push({ kind: "search", id: plan.id, code });
    return searchSummaryWithoutScan(plan, [], budget.stopReason);
  }
  if (SEARCH_MAX_BYTES - budget.bytesScanned <= 0) {
    errors.push({ kind: "search", id: plan.id, code: "SCAN_BYTE_LIMIT" });
    return searchSummaryWithoutScan(plan, [], "SCAN_BYTE_LIMIT");
  }
  if (SEARCH_MAX_FILES - budget.filesConsidered <= 0) {
    errors.push({ kind: "search", id: plan.id, code: "ITEM_LIMIT" });
    return searchSummaryWithoutScan(plan, [], "ITEM_LIMIT");
  }
  if (EVIDENCE_MAX_TOTAL_MATCHES - budget.matchesReturned <= 0) {
    errors.push({ kind: "search", id: plan.id, code: "MATCH_LIMIT" });
    return searchSummaryWithoutScan(plan, [], "MATCH_LIMIT");
  }

  const runSearch = runner ?? searchWorkspaceBounded;
  const first = await runSearch(workspace, searchOptions(plan, deadlineAt, budget));
  addSearchBudget(budget, first);
  addMatchLimitIssue(plan.id, collectSearchStopReasons([first]), errors);
  assertDeadline(deadlineAt);
  if (budget.stopReason !== null) {
    const code = searchStopReasonIssueCode(budget.stopReason);
    errors.push({ kind: "search", id: plan.id, code });
    return searchSummaryWithoutScan(plan, [first], budget.stopReason);
  }
  if (SEARCH_MAX_BYTES - budget.bytesScanned <= 0 || SEARCH_MAX_FILES - budget.filesConsidered <= 0) {
    const reason: SearchStopReason = SEARCH_MAX_BYTES - budget.bytesScanned <= 0 ? "SCAN_BYTE_LIMIT" : "ITEM_LIMIT";
    errors.push({ kind: "search", id: plan.id, code: searchStopReasonIssueCode(reason) });
    return searchSummaryWithoutScan(plan, [first], reason);
  }

  const second = await runSearch(workspace, searchOptions(plan, deadlineAt, budget));
  addSearchBudget(budget, second);
  addMatchLimitIssue(plan.id, collectSearchStopReasons([first, second]), errors);
  assertDeadline(deadlineAt);
  if (budget.stopReason !== null) {
    const code = searchStopReasonIssueCode(budget.stopReason);
    errors.push({ kind: "search", id: plan.id, code });
    return searchSummaryWithoutScan(plan, [first, second], budget.stopReason);
  }

  let status: EvidenceSearch["status"] = "partial";
  let truncated = first.truncated || second.truncated;
  const sourceVerification: EvidenceSearch["sourceVerification"] = "match_set_rechecked";
  if (!sameMatchSet(first.matches, second.matches)) {
    errors.push({ kind: "search", id: plan.id, code: "SOURCE_CHANGED" });
    return {
      id: plan.id,
      query: plan.query,
      queryHash: sha256(plan.query),
      engine: second.engine,
      matches: [],
      sourceFileHashes: [],
      scannedBytes: first.bytesScanned + second.bytesScanned,
      filesConsidered: first.filesConsidered + second.filesConsidered,
      filesScanned: first.filesScanned + second.filesScanned,
      sourceVerification,
      stopReasons: collectSearchStopReasons([first, second]),
      truncated: true,
      status: "source_changed",
    };
  }

  if (first.errorCode || second.errorCode) {
    errors.push({ kind: "search", id: plan.id, code: searchErrorCode(second.errorCode ?? first.errorCode) });
    truncated = true;
  }

  const groups = new Map<string, BoundedSearchResult["matches"]>();
  for (const match of second.matches) {
    const group = groups.get(match.path) ?? [];
    group.push(match);
    groups.set(match.path, group);
  }

  const matches: EvidenceSearchMatch[] = [];
  const sourceHashes = new Map<string, string>();
  for (const [path, pathMatches] of groups) {
    if (performance.now() >= deadlineAt) {
      truncated = true;
      errors.push(deadlineIssue("search", `${plan.id}:${path}`, path));
      break;
    }
    const verified = await verifySearchGroup(workspace, path, pathMatches, deadlineAt);
    if (verified.sourceHash) sourceHashes.set(verified.path, verified.sourceHash);
    if (verified.changed) {
      errors.push({ kind: "search", id: plan.id, path, code: "SOURCE_CHANGED" });
      truncated = true;
      return {
        id: plan.id,
        query: plan.query,
        queryHash: sha256(plan.query),
        engine: second.engine,
        matches: [],
        sourceFileHashes: [],
        scannedBytes: first.bytesScanned + second.bytesScanned,
        filesConsidered: first.filesConsidered + second.filesConsidered,
        filesScanned: first.filesScanned + second.filesScanned,
        sourceVerification,
        stopReasons: collectSearchStopReasons([first, second]),
        truncated: true,
        status: "source_changed",
      };
    }
    if (verified.deadline) {
      errors.push(deadlineIssue("search", `${plan.id}:${path}`, path));
      truncated = true;
      break;
    }
    if (verified.restricted) {
      errors.push({ kind: "search", id: `${plan.id}:${path}`, path, code: "PRIVATE_KEY_RESTRICTED" });
      status = "restricted";
      continue;
    }
    matches.push(...verified.matches);
  }

  errors.push({ kind: "search", id: plan.id, code: "SOURCE_SNAPSHOT_UNAVAILABLE" });
  if (status !== "restricted") status = "partial";
  budget.matchesReturned = Math.min(EVIDENCE_MAX_TOTAL_MATCHES, budget.matchesReturned + matches.length);
  return {
    id: plan.id,
    query: plan.query,
    queryHash: sha256(plan.query),
    engine: second.engine,
    matches,
    sourceFileHashes: [...sourceHashes].sort(([left], [right]) => left.localeCompare(right))
      .map(([path, sourceHash]) => ({ path, sourceHash })),
    scannedBytes: first.bytesScanned + second.bytesScanned,
    filesConsidered: first.filesConsidered + second.filesConsidered,
    filesScanned: first.filesScanned + second.filesScanned,
    sourceVerification,
    stopReasons: collectSearchStopReasons([first, second]),
    truncated: truncated || status === "restricted",
    status,
  };
}

async function collectSearches(
  workspace: Workspace,
  plans: EvidenceSearchPlan[],
  deadlineAt: number,
  budget: SharedSearchBudget,
  output: EvidenceSearch[],
  omitted: EvidenceIssue[],
  errors: EvidenceIssue[],
  runner: EvidenceRuntime["searchWorkspaceBounded"]
): Promise<boolean> {
  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (performance.now() >= deadlineAt) {
      for (const remaining of plans.slice(index)) omitted.push(deadlineIssue("search", remaining.id, remaining.path));
      return true;
    }
    try {
      output.push(await collectSearchPlan(workspace, plan, deadlineAt, budget, errors, runner));
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : "SEARCH_ERROR";
      const safePath = safeIssuePath(plan.path, code);
      omitted.push({ kind: "search", id: plan.id, ...(safePath === undefined ? {} : { path: safePath }), code });
      if (code === "DEADLINE") {
        for (const remaining of plans.slice(index + 1)) omitted.push(deadlineIssue("search", remaining.id, remaining.path));
        return true;
      }
    }
  }
  return false;
}

function packageHashInput(snapshot: EvidenceSnapshot): Omit<EvidenceSnapshot, "packageHash"> {
  const { packageHash: _packageHash, ...input } = snapshot;
  return input;
}

/** SHA-256 of the canonical snapshot JSON with its packageHash field omitted. */
export function computeEvidencePackageHash(snapshot: EvidenceSnapshot): string {
  return canonicalSha256(packageHashInput(snapshot));
}

function collectSourceHashes(snapshot: EvidenceSnapshot, deadlineAt: number): string[] {
  assertDeadline(deadlineAt);
  const hashes = new Set<string>();
  for (const file of snapshot.files) {
    assertDeadline(deadlineAt);
    hashes.add(file.contentHash);
  }
  for (const search of snapshot.searches) {
    assertDeadline(deadlineAt);
    for (const source of search.sourceFileHashes) {
      assertDeadline(deadlineAt);
      hashes.add(source.sourceHash);
    }
  }
  for (const repository of snapshot.repositories) {
    assertDeadline(deadlineAt);
    hashes.add(repository.repositoryIdentityHash);
    hashes.add(repository.dirtyStatusHash);
  }
  const result = [...hashes].filter((hash) => HASH_PATTERN.test(hash)).sort();
  assertDeadline(deadlineAt);
  return result;
}

function hasTruncatedData(snapshot: EvidenceSnapshot, deadlineAt: number): boolean {
  assertDeadline(deadlineAt);
  const result = snapshot.files.some((file) => file.truncated || file.ranges.some((range) => range.truncated)) ||
    snapshot.searches.some((search) => search.truncated) ||
    snapshot.repositories.some((repository) => repository.statusTruncated || repository.diff?.truncated === true) ||
    snapshot.omitted.some((issue) => issue.code === "DEADLINE" || issue.code === "PACKAGE_BYTE_LIMIT") ||
    snapshot.errors.some((issue) => issue.code === "DEADLINE");
  assertDeadline(deadlineAt);
  return result;
}

function deriveSnapshotMetadata(snapshot: EvidenceSnapshot, deadlineAt: number): void {
  assertDeadline(deadlineAt);
  snapshot.sourceHashes = collectSourceHashes(snapshot, deadlineAt);
  snapshot.truncated = hasTruncatedData(snapshot, deadlineAt);
  snapshot.complete = !snapshot.truncated && snapshot.omitted.length === 0 && snapshot.errors.length === 0 &&
    snapshot.files.every((file) => file.status === "ok") &&
    snapshot.searches.every((search) => search.status === "ok") &&
    snapshot.repositories.every((repository) => !repository.statusTruncated && repository.diff?.status !== "restricted");
  snapshot.packageHash = "0".repeat(64);
  assertDeadline(deadlineAt);
}

function packageFits(snapshot: EvidenceSnapshot, deadlineAt: number): boolean {
  assertDeadline(deadlineAt);
  let fits: boolean;
  try {
    canonicalJson({
      workspaceId: snapshot.workspaceId,
      ownerId: snapshot.ownerClientId,
      requestHash: snapshot.requestHash,
      sourceHashes: snapshot.sourceHashes,
      payload: { snapshot },
    }, { maxBytes: EVIDENCE_PACKAGE_MAX_BYTES });
    fits = true;
  } catch {
    fits = false;
  }
  assertDeadline(deadlineAt);
  return fits;
}

function trimIssueFields(snapshot: EvidenceSnapshot, deadlineAt: number): void {
  for (const issue of [...snapshot.omitted, ...snapshot.errors]) {
    assertDeadline(deadlineAt);
    issue.id = issue.id.slice(0, 128);
    if (issue.path !== undefined) issue.path = issue.path.slice(0, 1024);
  }
  assertDeadline(deadlineAt);
}

function dropLastContentRecord(snapshot: EvidenceSnapshot): EvidenceIssue | undefined {
  const artifact = snapshot.artifacts.pop();
  if (artifact) return { kind: "execution_job", id: artifact.id, code: "PACKAGE_BYTE_LIMIT" };
  const repository = snapshot.repositories.pop();
  if (repository) return { kind: "repository", id: repository.id, path: repository.path.slice(0, 1024), code: "PACKAGE_BYTE_LIMIT" };
  const search = snapshot.searches.pop();
  if (search) return { kind: "search", id: search.id, code: "PACKAGE_BYTE_LIMIT" };
  const file = snapshot.files.pop();
  if (file) return { kind: "file", id: file.id, path: file.path.slice(0, 1024), code: "PACKAGE_BYTE_LIMIT" };
  return undefined;
}

function finalizeSnapshot(snapshot: EvidenceSnapshot, deadlineAt: number): EvidenceSnapshot {
  assertDeadline(deadlineAt);
  trimIssueFields(snapshot, deadlineAt);
  deriveSnapshotMetadata(snapshot, deadlineAt);
  while (!packageFits(snapshot, deadlineAt)) {
    let removedCount = 0;
    for (; removedCount < EVIDENCE_PACKAGE_TRIM_BATCH_SIZE; removedCount += 1) {
      assertDeadline(deadlineAt);
      const issue = dropLastContentRecord(snapshot);
      if (!issue) break;
      snapshot.omitted.push(issue);
    }
    if (removedCount === 0) {
      throw new BatchContractError("CURSOR_CAPACITY", "Evidence issue records exceed the package capacity");
    }
    deriveSnapshotMetadata(snapshot, deadlineAt);
  }

  assertDeadline(deadlineAt);
  snapshot.packageHash = computeEvidencePackageHash(snapshot);
  assertDeadline(deadlineAt);
  if (!packageFits(snapshot, deadlineAt)) {
    throw new BatchContractError("CURSOR_CAPACITY", "Evidence package exceeds the package capacity after finalization");
  }
  assertDeadline(deadlineAt);
  return snapshot;
}

type EvidencePageRecord =
  | { kind: "files"; value: EvidenceFile }
  | { kind: "searches"; value: EvidenceSearch }
  | { kind: "repositories"; value: EvidenceRepository }
  | { kind: "artifacts"; value: EvidenceExecutionArtifact }
  | { kind: "omitted"; value: EvidenceIssue }
  | { kind: "errors"; value: EvidenceIssue };

function recordCount(snapshot: EvidenceSnapshot): number {
  return snapshot.files.length + snapshot.searches.length + snapshot.repositories.length +
    snapshot.artifacts.length + snapshot.omitted.length + snapshot.errors.length;
}

function recordAt(snapshot: EvidenceSnapshot, position: number): EvidencePageRecord | undefined {
  const groups: Array<[EvidencePageRecord["kind"], Array<unknown>]> = [
    ["files", snapshot.files],
    ["searches", snapshot.searches],
    ["repositories", snapshot.repositories],
    ["artifacts", snapshot.artifacts],
    ["omitted", snapshot.omitted],
    ["errors", snapshot.errors],
  ];
  let index = position;
  for (const [kind, values] of groups) {
    if (index < values.length) return { kind, value: values[index] } as EvidencePageRecord;
    index -= values.length;
  }
  return undefined;
}

function emptyPageContents(): EvidenceSnapshotPage["page"] {
  return { files: [], searches: [], repositories: [], artifacts: [], omitted: [], errors: [] };
}

function pageEnvelope(snapshot: EvidenceSnapshot, page: EvidenceSnapshotPage["page"], nextCursor?: string): EvidenceSnapshotPage {
  return {
    schemaVersion: snapshot.schemaVersion,
    snapshotId: snapshot.snapshotId,
    workspaceId: snapshot.workspaceId,
    ownerClientId: snapshot.ownerClientId,
    capturedAt: snapshot.capturedAt,
    requestHash: snapshot.requestHash,
    packageHash: snapshot.packageHash,
    sourceHashes: snapshot.sourceHashes,
    complete: snapshot.complete,
    truncated: snapshot.truncated,
    page,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function singlePageSnapshot(snapshot: EvidenceSnapshot): EvidenceSnapshotPage | undefined {
  const fullPage: EvidenceSnapshotPage["page"] = {
    files: snapshot.files,
    searches: snapshot.searches,
    repositories: snapshot.repositories,
    artifacts: snapshot.artifacts,
    omitted: snapshot.omitted,
    errors: snapshot.errors,
  };
  const candidate = pageEnvelope(snapshot, fullPage);
  try {
    canonicalJson(candidate, { maxBytes: EVIDENCE_PAGE_MAX_BYTES });
    return candidate;
  } catch {
    return undefined;
  }
}

function appendPageRecord(page: EvidenceSnapshotPage["page"], record: EvidencePageRecord): void {
  page[record.kind].push(record.value as never);
}

function popPageRecord(page: EvidenceSnapshotPage["page"], record: EvidencePageRecord): void {
  page[record.kind].pop();
}

function pageSnapshot(
  snapshot: EvidenceSnapshot,
  start: number,
  registrySnapshotId: string,
  registry: SnapshotRegistry
): EvidenceSnapshotPage {
  const count = recordCount(snapshot);
  if (!Number.isSafeInteger(start) || start < 0 || start > count) {
    throw new BatchContractError("CURSOR_INVALID", "Evidence cursor position is outside the snapshot");
  }
  const page = emptyPageContents();
  let position = start;
  let best: EvidenceSnapshotPage | undefined;

  while (position < count) {
    const record = recordAt(snapshot, position);
    if (!record) break;
    appendPageRecord(page, record);
    const nextPosition = position + 1;
    const cursor = nextPosition < count ? registry.issueCursor(registrySnapshotId, nextPosition) : undefined;
    const candidate = pageEnvelope(snapshot, page, cursor);
    try {
      canonicalJson(candidate, { maxBytes: EVIDENCE_PAGE_MAX_BYTES });
      best = candidate;
      position = nextPosition;
    } catch {
      popPageRecord(page, record);
      break;
    }
  }

  if (best) return best;
  if (start < count) {
    throw new BatchContractError("CURSOR_CAPACITY", "An evidence record cannot fit in a response page");
  }
  const empty = pageEnvelope(snapshot, page);
  canonicalJson(empty, { maxBytes: EVIDENCE_PAGE_MAX_BYTES });
  return empty;
}

function validateSnapshot(snapshot: EvidenceSnapshot, workspaceId: string, ownerId: string, requestHash: string): void {
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.workspaceId !== workspaceId ||
    snapshot.ownerClientId !== ownerId || snapshot.requestHash !== requestHash ||
    !HASH_PATTERN.test(snapshot.packageHash) || computeEvidencePackageHash(snapshot) !== snapshot.packageHash ||
    !Array.isArray(snapshot.sourceHashes) || snapshot.sourceHashes.some((hash) => !HASH_PATTERN.test(hash))) {
    throw new BatchContractError("CURSOR_INVALID", "Evidence snapshot payload is invalid");
  }
}

/**
 * Collect an explicit, bounded evidence plan and return its first page. The
 * owner id and supervisor are trusted adapter context, never request fields.
 */
export async function collectEvidence(
  workspace: Workspace,
  request: EvidenceRequest,
  context: EvidenceContext,
  runtime: EvidenceRuntime = {}
): Promise<EvidenceSnapshotPage> {
  if (!context || typeof context !== "object" || !(context.registry instanceof SnapshotRegistry)) {
    invalidRequest("A SnapshotRegistry must be injected");
  }
  if (typeof context.ownerId !== "string" || context.ownerId.length === 0 || context.ownerId.length > 256) {
    invalidRequest("Authenticated ownerId must contain 1 to 256 characters");
  }

  const normalized = normalizeRequest(request);
  const binding = {
    workspaceId: workspace.id,
    ownerId: context.ownerId,
    requestHash: normalized.requestHash,
  };

  if (normalized.cursor !== undefined) {
    const resolved = context.registry.resolve<EvidenceSnapshotPayload>(normalized.cursor, binding);
    const snapshot = resolved.payload?.snapshot;
    validateSnapshot(snapshot, workspace.id, context.ownerId, normalized.requestHash);
    return pageSnapshot(snapshot, resolved.position, resolved.snapshotId, context.registry);
  }

  const deadlineAt = performance.now() + EVIDENCE_DEADLINE_MS;
  const files: EvidenceFile[] = [];
  const searches: EvidenceSearch[] = [];
  const repositories: EvidenceRepository[] = [];
  const artifacts: EvidenceExecutionArtifact[] = [];
  const omitted: EvidenceIssue[] = [];
  const errors: EvidenceIssue[] = [];
  const searchBudget: SharedSearchBudget = {
    bytesScanned: 0,
    filesConsidered: 0,
    matchesReturned: 0,
    stopReason: null,
  };

  let deadlineReached = await collectFiles(
    workspace,
    normalized.plan.files ?? [],
    deadlineAt,
    files,
    omitted,
    errors
  );

  if (deadlineReached) {
    for (const item of normalized.plan.searches ?? []) omitted.push(deadlineIssue("search", item.id, item.path));
    for (const item of normalized.plan.repositories ?? []) omitted.push(deadlineIssue("repository", item.id, item.path));
    for (const item of normalized.plan.executionJobs ?? []) omitted.push(deadlineIssue("execution_job", item.id));
  } else {
    deadlineReached = await collectSearches(
      workspace,
      normalized.plan.searches ?? [],
      deadlineAt,
      searchBudget,
      searches,
      omitted,
      errors,
      runtime.searchWorkspaceBounded
    );
    if (deadlineReached) {
      for (const item of normalized.plan.repositories ?? []) omitted.push(deadlineIssue("repository", item.id, item.path));
      for (const item of normalized.plan.executionJobs ?? []) omitted.push(deadlineIssue("execution_job", item.id));
    } else {
      deadlineReached = await collectRepositories(
        workspace,
        normalized.plan.repositories ?? [],
        deadlineAt,
        repositories,
        omitted,
        errors
      );
      if (deadlineReached) {
        for (const item of normalized.plan.executionJobs ?? []) omitted.push(deadlineIssue("execution_job", item.id));
      } else {
        collectExecutionJobs(
          workspace,
          normalized.plan.executionJobs ?? [],
          context.ownerId,
          context.executionSupervisor,
          deadlineAt,
          artifacts,
          omitted,
          errors
        );
      }
    }
  }

  const snapshot = finalizeSnapshot({
    schemaVersion: 1,
    snapshotId: randomBytes(16).toString("hex"),
    workspaceId: workspace.id,
    ownerClientId: context.ownerId,
    capturedAt: new Date().toISOString(),
    requestHash: normalized.requestHash,
    packageHash: "0".repeat(64),
    sourceHashes: [],
    complete: false,
    truncated: false,
    files,
    searches,
    repositories,
    artifacts,
    omitted,
    errors,
  }, deadlineAt);

  assertDeadline(deadlineAt);
  const directPage = singlePageSnapshot(snapshot);
  assertDeadline(deadlineAt);
  if (directPage) return directPage;

  assertDeadline(deadlineAt);
  const created = context.registry.createWithSnapshotId({
    ...binding,
    sourceHashes: snapshot.sourceHashes,
    payload: { snapshot } satisfies EvidenceSnapshotPayload,
  });
  try {
    assertDeadline(deadlineAt);
    const stored = context.registry.resolve<EvidenceSnapshotPayload>(created.cursor, {
      ...binding,
      sourceHashes: snapshot.sourceHashes,
    });
    validateSnapshot(stored.payload.snapshot, workspace.id, context.ownerId, normalized.requestHash);
    assertDeadline(deadlineAt);
    const firstPage = pageSnapshot(stored.payload.snapshot, stored.position, stored.snapshotId, context.registry);
    assertDeadline(deadlineAt);
    return firstPage;
  } catch (error) {
    context.registry.discard(created.snapshotId);
    throw error;
  }
}
