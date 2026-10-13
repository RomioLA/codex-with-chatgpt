import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { setPermission } from "../src/permission/store.js";
import { createLevel3Request, approveLevel3Request, setLevel3Enabled, revokeLevel3Request, getLevel3Request } from "../src/execution/level3-approval.js";
import type { NativeRunnerCompletion } from "../src/execution/native-runner.js";
import { isolateStateDir, makeTmpDir, makeGitRepo, write, git } from "./helpers.js";
import { approveGitRepository, previewGitRepositoryApproval } from "../src/git-write/index.js";

class Runner implements ExecutionRunner {
  requests: Array<Parameters<ExecutionRunner["start"]>[0]> = [];
  cancelled = 0;
  finish!: (completion: NativeRunnerCompletion) => void;
  callbacks!: Parameters<ExecutionRunner["start"]>[1];
  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]) {
    this.requests.push(request);
    this.callbacks = callbacks;
    return { completion: new Promise<NativeRunnerCompletion>((resolve) => { this.finish = resolve; }),
      cancel: () => { this.cancelled++; }, abandon: () => undefined };
  }
  done() { this.finish({ result: { outcome: 0, exitCode: 0, win32Error: 0 }, helperExitCode: 0, tempCleanupConfirmed: true }); }
}

function fixture() {
  isolateStateDir(); const root = makeTmpDir("v13-supervisor"); makeGitRepo(root);
  const executable = write(root, "approved-program.exe", "MZ mock executable for injectable-runner authorization test");
  const ws = new Workspace(root); setPermission(ws.id, "level2");
  const runner = new Runner(); const supervisor = new ExecutionSupervisor(ws, { runner, permissionPollMs: 60_000 });
  const spec = { engine: "program" as const, repositoryPath: ".", executable, args: ["--literal", "a & b"], cwd: ".", timeoutSeconds: 30, materials: [] };
  return { ws, runner, supervisor, spec };
}

