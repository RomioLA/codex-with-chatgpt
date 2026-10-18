import fs from "node:fs";
import path from "node:path";
import { getStateDir, ensureDir } from "../config/paths.js";
import { isExecutionJobState, isExecutionKind, type ExecutionJob, type ExecutionStreamMeta, type FullAccessCommand, type OutputStream } from "./job-types.js";
import { isTerminalExecutionState, transitionExecutionJob } from "./state-machine.js";
import { archiveRecord, readArchivedRecord, jobCanBeArchived, archivedIdempotencyKey } from "./record-archive.js";
import { atomicReplace } from "./atomic-replace.js";
import { beginEventLoopTraceSpan, isEventLoopTraceEnabled, type RetainedSizeBucket } from "../diagnostics/event-loop-trace.js";

export const MAX_JOBS_PER_WORKSPACE = 50;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_JOB_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES_PER_STREAM = MAX_JOB_OUTPUT_BYTES / 2;
export const MAX_OUTPUT_READ_BYTES = 64 * 1024;
const OUTPUT_SEGMENT_BYTES = 256 * 1024;

interface OutputSegment {
  startOffset: number;
  endOffset: number;
  file: string;
}

interface InFlightOutputSegment {
  startOffset: number;
  bytes: Buffer;
}

interface OutputSegmentProbe {
  startOffset: number;
  endOffset: number;
  bytes: Buffer;
}

interface OutputWriter {
  segments: OutputSegment[];
  durableMeta: ExecutionStreamMeta;
  pending: Buffer[];
  pendingBytes: number;
  pendingStartOffset: number | null;
  inFlight: InFlightOutputSegment | null;
  probe: OutputSegmentProbe | null;
  tail: Promise<void>;
  failure: Error | null;
}

function newOutputWriter(segments: OutputSegment[] = [], durableMeta: ExecutionStreamMeta = EMPTY_STREAM): OutputWriter {
  return {
    segments,
    durableMeta: { ...durableMeta },
    pending: [],
    pendingBytes: 0,
    pendingStartOffset: null,
    inFlight: null,
    probe: null,
    tail: Promise.resolve(),
    failure: null,
  };
}

function outputWriterKey(jobId: string, stream: OutputStream): string {
  return `${jobId}:${stream}`;
}

function outputPersistenceError(cause: unknown): Error {
  if (cause instanceof Error && cause.message === "OUTPUT_PERSISTENCE_FAILED") return cause;
  return new Error("OUTPUT_PERSISTENCE_FAILED", { cause });
}

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

