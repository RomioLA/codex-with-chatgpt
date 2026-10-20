import path from "node:path";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { AuthStore } from "../src/auth/store.js";
import { bearerAuth } from "../src/auth/middleware.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createMcpHttpHandler } from "../src/mcp/http.js";
import { SnapshotRegistry } from "../src/workspace/batch.js";
import { nullLogger } from "../src/logger/index.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import type { OutputStream } from "../src/execution/job-types.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { atomicReplace as replaceFileAtomic } from "../src/execution/atomic-replace.js";
import { TaskStore } from "../src/tasks/task-store.js";
import { TaskSupervisor } from "../src/tasks/task-supervisor.js";
import { setPermission } from "../src/permission/store.js";
import { makeGitRepo, makeTmpDir, isolateStateDir, write } from "./helpers.js";

interface PendingRun {
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  resolve: (value: NativeRunnerCompletion) => void;
}

class TaskApiRunner implements ExecutionRunner {
  readonly runs = new Map<string, PendingRun>();
  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { callbacks, resolve });
    return { completion, cancel: () => undefined, abandon: () => undefined };
  }
  async emit(jobId: string, stream: OutputStream, text: string): Promise<void> {
    await this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(text, "utf8"));
  }
  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"] = 0): void {
    this.runs.get(jobId)?.resolve({ result: { outcome, exitCode: 0, win32Error: 0 }, helperExitCode: 0, tempCleanupConfirmed: true });
  }
}

let server: Server;
let baseUrl: string;
let runner: TaskApiRunner;
let root: string;
let workspace: Workspace;
let authStore: AuthStore;
let executionSupervisor: ExecutionSupervisor;
let taskStore: TaskStore;
let taskSupervisor: TaskSupervisor;
let snapshotRegistry: SnapshotRegistry;
let readerToken: string;
let executionToken: string;
let otherToken: string;

async function rpc(token: string, method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  return { status: response.status, text, bytes: Buffer.byteLength(text, "utf8"), body: JSON.parse(text) as any };
}

async function callTool(token: string, name: string, args: Record<string, unknown>, id = 1) {
  return rpc(token, "tools/call", { name, arguments: args }, id);
}

