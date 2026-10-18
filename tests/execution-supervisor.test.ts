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

  async emit(jobId: string, stream: OutputStream, value: string): Promise<void> {
    await this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(value, "utf8"));
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

function fullAccessInput(overrides: Partial<Parameters<ExecutionSupervisor["startFullAccess"]>[0]> = {}) {
  return {
    engine: "program" as const,
    executable: process.execPath,
    args: [],
    cwd: workspace.root,
    timeoutSeconds: 30,
    idempotencyKey: "full-access-test-0123456789",
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
  it("requires an existing level2 grant and does not promote readonly or level1", async () => {
    setPermission(workspace.id, "readonly");
    expect(await supervisor.startFullAccess(fullAccessInput({ idempotencyKey: "full-access-readonly-0001" })))
      .toEqual({ ok: false, error: "FULL_ACCESS_REQUIRED" });
    setPermission(workspace.id, "level1");
    expect(await supervisor.startFullAccess(fullAccessInput({ idempotencyKey: "full-access-level1-00001" })))
      .toEqual({ ok: false, error: "FULL_ACCESS_REQUIRED" });
    expect(runner.runs.size).toBe(0);
  });

  it("creates repo-independent Full Access jobs and keeps idempotency and output protection", async () => {
    setPermission(workspace.id, "level2");
    const hostCwd = makeTmpDir("full-access-outside-workspace");
    const input = fullAccessInput({ cwd: hostCwd });
    const started = await supervisor.startFullAccess(input);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const jobId = started.job.jobId;
    const running = await waitForState(jobId, "running");
    expect(running).toMatchObject({
      executionContext: "host",
      repositoryIdentity: null,
      repositoryPath: null,
      recipe: null,
      authorization: { type: "full_access", permissionMode: "level2" },
      fullAccessCommand: { engine: "program", cwd: hostCwd },
    });
    expect(runner.runs.get(jobId)).toBeDefined();

    const duplicate = await supervisor.startFullAccess(input);
    expect(duplicate).toMatchObject({ ok: true, duplicate: true, job: { jobId } });
    expect(await supervisor.startFullAccess({ ...input, args: ["different"] }))
      .toEqual({ ok: false, error: "IDEMPOTENCY_CONFLICT" });

    await runner.runs.get(jobId)!.callbacks.onOutput("stdout", Buffer.from("token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"));
    await runner.runs.get(jobId)!.callbacks.onOutput("stderr", Buffer.from("-----BEGIN "));
    await runner.runs.get(jobId)!.callbacks.onOutput("stderr", Buffer.from("RSA PRIVATE KEY-----\nsecret\n"));
    runner.finish(jobId, 0);
    await waitForState(jobId, "succeeded");
    const stdout = supervisor.readOutputForClient(jobId, "execution-test-client", "stdout");
    expect(stdout.ok).toBe(true);
    if (stdout.ok) {
      expect(stdout.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
      expect(stdout.text).toContain("[REDACTED]");
    }
    expect(supervisor.readOutputForClient(jobId, "execution-test-client", "stderr"))
      .toEqual({ ok: false, error: "OUTPUT_RESTRICTED" });
  });

  it("cancels a queued or running Full Access job when its level2 session grant is revoked", async () => {
    setPermission(workspace.id, "level2");
    const started = await supervisor.startFullAccess(fullAccessInput({
      idempotencyKey: "full-access-revocation-0001",
    }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await waitForState(started.job.jobId, "running");
    setPermission(workspace.id, "level1");
    supervisor.reconcilePermission();
    expect(runner.runs.get(started.job.jobId)?.cancelCount).toBe(1);
    expect(supervisor.store.get(started.job.jobId)?.state).toBe("cancelling");
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");
  });

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

  it("flushes stdout and stderr tails before completing a job", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-complete-0123456" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stdout", "stdout-final-fragment");
    await runner.emit(started.job.jobId, "stderr", "stderr-final-fragment");

    runner.finish(started.job.jobId, 0, 0);
    await waitForState(started.job.jobId, "succeeded");

    expect(supervisor.store.readOutput(started.job.jobId, "stdout")).toMatchObject({ ok: true, eof: true, text: "stdout-final-fragment" });
    expect(supervisor.store.readOutput(started.job.jobId, "stderr")).toMatchObject({ ok: true, eof: true, text: "stderr-final-fragment" });
  });

  it("waits for an in-flight output callback and flushes it before completion", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-racing-output-0123" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const payload = "p".repeat(512 * 1024);
    const outputPending = runner.emit(started.job.jobId, "stdout", payload);
    runner.finish(started.job.jobId, 0, 0);

    await waitForState(started.job.jobId, "succeeded");
    await outputPending;
    expect(supervisor.store.get(started.job.jobId)?.stdout.totalBytes).toBe(payload.length);
    expect(supervisor.store.readOutput(started.job.jobId, "stdout", 0)).toMatchObject({
      ok: true,
      text: "p".repeat(64 * 1024),
    });
    expect(supervisor.store.readOutput(started.job.jobId, "stdout", payload.length - 32, 32)).toMatchObject({
      ok: true,
      eof: true,
      text: "p".repeat(32),
    });
  });

  it("flushes accepted output when a running job is cancelled", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-cancel-0123456" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stdout", "cancel-final-fragment");

    expect(supervisor.cancel(started.job.jobId, "execution-test-client").ok).toBe(true);
    runner.finish(started.job.jobId, 1);
    await waitForState(started.job.jobId, "cancelled");

    expect(supervisor.store.readOutput(started.job.jobId, "stdout")).toMatchObject({ ok: true, eof: true, text: "cancel-final-fragment" });
  });

  it("flushes accepted output before shutdown completes", async () => {
    approveTestRecipe();
    const started = supervisor.start(startInput({ idempotencyKey: "flush-shutdown-012345" }));
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    await runner.emit(started.job.jobId, "stderr", "shutdown-final-fragment");

    const shuttingDown = supervisor.shutdown();
    runner.finish(started.job.jobId, 1);
    await shuttingDown;

    expect(supervisor.store.readOutput(started.job.jobId, "stderr")).toMatchObject({ ok: true, eof: true, text: "shutdown-final-fragment" });
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
