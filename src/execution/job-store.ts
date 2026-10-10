import fs from "node:fs";
import path from "node:path";
import { getStateDir, ensureDir } from "../config/paths.js";
import { isExecutionJobState, isExecutionKind, type ExecutionJob, type ExecutionStreamMeta, type OutputStream } from "./job-types.js";
import { isTerminalExecutionState, transitionExecutionJob } from "./state-machine.js";

export const MAX_JOBS_PER_WORKSPACE = 50;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES_PER_STREAM = MAX_JOB_OUTPUT_BYTES / 2;
export const MAX_OUTPUT_READ_BYTES = 64 * 1024;

interface PersistedJobs {
  version: 1;
  workspaceId: string;
  jobs: ExecutionJob[];
}

export interface JobStoreCorruption {
  code: "STORE_CORRUPT";
  reason: "read_failed" | "invalid_json" | "unsupported_schema" | "workspace_mismatch" | "invalid_record" | "duplicate_job_id";
}

export type ReadJobOutputResult =
  | {
      ok: true;
      stream: OutputStream;
      offset: number;
      nextOffset: number;
      oldestAvailableOffset: number;
      eof: boolean;
      truncated: boolean;
      text: string;
    }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" | "INVALID_OFFSET" | "STORE_CORRUPT" };

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function isUtf8Boundary(data: Buffer, offset: number): boolean {
  return offset <= 0 || offset >= data.byteLength || !isUtf8ContinuationByte(data[offset]);
}

function hasValidUtf8(data: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

const EMPTY_STREAM: ExecutionStreamMeta = {
  totalBytes: 0,
  retainedBytes: 0,
  oldestAvailableOffset: 0,
  truncated: false,
  restrictedReason: null,
};

function isValidJob(value: unknown, workspaceId: string): value is ExecutionJob {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Partial<ExecutionJob>;
  const recipe = job.recipe as Partial<ExecutionJob["recipe"]> | undefined;
  return job.workspaceId === workspaceId &&
    typeof job.jobId === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(job.jobId) &&
    typeof job.repositoryIdentity === "string" && /^[a-f0-9]{64}$/.test(job.repositoryIdentity) &&
    typeof job.repositoryPath === "string" &&
    typeof job.oauthClientId === "string" && job.oauthClientId.length > 0 && job.oauthClientId.length <= 200 &&
    !!recipe && isExecutionKind(recipe.kind) &&
    typeof recipe.target === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(recipe.target) &&
    (recipe.packageManager === "npm" || recipe.packageManager === "pnpm") &&
    typeof recipe.scriptHash === "string" && /^[a-f0-9]{64}$/.test(recipe.scriptHash) &&
    isExecutionJobState(job.state) &&
    typeof job.createdAt === "string" &&
    (job.startedAt === null || typeof job.startedAt === "string") &&
    (job.finishedAt === null || typeof job.finishedAt === "string") &&
    Number.isSafeInteger(job.timeoutSeconds) && job.timeoutSeconds! >= 1 && job.timeoutSeconds! <= 3600 &&
    typeof job.idempotencyKeyHash === "string" && /^[a-f0-9]{64}$/.test(job.idempotencyKeyHash) &&
    (job.exitCode === null || Number.isInteger(job.exitCode)) &&
    (job.failureCode === null || typeof job.failureCode === "string") &&
    isStreamMeta(job.stdout) && isStreamMeta(job.stderr);
}

function isStreamMeta(value: unknown): value is ExecutionStreamMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const meta = value as Partial<ExecutionStreamMeta>;
  return Number.isSafeInteger(meta.totalBytes) && meta.totalBytes! >= 0 &&
    Number.isSafeInteger(meta.retainedBytes) && meta.retainedBytes! >= 0 &&
    Number.isSafeInteger(meta.oldestAvailableOffset) && meta.oldestAvailableOffset! >= 0 &&
    typeof meta.truncated === "boolean" &&
    (meta.restrictedReason === null || typeof meta.restrictedReason === "string");
}

function serializeAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* best effort on Windows */
  }
  fs.renameSync(temporary, file);
}

function isOutputStream(value: string): value is OutputStream {
  return value === "stdout" || value === "stderr";
}

export class ExecutionJobStore {
  readonly directory: string;
  private readonly file: string;
  private readonly jobs = new Map<string, ExecutionJob>();
  corruption: JobStoreCorruption | null = null;

  constructor(readonly workspaceId: string, opts: { directory?: string } = {}) {
    this.directory = opts.directory ?? path.join(getStateDir(), "execution-jobs", workspaceId);
    ensureDir(this.directory);
    this.file = path.join(this.directory, "jobs.json");
    this.load();
  }

