import { randomBytes } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import { Workspace } from "../src/workspace/manager.js";
import { setPermission } from "../src/permission/store.js";
import { makeGitRepo, makeTmpDir, write, isolateStateDir } from "./helpers.js";

interface ExecutionJobView { job_id: string; state: string }

class CountingRunner implements ExecutionRunner {
  starts: string[] = [];
  private readonly resolves = new Map<string, (value: NativeRunnerCompletion) => void>();

  start(request: Parameters<ExecutionRunner["start"]>[0], _callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    this.starts.push(request.jobId);
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.resolves.set(request.jobId, resolve);
    return { completion, cancel: () => undefined, abandon: () => undefined };
  }

  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"]): void {
    this.resolves.get(jobId)?.({ result: { outcome, exitCode: 0, win32Error: 0 }, helperExitCode: 0 });
  }
}

function persistedRunningJob(workspaceId: string, repositoryIdentity: string, clientId: string): ExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity,
    repositoryPath: ".",
    oauthClientId: clientId,
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    timeoutSeconds: 30,
    idempotencyKeyHash: "c".repeat(64),
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

describe("Bridge execution restart reconciliation", () => {
  it("interrupts old jobs without attaching or rerunning them and rejects late cancellation", async () => {
    isolateStateDir();
    const root = makeTmpDir("execution-bridge-restart");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "restart-fixture", scripts: { test: "node -e 1" } }));
    const workspace = new Workspace(root);
    const repository = resolveRepositoryIdentity(workspace, ".");
    const oldJob = persistedRunningJob(workspace.id, repository.identity, "restart-client");

    const store = new ExecutionJobStore(workspace.id);
    store.create({ ...oldJob, state: "queued", startedAt: null });
    store.replace(oldJob);

    const runner = new CountingRunner();
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("execution-restart-auth"), "auth.json"),
      executionRunner: runner,
    });
    const token = bridge.authStore.issueTokens({
      clientId: "restart-client",
      scopes: ["execution.jobs.read", "execution.run", "execution.cancel"],
    }).accessToken;
    const client = new Client({ name: "execution-restart-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));

    try {
      const recovered = bridge.executionSupervisor.getForClient(oldJob.jobId, "restart-client");
      expect(recovered).toMatchObject({ state: "interrupted", failureCode: "BRIDGE_RESTARTED" });
      expect(runner.starts).toEqual([]);

      const lateCancel = await client.callTool({ name: "execution_cancel", arguments: { job_id: oldJob.jobId } });
      expect(lateCancel.isError).toBe(true);
      const lateCancelContent = lateCancel.content as { type: string; text: string }[];
      expect(JSON.parse(lateCancelContent[0].text)).toMatchObject({ error: "CANCEL_NOT_ALLOWED" });
      expect(runner.starts).toEqual([]);

      setPermission(workspace.id, "level1");
      approveTrustedCommand({
        workspaceId: workspace.id,
        repositoryIdentity: repository.identity,
        canonicalRepositoryPath: repository.canonicalPath,
        kind: "test",
        target: "test",
        packageManager: "npm",
        localApproval: true,
      });
      const started = await client.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "test",
          target: "test",
          timeout_seconds: 30,
          idempotency_key: "restart-new-job-00000001",
        },
      });
      expect(started.isError).not.toBe(true);
      const newJob = (started.structuredContent as { job: ExecutionJobView }).job;
      expect(newJob.job_id).not.toBe(oldJob.jobId);
      expect(newJob.state).toBe("running");
      expect(runner.starts).toEqual([newJob.job_id]);

      const stillOld = await client.callTool({ name: "execution_cancel", arguments: { job_id: oldJob.jobId } });
      expect(stillOld.isError).toBe(true);
      const stillNew = await client.callTool({ name: "execution_status", arguments: { job_id: newJob.job_id } });
      expect((stillNew.structuredContent as { job: ExecutionJobView }).job.state).toBe("running");
      runner.finish(newJob.job_id, 1);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = await client.callTool({ name: "execution_status", arguments: { job_id: newJob.job_id } });
        const job = (status.structuredContent as { job: ExecutionJobView }).job;
        if (job.state === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const finalStatus = await client.callTool({ name: "execution_status", arguments: { job_id: newJob.job_id } });
      expect((finalStatus.structuredContent as { job: ExecutionJobView }).job.state).toBe("cancelled");
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