function retainedSizeBucket(bytes: number): RetainedSizeBucket {
  if (bytes <= 0) return "0";
  if (bytes < 64 * 1024) return "lt64k";
  if (bytes < 256 * 1024) return "64k_256k";
  if (bytes < 1024 * 1024) return "256k_1m";
  if (bytes <= MAX_OUTPUT_BYTES_PER_STREAM) return "1m_4m";
  return "gt4m";
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
  const job = value as Record<string, unknown>;
  const recipe = job.recipe as Record<string, unknown> | null | undefined;
  const authorization = job.authorization as Record<string, unknown> | undefined;
  const hostJob = job.executionContext === "host";
  const validRepositoryFields = !hostJob &&
    (job.executionContext === undefined || job.executionContext === "repository") &&
    typeof job.repositoryIdentity === "string" && /^[a-f0-9]{64}$/.test(job.repositoryIdentity) &&
    typeof job.repositoryPath === "string" &&
    !!recipe && isExecutionKind(recipe.kind) &&
    typeof recipe.target === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(recipe.target) &&
    (recipe.packageManager === "npm" || recipe.packageManager === "pnpm") &&
    typeof recipe.scriptHash === "string" && /^[a-f0-9]{64}$/.test(recipe.scriptHash) &&
    (authorization === undefined || (
      (authorization.type === "level3" || authorization.type === "git") &&
      typeof authorization.requestId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(authorization.requestId) &&
      typeof authorization.digest === "string" && /^[a-f0-9]{64}$/.test(authorization.digest)
    )) && job.fullAccessCommand === undefined;
  const validHostFields = hostJob && job.repositoryIdentity === null && job.repositoryPath === null && recipe === null &&
    authorization?.type === "full_access" && authorization.permissionMode === "level2" &&
    typeof authorization.sessionGrantFingerprint === "string" && /^[a-f0-9]{64}$/.test(authorization.sessionGrantFingerprint) &&
    (authorization.sessionGrantId === undefined ||
      (typeof authorization.sessionGrantId === "string" && /^[a-f0-9]{64}$/.test(authorization.sessionGrantId))) &&
    typeof authorization.requestHash === "string" && /^[a-f0-9]{64}$/.test(authorization.requestHash) &&
    isValidFullAccessCommand(job.fullAccessCommand);
  const gitResult = job.gitResult as Record<string, unknown> | undefined;
  const validGitResult = gitResult === undefined || (
    ["confirmed", "changed", "identity_changed", "unavailable"].includes(String(gitResult.confirmation)) &&
    (gitResult.integrity === undefined || ["verified", "unexpected", "not_verified"].includes(String(gitResult.integrity))) &&
    gitResult.confirmationScope === "local_repository" &&
    ["not_applicable", "not_attempted", "reported_success", "unknown"].includes(String(gitResult.remoteOutcome)) &&
    typeof gitResult.partialSuccessPossible === "boolean" &&
    [gitResult.headBefore, gitResult.headAfter].every((item) => item === null || typeof item === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(item)) &&
    [gitResult.branchBefore, gitResult.branchAfter].every((item) => item === null || typeof item === "string" && item.length > 0 && item.length <= 200)
  );
  return job.workspaceId === workspaceId &&
    typeof job.jobId === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(job.jobId) &&
    typeof job.oauthClientId === "string" && job.oauthClientId.length > 0 && job.oauthClientId.length <= 200 &&
    (validRepositoryFields || validHostFields) && validGitResult &&
    isExecutionJobState(job.state) &&
    typeof job.createdAt === "string" &&
    (job.startedAt === null || typeof job.startedAt === "string") &&
    (job.finishedAt === null || typeof job.finishedAt === "string") &&
    Number.isSafeInteger(job.timeoutSeconds) && Number(job.timeoutSeconds) >= 1 && Number(job.timeoutSeconds) <= 3600 &&
    typeof job.idempotencyKeyHash === "string" && /^[a-f0-9]{64}$/.test(job.idempotencyKeyHash) &&
    (job.tempOwnership === undefined || job.tempOwnership === null || isTempOwnership(job.tempOwnership)) &&
    (job.exitCode === null || Number.isInteger(job.exitCode)) &&
    (job.failureCode === null || typeof job.failureCode === "string") &&
    isStreamMeta(job.stdout) && isStreamMeta(job.stderr);
}

function isValidFullAccessCommand(value: unknown): value is FullAccessCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const common = (command.engine === "program" || command.engine === "powershell" || command.engine === "cmd") &&
    typeof command.executable === "string" && path.win32.isAbsolute(command.executable) && !command.executable.includes("\0") &&
    typeof command.executableFileIdentity === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(command.executableFileIdentity) &&
    typeof command.executableHash === "string" && /^[a-f0-9]{64}$/.test(command.executableHash) &&
    typeof command.cwd === "string" && path.win32.isAbsolute(command.cwd) && !command.cwd.includes("\0") &&
    typeof command.cwdFileIdentity === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(command.cwdFileIdentity);
  if (!common) return false;
  if (command.engine === "program") {
    return Array.isArray(command.args) && command.args.length <= 256 &&
      command.args.every((argument) => typeof argument === "string" && !argument.includes("\0") && argument.length <= 32767) &&
      command.command === undefined;
  }
  return (command.engine === "powershell" || command.engine === "cmd") &&
    typeof command.command === "string" && command.command.length > 0 && command.command.length <= 32767 &&
    !command.command.includes("\0") && command.args === undefined;
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

function isTempOwnership(value: unknown): value is NonNullable<ExecutionJob["tempOwnership"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ownership = value as Partial<NonNullable<ExecutionJob["tempOwnership"]>>;
  return typeof ownership.rootFileIdentity === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(ownership.rootFileIdentity) &&
    typeof ownership.directoryFileIdentity === "string" && /^[a-f0-9]+:[a-f0-9]+$/i.test(ownership.directoryFileIdentity) &&
    typeof ownership.nonce === "string" && /^[a-f0-9]{64}$/i.test(ownership.nonce) &&
    Number.isSafeInteger(ownership.createdAtMs) && ownership.createdAtMs! >= 0;
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
  atomicReplace(temporary, file);
}

