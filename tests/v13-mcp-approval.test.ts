import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { approveLevel3Request, createLevel3Request, getLevel3Request, setLevel3Enabled, type Level3Spec } from "../src/execution/level3-approval.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import type { OutputStream } from "../src/execution/job-types.js";
import { nullLogger } from "../src/logger/index.js";
import { setPermission } from "../src/permission/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { approveGitRepository, previewGitRepositoryApproval } from "../src/git-write/index.js";
import { resolveGitExecutable } from "../src/git-write/security.js";
import { git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const sessionIdentity = vi.hoisted(() => ({ fingerprint: "e".repeat(64) }));
vi.mock("../src/permission/session-identity.js", () => ({
  getCurrentSessionIdentityFingerprint: () => sessionIdentity.fingerprint,
}));

interface CapturedExecution {
  request: Parameters<ExecutionRunner["start"]>[0];
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  resolve: (value: NativeRunnerCompletion) => void;
}

class ControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, CapturedExecution>();
  cancelCalls = 0;

  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { request, callbacks, resolve });
    return {
      completion,
      cancel: () => { this.cancelCalls++; },
      abandon: () => undefined,
    };
  }

  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"]): void {
    this.runs.get(jobId)?.resolve({ result: { outcome, exitCode: 0, win32Error: 0 }, helperExitCode: 0, tempCleanupConfirmed: true });
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function jsonOf<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

function structuredJsonOf<T = Record<string, unknown>>(result: unknown): T {
  const parsed = jsonOf<T>(result);
  expect((result as { structuredContent?: unknown } | null)?.structuredContent).toEqual(parsed);
  return parsed;
}

