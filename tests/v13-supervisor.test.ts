import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { setPermission } from "../src/permission/store.js";
import { createLevel3Request, approveLevel3Request, setLevel3Enabled, revokeLevel3Request } from "../src/execution/level3-approval.js";
import type { NativeRunnerCompletion } from "../src/execution/native-runner.js";
import { isolateStateDir, makeTmpDir, makeGitRepo, write } from "./helpers.js";

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