function payload(response: Awaited<ReturnType<typeof callTool>>) {
  return response.body.result?.structuredContent as Record<string, any> | undefined;
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("TASK_MCP_TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForTask(taskId: string, expected: string): Promise<void> {
  await waitUntil(() => taskStore.get(taskId)?.state === expected);
}

beforeEach(async () => {
  isolateStateDir();
  root = makeTmpDir("task-mcp-workspace");
  makeGitRepo(root);
  workspace = new Workspace(root);
  setPermission(workspace.id, "level2");
  runner = new TaskApiRunner();
  authStore = new AuthStore(workspace.id, { file: path.join(makeTmpDir("task-mcp-auth"), "auth.json") });
  executionSupervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
  snapshotRegistry = new SnapshotRegistry();
  taskStore = new TaskStore(workspace.id, {
    atomicReplace(source, destination, expectedNewHash) {
      replaceFileAtomic(source, destination, { expectedNewHash });
    },
  });
  taskSupervisor = new TaskSupervisor(workspace, taskStore, executionSupervisor, {
    snapshotRegistry,
    authorizationValid: (task) => authStore.hasActiveAuthorization(task.ownerClientId, task.authBinding.requiredScopes),
  });
  const app = express();
  const handler = createMcpHttpHandler(() => createMcpServer({
    workspace,
    logger: nullLogger,
    executionSupervisor,
    taskSupervisor,
    snapshotRegistry,
    oauthResourceMetadataUri: `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
  }), nullLogger);
  app.all("/mcp", express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl: () => baseUrl, logger: nullLogger }),
    (req: Request, res: Response) => { void handler(req, res); });
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TASK_MCP_TEST_LISTENER_FAILED");
  baseUrl = `http://127.0.0.1:${address.port}`;
  readerToken = authStore.issueTokens({
    clientId: "task-reader-owner",
    scopes: ["workspace.read", "execution.jobs.read", "execution.cancel"],
  }).accessToken;
  executionToken = authStore.issueTokens({
    clientId: "task-execution-owner",
    scopes: ["workspace.read", "execution.run", "execution.jobs.read", "execution.cancel"],
  }).accessToken;
  otherToken = authStore.issueTokens({
    clientId: "task-other-owner",
    scopes: ["workspace.read", "execution.run", "execution.jobs.read", "execution.cancel"],
  }).accessToken;
});

afterEach(async () => {
  for (const jobId of runner.runs.keys()) runner.finish(jobId, 1);
  await taskSupervisor.shutdown();
  await executionSupervisor.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("C2C Persistent Task API over Streamable HTTP", () => {
  it("registers six proprietary tools with their existing OAuth scope metadata", async () => {
    const response = await rpc(readerToken, "tools/list", {}, 10);
    expect(response.status).toBe(200);
    const tools = response.body.result.tools as Array<{ name: string; securitySchemes?: unknown; _meta?: Record<string, unknown> }>;
    for (const name of ["task_create", "task_status", "task_list", "task_result", "task_output", "task_cancel"]) {
      expect(tools.some((tool) => tool.name === name)).toBe(true);
    }
    expect(tools.find((tool) => tool.name === "task_create")?.securitySchemes).toEqual([{ type: "oauth2", scopes: [] }]);
    for (const name of ["task_status", "task_list", "task_result", "task_output"]) {
      expect(tools.find((tool) => tool.name === name)?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["execution.jobs.read"] }]);
    }
    expect(tools.find((tool) => tool.name === "task_cancel")?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["execution.cancel"] }]);
  });

  it("creates a bounded result snapshot and pages it under 64 KiB with owner-bound cursors", async () => {
    const large = "result-page-".repeat(4_000);
    write(root, "large.txt", large);
    const createdResponse = await callTool(readerToken, "task_create", {
      idempotency_key: "task-result-page-key-0001",
      plan: {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{ stepId: "read", kind: "batch_read", request: {
          items: [{ id: "large", path: "large.txt", maxBytes: 60_000 }], maxTotalBytes: 60_000,
        } }],
      },
    }, 11);
    expect(createdResponse.status).toBe(200);
    const taskId = payload(createdResponse)!.task_id as string;
    await waitForTask(taskId, "COMPLETED");

    let cursor: string | null = null;
    let combined = "";
    let pageCount = 0;
    do {
      const response = await callTool(readerToken, "task_result", {
        task_id: taskId,
        ...(cursor ? { cursor } : {}),
      }, 12 + pageCount);
      expect(response.status).toBe(200);
      expect(response.bytes).toBeLessThanOrEqual(64 * 1024);
      const page = payload(response)!;
      combined += page.result_json_chunk as string;
      cursor = page.next_cursor as string | null;
      pageCount += 1;
      expect(pageCount).toBeLessThan(10);
    } while (cursor);
    expect(pageCount).toBeGreaterThan(1);
    expect(JSON.parse(combined).checkpoints[0].result.results[0].content).toBe(large);

    const wrongOwner = await callTool(otherToken, "task_result", { task_id: taskId }, 30);
    expect(wrongOwner.body.result.isError).toBe(true);
    expect(wrongOwner.text).toContain("TASK_NOT_FOUND_OR_NOT_OWNED");
  });

  it("keeps task_list owner isolated and rejects a cursor from another client", async () => {
    const plan = { version: 1, maxDurationMs: 60_000, steps: [] };
    for (const key of ["task-list-key-owner-a-001", "task-list-key-owner-a-002"]) {
      const created = await callTool(readerToken, "task_create", { idempotency_key: key, plan });
      expect(created.body.result.isError, created.text).not.toBe(true);
    }
    expect(taskStore.listForClient("task-reader-owner")).toHaveLength(2);
    const first = await callTool(readerToken, "task_list", { limit: 1 }, 40);
    expect(first.status).toBe(200);
    const page = payload(first)!;
    expect(page.tasks).toHaveLength(1);
    expect(typeof page.next_cursor).toBe("string");
    const second = await callTool(readerToken, "task_list", { limit: 1, cursor: page.next_cursor }, 41);
    expect(payload(second)?.tasks).toHaveLength(1);

    const otherOwner = await callTool(otherToken, "task_list", { limit: 1, cursor: page.next_cursor }, 42);
    expect(otherOwner.body.result.isError).toBe(true);
    expect(otherOwner.bytes).toBeLessThan(2_000);
  });

  it("does not expose a Task through another workspace's HTTP runtime", async () => {
    const created = await callTool(executionToken, "task_create", {
      idempotency_key: "task-cross-workspace-owner-key-001",
      plan: { version: 1, maxDurationMs: 60_000, steps: [] },
    }, 50);
    expect(created.body.result?.isError).not.toBe(true);
    const taskId = payload(created)?.task_id as string | undefined;
    expect(taskId).toEqual(expect.any(String));
    const secondCreated = await callTool(executionToken, "task_create", {
      idempotency_key: "task-cross-workspace-owner-key-002",
      plan: { version: 1, maxDurationMs: 60_000, steps: [] },
    }, 52);
    expect(secondCreated.body.result?.isError).not.toBe(true);
    const firstPage = await callTool(executionToken, "task_list", { limit: 1 }, 53);
    const cursor = payload(firstPage)?.next_cursor as string | null | undefined;
    expect(cursor).toEqual(expect.any(String));

    const otherRoot = makeTmpDir("task-mcp-other-workspace");
    makeGitRepo(otherRoot);
    const otherWorkspace = new Workspace(otherRoot);
    const otherAuthStore = new AuthStore(otherWorkspace.id, {
      file: path.join(makeTmpDir("task-mcp-other-auth"), "auth.json"),
    });
    const otherRunner = new TaskApiRunner();
    const otherExecutionSupervisor = new ExecutionSupervisor(otherWorkspace, {
      runner: otherRunner,
      permissionPollMs: 60_000,
    });
    const otherSnapshotRegistry = snapshotRegistry;
    const otherTaskSupervisor = new TaskSupervisor(
      otherWorkspace,
      new TaskStore(otherWorkspace.id),
      otherExecutionSupervisor,
      { snapshotRegistry: otherSnapshotRegistry },
    );
    let otherBaseUrl = "";
    const app = express();
    const handler = createMcpHttpHandler(() => createMcpServer({
      workspace: otherWorkspace,
      logger: nullLogger,
      executionSupervisor: otherExecutionSupervisor,
      taskSupervisor: otherTaskSupervisor,
      snapshotRegistry: otherSnapshotRegistry,
      oauthResourceMetadataUri: `${otherBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    }), nullLogger);
    app.all("/mcp", express.json({ limit: "8mb" }),
      bearerAuth({ store: otherAuthStore, workspaceId: otherWorkspace.id, getBaseUrl: () => otherBaseUrl, logger: nullLogger }),
      (req: Request, res: Response) => { void handler(req, res); });
    const otherServer = await new Promise<Server>((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    const address = otherServer.address();
    if (!address || typeof address === "string") throw new Error("TASK_MCP_OTHER_WORKSPACE_LISTENER_FAILED");
    otherBaseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const otherToken = otherAuthStore.issueTokens({
        clientId: "task-execution-owner",
        scopes: ["workspace.read", "execution.run", "execution.jobs.read", "execution.cancel"],
      }).accessToken;
      const response = await fetch(`${otherBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${otherToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 51,
          method: "tools/call",
          params: { name: "task_status", arguments: { task_id: taskId } },
        }),
      });
      const result = await response.json() as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(response.status).toBe(200);
      expect(result.result?.isError).toBe(true);
      expect(JSON.stringify(result.result)).toContain("TASK_NOT_FOUND_OR_NOT_OWNED");
      expect(JSON.stringify(result.result)).not.toContain(taskId);

      const cursorResponse = await fetch(`${otherBaseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${otherToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 54,
          method: "tools/call",
          params: { name: "task_list", arguments: { limit: 1, cursor } },
        }),
      });
      const cursorResult = await cursorResponse.json() as { result?: { isError?: boolean } };
      expect(cursorResponse.status).toBe(200);
      expect(cursorResult.result?.isError).toBe(true);
      expect(JSON.stringify(cursorResult.result)).not.toContain(taskId);
    } finally {
      await otherTaskSupervisor.shutdown();
      await otherExecutionSupervisor.shutdown();
      await new Promise<void>((resolve) => otherServer.close(() => resolve()));
    }
  });

  it("routes Task output through JobStore and caps the real HTTP response page", async () => {
    const createdResponse = await callTool(executionToken, "task_create", {
      idempotency_key: "task-output-page-key-0001",
      plan: {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{ stepId: "command", kind: "execution", command: {
          engine: "program", executable: process.execPath, args: ["-e", "process.stdout.write('x')"], cwd: root,
        }, timeoutSeconds: 30 }],
      },
    }, 50);
    const taskId = payload(createdResponse)!.task_id as string;
    await waitUntil(() => runner.runs.size === 1);
    const jobId = [...runner.runs.keys()][0]!;
    await runner.emit(jobId, "stdout", "x".repeat(70_000));
    runner.finish(jobId, 0);
    await waitForTask(taskId, "COMPLETED");

    const response = await callTool(executionToken, "task_output", {
      task_id: taskId, step_id: "command", stream: "stdout", offset: 0, max_bytes: 64 * 1024,
    }, 51);
    expect(response.status).toBe(200);
    expect(response.bytes).toBeLessThanOrEqual(64 * 1024);
    const output = payload(response)!;
    expect(output.text.length).toBeGreaterThan(0);
    expect(output.text.length).toBeLessThanOrEqual(64 * 1024);
    expect(output.text).toMatch(/^x+$/);

    const wrongOwner = await callTool(otherToken, "task_output", {
      task_id: taskId, step_id: "command", stream: "stdout", offset: 0, max_bytes: 128,
    }, 52);
    expect(wrongOwner.body.result.isError).toBe(true);
    expect(wrongOwner.text).toContain("TASK_NOT_FOUND_OR_NOT_OWNED");
  });

  it("waits for a running child to terminate before returning CANCELLED and never starts the next step", async () => {
    const createdResponse = await callTool(executionToken, "task_create", {
      idempotency_key: "task-cancel-race-key-00001",
      plan: {
        version: 1,
        maxDurationMs: 60_000,
        steps: [
          { stepId: "command", kind: "execution", command: {
            engine: "program", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root,
          }, timeoutSeconds: 30 },
          { stepId: "must-not-run", kind: "batch_read", request: { items: [{ id: "hello", path: "hello.txt" }] } },
        ],
      },
    }, 55);
    const taskId = payload(createdResponse)!.task_id as string;
    await waitUntil(() => runner.runs.size === 1);
    const jobId = [...runner.runs.keys()][0]!;
    const cancelResponsePromise = callTool(executionToken, "task_cancel", { task_id: taskId }, 56);
    await waitUntil(() => taskStore.get(taskId)?.state === "CANCELLING" &&
      executionSupervisor.store.get(jobId)?.state === "cancelling");
    expect(taskStore.get(taskId)?.state).toBe("CANCELLING");
    runner.finish(jobId, 0);
    const cancelResponse = await cancelResponsePromise;
    expect(cancelResponse.status).toBe(200);
    expect(payload(cancelResponse)?.state).toBe("CANCELLED");
    expect(taskStore.get(taskId)?.stepStates.map((step) => step.state)).toEqual(["failed", "pending"]);
    expect(executionSupervisor.store.listAll()).toHaveLength(1);
  });

  it("does not expose Task APIs without their existing read or cancel scope", async () => {
    const limitedToken = authStore.issueTokens({
      clientId: "task-limited-owner",
      scopes: ["workspace.read"],
    }).accessToken;
    const denied = await callTool(limitedToken, "task_list", { limit: 1 }, 60);
    expect(denied.body.result.isError).toBe(true);
    expect(denied.text).toContain("INSUFFICIENT_SCOPE");

    const deniedCreate = await callTool(limitedToken, "task_create", {
      idempotency_key: "task-create-missing-run-scope-01",
      plan: {
        version: 1,
        maxDurationMs: 60_000,
        steps: [{ stepId: "command", kind: "execution", command: {
          engine: "program", executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root,
        }, timeoutSeconds: 5 }],
      },
    }, 61);
    expect(deniedCreate.body.result.isError).toBe(true);
    expect(deniedCreate.text).toContain("execution.run");
    expect(deniedCreate.body.result._meta["mcp/www_authenticate"][0]).toContain("scope=\"execution.run\"");
  });
});
