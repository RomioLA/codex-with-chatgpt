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

export interface ExecutionJob {
  jobId: string;
  workspaceId: string;
  repositoryIdentity: string;
  repositoryPath: string;
  oauthClientId: string;
  recipe: ExecutionRecipe;
  state: ExecutionJobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeoutSeconds: number;
  idempotencyKeyHash: string;
  exitCode: number | null;
  failureCode: string | null;
  stdout: ExecutionStreamMeta;
  stderr: ExecutionStreamMeta;
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
