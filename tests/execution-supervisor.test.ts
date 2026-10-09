import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import type { ExecutionJob, OutputStream } from "../src/execution/job-types.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import { setPermission } from "../src/permission/store.js";
import { makeGitRepo, makeTmpDir, write, isolateStateDir } from "./helpers.js";

interface CapturedRun {
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  completion: Promise<NativeRunnerCompletion>;
  resolve: (value: NativeRunnerCompletion) => void;
  cancelCount: number;
  abandonCount: number;
}

class ControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, CapturedRun>();

  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { callbacks, completion, resolve, cancelCount: 0, abandonCount: 0 });
    const run = this.runs.get(request.jobId)!;
    return {
      completion,
      cancel: () => { run.cancelCount += 1; },
      abandon: () => { run.abandonCount += 1; },
    };
  }

  emit(jobId: string, stream: OutputStream, value: string): void {
    this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(value, "utf8"));
  }

  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"], exitCode = 0): void {
    this.runs.get(jobId)?.resolve({
      result: { outcome, exitCode, win32Error: 0 },
      helperExitCode: 0,
    });
  }
}

let workspace: Workspace;
let supervisor: ExecutionSupervisor;
let runner: ControlledRunner;

function startInput(overrides: Partial<Parameters<ExecutionSupervisor["start"]>[0]> = {}) {
  return {
    repositoryPath: ".",
    kind: "test" as const,
    target: "test",
    timeoutSeconds: 30,
    idempotencyKey: "test-key-0123456789",
    oauthClientId: "execution-test-client",
    scopes: ["execution.run"],
    ...overrides,
  };
}

async function waitForState(jobId: string, expected: ExecutionJob["state"]): Promise<ExecutionJob> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = supervisor.store.get(jobId);
    if (job?.state === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const actual = supervisor.store.get(jobId)?.state;
  throw new Error(`Timed out waiting for ${expected}; current state is ${actual ?? "missing"}`);
}

beforeEach(() => {
  isolateStateDir();
  const root = makeTmpDir("execution-supervisor");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 1" } }));
  workspace = new Workspace(root);
  setPermission(workspace.id, "level1");
  runner = new ControlledRunner();
  supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000, cancelGraceMs: 5_000 });
});

afterEach(async () => {
  for (const job of supervisor.store.listAll()) {
    if (job.state === "running" || job.state === "cancelling") runner.finish(job.jobId, 1);
  }
  await supervisor.shutdown();
});

function approveTestRecipe(): void {
  const repository = resolveRepositoryIdentity(workspace, ".");
  approveTrustedCommand({
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "test",
    target: "test",
    packageManager: "npm",
    localApproval: true,
  });
}

describe("ExecutionSupervisor", () => {
  it("requires local trust, scopes idempotency by client, and prevents cross-client ownership", async () => {
    const input = startInput();
    expect(supervisor.start(input)).toEqual({ ok: false, error: "COMMAND_NOT_APPROVED" });
    approveTestRecipe();

    const started = supervisor.start(input);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    expect(started.job.state).toBe("running");
    expect(supervisor.start(input)).toMatchObject({ ok: true, duplicate: true, job: { jobId: started.job.jobId } });
    expect(supervisor.start(startInput({ timeoutSeconds: 29 }))).toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });
    expect(supervisor.getForClient(started.job.jobId, "another-client")).toBeNull();
    expect(supervisor.listForClient("another-client")).toEqual([]);

    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");
  });

  it("rejects a package script after its approved content changes", () => {
    approveTestRecipe();
    const root = workspace.root;
    write(root, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 2" } }));
    expect(supervisor.start(startInput({ idempotencyKey: "changed-key-0123456789" }))).toEqual({
      ok: false,
      error: "COMMAND_NOT_APPROVED",
    });
  });

  it("runs a separately approved nested repository and rejects a junction path", async () => {
    const nested = path.join(workspace.root, "nested-project");
    fs.mkdirSync(nested);
    makeGitRepo(nested);
    write(nested, "package.json", JSON.stringify({ name: "nested-fixture", scripts: { test: "node -e 1" } }));
    const repository = resolveRepositoryIdentity(workspace, "nested-project");
    approveTrustedCommand({
      workspaceId: workspace.id,
      repositoryIdentity: repository.identity,
      canonicalRepositoryPath: repository.canonicalPath,
      kind: "test",
      target: "test",
      packageManager: "npm",
      localApproval: true,
    });

    const started = supervisor.start(startInput({ repositoryPath: "nested-project" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");

    fs.symlinkSync(nested, path.join(workspace.root, "nested-alias"), "junction");
    expect(supervisor.start(startInput({ repositoryPath: "nested-alias", idempotencyKey: "junction-key-0123456789" }))).toEqual({
      ok: false,
      error: "REPARSE_POINT",
    });
  });

  it("does not preserve trust when a different repository replaces the approved path", () => {
    approveTestRecipe();
    const originalPath = workspace.root;
    fs.renameSync(originalPath, `${originalPath}-preserved`);
    fs.mkdirSync(originalPath);
    makeGitRepo(originalPath);
    write(originalPath, "package.json", JSON.stringify({ name: "execution-fixture", scripts: { test: "node -e 1" } }));

    expect(supervisor.start(startInput({ idempotencyKey: "replacement-key-012345" }))).toEqual({
      ok: false,
      error: "COMMAND_NOT_APPROVED",
    });
  });

  it("stops starts after permission downgrade and reconciles a running job through cancellation", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput());
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    setPermission(workspace.id, "readonly");
    supervisor.reconcilePermission();
    expect(runner.runs.get(started.job.jobId)?.cancelCount).toBe(1);
    expect(supervisor.start(startInput({ idempotencyKey: "readonly-key-0123456" }))).toEqual({
      ok: false,
      error: "EXECUTION_PERMISSION_DENIED",
    });
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");
  });

  it("lets a timeout win when it races a pending client cancellation", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ timeoutSeconds: 1 }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    expect(supervisor.cancel(started.job.jobId, "execution-test-client").ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "timed_out");
  });
});
