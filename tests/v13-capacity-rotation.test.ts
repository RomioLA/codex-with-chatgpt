import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { approveGitRepository, previewGitRepositoryApproval, type GitWriteOperationKind } from "../src/git-write/index.js";
import {
  archiveGitJobPlan,
  createGitJobPlan,
  readGitJobPlan,
  resolveGitJobPlan,
} from "../src/execution/git-job-plan.js";
import {
  approveLevel3Request,
  completeLevel3Request,
  consumeLevel3Request,
  createLevel3Request,
  getLevel3Request,
  resolveConsumedLevel3Request,
  revokeLevel3Request,
  setLevel3Enabled,
  type Level3RequestRecord,
  type Level3Spec,
} from "../src/execution/level3-approval.js";
import { ExecutionJobStore, MAX_JOBS_PER_WORKSPACE } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { transitionExecutionJob } from "../src/execution/state-machine.js";
import { git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const CLIENT_ID = "f05-capacity-client";
const JOB_WORKSPACE_ID = "f05-capacity-jobs";

let fixtureRoot: string;
let repositoryPath: string;
let workspace: Workspace;
let fakeProgram: string;
let stateRoot: string;
let previousStateRoot: string | undefined;

beforeAll(() => {
  fixtureRoot = makeTmpDir("v13-capacity-shared");
  repositoryPath = path.join(fixtureRoot, "repo");
  fs.mkdirSync(repositoryPath, { recursive: true });
  makeGitRepo(repositoryPath);
  workspace = new Workspace(fixtureRoot);
  fakeProgram = write(fixtureRoot, "tools/FakeProgram.exe", "F-05 fixture; this file is never executed.\n");
});

beforeEach(() => {
  previousStateRoot = process.env.C2C_STATE_DIR;
  stateRoot = isolateStateDir();
});

afterEach(() => {
  if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateRoot;
});

function jobForIndex(index: number): ExecutionJob {
  const createdAt = new Date(Date.now() + index).toISOString();
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId: JOB_WORKSPACE_ID,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: CLIENT_ID,
    recipe: { kind: "test", target: "fake-program", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "queued",
    createdAt,
    startedAt: null,
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: createHash("sha256").update(`f05-idempotency-${index}`).digest("hex"),
    tempOwnership: null,
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

function level3Spec(): Level3Spec {
  return {
    engine: "program",
    repositoryPath: "repo",
    executable: fakeProgram,
    args: ["--f05-fixture"],
    cwd: "repo",
    timeoutSeconds: 60,
    materials: ["repo/src/index.ts"],
  };
}

function requestAndApprove(): { requestId: string; digest: string } {
  const request = createLevel3Request(workspace, CLIENT_ID, level3Spec());
  approveLevel3Request(workspace, request.requestId, request.digest, true, { risk: "development" });
  return request;
}

function level3StoreFile(): string {
  return path.join(stateRoot, "execution", "level3", workspace.id, "state.json");
}

function level3ArchiveFile(requestId: string): string {
  return path.join(stateRoot, "execution", "level3", workspace.id, ".archive", "level3", requestId.slice(0, 2), `${requestId}.json`);
}

function makeGitJob(request: { requestId: string; digest: string }, repositoryIdentity: string): ExecutionJob {
  const timestamp = new Date().toISOString();
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId: workspace.id,
    repositoryIdentity,
    repositoryPath: "repo",
    oauthClientId: CLIENT_ID,
    recipe: { kind: "test", target: "git-plan", packageManager: "npm", scriptHash: "c".repeat(64) },
    authorization: { type: "git", requestId: request.requestId, digest: request.digest },
    gitResult: {
      confirmation: "confirmed",
      confirmationScope: "local_repository",
      remoteOutcome: "not_applicable",
      partialSuccessPossible: false,
      headBefore: null,
      headAfter: null,
      branchBefore: null,
      branchAfter: null,
    },
    state: "succeeded",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    timeoutSeconds: 60,
    idempotencyKeyHash: createHash("sha256").update(request.requestId).digest("hex"),
    tempOwnership: null,
    exitCode: 0,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

function approveGitPlanRepository(): void {
  const policy = {
    allowedRemotes: [],
    allowedBranches: ["main"],
    allowedOperations: ["branch_list"] as GitWriteOperationKind[],
  };
  const preview = previewGitRepositoryApproval(workspace, "repo", policy);
  approveGitRepository(workspace, "repo", { ...policy, localApproval: true }, preview.digest);
}

function branchListOperation() {
  return {
    kind: "branch_list" as const,
    expectedHead: git(repositoryPath, "rev-parse", "HEAD").trim(),
    expectedBranch: "main",
  };
}

describe("V1.3 F-05 durable capacity rotation", () => {
  it("archives at least 300 terminal jobs across store reconstruction with idempotency and output intact", () => {
    const directory = makeTmpDir("v13-capacity-job-store");
    let store = new ExecutionJobStore(JOB_WORKSPACE_ID, { directory });
    let firstJob: ExecutionJob | undefined;

    for (let index = 0; index < 300; index += 1) {
      const queued = jobForIndex(index);
      store.create(queued);
      store.appendSanitized(queued.jobId, "stdout", `fake-program-output-${index}\n`);
      const started = transitionExecutionJob(store.get(queued.jobId)!, "running", {}, queued.createdAt);
      const terminal = transitionExecutionJob(started, "succeeded", { exitCode: 0 }, new Date(Date.parse(queued.createdAt) + 1).toISOString());
      store.replace(terminal);
      if (index === 0) firstJob = terminal;
      if (index === 149) store = new ExecutionJobStore(JOB_WORKSPACE_ID, { directory });
    }

    expect(firstJob).toBeDefined();
    const restarted = new ExecutionJobStore(JOB_WORKSPACE_ID, { directory });
    expect(restarted.corruption).toBeNull();
    expect(restarted.listAll()).toHaveLength(MAX_JOBS_PER_WORKSPACE);
    expect(restarted.get(firstJob!.jobId)).toMatchObject({ jobId: firstJob!.jobId, state: "succeeded" });
    expect(restarted.findIdempotent(CLIENT_ID, firstJob!.idempotencyKeyHash)).toMatchObject({ jobId: firstJob!.jobId });
    expect(restarted.readOutput(firstJob!.jobId, "stdout")).toMatchObject({
      ok: true,
      eof: true,
      text: "fake-program-output-0\n",
    });
    expect(fs.existsSync(path.join(directory, ".archive", "jobs", firstJob!.jobId.slice(0, 2), `${firstJob!.jobId}.json`))).toBe(true);
  });

  it("rotates a full Level 3 index, accepts a new request, and retains unconfirmed lifecycle evidence", () => {
    setLevel3Enabled(workspace.id, true, true);

    // One revoked request is created through the public API; the other 251 safe records
    // are explicit state seeds so this quota test does not perform hundreds of Git scans.
    const seedReceipt = createLevel3Request(workspace, CLIENT_ID, level3Spec());
    expect(revokeLevel3Request(workspace.id, seedReceipt.requestId, true)).toBe(true);
    const storeFile = level3StoreFile();
    const seededState = JSON.parse(fs.readFileSync(storeFile, "utf8")) as { requests: Level3RequestRecord[]; [key: string]: unknown };
    const apiRecord = seededState.requests[0];
    const safeHistory = Array.from({ length: 252 }, (_, index): Level3RequestRecord => ({
      ...apiRecord,
      requestId: index === 0 ? apiRecord.requestId : randomBytes(24).toString("base64url"),
      createdAt: new Date(Date.parse(apiRecord.createdAt) + index * 1000).toISOString(),
    }));
    fs.writeFileSync(storeFile, JSON.stringify({ ...seededState, requests: safeHistory }), { mode: 0o600 });

    const consumed = requestAndApprove();
    consumeLevel3Request(workspace, consumed.requestId, CLIENT_ID, consumed.digest);

    const launching = requestAndApprove();
    consumeLevel3Request(workspace, launching.requestId, CLIENT_ID, launching.digest);
    resolveConsumedLevel3Request(workspace, launching.requestId, CLIENT_ID, launching.digest);

    const failedWithoutCleanup = requestAndApprove();
    consumeLevel3Request(workspace, failedWithoutCleanup.requestId, CLIENT_ID, failedWithoutCleanup.digest);
    expect(completeLevel3Request(workspace.id, failedWithoutCleanup.requestId, CLIENT_ID, "failed")).toBe(true);

    const completedWithoutCleanup = requestAndApprove();
    consumeLevel3Request(workspace, completedWithoutCleanup.requestId, CLIENT_ID, completedWithoutCleanup.digest);
    resolveConsumedLevel3Request(workspace, completedWithoutCleanup.requestId, CLIENT_ID, completedWithoutCleanup.digest);
    expect(completeLevel3Request(workspace.id, completedWithoutCleanup.requestId, CLIENT_ID, "completed")).toBe(true);

    const acceptedAfterRotation = createLevel3Request(workspace, CLIENT_ID, level3Spec());
    expect(acceptedAfterRotation.status).toBe("pending");

    const afterRotation = JSON.parse(fs.readFileSync(storeFile, "utf8")) as { requests: Level3RequestRecord[] };
    const retainedIds = new Set(afterRotation.requests.map((record) => record.requestId));
    expect(afterRotation.requests).toHaveLength(5);
    for (const record of [consumed, launching, failedWithoutCleanup, completedWithoutCleanup]) {
      expect(retainedIds.has(record.requestId)).toBe(true);
      expect(fs.existsSync(level3ArchiveFile(record.requestId))).toBe(false);
    }
    expect(getLevel3Request(workspace.id, consumed.requestId)?.status).toBe("consumed");
    expect(getLevel3Request(workspace.id, launching.requestId)?.status).toBe("launching");
    expect(getLevel3Request(workspace.id, failedWithoutCleanup.requestId)?.status).toBe("failed");
    expect(getLevel3Request(workspace.id, completedWithoutCleanup.requestId)?.status).toBe("completed");
    expect(getLevel3Request(workspace.id, apiRecord.requestId)?.status).toBe("revoked");
    expect(fs.existsSync(level3ArchiveFile(apiRecord.requestId))).toBe(true);
    expect(getLevel3Request(workspace.id, safeHistory[1].requestId)?.status).toBe("revoked");
    expect(fs.existsSync(level3ArchiveFile(safeHistory[1].requestId))).toBe(true);
  });

  it("keeps an archived Git plan readable for idempotency but refuses execution", () => {
    approveGitPlanRepository();
    const request = createGitJobPlan(workspace, "repo", branchListOperation());
    const originalFile = path.join(stateRoot, "execution", "git-plans", workspace.id, `${request.requestId}.json`);
    const materialFile = path.join(stateRoot, "execution", "git-plans", workspace.id, ".archive", "git-plans", request.requestId.slice(0, 2), `${request.requestId}.material.json`);

    archiveGitJobPlan(workspace, makeGitJob(request, request.plan.repository.identity));

    expect(fs.existsSync(originalFile)).toBe(false);
    expect(fs.existsSync(materialFile)).toBe(true);
    expect(readGitJobPlan(workspace, request.requestId, request.digest)).toEqual(request.plan);
    expect(() => resolveGitJobPlan(workspace, request.requestId, request.digest)).toThrow("V13_AUTHORIZATION_DENIED");
  });

  it("rejects unknown plan files, reparse-point entries, and a mismatched plan digest", () => {
    const planDirectory = path.join(stateRoot, "execution", "git-plans", workspace.id);
    fs.mkdirSync(planDirectory, { recursive: true });
    fs.writeFileSync(path.join(planDirectory, "unexpected.txt"), "preserve this unknown file\n");
    expect(() => createGitJobPlan(workspace, "repo", branchListOperation())).toThrow("V13_AUTHORIZATION_DENIED");
    expect(fs.readFileSync(path.join(planDirectory, "unexpected.txt"), "utf8")).toBe("preserve this unknown file\n");

    const reparseState = isolateStateDir();
    const reparseDirectory = path.join(reparseState, "execution", "git-plans", workspace.id);
    fs.mkdirSync(reparseDirectory, { recursive: true });
    const linkPath = path.join(reparseDirectory, "linked-plan.json");
    fs.symlinkSync(repositoryPath, linkPath, "junction");
    expect(() => createGitJobPlan(workspace, "repo", branchListOperation())).toThrow("V13_AUTHORIZATION_DENIED");
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);

    const digestState = isolateStateDir();
    const digestDirectory = path.join(digestState, "execution", "git-plans", workspace.id);
    approveGitPlanRepository();
    const created = createGitJobPlan(workspace, "repo", branchListOperation());
    const planFile = path.join(digestDirectory, `${created.requestId}.json`);
    fs.appendFileSync(planFile, " ");
    expect(() => readGitJobPlan(workspace, created.requestId, created.digest)).toThrow("V13_AUTHORIZATION_DENIED");
  });
});
