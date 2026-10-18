import { randomUUID, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionJob } from "../src/execution/job-types.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import { nullLogger } from "../src/logger/index.js";
import { makeGitRepo, makeTmpDir } from "./helpers.js";

class TraceResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableFinished = false;
  readonly headers = new Map<string, string>();
  body: unknown;

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  status(value: number): this {
    this.statusCode = value;
    return this;
  }

  json(value: unknown): this {
    this.body = value;
    this.headersSent = true;
    return this;
  }

  end(): this {
    this.headersSent = true;
    this.writableFinished = true;
    this.emit("finish");
    return this;
  }
}

async function freshTrace(enabled: boolean) {
  vi.resetModules();
  vi.stubEnv("C2C_EVENT_LOOP_TRACE", enabled ? "1" : "");
  return import("../src/diagnostics/event-loop-trace.js");
}

function makeExecutionJob(workspaceId: string): ExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: "trace-test-client",
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    tempOwnership: null,
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

afterEach(async () => {
  vi.stubEnv("C2C_EVENT_LOOP_TRACE", "");
  try {
    const trace = await import("../src/diagnostics/event-loop-trace.js");
    trace.recordEventLoopTrace("http_received");
  } catch {
    // A test cleanup failure must not hide the assertion that failed first.
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("event-loop trace instrumentation", () => {
  it("keeps tracing off without a timer or response changes", async () => {
    const trace = await freshTrace(false);
    const { createMcpHttpHandler } = await import("../src/mcp/http.js");
    const response = new TraceResponse();
    const handler = vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockImplementation(async (_request, rawResponse) => {
        (rawResponse as unknown as TraceResponse).json({ result: "unchanged" });
      });
    const server = {
      connect: async () => undefined,
      close: async () => undefined,
    } as unknown as McpServer;

    await createMcpHttpHandler(() => server, nullLogger)(
      { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_info" } } } as Request,
      response as unknown as Response,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ result: "unchanged" });
    expect([...response.headers.keys()]).toEqual(["x-correlation-id"]);
    expect(response.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(trace.getEventLoopTraceSnapshot()).toMatchObject({ enabled: false, events: [], droppedEvents: 0, metricsActive: false });
  });

  it("correlates health and MCP spans and samples delay plus ELU", async () => {
    const trace = await freshTrace(true);
    const { createMcpHttpHandler } = await import("../src/mcp/http.js");
    const registeredHandlers = new Map<string, (request: unknown, extra: unknown) => unknown | Promise<unknown>>();
    registeredHandlers.set("tools/call", async () => ({ content: [{ type: "text", text: "ok" }] }));
    const server = {
      server: { _requestHandlers: registeredHandlers },
      connect: async () => undefined,
      close: async () => undefined,
    } as unknown as McpServer;
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest").mockImplementation(async (_request, rawResponse) => {
      const callHandler = registeredHandlers.get("tools/call");
      await callHandler?.({ params: { name: "workspace_info", arguments: { token: "token_fixture", secret: "secret_fixture", path: "C:\\sensitive\\private" } } }, {});
      (rawResponse as unknown as TraceResponse).end();
    });

    const healthResponse = new TraceResponse();
    trace.eventLoopTraceMiddleware(
      { path: "/health" } as Request,
      healthResponse as unknown as Response,
      () => {
        trace.recordEventLoopTrace("handler_start");
        healthResponse.end();
      },
    );

    const handler = createMcpHttpHandler(() => server, nullLogger);
    const mcpResponse = new TraceResponse();
    const req = {
      path: "/mcp",
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workspace_info", arguments: { token: "token_fixture", secret: "secret_fixture" } },
      },
    } as Request;
    let pending: Promise<void> | undefined;
    trace.eventLoopTraceMiddleware(req, mcpResponse as unknown as Response, () => {
      trace.recordEventLoopTrace("auth_done", { toolName: "workspace_info" });
      pending = handler(req, mcpResponse as unknown as Response);
    });
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const snapshot = trace.getEventLoopTraceSnapshot();
    const healthEvents = snapshot.events.filter((event) => event.route === "/health");
    const mcpEvents = snapshot.events.filter((event) => event.route === "/mcp");
    expect(healthEvents.map((event) => event.name)).toEqual(["http_received", "handler_start", "response_end"]);
    expect(new Set(healthEvents.map((event) => event.requestId)).size).toBe(1);
    expect(mcpEvents.map((event) => event.name)).toEqual([
      "http_received", "auth_done", "handler_start", "tool_start", "tool_end", "response_end",
    ]);
    expect(new Set(mcpEvents.map((event) => event.requestId)).size).toBe(1);
    expect(mcpEvents.find((event) => event.name === "tool_start")?.toolName).toBe("workspace_info");
    expect(mcpResponse.headers.get("x-correlation-id")).toBe(mcpEvents[0].requestId);
    const metrics = snapshot.events.find((event) => event.name === "event_loop_metrics");
    expect(metrics).toMatchObject({ correlationId: "background" });
    expect(metrics?.p50Ms).toEqual(expect.any(Number));
    expect(metrics?.p95Ms).toEqual(expect.any(Number));
    expect(metrics?.p99Ms).toEqual(expect.any(Number));
    expect(metrics?.maxMs).toEqual(expect.any(Number));
    expect(metrics?.elu).toEqual(expect.any(Number));
    expect(snapshot.estimatedMaxMemoryBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("token_fixture");
    expect(serialized).not.toContain("secret_fixture");
    expect(serialized).not.toContain("sensitive\\private");
  });

  it("wires the health and MCP timeline into the local admin trace snapshot", async () => {
    const trace = await freshTrace(true);
    vi.stubEnv("C2C_STATE_DIR", makeTmpDir("event-loop-bridge-state"));
    const { startBridge } = await import("../src/bridge/server.js");
    const root = makeTmpDir("event-loop-bridge-workspace");
    makeGitRepo(root);
    const runner = { start: () => { throw new Error("unexpected execution start"); } } as unknown as ExecutionRunner;
    const authFile = path.join(makeTmpDir("event-loop-bridge-auth"), "store.json");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: authFile,
      executionRunner: runner,
    });

    try {
      const healthResponse = await fetch(`${bridge.localBaseUrl()}/health`);
      expect(healthResponse.status).toBe(200);
      const healthPayload = await healthResponse.json() as Record<string, unknown>;
      expect(healthPayload.status).toBe("ok");
      expect(Object.keys(healthPayload).sort()).toEqual(["service", "status", "version", "workspaceId"]);

      const token = bridge.authStore.issueTokens({ clientId: "event-loop-trace-client", scopes: ["workspace.read"] }).accessToken;
      const mcpResponse = await fetch(`${bridge.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "workspace_info", arguments: {} },
        }),
      });
      expect(mcpResponse.status).toBe(200);
      expect(mcpResponse.headers.get("x-correlation-id")).toMatch(/^[0-9a-f-]{36}$/i);
      await mcpResponse.arrayBuffer();

      const traceUrl = `${bridge.localBaseUrl()}/admin/event-loop-trace`;
      expect((await fetch(traceUrl)).status).toBe(404);
      const snapshotResponse = await fetch(traceUrl, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json() as Awaited<ReturnType<typeof trace.getEventLoopTraceSnapshot>>;
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.events.some((event) => event.route === "/health" && event.name === "http_received")).toBe(true);
      expect(snapshot.events.some((event) => event.route === "/mcp" && event.name === "auth_done")).toBe(true);
      expect(snapshot.events.some((event) => event.route === "/mcp" && event.name === "tool_start" && event.toolName === "workspace_info")).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain(token);
    } finally {
      await bridge.close();
    }
  });

  it("bounds the ring, drops oldest events, and contains trace collection failures", async () => {
    const trace = await freshTrace(true);
    for (let index = 0; index < trace.MAX_TRACE_EVENTS + 3; index += 1) {
      trace.recordEventLoopTrace("http_received");
    }
    trace.recordEventLoopTrace("git_sync_start", {
      operationClass: "status",
      token: "token_fixture",
      command: "git status --show-secret",
      absolutePath: "C:\\sensitive\\private",
      stdout: "stdout_fixture",
    } as never);

    const hostileFields = Object.defineProperty({}, "toolName", {
      get() { throw new Error("secret_fixture"); },
    });
    expect(() => trace.recordEventLoopTrace("http_received", hostileFields as never)).not.toThrow();
    const wallClockFailure = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
      throw new Error("secret_fixture");
    });
    expect(() => trace.recordEventLoopTrace("http_received")).not.toThrow();
    wallClockFailure.mockRestore();

    const snapshot = trace.getEventLoopTraceSnapshot();
    expect(snapshot.events).toHaveLength(trace.MAX_TRACE_EVENTS);
    expect(snapshot.droppedEvents).toBe(4);
    expect(snapshot.events[0].monotonicMs).toBeLessThan(snapshot.events.at(-1)!.monotonicMs);
    expect(snapshot.events.every((event) => JSON.stringify(event).length <= snapshot.maxEventChars)).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("token_fixture");
    expect(serialized).not.toContain("secret_fixture");
    expect(serialized).not.toContain("show-secret");
    expect(serialized).not.toContain("absolutePath");
    expect(serialized).not.toContain("stdout_fixture");
    expect(serialized).not.toContain("C:\\sensitive\\private");
  });

  it("records safe Git and Job Output spans while preserving query and output results", async () => {
    const trace = await freshTrace(false);
    const gitRoot = makeTmpDir("event-loop-git");
    makeGitRepo(gitRoot);
    const { resolveGitExecutable } = await import("../src/git-write/security.js");
    const { runGit } = await import("../src/workspace/git.js");
    vi.stubEnv("C2C_TRUSTED_GIT_EXECUTABLE", resolveGitExecutable().path);
    const args = Object.freeze(["status", "--porcelain"]) as unknown as string[];
    const withoutTrace = runGit(gitRoot, args);
    expect(trace.getEventLoopTraceSnapshot().events).toEqual([]);

    vi.stubEnv("C2C_EVENT_LOOP_TRACE", "1");
    const withTrace = runGit(gitRoot, args);
    expect(withTrace).toEqual(withoutTrace);
    expect(args).toEqual(["status", "--porcelain"]);
    const { ExecutionJobStore } = await import("../src/execution/job-store.js");
    const directory = makeTmpDir("event-loop-output");
    const store = new ExecutionJobStore("trace-output-workspace", { directory });
    const job = makeExecutionJob("trace-output-workspace");
    store.create(job);
    const output = "OUTPUT_SECRET_fixture\n";
    await store.appendSanitized(job.jobId, "stderr", output);
    await store.flushOutput(job.jobId);
    expect(store.readOutput(job.jobId, "stderr")).toMatchObject({ ok: true, text: output });

    const snapshot = trace.getEventLoopTraceSnapshot();
    expect(snapshot.events.map((event) => event.name)).toEqual(expect.arrayContaining([
      "git_sync_start", "git_sync_end", "job_output_persist_start", "job_output_persist_end",
    ]));
    expect(snapshot.events.filter((event) => event.name === "git_sync_start").map((event) => event.operationClass))
      .toEqual(expect.arrayContaining(["config", "status"]));
    const outputStart = snapshot.events.find((event) => event.name === "job_output_persist_start");
    expect(outputStart).toMatchObject({ streamType: "stderr", incomingChunkBytes: Buffer.byteLength(output) });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("OUTPUT_SECRET_fixture");
    expect(serialized).not.toContain(gitRoot);
    expect(serialized).not.toContain("--porcelain");
    expect(serialized).not.toContain("C2C_TRUSTED_GIT_EXECUTABLE");
  });

  it("records permission polling as background work without changing exceptions", async () => {
    const trace = await freshTrace(true);
    const stateDirectory = makeTmpDir("event-loop-permission-state");
    vi.stubEnv("C2C_STATE_DIR", stateDirectory);
    const root = makeTmpDir("event-loop-permission-workspace");
    makeGitRepo(root);
    const [{ Workspace }, { ExecutionSupervisor }, { setPermission }] = await Promise.all([
      import("../src/workspace/manager.js"),
      import("../src/execution/supervisor.js"),
      import("../src/permission/store.js"),
    ]);
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
    const runner = { start: () => { throw new Error("unexpected execution start"); } } as unknown as ExecutionRunner;
    const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
    const requestId = randomUUID();
    try {
      trace.runWithEventLoopTraceContext({ requestId, route: "/mcp" }, () => supervisor.reconcilePermission());
    } finally {
      await supervisor.shutdown();
    }

    const permissionEvents = trace.getEventLoopTraceSnapshot().events.filter((event) => event.name.startsWith("permission_poll_"));
    expect(permissionEvents.map((event) => event.name)).toEqual(["permission_poll_start", "permission_poll_end"]);
    expect(permissionEvents.every((event) => event.correlationId === "background" && event.requestId === undefined)).toBe(true);
    expect(permissionEvents[1].durationMs).toEqual(expect.any(Number));
    expect(permissionEvents[1].resultCategory).toBe("success");
  });

  it("does not let span finalization replace an operation failure", async () => {
    const trace = await freshTrace(true);
    const failure = new Error("operation_fixture");
    const end = trace.beginEventLoopTraceSpan("tool", { toolName: "workspace_info" });
    let observed: unknown;
    try {
      throw failure;
    } catch (error) {
      observed = error;
    } finally {
      end({ resultCategory: "failure" });
    }
    expect(observed).toBe(failure);
  });
});