  private markCorrupt(reason: JobStoreCorruption["reason"]): void {
    this.corruption = { code: "STORE_CORRUPT", reason };
    this.jobs.clear();
  }

  private load(): void {
    let bytes: Buffer;
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.markCorrupt("read_failed");
        return;
      }
      bytes = fs.readFileSync(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.markCorrupt("read_failed");
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      this.markCorrupt("invalid_json");
      return;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.markCorrupt("unsupported_schema");
      return;
    }
    const persisted = raw as Partial<PersistedJobs>;
    if (persisted.version !== 1 || !Array.isArray(persisted.jobs)) {
      this.markCorrupt("unsupported_schema");
      return;
    }
    if (persisted.workspaceId !== this.workspaceId) {
      this.markCorrupt("workspace_mismatch");
      return;
    }

    const loaded = new Map<string, ExecutionJob>();
    for (const value of persisted.jobs) {
      if (!isValidJob(value, this.workspaceId)) {
        this.markCorrupt("invalid_record");
        return;
      }
      if (loaded.has(value.jobId)) {
        this.markCorrupt("duplicate_job_id");
        return;
      }
      loaded.set(value.jobId, value);
    }
    for (const [jobId, job] of loaded) {
      if (job.state === "queued" || job.state === "running" || job.state === "cancelling") {
        loaded.set(jobId, transitionExecutionJob(job, "interrupted", {
          failureCode: "BRIDGE_RESTARTED",
          finishedAt: new Date().toISOString(),
        }));
      }
    }
    for (const [jobId, job] of loaded) this.jobs.set(jobId, job);
    this.prune();
    this.persist();
  }

  private persist(): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    const jobs = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    serializeAtomic(this.file, { version: 1, workspaceId: this.workspaceId, jobs } satisfies PersistedJobs);
  }

  private outputFile(jobId: string, stream: OutputStream): string {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(jobId) || !isOutputStream(stream)) {
      throw new TypeError("Invalid execution output key");
    }
    return path.join(this.directory, `${jobId}.${stream}.log`);
  }

  private deleteOutputFiles(jobId: string): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const file = this.outputFile(jobId, stream);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fs.unlinkSync(file);
      } catch {
        /* already absent or inaccessible; do not widen the deletion target */
      }
    }
  }

  private prune(now = Date.now()): void {
    const ordered = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keep: ExecutionJob[] = [];
    for (const job of ordered) {
      const age = now - Date.parse(job.createdAt);
      const expired = Number.isFinite(age) && age > JOB_RETENTION_MS && isTerminalExecutionState(job.state);
      if (expired) {
        this.deleteOutputFiles(job.jobId);
        this.jobs.delete(job.jobId);
      } else {
        keep.push(job);
      }
    }
    while (keep.length > MAX_JOBS_PER_WORKSPACE) {
      const index = keep.findIndex((job) => isTerminalExecutionState(job.state));
      if (index < 0) break;
      const [dropped] = keep.splice(index, 1);
      this.deleteOutputFiles(dropped.jobId);
      this.jobs.delete(dropped.jobId);
    }
  }

  create(job: ExecutionJob): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    if (job.workspaceId !== this.workspaceId || this.jobs.has(job.jobId)) throw new TypeError("Invalid execution job");
    this.prune();
    if (this.jobs.size >= MAX_JOBS_PER_WORKSPACE) throw new Error("JOB_STORE_FULL");
    this.jobs.set(job.jobId, { ...job, stdout: { ...EMPTY_STREAM }, stderr: { ...EMPTY_STREAM } });
    this.persist();
  }

  get(jobId: string): ExecutionJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  listForClient(clientId: string, limit = MAX_JOBS_PER_WORKSPACE): ExecutionJob[] {
    const bounded = Math.max(1, Math.min(MAX_JOBS_PER_WORKSPACE, Math.floor(limit)));
    return [...this.jobs.values()]
      .filter((job) => job.oauthClientId === clientId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded);
  }

  listAll(limit = MAX_JOBS_PER_WORKSPACE): ExecutionJob[] {
    const bounded = Math.max(1, Math.min(MAX_JOBS_PER_WORKSPACE, Math.floor(limit)));
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, bounded);
  }

  findIdempotent(clientId: string, idempotencyKeyHash: string): ExecutionJob | null {
    return [...this.jobs.values()].find((job) =>
      job.oauthClientId === clientId && job.idempotencyKeyHash === idempotencyKeyHash
    ) ?? null;
  }

  replace(job: ExecutionJob): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    if (job.workspaceId !== this.workspaceId || !this.jobs.has(job.jobId)) throw new TypeError("Unknown execution job");
    this.jobs.set(job.jobId, job);
    this.persist();
    this.prune();
  }

  appendSanitized(jobId: string, stream: OutputStream, text: string): void {
    if (text.length === 0) return;
    const job = this.jobs.get(jobId);
    if (!job || job[stream].restrictedReason) return;
    const allBytes = Buffer.from(text, "utf8");
    const chunkBytes = 64 * 1024;
    for (let start = 0; start < allBytes.byteLength; start += chunkBytes) {
      this.appendSanitizedChunk(job, stream, allBytes.subarray(start, start + chunkBytes));
    }
  }

  private appendSanitizedChunk(job: ExecutionJob, stream: OutputStream, bytes: Buffer): void {
    if (bytes.byteLength === 0 || job[stream].restrictedReason) return;
    const file = this.outputFile(job.jobId, stream);
    const previous = job[stream];
    const nextTotal = previous.totalBytes + bytes.byteLength;
    let retained: Buffer;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTPUT_BYTES_PER_STREAM) {
        this.markOutputRestricted(job.jobId, stream, "output_store_invalid");
        return;
      }
      const existing = fs.readFileSync(file);
      retained = Buffer.concat([existing, bytes]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      retained = bytes;
    }
    let dropped = Math.max(0, retained.byteLength - MAX_OUTPUT_BYTES_PER_STREAM);
    while (dropped < retained.byteLength && isUtf8ContinuationByte(retained[dropped])) dropped += 1;
    if (dropped > 0) retained = retained.subarray(dropped);
    try {
      fs.writeFileSync(file, retained, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* best effort on Windows */
      }
    } catch {
      this.markOutputRestricted(job.jobId, stream, "output_store_error");
      return;
    }
    job[stream] = {
      totalBytes: nextTotal,
      retainedBytes: retained.byteLength,
      oldestAvailableOffset: Math.max(0, nextTotal - retained.byteLength),
      truncated: previous.truncated || nextTotal > MAX_OUTPUT_BYTES_PER_STREAM,
      restrictedReason: null,
    };
    this.persist();
  }

  markOutputRestricted(jobId: string, stream: OutputStream, reason: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const safeReason = /^[a-z0-9_]{1,64}$/i.test(reason) ? reason : "sensitive_output";
    job[stream] = { ...job[stream], restrictedReason: safeReason };
    this.persist();
  }

  readOutput(jobId: string, stream: OutputStream, requestedOffset = 0, requestedBytes = MAX_OUTPUT_READ_BYTES): ReadJobOutputResult {
    if (this.corruption) return { ok: false, error: "STORE_CORRUPT" };
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, error: "NOT_FOUND" };
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || !Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
      return { ok: false, error: "INVALID_OFFSET" };
    }
    const meta = job[stream];
    if (meta.restrictedReason) return { ok: false, error: "OUTPUT_RESTRICTED" };
    const offset = Math.max(requestedOffset, meta.oldestAvailableOffset);
    if (offset > meta.totalBytes) return { ok: false, error: "INVALID_OFFSET" };
    const file = this.outputFile(jobId, stream);
    let data = Buffer.alloc(0);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTPUT_BYTES_PER_STREAM) {
        return { ok: false, error: "OUTPUT_RESTRICTED" };
      }
      data = fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: "OUTPUT_RESTRICTED" };
    }
    if (data.byteLength !== meta.retainedBytes || !hasValidUtf8(data)) return { ok: false, error: "OUTPUT_RESTRICTED" };
    const relative = offset - meta.oldestAvailableOffset;
    if (!isUtf8Boundary(data, relative)) return { ok: false, error: "INVALID_OFFSET" };
    const requestedCount = Math.min(requestedBytes, MAX_OUTPUT_READ_BYTES, Math.max(0, data.byteLength - relative));
    let end = relative + requestedCount;
    while (end < data.byteLength && isUtf8ContinuationByte(data[end])) end += 1;
    const nextOffset = meta.oldestAvailableOffset + end;
    return {
      ok: true,
      stream,
      offset,
      nextOffset,
      oldestAvailableOffset: meta.oldestAvailableOffset,
      eof: isTerminalExecutionState(job.state) && nextOffset >= meta.totalBytes,
      truncated: meta.truncated || requestedOffset < meta.oldestAvailableOffset,
      text: data.subarray(relative, end).toString("utf8"),
    };
  }
}
