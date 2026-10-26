import type { RepositoryIdentity } from "../execution/repository-identity.js";

export const GIT_WRITE_OPERATION_KINDS = [
  "add",
  "commit",
  "push",
  "fetch",
  "branch_list",
  "branch_create",
  "switch",
  "pull_ff_only",
] as const;

export type GitWriteOperationKind = (typeof GIT_WRITE_OPERATION_KINDS)[number];

export interface GitWriteExpectation {
  expectedHead: string | null;
  expectedBranch: string | null;
  expectedStatusHash?: string;
}

export type GitWriteOperation = GitWriteExpectation & (
  | { kind: "add"; paths: string[] }
  | { kind: "commit"; message: string }
  | { kind: "push"; remote: string; branch: string }
  | { kind: "fetch"; remote: string; branches?: string[] }
  | { kind: "branch_list" }
  | { kind: "branch_create"; name: string; startPoint?: string }
  | { kind: "switch"; name: string }
  | { kind: "pull_ff_only"; remote: string; branch: string }
);

export interface GitWriteMaterial {
  path: string;
  fileIdentity: string;
  hash: string;
}

export interface GitWriteBefore {
  repositoryIdentity: string;
  executable: string;
  executableFileIdentity: string;
  executableHash: string;
  head: string | null;
  branch: string | null;
  statusHash: string;
  refsHash: string;
}

export interface GitWriteExecutable {
  path: string;
  fileIdentity: string;
  hash: string;
}

export interface GitWriteRemoteBinding {
  name: string;
  url: string;
}

export type GitWritePlanAuthorization =
  | { source: "repository_approval" }
  | {
      source: "full_access";
      permissionMode: "level2";
      sessionGrantFingerprint: string;
      sessionGrantId: string;
    };

export interface GitWritePlan {
  commitBinding?: { tree: string; parent: string | null; branch: string };
  switchBinding?: { head: string };
  repository: RepositoryIdentity;
  executable: string;
  executableFileIdentity: string;
  executableHash: string;
  args: string[];
  environment: Record<string, string>;
  clearEnvironment: string[];
  digest: string;
  before: GitWriteBefore;
  description: string;
  /** Files locked by Native while the write process runs. */
  materials: GitWriteMaterial[];
  /** State inputs included in the plan digest but not held open during execution. */
  snapshotMaterials: GitWriteMaterial[];
  operation: GitWriteOperation;
  /** Present on plans created after authorization-source binding was added. */
  authorization?: GitWritePlanAuthorization;
  remoteBinding: GitWriteRemoteBinding | null;
  credentialHelper: GitWriteMaterial | null;
}

export interface GitWriteStateSnapshot {
  repositoryIdentity: string;
  head: string | null;
  branch: string | null;
  statusHash: string;
  refsHash: string;
}

export type ConfirmGitWriteStateResult =
  | { state: "confirmed" | "changed"; before: GitWriteBefore; after: GitWriteStateSnapshot }
  | { state: "identity_changed"; before: GitWriteBefore; repositoryIdentity: string | null }
  | { state: "unavailable"; before: GitWriteBefore };

export class GitWriteError extends Error {
  constructor(
    public readonly code:
      | "INVALID_ARGUMENTS"
      | "INVALID_REPOSITORY"
      | "REPARSE_POINT"
      | "NOT_APPROVED"
      | "APPROVAL_INVALID"
      | "APPROVAL_PREVIEW_CHANGED"
      | "APPROVAL_BUSY"
      | "UNSAFE_GIT_CONFIG"
      | "GIT_EXECUTABLE_CHANGED"
      | "EXPECTED_STATE_CHANGED"
      | "INVALID_REMOTE"
      | "INVALID_BRANCH"
      | "INVALID_PATH"
      | "SENSITIVE_PATH"
      | "STATE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "GitWriteError";
  }
}