async function connectClient(name: string, baseUrl: string, accessToken: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

async function waitForState(readState: () => Promise<string>, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await readState() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for execution state ${expected}`);
}

describe("V1.3 Level 3 over authenticated Streamable HTTP", () => {
  let bridge: Bridge | undefined;
  let owner: Client | undefined;
  let other: Client | undefined;
  let legacy: Client | undefined;
  let workspace: Workspace;
  let executable: string;
  let gitExecutable: string;
  let runner: ControlledRunner;
  let originalStateDir: string | undefined;

  beforeAll(async () => {
    originalStateDir = process.env.C2C_STATE_DIR;
    isolateStateDir();
    const root = makeTmpDir("v13-mcp-level3-workspace");
    makeGitRepo(root);
    executable = write(root, "approved-program.exe", "mock executable; injected runner prevents process launch\n");
    gitExecutable = resolveGitExecutable().path;
    write(root, "safe-task.js", "console.log('safe task fixture');\n");
    write(root, "approval-material.txt", "the exact reviewed material\n");
    workspace = new Workspace(root);
    setPermission(workspace.id, "level2");
    runner = new ControlledRunner();

    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("v13-mcp-level3-auth"), "store.json"),
      executionRunner: runner,
      logger: nullLogger,
    });
    const ownerToken = bridge.authStore.issueTokens({
      clientId: "level3-owner-client",
      scopes: ["execution.level3", "execution.jobs.read", "execution.cancel", "git.write"],
    }).accessToken;
    const otherToken = bridge.authStore.issueTokens({
      clientId: "level3-other-client",
      scopes: ["execution.level3"],
    }).accessToken;
    const legacyToken = bridge.authStore.issueTokens({
      clientId: "legacy-execution-client",
      scopes: ["execution.run"],
    }).accessToken;
    owner = await connectClient("level3-owner", bridge.localBaseUrl(), ownerToken);
    other = await connectClient("level3-other", bridge.localBaseUrl(), otherToken);
    legacy = await connectClient("legacy-execution", bridge.localBaseUrl(), legacyToken);
  });

  afterAll(async () => {
    for (const jobId of runner?.runs.keys() ?? []) runner.finish(jobId, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await owner?.close();
    await other?.close();
    await legacy?.close();
    await bridge?.close();
    if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDir;
  });

  it("keeps structured Git jobs behind both scope and a local grant over HTTP", async () => {
    const arguments_ = { repository_path: ".", operation: { kind: "branch_list",
      expectedHead: git(workspace.root, "rev-parse", "HEAD").trim(), expectedBranch: "main" },
      timeout_seconds: 30, idempotency_key: "mcp-git-branch-list-0123456789" };
    const before = runner.runs.size;
    expect(jsonOf(await legacy!.callTool({ name: "git_write", arguments: arguments_ }))).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    expect(jsonOf(await owner!.callTool({ name: "git_write", arguments: arguments_ }))).toMatchObject({ error: "NOT_APPROVED" });
    expect(runner.runs.size).toBe(before);
    const policy = { allowedOperations: ["branch_list" as const], allowedBranches: ["main"], allowedRemotes: [] };
    const preview = previewGitRepositoryApproval(workspace, ".", policy);
    approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest);
    const started = structuredJsonOf<{ job: { job_id: string; recipe: { kind: string }; authorization: { type: string } } }>(
      await owner!.callTool({ name: "git_write", arguments: arguments_ }));
    expect(started.job.recipe.kind).toBe("git_write");
    expect(started.job.authorization.type).toBe("git");
    expect(runner.runs.size).toBe(before + 1);
    expect(runner.runs.get(started.job.job_id)?.request.genericCommand?.args).toContain("for-each-ref");
    runner.finish(started.job.job_id, 0);
    await waitForState(async () => {
      const status = structuredJsonOf<{ job: { state: string; git_result?: { confirmationScope: string } } }>(
        await owner!.callTool({ name: "execution_status", arguments: { job_id: started.job.job_id } }));
      if (status.job.state === "succeeded") expect(status.job.git_result?.confirmationScope).toBe("local_repository");
      return status.job.state;
    }, "succeeded");
    runner.runs.delete(started.job.job_id);
  }, 30_000);

  it.skipIf(process.platform !== "win32")("auto-authorizes safe-development Level 3 requests over MCP without a local approval round-trip", async () => {
    setLevel3Enabled(workspace.id, true, true);
    const noGitWriteToken = bridge!.authStore.issueTokens({
      clientId: "level3-git-no-write-client",
      scopes: ["execution.level3", "execution.jobs.read"],
    }).accessToken;
    const noGitWriteClient = await connectClient("level3-git-no-write", bridge!.localBaseUrl(), noGitWriteToken);
    const requested = structuredJsonOf<{
      request_id: string;
      digest: string;
      state: string;
      approval_required: boolean;
      risk_class: string;
    }>(await noGitWriteClient.callTool({
      name: "level3_request",
      arguments: {
        repository_path: ".",
        engine: "program",
        executable: gitExecutable,
        args: ["add", "--", "safe-task.js"],
        cwd: ".",
        timeout_seconds: 30,
        materials: [],
      },
    }));

    expect(requested.state).toBe("approved");
    expect(requested.approval_required).toBe(false);
    expect(requested.risk_class).toBe("safe-development");
    expect(getLevel3Request(workspace.id, requested.request_id)?.status).toBe("approved");

    const started = structuredJsonOf<{ job: { job_id: string; state: string } }>(await noGitWriteClient.callTool({
      name: "level3_start",
      arguments: {
        request_id: requested.request_id,
        digest: requested.digest,
        idempotency_key: "v132-safe-auto-start-000001",
      },
    }));
    expect(["queued", "running"]).toContain(started.job.state);
    const jobId = started.job.job_id;
    expect(runner.runs.get(jobId)?.request.genericCommand?.args.slice(-3)).toEqual(["add", "--", "safe-task.js"]);
    runner.finish(jobId, 0);
    await waitForState(async () => {
      const status = structuredJsonOf<{ job: { state: string } }>(await noGitWriteClient.callTool({
        name: "execution_status",
        arguments: { job_id: jobId },
      }));
      return status.job.state;
    }, "succeeded");
    runner.runs.delete(jobId);
    await noGitWriteClient.close();
  });

  it("keeps requests inert until local approval and limits status/start authority by client and scope", async () => {
    expect(owner).toBeDefined();
    expect(other).toBeDefined();
    expect(legacy).toBeDefined();
    const ownerClient = owner!;
    const otherClient = other!;
    const legacyClient = legacy!;
    const tools = await ownerClient.listTools();
    expect(tools.tools.filter((tool) => tool.name.startsWith("level3_")).map((tool) => tool.name).sort()).toEqual([
      "level3_request",
      "level3_request_status",
      "level3_start",
    ]);

    setLevel3Enabled(workspace.id, true, true);
    const spec: Level3Spec = {
      engine: "program",
      repositoryPath: ".",
      executable,
      args: ["--literal", "a & b"],
      cwd: ".",
      timeoutSeconds: 30,
      materials: ["approval-material.txt"],
    };
    const requested = structuredJsonOf<{ request_id: string; digest: string; state: string }>(await ownerClient.callTool({
      name: "level3_request",
      arguments: {
        repository_path: spec.repositoryPath,
        engine: spec.engine,
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        timeout_seconds: spec.timeoutSeconds,
        materials: spec.materials,
      },
    }));
    expect(requested.state).toBe("pending");
    expect(runner.runs.size).toBe(0);
    expect(getLevel3Request(workspace.id, requested.request_id)?.status).toBe("pending");

    const ownerStatus = structuredJsonOf<{ state: string }>(await ownerClient.callTool({
      name: "level3_request_status",
      arguments: { request_id: requested.request_id },
    }));
    expect(ownerStatus.state).toBe("pending");

    approveLevel3Request(workspace, requested.request_id, requested.digest, true, { risk: "development" });
    expect(jsonOf(await otherClient.callTool({
      name: "level3_request_status",
      arguments: { request_id: requested.request_id },
    }))).toMatchObject({ error: "NOT_FOUND" });
    expect(jsonOf(await otherClient.callTool({
      name: "level3_start",
      arguments: { request_id: requested.request_id, digest: requested.digest, idempotency_key: "other-client-level3-0001" },
    }))).toMatchObject({ error: "LEVEL3_CLIENT_MISMATCH" });
    expect(jsonOf(await legacyClient.callTool({
      name: "level3_start",
      arguments: { request_id: requested.request_id, digest: requested.digest, idempotency_key: "legacy-scope-level3-00001" },
    }))).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    expect(runner.runs.size).toBe(0);
    expect(getLevel3Request(workspace.id, requested.request_id)?.status).toBe("approved");

    const started = structuredJsonOf<{ job: { job_id: string; state: string } }>(await ownerClient.callTool({
      name: "level3_start",
      arguments: { request_id: requested.request_id, digest: requested.digest, idempotency_key: "owner-level3-start-000001" },
    }));
    const jobId = started.job.job_id;
    expect(started.job.state).toBe("running");
    expect(runner.runs.size).toBe(1);
    expect(runner.runs.get(jobId)?.request.genericCommand?.args).toEqual(spec.args);
    expect(getLevel3Request(workspace.id, requested.request_id)?.status).toBe("launching");

    const cancelled = structuredJsonOf<{ job: { state: string } }>(await ownerClient.callTool({
      name: "execution_cancel",
      arguments: { job_id: jobId },
    }));
    expect(cancelled.job.state).toBe("cancelling");
    expect(runner.cancelCalls).toBe(1);
    const duringCancellation = structuredJsonOf<{ job: { state: string } }>(await ownerClient.callTool({
      name: "execution_status",
      arguments: { job_id: jobId },
    }));
    expect(duringCancellation.job.state).toBe("cancelling");

    runner.finish(jobId, 1);
    await waitForState(async () => {
      const status = structuredJsonOf<{ job: { state: string } }>(await ownerClient.callTool({
        name: "execution_status",
        arguments: { job_id: jobId },
      }));
      return status.job.state;
    }, "cancelled");
    expect(getLevel3Request(workspace.id, requested.request_id)?.status).toBe("failed");
  });
});
