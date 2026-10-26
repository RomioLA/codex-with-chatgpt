import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { startBridge, type BridgeInstance } from "../src/bridge/server.js";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import type { NativeRunnerCompletion } from "../src/execution/native-runner.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { restoreWorkspace } from "../src/process/recovery.js";
import { nullLogger } from "../src/logger/index.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { setPermission } from "../src/permission/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

async function connect(bridge: BridgeInstance, token: string): Promise<Client> {
  const client = new Client({ name: "stage2-recovered-query", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

describe("recovered Job and Task queries over MCP", () => {
  it("retains existing OAuth ownership after an isolated Bridge restart without replaying a Job", async () => {
    const state = isolateStateDir();
    const root = makeTmpDir("stage2-recovered-query");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
    const repository = resolveRepositoryIdentity(workspace, ".");
    const owner = "stage2-recovery-owner";
    const job: ExecutionJob = {
      jobId: randomBytes(24).toString("base64url"),
      workspaceId: workspace.id,
      repositoryIdentity: repository.identity,
      repositoryPath: ".",
      oauthClientId: owner,
      recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
      state: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      timeoutSeconds: 60,
      idempotencyKeyHash: "c".repeat(64),
      tempOwnership: null,
      exitCode: null,
      failureCode: null,
      stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    };
    const store = new ExecutionJobStore(workspace.id);
    store.create({ ...job, state: "queued", startedAt: null });
    store.replace(job);

    let starts = 0;
    const runner: ExecutionRunner = {
      start() { starts += 1; throw new Error("RECOVERED_JOB_MUST_NOT_BE_REPLAYED"); },
    };
    const options = {
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(state, "stage2-query-auth.json"),
      executionRunner: runner,
    };
    let bridge: BridgeInstance | undefined;
    let client: Client | undefined;
    let otherClient: Client | undefined;
    try {
      bridge = await startBridge(options);
      const scopes = ["workspace.read", "execution.jobs.read"];
      const token = bridge.authStore.issueTokens({ clientId: owner, scopes }).accessToken;
      const otherToken = bridge.authStore.issueTokens({ clientId: "stage2-other-owner", scopes }).accessToken;
      client = await connect(bridge, token);
      const created = await client.callTool({
        name: "task_create",
        arguments: {
          idempotency_key: "stage2-recovered-query-0001",
          plan: {
            version: 1,
            maxDurationMs: 60_000,
            steps: [{ stepId: "read", kind: "batch_read", request: {
              items: [{ id: "hello", path: "hello.txt", maxBytes: 1024 }],
              maxTotalBytes: 1024,
            } }],
          },
        },
      });
      expect(created.isError).not.toBe(true);
      const taskId = (created.structuredContent as { task_id: string }).task_id;
      let stateBeforeRestart: string | undefined;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = await client.callTool({ name: "task_status", arguments: { task_id: taskId } });
        expect(status.isError).not.toBe(true);
        stateBeforeRestart = (status.structuredContent as { state: string }).state;
        if (stateBeforeRestart === "COMPLETED") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(stateBeforeRestart).toBe("COMPLETED");
      await client.close();
      client = undefined;
      await bridge.close();
      bridge = undefined;

      // Reuse the persisted auth and workspace state, rather than pairing again.
      bridge = await startBridge(options);
      client = await connect(bridge, token);
      const recoveredJob = await client.callTool({ name: "execution_status", arguments: { job_id: job.jobId } });
      expect(recoveredJob.isError).not.toBe(true);
      expect((recoveredJob.structuredContent as { job: { state: string; failure_code: string } }).job)
        .toMatchObject({ state: "interrupted", failure_code: "BRIDGE_RESTARTED" });
      const recoveredTask = await client.callTool({ name: "task_status", arguments: { task_id: taskId } });
      expect(recoveredTask.isError).not.toBe(true);
      expect(recoveredTask.structuredContent).toMatchObject({ task_id: taskId, state: "COMPLETED" });

      otherClient = await connect(bridge, otherToken);
      const hiddenJob = await otherClient.callTool({ name: "execution_status", arguments: { job_id: job.jobId } });
      const hiddenTask = await otherClient.callTool({ name: "task_status", arguments: { task_id: taskId } });
      expect(hiddenJob.isError).toBe(true);
      expect(hiddenTask.isError).toBe(true);
      expect(starts).toBe(0);
    } finally {
      await otherClient?.close();
      await client?.close();
      await bridge?.close();
    }
  }, 20_000);
  it("keeps an active Job running when restore reuses its healthy isolated Bridge", async () => {
    isolateStateDir();
    const root = makeTmpDir("stage2-active-job-restore");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "stage2-job", scripts: { test: "node -e 1" } }));
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
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
    let starts = 0;
    let cancels = 0;
    let finish: (() => void) | undefined;
    const runner: ExecutionRunner = {
      start() {
        starts += 1;
        const completion = new Promise<NativeRunnerCompletion>((resolve) => {
          finish = () => resolve({
            result: { outcome: 0, exitCode: 0, win32Error: 0 },
            helperExitCode: 0,
            tempCleanupConfirmed: true,
          });
        });
        return { completion, cancel: () => { cancels += 1; }, abandon: () => undefined };
      },
    };
    const bridge = await startBridge({ workspaceRoot: root, port: 0, executionRunner: runner });
    let client: Client | undefined;
    try {
      const token = bridge.authStore.issueTokens({
        clientId: "stage2-live-job-owner",
        scopes: ["execution.run", "execution.jobs.read"],
      }).accessToken;
      client = await connect(bridge, token);
      const started = await client.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "test",
          target: "test",
          timeout_seconds: 60,
          idempotency_key: "stage2-active-job-restore-0001",
        },
      });
      expect(started.isError).not.toBe(true);
      const jobId = (started.structuredContent as { job: { job_id: string } }).job.job_id;
      const status = () => client!.callTool({ name: "execution_status", arguments: { job_id: jobId } });
      expect((await status()).structuredContent).toMatchObject({ job: { state: "running" } });

      const restored = await restoreWorkspace(root, { logger: nullLogger });
      expect(restored).toMatchObject({ ok: true, bridgeAction: "reused", tunnelAction: "notConfigured" });
      expect((await status()).structuredContent).toMatchObject({ job: { state: "running" } });
      expect(starts).toBe(1);
      expect(cancels).toBe(0);

      finish?.();
      const deadline = Date.now() + 5000;
      let terminalState: string | undefined;
      while (Date.now() < deadline) {
        const result = await status();
        terminalState = (result.structuredContent as { job: { state: string } }).job.state;
        if (terminalState !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(terminalState).toBe("succeeded");
    } finally {
      finish?.();
      await client?.close();
      await bridge.close();
    }
  }, 20_000);

});