function isOutputStream(value: string): value is OutputStream {
  return value === "stdout" || value === "stderr";
}

export class ExecutionJobStore {
  readonly directory: string;
  private readonly file: string;
  private readonly jobs = new Map<string, ExecutionJob>();
  private readonly outputWriters = new Map<string, OutputWriter>();
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
    this.outputWriters.clear();
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
      loaded.set(value.jobId, {
        ...value,
        executionContext: value.executionContext ?? "repository",
        tempOwnership: value.tempOwnership ?? null,
      } as ExecutionJob);
    }
    const directoryEntries = fs.readdirSync(this.directory);
    for (const [jobId, job] of loaded) {
      for (const stream of ["stdout", "stderr"] as const) {
        let segments: OutputSegment[] = [];
        try {
          segments = this.readOutputSegments(jobId, stream, directoryEntries);
          if (segments.length > 0) this.restoreSegmentedOutput(job, stream, segments);
        } catch {
          job[stream] = { ...job[stream], restrictedReason: "output_store_invalid" };
        }
        this.outputWriters.set(outputWriterKey(jobId, stream), newOutputWriter(segments, job[stream]));
      }
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
    const jobs = [...this.jobs.values()].map((job) => {
      let persisted = job;
      for (const stream of ["stdout", "stderr"] as const) {
        const durable = this.outputWriters.get(outputWriterKey(job.jobId, stream))?.durableMeta;
        if (!durable) continue;
        persisted = {
          ...persisted,
          [stream]: {
            ...persisted[stream],
            totalBytes: durable.totalBytes,
            retainedBytes: durable.retainedBytes,
            oldestAvailableOffset: durable.oldestAvailableOffset,
            truncated: durable.truncated,
          },
        };
      }
      return persisted;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    serializeAtomic(this.file, { version: 1, workspaceId: this.workspaceId, jobs } satisfies PersistedJobs);
  }

  private outputFile(jobId: string, stream: OutputStream): string {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(jobId) || !isOutputStream(stream)) {
      throw new TypeError("Invalid execution output key");
    }
    return path.join(this.directory, `${jobId}.${stream}.log`);
  }

  private outputSegmentFile(jobId: string, stream: OutputStream, startOffset: number): string {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(jobId) || !isOutputStream(stream) ||
      !Number.isSafeInteger(startOffset) || startOffset < 0) {
      throw new TypeError("Invalid execution output key");
    }
    return path.join(this.directory, `${jobId}.${stream}.seg.${String(startOffset).padStart(16, "0")}`);
  }

  private readOutputSegments(jobId: string, stream: OutputStream, names = fs.readdirSync(this.directory)): OutputSegment[] {
    const prefix = `${jobId}.${stream}.seg.`;
    const segments: OutputSegment[] = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (!/^\d{16}$/.test(suffix)) continue;
      const startOffset = Number(suffix);
      if (!Number.isSafeInteger(startOffset)) throw new Error("OUTPUT_STORE_INVALID");
      const file = path.join(this.directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > OUTPUT_SEGMENT_BYTES) {
        throw new Error("OUTPUT_STORE_INVALID");
      }
      const endOffset = startOffset + stat.size;
      if (!Number.isSafeInteger(endOffset)) throw new Error("OUTPUT_STORE_INVALID");
      segments.push({ startOffset, endOffset, file });
    }
    segments.sort((a, b) => a.startOffset - b.startOffset);
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index - 1]!.endOffset !== segments[index]!.startOffset) throw new Error("OUTPUT_STORE_INVALID");
    }
    return segments;
  }

  private restoreSegmentedOutput(job: ExecutionJob, stream: OutputStream, segments: OutputSegment[]): void {
    const previous = job[stream];
    const last = segments.at(-1);
    const first = segments[0];
    if (!first || !last) return;
    const totalBytes = last.endOffset;
    if (isTerminalExecutionState(job.state) && previous.totalBytes !== totalBytes) {
      throw new Error("OUTPUT_STORE_INVALID");
    }
    const rawOldestOffset = Math.max(0, totalBytes - MAX_OUTPUT_BYTES_PER_STREAM);
    if (first.startOffset > rawOldestOffset) throw new Error("OUTPUT_STORE_INVALID");
    let oldestAvailableOffset = Math.max(rawOldestOffset, Math.min(previous.oldestAvailableOffset, totalBytes));
    while (oldestAvailableOffset < totalBytes) {
      const segment = segments.find((candidate) => candidate.startOffset <= oldestAvailableOffset && candidate.endOffset > oldestAvailableOffset);
      if (!segment) throw new Error("OUTPUT_STORE_INVALID");
      const data = fs.readFileSync(segment.file);
      if (data.byteLength !== segment.endOffset - segment.startOffset || !data.byteLength) throw new Error("OUTPUT_STORE_INVALID");
      if (!isUtf8ContinuationByte(data[oldestAvailableOffset - segment.startOffset])) break;
      oldestAvailableOffset += 1;
      if (oldestAvailableOffset - rawOldestOffset > 3) throw new Error("OUTPUT_STORE_INVALID");
    }
    job[stream] = {
      totalBytes,
      retainedBytes: totalBytes - oldestAvailableOffset,
      oldestAvailableOffset,
      truncated: previous.truncated || totalBytes > MAX_OUTPUT_BYTES_PER_STREAM || oldestAvailableOffset > 0,
      restrictedReason: previous.restrictedReason,
    };
  }

  private outputWriter(jobId: string, stream: OutputStream): OutputWriter {
    const key = outputWriterKey(jobId, stream);
    let writer = this.outputWriters.get(key);
    if (writer) return writer;
    writer = newOutputWriter(this.readOutputSegments(jobId, stream), this.jobs.get(jobId)?.[stream] ?? EMPTY_STREAM);
    // Archived outputs are read on demand. Do not retain writer probes for every historical job.
    if (this.jobs.has(jobId)) this.outputWriters.set(key, writer);
    return writer;
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

  private archiveJob(job: ExecutionJob): void {
    archiveRecord(this.directory, "jobs", job.jobId, job);
    archiveRecord(this.directory, "idempotency", archivedIdempotencyKey(job.oauthClientId, job.idempotencyKeyHash), { workspaceId: this.workspaceId, jobId: job.jobId });
    // Output and uncertain evidence are retained. Only the active index shrinks.
    this.jobs.delete(job.jobId);
    this.outputWriters.delete(outputWriterKey(job.jobId, "stdout"));
    this.outputWriters.delete(outputWriterKey(job.jobId, "stderr"));
  }

  private prune(now = Date.now(), reserveSlot = false): void {
    const ordered = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keep: ExecutionJob[] = [];
    for (const job of ordered) {
      const age = now - Date.parse(job.createdAt);
      const expired = Number.isFinite(age) && age > JOB_RETENTION_MS && jobCanBeArchived(job);
      if (expired) {
        this.archiveJob(job);
      } else {
        keep.push(job);
      }
    }
    while (keep.length > MAX_JOBS_PER_WORKSPACE - (reserveSlot ? 1 : 0)) {
      const index = keep.findIndex(jobCanBeArchived);
      if (index < 0) break;
      const [dropped] = keep.splice(index, 1);
      this.archiveJob(dropped);
    }
  }

  create(job: ExecutionJob): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    if (job.workspaceId !== this.workspaceId || this.jobs.has(job.jobId)) throw new TypeError("Invalid execution job");
    this.prune(Date.now(), true);
    if (this.jobs.size >= MAX_JOBS_PER_WORKSPACE) throw new Error("JOB_STORE_FULL");
    this.jobs.set(job.jobId, { ...job, stdout: { ...EMPTY_STREAM }, stderr: { ...EMPTY_STREAM } });
    this.persist();
    this.outputWriters.set(outputWriterKey(job.jobId, "stdout"), newOutputWriter());
    this.outputWriters.set(outputWriterKey(job.jobId, "stderr"), newOutputWriter());
  }

  prepareCapacity(): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    this.prune(Date.now(), true);
    this.persist();
    if (this.jobs.size >= MAX_JOBS_PER_WORKSPACE) throw new Error("JOB_STORE_FULL");
  }

  get(jobId: string): ExecutionJob | null {
    const active = this.jobs.get(jobId);
    if (active) return active;
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(jobId)) return null;
    const archived = readArchivedRecord<ExecutionJob>(this.directory, "jobs", jobId);
    if (archived && (!isValidJob(archived, this.workspaceId) || archived.jobId !== jobId || !jobCanBeArchived(archived))) throw new Error("ARCHIVE_CORRUPT");
    return archived;
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
    const active = [...this.jobs.values()].find((job) =>
      job.oauthClientId === clientId && job.idempotencyKeyHash === idempotencyKeyHash
    );
    if (active) return active;
    const pointer = readArchivedRecord<{workspaceId: string; jobId: string}>(this.directory, "idempotency", archivedIdempotencyKey(clientId, idempotencyKeyHash));
    if (!pointer) return null;
    const job = this.get(pointer.jobId);
    if (!job || pointer.workspaceId !== this.workspaceId || job.oauthClientId !== clientId || job.idempotencyKeyHash !== idempotencyKeyHash) throw new Error("ARCHIVE_CORRUPT");
    return job;
  }

  replace(job: ExecutionJob): void {
    if (this.corruption) throw new Error("STORE_CORRUPT");
    if (job.workspaceId !== this.workspaceId || !this.jobs.has(job.jobId)) throw new TypeError("Unknown execution job");
    this.jobs.set(job.jobId, job);
    this.prune();
    this.persist();
  }

  appendSanitized(jobId: string, stream: OutputStream, text: string): Promise<void> {
    if (text.length === 0) return Promise.resolve();
    const job = this.jobs.get(jobId);
    if (!job) return Promise.resolve();
    if (job[stream].restrictedReason && job[stream].restrictedReason !== "output_store_error") return Promise.resolve();
    const writer = this.outputWriter(jobId, stream);
    return this.enqueueOutput(jobId, stream, writer, async () => {
      // Encode bounded string slices rather than allocating an arbitrarily large input buffer.
      for (let textOffset = 0; textOffset < text.length;) {
        let textEnd = Math.min(text.length, textOffset + 64 * 1024);
        if (textEnd < text.length) {
          const last = text.charCodeAt(textEnd - 1);
          const next = text.charCodeAt(textEnd);
          if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) textEnd -= 1;
        }
        const bytes = Buffer.from(text.slice(textOffset, textEnd), "utf8");
        textOffset = textEnd;
        for (let sourceOffset = 0; sourceOffset < bytes.byteLength;) {
          const current = this.jobs.get(jobId);
          if (!current) return;
          if (current[stream].restrictedReason && current[stream].restrictedReason !== "output_store_error") return;
          const previous = current[stream];
          const room = OUTPUT_SEGMENT_BYTES - writer.pendingBytes;
          const count = Math.min(room, bytes.byteLength - sourceOffset);
          const part = Buffer.from(bytes.subarray(sourceOffset, sourceOffset + count));
          if (writer.pendingBytes === 0) writer.pendingStartOffset = previous.totalBytes;
          writer.pending.push(part);
          writer.pendingBytes += count;
          sourceOffset += count;

          const nextTotal = previous.totalBytes + count;
          if (!Number.isSafeInteger(nextTotal)) throw new Error("OUTPUT_SIZE_LIMIT_EXCEEDED");
          const rawOldestOffset = Math.max(0, nextTotal - MAX_OUTPUT_BYTES_PER_STREAM);
          let oldestAvailableOffset = Math.max(previous.oldestAvailableOffset, rawOldestOffset);
          while (oldestAvailableOffset < nextTotal && isUtf8ContinuationByte(await this.outputByteAt(jobId, stream, writer, oldestAvailableOffset))) {
            oldestAvailableOffset += 1;
            if (oldestAvailableOffset - rawOldestOffset > 3) throw new Error("OUTPUT_STORE_INVALID_UTF8");
          }
          current[stream] = {
            totalBytes: nextTotal,
            retainedBytes: nextTotal - oldestAvailableOffset,
            oldestAvailableOffset,
            truncated: previous.truncated || nextTotal > MAX_OUTPUT_BYTES_PER_STREAM,
            restrictedReason: previous.restrictedReason,
          };
          if (writer.pendingBytes === OUTPUT_SEGMENT_BYTES) await this.flushOutputWriter(jobId, stream, writer);
        }
      }
    });
  }

  private enqueueOutput(
    jobId: string,
    stream: OutputStream,
    writer: OutputWriter,
    operation: () => Promise<void>,
  ): Promise<void> {
    const task = writer.tail.then(async () => {
      if (writer.failure) throw writer.failure;
      await operation();
    });
    writer.tail = task.then(() => undefined, (cause: unknown) => {
      if (!writer.failure) writer.failure = cause instanceof Error ? cause : new Error("OUTPUT_PERSISTENCE_FAILED", { cause });
      const job = this.jobs.get(jobId);
      if (job && job[stream].restrictedReason !== "output_store_error") {
        job[stream] = { ...job[stream], restrictedReason: "output_store_error" };
        try { this.persist(); } catch { /* retain the original output persistence failure */ }
      }
    });
    return task.catch((cause: unknown) => { throw outputPersistenceError(cause); });
  }

  private async outputByteAt(jobId: string, stream: OutputStream, writer: OutputWriter, offset: number): Promise<number | undefined> {
    if (writer.inFlight && offset >= writer.inFlight.startOffset && offset < writer.inFlight.startOffset + writer.inFlight.bytes.byteLength) {
      return writer.inFlight.bytes[offset - writer.inFlight.startOffset];
    }
    if (writer.pendingStartOffset !== null && offset >= writer.pendingStartOffset && offset < writer.pendingStartOffset + writer.pendingBytes) {
      let position = offset - writer.pendingStartOffset;
      for (const part of writer.pending) {
        if (position < part.byteLength) return part[position];
        position -= part.byteLength;
      }
    }
    const segment = writer.segments.find((candidate) => candidate.startOffset <= offset && candidate.endOffset > offset);
    if (!segment) throw new Error("OUTPUT_STORE_INVALID");
    if (!writer.probe || writer.probe.startOffset !== segment.startOffset || writer.probe.endOffset !== segment.endOffset) {
      const stat = await fs.promises.lstat(segment.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== segment.endOffset - segment.startOffset) throw new Error("OUTPUT_STORE_INVALID");
      writer.probe = { ...segment, bytes: await fs.promises.readFile(segment.file) };
      if (writer.probe.bytes.byteLength !== segment.endOffset - segment.startOffset) throw new Error("OUTPUT_STORE_INVALID");
    }
    return writer.probe.bytes[offset - segment.startOffset];
  }

  private async flushOutputWriter(jobId: string, stream: OutputStream, writer: OutputWriter): Promise<void> {
    if (writer.pendingBytes === 0 || writer.pendingStartOffset === null) return;
    const bytes = Buffer.concat(writer.pending, writer.pendingBytes);
    const startOffset = writer.pendingStartOffset;
    const endOffset = startOffset + bytes.byteLength;
    if (!Number.isSafeInteger(endOffset)) throw new Error("OUTPUT_SIZE_LIMIT_EXCEEDED");
    writer.pending = [];
    writer.pendingBytes = 0;
    writer.pendingStartOffset = null;
    writer.inFlight = { startOffset, bytes };

    const job = this.jobs.get(jobId);
    const span = isEventLoopTraceEnabled() ? beginEventLoopTraceSpan("job_output_persist", {
      streamType: stream,
      incomingChunkBytes: bytes.byteLength,
      retainedSizeBucket: retainedSizeBucket(job?.[stream].retainedBytes ?? 0),
    }) : null;
    const target = this.outputSegmentFile(jobId, stream, startOffset);
    const temporary = `${target}.pending`;
    try {
      const handle = await fs.promises.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      try { await fs.promises.chmod(temporary, 0o600); } catch { /* best effort on Windows */ }
      try {
        await fs.promises.lstat(target);
        throw new Error("OUTPUT_SEGMENT_EXISTS");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.promises.rename(temporary, target);
      writer.segments.push({ startOffset, endOffset, file: target });
      const committedJob = this.jobs.get(jobId);
      if (committedJob) writer.durableMeta = { ...committedJob[stream] };
      await this.pruneOutputSegments(writer, job?.[stream].oldestAvailableOffset ?? 0);
    } catch (error) {
      try { await fs.promises.unlink(temporary); } catch { /* one exact pending file may already be absent */ }
      throw error;
    } finally {
      writer.inFlight = null;
      span?.({ retainedSizeBucket: retainedSizeBucket(this.jobs.get(jobId)?.[stream].retainedBytes ?? 0) });
    }
  }

  private async pruneOutputSegments(writer: OutputWriter, oldestAvailableOffset: number): Promise<void> {
    const obsolete = writer.segments.filter((segment) => segment.endOffset <= oldestAvailableOffset);
    writer.segments = writer.segments.filter((segment) => segment.endOffset > oldestAvailableOffset);
    if (writer.probe && writer.probe.endOffset <= oldestAvailableOffset) writer.probe = null;
    for (const segment of obsolete) await fs.promises.unlink(segment.file);
  }

  async flushOutput(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) return;
    await Promise.all(([
      ["stdout", this.outputWriter(jobId, "stdout")],
      ["stderr", this.outputWriter(jobId, "stderr")],
    ] as const).map(([stream, writer]) => this.enqueueOutput(jobId, stream, writer, async () => {
      await this.flushOutputWriter(jobId, stream, writer);
    })));
  }

  markOutputRestricted(jobId: string, stream: OutputStream, reason: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    const safeReason = /^[a-z0-9_]{1,64}$/i.test(reason) ? reason : "sensitive_output";
    if (job[stream].restrictedReason === safeReason) return;
    job[stream] = { ...job[stream], restrictedReason: safeReason };
    this.persist();
  }

  private readSegmentedOutput(meta: ExecutionStreamMeta, writer: OutputWriter): Buffer {
    interface Source { startOffset: number; bytes: Buffer; }
    const sources: Source[] = [];
    for (const segment of writer.segments) {
      if (segment.endOffset <= meta.oldestAvailableOffset || segment.startOffset >= meta.totalBytes) continue;
      const stat = fs.lstatSync(segment.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== segment.endOffset - segment.startOffset) {
        throw new Error("OUTPUT_STORE_INVALID");
      }
      const bytes = fs.readFileSync(segment.file);
      if (bytes.byteLength !== stat.size) throw new Error("OUTPUT_STORE_INVALID");
      sources.push({ startOffset: segment.startOffset, bytes });
    }
    if (writer.inFlight) sources.push({ startOffset: writer.inFlight.startOffset, bytes: writer.inFlight.bytes });
    if (writer.pendingBytes > 0 && writer.pendingStartOffset !== null) {
      sources.push({ startOffset: writer.pendingStartOffset, bytes: Buffer.concat(writer.pending, writer.pendingBytes) });
    }
    sources.sort((a, b) => a.startOffset - b.startOffset);

    const parts: Buffer[] = [];
    let cursor = meta.oldestAvailableOffset;
    for (const source of sources) {
      const sourceEnd = source.startOffset + source.bytes.byteLength;
      if (sourceEnd <= cursor || source.startOffset >= meta.totalBytes) continue;
      if (source.startOffset > cursor) throw new Error("OUTPUT_STORE_INVALID");
      const from = cursor - source.startOffset;
      const to = Math.min(meta.totalBytes, sourceEnd) - source.startOffset;
      if (to > from) parts.push(source.bytes.subarray(from, to));
      cursor = source.startOffset + to;
      if (cursor >= meta.totalBytes) break;
    }
    if (cursor !== meta.totalBytes) throw new Error("OUTPUT_STORE_INVALID");
    return Buffer.concat(parts, meta.retainedBytes);
  }

  readOutput(jobId: string, stream: OutputStream, requestedOffset = 0, requestedBytes = MAX_OUTPUT_READ_BYTES): ReadJobOutputResult {
    if (this.corruption) return { ok: false, error: "STORE_CORRUPT" };
    const job = this.get(jobId);
    if (!job) return { ok: false, error: "NOT_FOUND" };
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || !Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
      return { ok: false, error: "INVALID_OFFSET" };
    }
    const meta = job[stream];
    if (meta.restrictedReason) return { ok: false, error: "OUTPUT_RESTRICTED" };
    const offset = Math.max(requestedOffset, meta.oldestAvailableOffset);
    if (offset > meta.totalBytes) return { ok: false, error: "INVALID_OFFSET" };
    let data: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    try {
      const writer = this.outputWriter(jobId, stream);
      if (writer.segments.length > 0 || writer.pendingBytes > 0 || writer.inFlight) {
        data = this.readSegmentedOutput(meta, writer);
      } else {
        const file = this.outputFile(jobId, stream);
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTPUT_BYTES_PER_STREAM) {
            return { ok: false, error: "OUTPUT_RESTRICTED" };
          }
          data = fs.readFileSync(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, error: "OUTPUT_RESTRICTED" };
        }
      }
    } catch {
      return { ok: false, error: "OUTPUT_RESTRICTED" };
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