describe("V1.3 supervisor isolation", () => {
  it("requires review after a started Git failure even when the local state is unchanged", async () => {
    const f = fixture();
    try {
      const policy = { allowedRemotes: [], allowedBranches: ["main"], allowedOperations: ["branch_list" as const] };
      const preview = previewGitRepositoryApproval(f.ws, ".", policy);
      approveGitRepository(f.ws, ".", { ...policy, localApproval: true }, preview.digest);
      const input = { repositoryPath: ".", operation: { kind: "branch_list" as const, expectedHead: null, expectedBranch: "main" },
        timeoutSeconds: 30, oauthClientId: "git-failure-client", scopes: ["git.write"], idempotencyKey: "git-known-failure-0123456789" };
      // The fixture's initialized repository has a real HEAD; take the preview's
      // repository state through Git rather than guessing its commit identity.
      const request = { ...input, operation: { ...input.operation, expectedHead: git(f.ws.root, "rev-parse", "HEAD").trim() } };
      const started = f.supervisor.startGitWrite(request);
      expect(started.ok).toBe(true);
      f.runner.finish({ result: { outcome: 0, exitCode: 7, win32Error: 0 }, helperExitCode: 0, tempCleanupConfirmed: true });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(f.supervisor.startGitWrite(request)).toMatchObject({ ok: true, duplicate: true });
      expect(f.supervisor.startGitWrite({ ...request, idempotencyKey: "git-fresh-key-0123456789" })).toMatchObject({ ok: false, error: "GIT_REVIEW_REQUIRED" });
    } finally { await f.supervisor.shutdown(); }
  });
  it("deduplicates explicit and discovered script aliases and rejects UNC executable paths", async () => {
    const f = fixture();
    try {
      setLevel3Enabled(f.ws.id, true, true);
      write(f.ws.root, "entry.js", "approved script");
      const record = createLevel3Request(f.ws, "owner", { ...f.spec, args: ["entry.js"], materials: ["./entry.js"] });
      expect(getLevel3Request(f.ws.id, record.requestId)?.snapshot.materials).toHaveLength(1);
      if (process.platform === "win32") expect(() => createLevel3Request(f.ws, "owner", { ...f.spec, executable: String.raw`\\unreachable-host\share\program.exe` })).toThrow("INVALID_ARGUMENTS");
    } finally { await f.supervisor.shutdown(); }
  });
  it("rejects known shell aliases and credential literals even beside a redaction placeholder", async () => {
    const f = fixture();
    try {
      setLevel3Enabled(f.ws.id, true, true);
      const shell = write(f.ws.root, "cmd.exe", "MZ mock shell");
      expect(() => createLevel3Request(f.ws, "owner", { ...f.spec, executable: shell })).toThrow("INVALID_ARGUMENTS");
      expect(() => createLevel3Request(f.ws, "owner", { ...f.spec, args: ["[REDACTED] ghp_" + "a".repeat(36)] })).toThrow("INVALID_ARGUMENTS");
      expect(createLevel3Request(f.ws, "owner", { ...f.spec, args: [String.raw`C:\Users\developer\project`] }).status).toBe("pending");
    } finally { await f.supervisor.shutdown(); }
  });
  it("level2 and V1.2 scope never authorize Level 3; only one exact approval launches", async () => {
    const f = fixture();
    try {
      const input = { requestId: "not-yet-approved-0123456789", digest: "a".repeat(64), oauthClientId: "owner", scopes: ["execution.run"], idempotencyKey: "v13-idempotency-012345" };
      expect(f.supervisor.startLevel3(input)).toEqual({ ok: false, error: "INSUFFICIENT_SCOPE" });
      expect(f.runner.requests).toHaveLength(0);
      setLevel3Enabled(f.ws.id, true, true);
      const request = createLevel3Request(f.ws, "owner", f.spec);
      const exact = { ...input, requestId: request.requestId, digest: request.digest, scopes: ["execution.level3"] };
      expect(f.supervisor.startLevel3(exact)).toMatchObject({ ok: false, error: "LEVEL3_REQUEST_NOT_APPROVED" });
      approveLevel3Request(f.ws, request.requestId, request.digest, true, { risk: "development" });
      expect(f.supervisor.startLevel3({ ...exact, oauthClientId: "other" })).toMatchObject({ ok: false, error: "LEVEL3_CLIENT_MISMATCH" });
      const started = f.supervisor.startLevel3(exact);
      expect(started.ok).toBe(true);
      expect(f.runner.requests).toHaveLength(1);
      expect(f.runner.requests[0].genericCommand?.args).toEqual(f.spec.args);
      f.runner.callbacks.onOutput("stdout", Buffer.from("-----BEGIN PRIVATE KEY-----", "utf16le"));
      if (started.ok) expect(f.supervisor.readOutputForClient(started.job.jobId, "owner", "stdout")).toMatchObject({ ok: false, error: "OUTPUT_RESTRICTED" });
      expect(f.supervisor.startLevel3(exact)).toMatchObject({ ok: true, duplicate: true });
      expect(f.supervisor.startLevel3({ ...exact, idempotencyKey: "different-key-0123456789" })).toMatchObject({ ok: false, error: "LEVEL3_REQUEST_ALREADY_USED" });
      f.runner.done(); await new Promise((resolve) => setTimeout(resolve, 20));
    } finally { await f.supervisor.shutdown(); }
  });

  it("revocation cancels the already running exact request", async () => {
    const f = fixture();
    try {
      setLevel3Enabled(f.ws.id, true, true);
      const request = createLevel3Request(f.ws, "owner", f.spec);
      approveLevel3Request(f.ws, request.requestId, request.digest, true, { risk: "development" });
      const started = f.supervisor.startLevel3({ requestId: request.requestId, digest: request.digest, oauthClientId: "owner", scopes: ["execution.level3"], idempotencyKey: "revoke-key-0123456789" });
      expect(started.ok).toBe(true);
      revokeLevel3Request(f.ws.id, request.requestId, true);
      f.supervisor.reconcilePermission();
      expect(f.runner.cancelled).toBe(1);
      f.runner.done(); await new Promise((resolve) => setTimeout(resolve, 20));
      if (started.ok) expect(f.supervisor.store.get(started.job.jobId)?.state).toBe("cancelled");
    } finally { await f.supervisor.shutdown(); }
  });
});
