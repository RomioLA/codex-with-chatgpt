export const EXECUTION_JOB_STATES = [
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
] as const;

export type ExecutionJobState = (typeof EXECUTION_JOB_STATES)[number];

export const EXECUTION_KINDS = ["test", "build", "lint", "typecheck", "package_script"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];
export type PackageManager = "npm" | "pnpm";
export type OutputStream = "stdout" | "stderr";

export interface ExecutionRecipe {
  kind: ExecutionKind;
  target: string;
  packageManager: PackageManager;
  scriptHash: string;
}

export type FullAccessCommand =
  | {
      engine: "program";
      executable: string;
      executableFileIdentity: string;
      executableHash: string;
      args: string[];
      cwd: string;
      cwdFileIdentity: string;
    }
  | {
      engine: "powershell" | "cmd";
      executable: string;
      executableFileIdentity: string;
      executableHash: string;
      command: string;
      cwd: string;
      cwdFileIdentity: string;
    };

export type RepositoryExecutionAuthorization = { type: "level3" | "git"; requestId: string; digest: string };
export type FullAccessExecutionAuthorization = {
  type: "full_access";
  permissionMode: "level2";
  sessionGrantFingerprint: string;
  /** Missing only on persisted jobs created before revocable grant generations existed. */
  sessionGrantId?: string;
  requestHash: string;
};

export interface FullAccessRepositoryScope {
  identity: string;
  path: string;
}

export interface ExecutionTempOwnership {
  rootFileIdentity: string;
  directoryFileIdentity: string;
  nonce: string;
  createdAtMs: number;
}

interface ExecutionJobBase {
  jobId: string;
  workspaceId: string;
  oauthClientId: string;
  state: ExecutionJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutSeconds: number;
  idempotencyKeyHash: string;
  tempOwnership: ExecutionTempOwnership | null;
  exitCode: number | null;
  failureCode: string | null;
  stdout: ExecutionStreamMeta;
  stderr: ExecutionStreamMeta;
}

export interface RepositoryExecutionJob extends ExecutionJobBase {
  /** Omitted only by persisted V1 jobs written before the context discriminator existed. */
  executionContext?: "repository";
  repositoryIdentity: string;
  repositoryPath: string;
  recipe: ExecutionRecipe;
  /** V1.3 controlled capabilities never inherit recipe authorization. */
  authorization?: RepositoryExecutionAuthorization;
  gitResult?: {
    integrity?: "verified" | "unexpected" | "not_verified";
    confirmation: "confirmed" | "changed" | "identity_changed" | "unavailable";
    confirmationScope: "local_repository";
    remoteOutcome: "not_applicable" | "not_attempted" | "reported_success" | "unknown";
    partialSuccessPossible: boolean;
    headBefore: string | null;
    headAfter: string | null;
    branchBefore: string | null;
    branchAfter: string | null;
  };
}

export interface FullAccessExecutionJob extends ExecutionJobBase {
  executionContext: "host";
  repositoryIdentity: null;
  repositoryPath: null;
  recipe: null;
  authorization: FullAccessExecutionAuthorization;
  fullAccessCommand: FullAccessCommand;
  /** Optional repository lock scope for host commands launched on behalf of a task. */
  repositoryScope?: FullAccessRepositoryScope;
  gitResult?: never;
}

export type ExecutionJob = RepositoryExecutionJob | FullAccessExecutionJob;

export function isFullAccessExecutionJob(job: ExecutionJob): job is FullAccessExecutionJob {
  return job.executionContext === "host" && job.authorization.type === "full_access";
}

export interface ExecutionStreamMeta {
  totalBytes: number;
  retainedBytes: number;
  oldestAvailableOffset: number;
  truncated: boolean;
  restrictedReason: string | null;
}

export function isExecutionJobState(value: unknown): value is ExecutionJobState {
  return typeof value === "string" && (EXECUTION_JOB_STATES as readonly string[]).includes(value);
}

export function isExecutionKind(value: unknown): value is ExecutionKind {
  return typeof value === "string" && (EXECUTION_KINDS as readonly string[]).includes(value);
}
