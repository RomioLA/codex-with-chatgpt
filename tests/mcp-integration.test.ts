import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { safeToolName } from "../src/mcp/http.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import type { ExecutionRunner } from "../src/execution/supervisor.js";
import type { OutputStream } from "../src/execution/job-types.js";
import type { NativeRunnerCompletion, NativeRunnerHandle } from "../src/execution/native-runner.js";
import { nullLogger } from "../src/logger/index.js";
import { setPermission } from "../src/permission/store.js";
import { makeTmpDir, write, makeGitRepo, git, isolateStateDir } from "./helpers.js";

let root: string;
let bridge: Bridge;
let client: Client;
let accessToken: string;
let stateDir: string;
let executionToken: string;
let secondExecutionToken: string;
let evidenceFileToken: string;
let evidenceOtherFileToken: string;

interface CapturedExecution {
  callbacks: Parameters<ExecutionRunner["start"]>[1];
  resolve: (value: NativeRunnerCompletion) => void;
}

class McpControlledRunner implements ExecutionRunner {
  readonly runs = new Map<string, CapturedExecution>();

  start(request: Parameters<ExecutionRunner["start"]>[0], callbacks: Parameters<ExecutionRunner["start"]>[1]): NativeRunnerHandle {
    let resolve!: (value: NativeRunnerCompletion) => void;
    const completion = new Promise<NativeRunnerCompletion>((done) => { resolve = done; });
    this.runs.set(request.jobId, { callbacks, resolve });
    return {
      completion,
      cancel: () => undefined,
      abandon: () => undefined,
    };
  }

  emit(jobId: string, stream: OutputStream, value: string): void {
    this.runs.get(jobId)?.callbacks.onOutput(stream, Buffer.from(value, "utf8"));
  }

  finish(jobId: string, outcome: NativeRunnerCompletion["result"]["outcome"]): void {
    this.runs.get(jobId)?.resolve({ result: { outcome, exitCode: 0, win32Error: 0 }, helperExitCode: 0 });
  }
}

interface McpExecutionJob { job_id: string; state: string }

const executionRunner = new McpControlledRunner();

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

function structuredContentOf<T = Record<string, unknown>>(result: unknown): T {
  const structured = (result as { structuredContent?: unknown } | null)?.structuredContent;
  expect(structured).toBeDefined();
  return structured as T;
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("MCP_INTEGRATION_TEST_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectHttpClient(token: string, name: string): Promise<Client> {
  const connected = new Client({ name, version: "1.0.0" });
  await connected.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return connected;
}

function expectToolOutputSchema(
  tools: Awaited<ReturnType<Client["listTools"]>>["tools"],
  name: string,
  properties: string[]
): void {
  const schema = tools.find((tool) => tool.name === name)?.outputSchema as
    | { type?: string; properties?: Record<string, unknown> }
    | undefined;
  expect(schema?.type).toBe("object");
  expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining(properties));
}

beforeAll(async () => {
  stateDir = isolateStateDir();
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, dependencies: { react: "^19.0.0" } }));
  write(root, ".env", "API_KEY=supersecret\n");
  fs.writeFileSync(path.join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  // an uncommitted change so git_diff has content
  write(root, "src/index.ts", "export const answer = 43; // changed\n");

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    executionRunner,
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "it-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  accessToken = tokens.accessToken;
  executionToken = bridge.authStore.issueTokens({
    clientId: "execution-client-a",
    scopes: ["execution.jobs.read", "execution.run", "execution.cancel"],
  }).accessToken;
  secondExecutionToken = bridge.authStore.issueTokens({
    clientId: "execution-client-b",
    scopes: ["execution.jobs.read", "execution.run", "execution.cancel"],
  }).accessToken;
  evidenceFileToken = bridge.authStore.issueTokens({
    clientId: "evidence-file-only",
    scopes: ["workspace.read"],
  }).accessToken;
  evidenceOtherFileToken = bridge.authStore.issueTokens({
    clientId: "evidence-other-file-only",
    scopes: ["workspace.read"],
  }).accessToken;

  client = new Client({ name: "c2c-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  // Retain temporary fixtures; no recursive deletion.
});

describe("MCP tools over Streamable HTTP", () => {
  const executionPolicies = [
    { name: "execution_run", scope: "execution.run", args: { engine: "program", executable: process.execPath, args: [], cwd: ".", timeout_seconds: 30, idempotency_key: "oauth-run-scope-test-00001", wait_seconds: 0 } },
    { name: "execution_start", scope: "execution.run", args: { repository_path: ".", kind: "test", target: "test", timeout_seconds: 30, idempotency_key: "oauth-scope-test-00001" } },
    { name: "execution_status", scope: "execution.jobs.read", args: { job_id: "a".repeat(24) } },
    { name: "execution_job_output", scope: "execution.jobs.read", args: { job_id: "a".repeat(24), stream: "stdout" } },
    { name: "execution_cancel", scope: "execution.cancel", args: { job_id: "a".repeat(24) } },
    { name: "execution_list", scope: "execution.jobs.read", args: { limit: 1 } },
    { name: "level3_request", scope: "execution.level3", args: { repository_path: ".", engine: "program", executable: "C:/test/program.exe", args: [], cwd: ".", timeout_seconds: 30 } },
    { name: "level3_request_status", scope: "execution.level3", args: { request_id: "a".repeat(24) } },
    { name: "level3_start", scope: "execution.level3", args: { request_id: "a".repeat(24), digest: "a".repeat(64), idempotency_key: "v13-scope-key-0123456" } },
    { name: "git_write", scope: "git.write", args: { repository_path: ".", operation: { kind: "branch_list", expectedHead: null, expectedBranch: null }, timeout_seconds: 30, idempotency_key: "v13-git-scope-0123456" } },
  ];
  const batchPolicies = [
    { name: "batch_read", scope: "workspace.read" },
    { name: "batch_search", scope: "workspace.search" },
  ];

  it("publishes execution OAuth policies on the actual tools/list wire response", async () => {
    // SDK 1.30's client ToolSchema strips unknown top-level fields, so inspect
    // the real HTTP result as well as the SDK-visible compatibility mirror.
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    const rpc = await response.json() as { result: { tools: { name: string; title?: string; description?: string; securitySchemes?: unknown; _meta?: Record<string, unknown> }[] } };
    const sdk = await client.listTools();
    for (const { name, scope } of executionPolicies) {
      const schemes = [{ type: "oauth2", scopes: [scope] }];
      const tool = rpc.result.tools.find((tool) => tool.name === name);
      expect(tool?.securitySchemes).toEqual(schemes);
      expect(tool?._meta?.securitySchemes).toEqual(schemes);
      expect(sdk.tools.find((tool) => tool.name === name)?._meta?.securitySchemes).toEqual(schemes);
    }
    const fullAccess = rpc.result.tools.find((tool) => tool.name === "execution_run");
    expect(fullAccess?.title).toBe("Run a generic Full Access command");
    expect(fullAccess?.description).toContain("does not require trusted-command registration or per-command approval");
    const restrictedRecipe = rpc.result.tools.find((tool) => tool.name === "execution_start");
    expect(restrictedRecipe?.title).toBe("Restricted: start a pre-approved package-script recipe");
    expect(restrictedRecipe?.description).toContain("use execution_run");
    const gitCompareSecurity = [{ type: "oauth2", scopes: ["git.read"] }];
    const gitCompare = rpc.result.tools.find((tool) => tool.name === "git_compare");
    expect(gitCompare?.securitySchemes).toEqual(gitCompareSecurity);
    expect(gitCompare?._meta?.securitySchemes).toEqual(gitCompareSecurity);
    expect(sdk.tools.find((tool) => tool.name === "git_compare")?._meta?.securitySchemes).toEqual(gitCompareSecurity);
    for (const { name, scope } of batchPolicies) {
      const schemes = [{ type: "oauth2", scopes: [scope] }];
      const tool = rpc.result.tools.find((tool) => tool.name === name);
      expect(tool?.securitySchemes).toEqual(schemes);
      expect(tool?._meta?.securitySchemes).toEqual(schemes);
      expect(sdk.tools.find((tool) => tool.name === name)?._meta?.securitySchemes).toEqual(schemes);
    }
    const collectEvidence = rpc.result.tools.find((tool) => tool.name === "collect_evidence");
    expect(collectEvidence?.description).toContain("files require workspace.read");
    expect(collectEvidence?.description).toContain("execution_jobs execution.jobs.read");
    expect(collectEvidence?._meta?.["io.romiola.c2c/requiredScopesBySection"]).toEqual({
      files: "workspace.read",
      searches: "workspace.search",
      repositories: "git.read",
      execution_jobs: "execution.jobs.read",
    });
  });

  it.each(executionPolicies)("returns a scope-specific OAuth challenge for old-token $name", async ({ name, scope, args }) => {
    const denied = await client.callTool({ name, arguments: args });
    expect(denied.isError).toBe(true);
    expect(jsonOf(denied)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([
      `Bearer resource_metadata="${bridge.localBaseUrl()}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="This operation requires the '${scope}' scope.", scope="${scope}"`,
    ]);
    expect(textOf(denied)).not.toContain("EXECUTION_UNAVAILABLE");
    const verdict = bridge.authStore.verifyAccessToken(accessToken);
    expect(verdict.ok && verdict.record.scopes).toEqual(["workspace.read", "workspace.search", "git.read", "execution.read"]);
  });

  it("uses trusted resource metadata even with forged Host and forwarded headers", async () => {
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}`, host: "attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "execution_list", arguments: { limit: 1 } } }),
    });
    expect(response.status).toBe(200);
    const rpc = await response.json() as { result: { isError: boolean; _meta: Record<string, string[]> } };
    expect(rpc.result.isError).toBe(true);
    expect(rpc.result._meta["mcp/www_authenticate"][0]).toContain(`resource_metadata="${bridge.localBaseUrl()}/.well-known/oauth-protected-resource/mcp"`);
    expect(JSON.stringify(rpc)).not.toContain("attacker.invalid");
  });

  it("lists read-only tools and explicitly separated permission-gated file tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "batch_read",
      "batch_search",
      "collect_evidence",
      "create_directory",
      "create_external_file",
      "create_file",
      "delete_file",
      "dns_resolve",
      "edit_external_file",
      "edit_file",
      "execution_cancel",
      "execution_job_output",
      "execution_list",
      "execution_output",
      "execution_run",
      "execution_start",
      "execution_status",
      "execution_summary",
      "git_branches",
      "git_compare",
      "git_diff",
      "git_info",
      "git_status",
      "git_write",
      "host_context",
      "level3_request",
      "level3_request_status",
      "level3_start",
      "list_directory",
      "move_file",
      "network_listeners",
      "network_status",
      "path_inspect",
      "permission_status",
      "process_query",
      "process_tree",
      "read_external_file",
      "read_file",
      "read_image",
      "replace_external_file",
      "replace_file",
      "search_workspace",
      "task_cancel",
      "task_create",
      "task_list",
      "task_output",
      "task_result",
      "task_status",
      "test_status",
      "workspace_info",
    ]);
    for (const forbidden of ["write_file", "move_external_file", "delete_external_file", "delete_directory", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git"]);
    expectToolOutputSchema(tools, "batch_read", ["results", "returnedBytes", "sourceBytesScanned", "truncated", "nextCursor"]);
    expectToolOutputSchema(tools, "batch_search", ["queries", "matches", "bytesScanned", "complete", "scanComplete", "resultsComplete", "totalMatches", "nextCursor"]);
    expectToolOutputSchema(tools, "collect_evidence", ["snapshotId", "requestHash", "packageHash", "page", "nextCursor"]);
    expect(JSON.stringify(tools.find((tool) => tool.name === "batch_search")?.outputSchema)).toContain("scanComplete");
    expect(JSON.stringify(tools.find((tool) => tool.name === "batch_search")?.outputSchema)).toContain("resultsComplete");
    expect(JSON.stringify(tools.find((tool) => tool.name === "collect_evidence")?.outputSchema)).toContain("continuationMode");
    expect(JSON.stringify(tools.find((tool) => tool.name === "collect_evidence")?.outputSchema)).toContain("unavailable");
    expect(JSON.stringify(tools.find((tool) => tool.name === "collect_evidence")?.outputSchema)).toContain("nextStartLine");
    expect(tools.find((tool) => tool.name === "collect_evidence")?.description).toContain("continuationMode=byte");
    expect(tools.find((tool) => tool.name === "collect_evidence")?.description).toContain("continuationMode=unavailable");
    expect(safeToolName({ params: { name: "batch_read" } })).toBe("batch_read");
    expect(safeToolName({ params: { name: "batch_search" } })).toBe("batch_search");
    expect(safeToolName({ params: { name: "collect_evidence" } })).toBe("collect_evidence");
    expectToolOutputSchema(tools, "list_directory", ["path", "entries", "total", "hasMore"]);
    expectToolOutputSchema(tools, "read_file", ["path", "content", "contentHash", "startLine", "endLine", "nextStartLine"]);
    expectToolOutputSchema(tools, "read_image", ["path", "sizeBytes", "mimeType"]);
    expectToolOutputSchema(tools, "search_workspace", ["matches", "matchCount", "truncated", "engine"]);
    expectToolOutputSchema(tools, "git_info", ["isRepo", "repositoryPath", "topLevel", "branch", "head", "dirty"]);
    expectToolOutputSchema(tools, "git_status", ["isRepo", "repositoryPath", "topLevel", "branch", "staged", "unstaged", "untracked", "hidden"]);
    expectToolOutputSchema(tools, "git_diff", ["isRepo", "repositoryPath", "topLevel", "mode", "diff", "hasMore", "nextOffset"]);
    expectToolOutputSchema(tools, "test_status", ["available", "tests", "outputAvailable", "outputId"]);
    expectToolOutputSchema(tools, "execution_summary", ["records"]);
    expectToolOutputSchema(tools, "execution_output", ["action", "items", "text"]);
    expectToolOutputSchema(tools, "execution_start", ["job", "duplicate"]);
    expectToolOutputSchema(tools, "execution_run", ["job", "job_id", "state", "exit_code", "duplicate", "stdout_tail", "stderr_tail"]);
    expectToolOutputSchema(tools, "execution_status", ["available", "job"]);
    expectToolOutputSchema(tools, "execution_list", ["jobs"]);
    expectToolOutputSchema(tools, "execution_job_output", ["offset", "next_offset", "oldest_available_offset", "eof", "truncated", "text"]);
    expectToolOutputSchema(tools, "execution_cancel", ["job"]);
    expect(tools.find((tool) => tool.name === "execution_run")?.description)
      .toContain("Preferred local command execution tool for C2C Level 2 Full Access");
    expect(tools.find((tool) => tool.name === "execution_run")?.description)
      .toContain("does not require trusted-command registration or per-command approval");
    expect(tools.find((tool) => tool.name === "execution_start")?.description)
      .toContain("Restricted trusted-recipe execution path");
    expect(tools.find((tool) => tool.name === "execution_start")?.description)
      .toContain("use execution_run");
    expect(tools.find((tool) => tool.name === "level3_request")?.description)
      .toContain("Historical restricted controlled path");
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
  });

  it("calls all three Wave 2 tools over HTTP with partial results and per-section scope checks", async () => {
    const read = structuredContentOf<{
      results: Array<{ id: string; ok: boolean; error?: { code: string } }>;
      returnedBytes: number;
      sourceBytesScanned: number;
      truncated: boolean;
    }>(await client.callTool({
      name: "batch_read",
      arguments: { items: [
        { id: "present", path: "src/index.ts", start_line: 1 },
        { id: "missing", path: "missing-wave2.txt", start_line: 1 },
      ] },
    }));
    expect(read.results.map((item) => item.id)).toEqual(["present", "missing"]);
    expect(read.results[0]).toMatchObject({ ok: true });
    expect(read.results[1]).toMatchObject({ ok: false, error: { code: "FILE_NOT_FOUND" } });
    expect(read.sourceBytesScanned).toBeGreaterThan(0);

    const search = structuredContentOf<{
      queries: Array<{ id: string; complete: boolean; scanComplete: boolean; resultsComplete: boolean; errors: Array<{ code: string }> }>;
      matches: Array<{ id: string; path: string; text: string; untrusted: true }>;
      complete: boolean;
      scanComplete: boolean;
      resultsComplete: boolean;
    }>(await client.callTool({
      name: "batch_search",
      arguments: { queries: [{ id: "answer", query: "answer", mode: "literal", paths: ["src/index.ts"] }] },
    }));
    expect(search.queries.map((query) => query.id)).toEqual(["answer"]);
    expect(search).toMatchObject({ complete: true, scanComplete: true, resultsComplete: true });
    expect(search.queries[0]).toMatchObject({ complete: true, scanComplete: true, resultsComplete: true });
    expect(search.matches.some((match) => match.text.includes("answer") && match.untrusted)).toBe(true);

    const evidence = structuredContentOf<{
      complete: boolean;
      packageHash: string;
      page: { files: Array<{ path: string; ranges: Array<{ continuationMode: string; nextStartLine: number | null }> }>; searches: Array<{ id: string }>; repositories: Array<{ path: string }> };
    }>(await client.callTool({
      name: "collect_evidence",
      arguments: {
        files: [{ id: "file", path: "src/index.ts", ranges: [{ start_line: 1 }] }],
        searches: [{ id: "query", query: "answer", path: "src/index.ts" }],
        repositories: [{ id: "repo", path: "." }],
      },
    }));
    expect(evidence.packageHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.page.files[0]?.path).toBe("src/index.ts");
    expect(evidence.page.files[0]?.ranges[0]).toMatchObject({ continuationMode: "complete", nextStartLine: null });
    expect(evidence.page.searches[0]?.id).toBe("query");
    expect(evidence.page.repositories[0]?.path).toBe(".");

    const fileOnly = await connectHttpClient(evidenceFileToken, "c2c-evidence-file-only");
    try {
      const fileEvidence = structuredContentOf<{ page: { files: Array<{ id: string }> } }>(await fileOnly.callTool({
        name: "collect_evidence",
        arguments: { files: [{ id: "file", path: "package.json", ranges: [{ start_line: 1 }] }] },
      }));
      expect(fileEvidence.page.files.map((item) => item.id)).toEqual(["file:1"]);

      const deniedSearch = await fileOnly.callTool({
        name: "collect_evidence",
        arguments: { searches: [{ id: "query", query: "react", path: "package.json" }] },
      });
      expect(deniedSearch.isError).toBe(true);
      expect(textOf(deniedSearch)).toContain("INSUFFICIENT_SCOPE");
      expect(deniedSearch._meta?.["mcp/www_authenticate"]).toEqual([
        `Bearer resource_metadata="${bridge.localBaseUrl()}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="This operation requires the 'workspace.search' scope.", scope="workspace.search"`,
      ]);

      const deniedBatchSearch = await fileOnly.callTool({
        name: "batch_search",
        arguments: { queries: [{ id: "query", query: "react", mode: "literal" }] },
      });
      expect(deniedBatchSearch.isError).toBe(true);
      expect(textOf(deniedBatchSearch)).toContain("INSUFFICIENT_SCOPE");

      const malformed = await fileOnly.callTool({ name: "batch_read", arguments: { items: [] } });
      expect(malformed.isError).toBe(true);
    } finally {
      await fileOnly.close();
    }

    const deniedJobs = await client.callTool({
      name: "collect_evidence",
      arguments: { execution_jobs: [{ id: "job", job_id: "a".repeat(24) }] },
    });
    expect(deniedJobs.isError).toBe(true);
    expect(deniedJobs._meta?.["mcp/www_authenticate"]).toEqual([
      `Bearer resource_metadata="${bridge.localBaseUrl()}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="This operation requires the 'execution.jobs.read' scope.", scope="execution.jobs.read"`,
    ]);
  });

  it("keeps each complete JSON-RPC HTTP payload within the 256 KiB wire bound", async () => {
    write(root, "wire-read.txt", "r".repeat(64 * 1024));
    write(root, "wire-search.txt", Array.from({ length: 60 }, (_, index) =>
      `needle-${String(index).padStart(3, "0")}-${"s".repeat(480)}`).join("\n"));
    const evidenceFiles = Array.from({ length: 4 }, (_, index) => {
      const filePath = `wire-evidence-${index}.txt`;
      write(root, filePath, "e".repeat(64 * 1024));
      return { id: `file-${index}`, path: filePath, ranges: [{ start_line: 1 }] };
    });
    const calls = [
      {
        name: "batch_read",
        arguments: { items: [{ id: "wire", path: "wire-read.txt", offset_bytes: 0, max_bytes: 64 * 1024 }], max_total_bytes: 64 * 1024 },
      },
      {
        name: "batch_search",
        arguments: { queries: [{ id: "wire", query: "needle", mode: "literal", paths: ["wire-search.txt"], max_matches: 50 }] },
      },
      { name: "collect_evidence", arguments: { files: evidenceFiles } },
    ];
    const responseBytes = new Map<string, number>();

    for (const [index, call] of calls.entries()) {
      const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 100 + index,
          method: "tools/call",
          params: { name: call.name, arguments: call.arguments },
        }),
      });
      const payload = await response.text();
      expect(response.status).toBe(200);
      const bytes = Buffer.byteLength(payload, "utf8");
      responseBytes.set(call.name, bytes);
      expect(bytes).toBeLessThanOrEqual(256 * 1024);

      const rpc = JSON.parse(payload) as {
        result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
      };
      expect(rpc.result?.isError).not.toBe(true);
      expect(rpc.result?.structuredContent).toBeDefined();
      if (call.name === "batch_search") {
        const structured = rpc.result?.structuredContent as {
          complete: boolean;
          scanComplete: boolean;
          resultsComplete: boolean;
          queries: Array<{ complete: boolean; scanComplete: boolean; resultsComplete: boolean; matchesObserved: number }>;
        };
        expect(structured).toMatchObject({ complete: false, scanComplete: true, resultsComplete: false });
        expect(structured.queries[0]).toMatchObject({
          complete: false,
          scanComplete: true,
          resultsComplete: false,
          matchesObserved: 60,
        });
      }
    }

    expect(responseBytes.get("batch_read")).toBeGreaterThan(64 * 1024);
    expect(responseBytes.get("batch_search")).toBeGreaterThan(20 * 1024);
    expect(responseBytes.get("collect_evidence")).toBeGreaterThan(180 * 1024);
  });

  it("keeps batch_read and Evidence cursors alive across stateless HTTP server instances", async () => {
    const batchItems = Array.from({ length: 10 }, (_, index) => {
      const filePath = `batch-page-${index}.txt`;
      write(root, filePath, `${"b".repeat(29_990)}\n`);
      return { id: `batch-${index}`, path: filePath, start_line: 1, max_bytes: 30_000 };
    });
    const batchRequest = { items: batchItems, max_total_bytes: 512 * 1024 };
    const batchPages: Array<{ results: Array<{ id: string }>; nextCursor?: string }> = [];
    const batchWireResponse = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 71, method: "tools/call", params: { name: "batch_read", arguments: batchRequest } }),
    });
    expect(batchWireResponse.status).toBe(200);
    const batchWireBody = await batchWireResponse.text();
    expect(Buffer.byteLength(batchWireBody, "utf8")).toBeLessThanOrEqual(256 * 1024);
    const batchWireResult = (JSON.parse(batchWireBody) as { result: unknown }).result;
    let batchPage = structuredContentOf<typeof batchPages[number]>(batchWireResult);
    expect(((batchWireResult as { content: Array<{ text: string }> }).content[0]?.text.length ?? 0)).toBeLessThan(512);
    batchPages.push(batchPage);
    expect(batchPage.nextCursor).toBeDefined();

    const otherOwner = await connectHttpClient(evidenceOtherFileToken, "c2c-other-cursor-owner");
    try {
      const deniedCursor = await otherOwner.callTool({
        name: "batch_read",
        arguments: { ...batchRequest, cursor: batchPage.nextCursor },
      });
      expect(deniedCursor.isError).toBe(true);
      expect(textOf(deniedCursor)).toContain("CURSOR_INVALID");
    } finally {
      await otherOwner.close();
    }

    while (batchPage.nextCursor) {
      batchPage = structuredContentOf<typeof batchPages[number]>(await client.callTool({
        name: "batch_read",
        arguments: { ...batchRequest, cursor: batchPage.nextCursor },
      }));
      batchPages.push(batchPage);
    }
    expect(batchPages.flatMap((page) => page.results.map((item) => item.id)))
      .toEqual(batchItems.map((item) => item.id));

    const evidenceFiles = Array.from({ length: 10 }, (_, index) => {
      const filePath = `evidence-page-${index}.txt`;
      write(root, filePath, `${"e".repeat(29_990)}\n`);
      return { id: `evidence-${index}`, path: filePath, ranges: [{ start_line: 1 }] };
    });
    const evidenceRequest = { files: evidenceFiles };
    const evidencePages: Array<{ page: { files: Array<{ id: string }> }; nextCursor?: string }> = [];
    const evidenceWireResponse = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 72, method: "tools/call", params: { name: "collect_evidence", arguments: evidenceRequest } }),
    });
    expect(evidenceWireResponse.status).toBe(200);
    const evidenceWireBody = await evidenceWireResponse.text();
    expect(Buffer.byteLength(evidenceWireBody, "utf8")).toBeLessThanOrEqual(256 * 1024);
    const evidenceWireResult = (JSON.parse(evidenceWireBody) as { result: unknown }).result;
    let evidencePage = structuredContentOf<typeof evidencePages[number]>(evidenceWireResult);
    expect(((evidenceWireResult as { content: Array<{ text: string }> }).content[0]?.text.length ?? 0)).toBeLessThan(512);
    evidencePages.push(evidencePage);
    expect(evidencePage.nextCursor).toBeDefined();
    while (evidencePage.nextCursor) {
      evidencePage = structuredContentOf<typeof evidencePages[number]>(await client.callTool({
        name: "collect_evidence",
        arguments: { ...evidenceRequest, cursor: evidencePage.nextCursor },
      }));
      evidencePages.push(evidencePage);
    }
    expect(evidencePages.flatMap((page) => page.page.files.map((item) => item.id)))
      .toEqual(evidenceFiles.map((item) => `${item.id}:1`));
  });

  it("reads branches with git.read while Git write remains unauthorized", async () => {
    const branches = structuredJsonOf<{ branches: { ref: string; head: string }[]; total: number }>(
      await client.callTool({ name: "git_branches", arguments: { repository_path: ".", limit: 1 } })
    );
    expect(branches.total).toBeGreaterThan(0);
    expect(branches.branches[0].ref).toMatch(/^refs\/(heads|remotes)\//);
    expect(branches.branches[0].head).toMatch(/^[a-f0-9]{40}$/);
    const denied = await client.callTool({ name: "git_write", arguments: { repository_path: ".", operation: {
      kind: "branch_list", expectedHead: branches.branches[0].head, expectedBranch: "main" },
      timeout_seconds: 30, idempotency_key: "readonly-git-reject-0123456" } });
    expect(jsonOf(denied)).toMatchObject({ error: "INSUFFICIENT_SCOPE" });
  });

  it("workspace_info returns identity and project detection", async () => {
    const result = await client.callTool({ name: "workspace_info", arguments: {} });
    const info = structuredJsonOf<{ workspaceId: string; projectType: string; frameworks: string[]; git: { isRepo: boolean; branch: string } }>(result);
    expect(info.workspaceId).toBe(bridge.workspace.id);
    expect(info.projectType).toBe("node");
    expect(info.frameworks).toContain("React");
    expect(info.git.isRepo).toBe(true);
    expect(info.git.branch).toBe("main");
  });

  it("read_file returns hello.txt", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    const file = structuredJsonOf<{ content: string; totalLines: number }>(result);
    expect(file.content).toContain("Hello from Codex with ChatGPT!");
  });

  it("read_image returns metadata and image content", async () => {
    const result = await client.callTool({ name: "read_image", arguments: { path: "pixel.png" } });
    expect(result.structuredContent).toEqual({ path: "pixel.png", sizeBytes: 11, mimeType: "image/png" });
    const content = result.content as { type: string; mimeType?: string }[];
    expect(content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
  });

  it("read_file denies .env with ACCESS_DENIED_SENSITIVE_FILE and no content", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("ACCESS_DENIED_SENSITIVE_FILE");
    expect(textOf(result)).not.toContain("supersecret");
  });

  it("read_file denies paths outside the workspace", async () => {
    const result = await client.callTool({ name: "read_file", arguments: { path: "../../etc/hosts" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("list_directory lists the tree", async () => {
    const result = await client.callTool({ name: "list_directory", arguments: { path: ".", depth: 2 } });
    const listing = structuredJsonOf<{ entries: { path: string }[] }>(result);
    const paths = listing.entries.map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("src/index.ts");
    expect(paths).not.toContain(".env");
  });

  it("search_workspace finds matches", async () => {
    const result = await client.callTool({ name: "search_workspace", arguments: { query: "answer" } });
    const search = structuredJsonOf<{ matches: { path: string; line: number }[] }>(result);
    expect(search.matches.some((match) => match.path === "src/index.ts")).toBe(true);
  });

  it("git_status reports the dirty file", async () => {
    const result = await client.callTool({ name: "git_status", arguments: {} });
    const status = structuredJsonOf<{ isRepo: boolean; unstaged: { path: string }[] }>(result);
    expect(status.isRepo).toBe(true);
    expect(status.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);
  });

  it("git_diff shows the change", async () => {
    const result = await client.callTool({ name: "git_diff", arguments: { mode: "unstaged" } });
    const diff = structuredJsonOf<{ diff: string; hasMore: boolean }>(result);
    expect(diff.diff).toContain("answer = 43");
    expect(diff.hasMore).toBe(false);
  });

  it("selects nested repositories and worktrees without crossing their Git state", async () => {
    const nested = path.join(root, "repo-a");
    const cleanRepo = path.join(root, "repo-b");
    const primary = path.join(root, "repo-worktree-primary");
    const secondary = path.join(root, "worktrees", "SECONDARY");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(cleanRepo, { recursive: true });
    fs.mkdirSync(primary, { recursive: true });
    fs.mkdirSync(path.dirname(secondary), { recursive: true });
    makeGitRepo(nested);
    makeGitRepo(cleanRepo);
    makeGitRepo(primary);
    git(primary, "worktree", "add", "-b", "secondary", secondary);

    write(nested, ".c2cignore", "private-notes/\n");
    write(nested, "private-notes/secret.txt", "initial nested secret\n");
    git(nested, "add", ".c2cignore");
    git(nested, "add", "-f", "private-notes/secret.txt");
    git(nested, "commit", "-m", "add nested sensitive fixture");
    const nestedHead = git(nested, "rev-parse", "HEAD").trim();
    write(nested, "src/index.ts", "export const answer = 44; // nested edit\n");
    write(nested, "staged.txt", "staged in repo-a\n");
    write(nested, "untracked.txt", "untracked in repo-a\n");
    write(nested, "private-notes/secret.txt", "nested-ignore-secret\n");
    git(nested, "add", "staged.txt");

    const selectedInfo = structuredJsonOf<{
      isRepo: boolean;
      requestedRepositoryPath: string;
      repositoryPath: string;
      topLevel: string | null;
      branch: string | null;
      head: string | null;
      dirty: boolean;
    }>(await client.callTool({ name: "git_info", arguments: { repository_path: "repo-a" } }));
    expect(selectedInfo).toMatchObject({
      isRepo: true,
      requestedRepositoryPath: "repo-a",
      repositoryPath: "repo-a",
      topLevel: "repo-a",
      branch: "main",
      head: nestedHead,
      dirty: true,
    });

    const nestedStatus = structuredJsonOf<{
      isRepo: boolean;
      branch: string;
      repositoryPath: string;
      topLevel: string | null;
      staged: { path: string }[];
      unstaged: { path: string }[];
      untracked: string[];
      hidden: { changes: number; conflicts: number };
    }>(await client.callTool({ name: "git_status", arguments: { repository_path: "repo-a" } }));
    expect(nestedStatus.isRepo).toBe(true);
    expect(nestedStatus.branch).toBe("main");
    expect(nestedStatus.repositoryPath).toBe("repo-a");
    expect(nestedStatus.topLevel).toBe("repo-a");
    expect(nestedStatus.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(nestedStatus.unstaged.map((entry) => entry.path)).toContain("src/index.ts");
    expect(nestedStatus.untracked).toContain("untracked.txt");
    expect(nestedStatus.untracked).not.toContain("private-notes/secret.txt");
    expect(nestedStatus.hidden.changes).toBeGreaterThan(0);

    const nestedDiff = structuredJsonOf<{ repositoryPath: string; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { repository_path: "repo-a", path: "src/index.ts", mode: "unstaged" },
      })
    );
    expect(nestedDiff.repositoryPath).toBe("repo-a");
    expect(nestedDiff.diff).toContain("nested edit");
    expect(nestedDiff.diff).not.toContain("answer = 43");
    const escapedDiffScope = await client.callTool({
      name: "git_diff",
      arguments: { repository_path: "repo-a", path: "../src/index.ts" },
    });
    expect(escapedDiffScope.isError).toBe(true);
    expect(textOf(escapedDiffScope)).toContain("PATH_OUTSIDE_REPOSITORY");

    write(nested, ".env", "NESTED_SECRET=before\n");
    git(nested, "add", "-f", ".env");
    git(nested, "commit", "-m", "add nested sensitive fixture");
    write(nested, ".env", "NESTED_SECRET=must-not-leak\n");
    const filteredNestedDiff = structuredJsonOf<{ diff: string }>(
      await client.callTool({ name: "git_diff", arguments: { repository_path: "repo-a", mode: "unstaged" } })
    );
    expect(filteredNestedDiff.diff).not.toContain("must-not-leak");

    write(primary, "primary-only.txt", "primary dirty state\n");
    const secondaryClean = structuredJsonOf<{
      isRepo: boolean;
      branch: string;
      dirty: boolean;
      head: string;
      topLevel: string | null;
    }>(await client.callTool({ name: "git_info", arguments: { repository_path: "worktrees/SECONDARY" } }));
    expect(fs.statSync(path.join(secondary, ".git")).isFile()).toBe(true);
    expect(secondaryClean).toMatchObject({
      isRepo: true,
      branch: "secondary",
      dirty: false,
      head: git(primary, "rev-parse", "HEAD").trim(),
      topLevel: "worktrees/SECONDARY",
    });

    write(secondary, "src/index.ts", "export const answer = 99; // secondary edit\n");
    write(secondary, "staged.txt", "staged in secondary\n");
    write(secondary, "untracked.txt", "untracked in secondary\n");
    git(secondary, "add", "staged.txt");
    const secondaryStatus = structuredJsonOf<{
      branch: string;
      staged: { path: string }[];
      unstaged: { path: string }[];
      untracked: string[];
    }>(await client.callTool({ name: "git_status", arguments: { repository_path: "worktrees/SECONDARY" } }));
    expect(secondaryStatus.branch).toBe("secondary");
    expect(secondaryStatus.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(secondaryStatus.unstaged.map((entry) => entry.path)).toContain("src/index.ts");
    expect(secondaryStatus.untracked).toContain("untracked.txt");

    const secondaryDiff = structuredJsonOf<{ diff: string }>(
      await client.callTool({ name: "git_diff", arguments: { repository_path: "worktrees/SECONDARY" } })
    );
    expect(secondaryDiff.diff).toContain("secondary edit");
    expect(secondaryDiff.diff).not.toContain("primary dirty state");

    const isolatedClean = structuredJsonOf<{
      isRepo: boolean;
      staged: unknown[];
      unstaged: unknown[];
      untracked: unknown[];
    }>(await client.callTool({ name: "git_status", arguments: { repository_path: "repo-b" } }));
    expect(isolatedClean.isRepo).toBe(true);
    expect(isolatedClean.staged).toEqual([]);
    expect(isolatedClean.unstaged).toEqual([]);
    expect(isolatedClean.untracked).toEqual([]);

    const defaultStatus = structuredJsonOf<{ repositoryPath: string; topLevel: string | null; unstaged: { path: string }[] }>(
      await client.callTool({ name: "git_status", arguments: {} })
    );
    expect(defaultStatus.repositoryPath).toBe(".");
    expect(defaultStatus.topLevel).toBe(".");
    expect(defaultStatus.unstaged.some((entry) => entry.path === "src/index.ts")).toBe(true);

    fs.mkdirSync(path.join(root, "not-a-repository"), { recursive: true });
    const noFallback = structuredJsonOf<{ isRepo: boolean; head: string | null }>(
      await client.callTool({ name: "git_info", arguments: { repository_path: "not-a-repository" } })
    );
    expect(noFallback).toMatchObject({ isRepo: false, head: null });

    const conflictRepo = path.join(root, "repo-conflicts");
    fs.mkdirSync(conflictRepo, { recursive: true });
    makeGitRepo(conflictRepo);
    write(conflictRepo, ".c2cignore", "private-notes/\n");
    write(conflictRepo, "private-notes/conflict.txt", "base\n");
    git(conflictRepo, "add", ".c2cignore", "private-notes/conflict.txt");
    git(conflictRepo, "commit", "-m", "add ignored conflict fixture");
    git(conflictRepo, "checkout", "-b", "conflict-side");
    write(conflictRepo, "private-notes/conflict.txt", "side-conflict-secret\n");
    git(conflictRepo, "add", "private-notes/conflict.txt");
    git(conflictRepo, "commit", "-m", "side change");
    git(conflictRepo, "checkout", "main");
    write(conflictRepo, "private-notes/conflict.txt", "main-conflict-secret\n");
    git(conflictRepo, "add", "private-notes/conflict.txt");
    git(conflictRepo, "commit", "-m", "main change");
    expect(() => git(conflictRepo, "merge", "conflict-side")).toThrow();

    const hiddenConflictStatus = structuredJsonOf<{
      isRepo: boolean;
      conflicted: string[];
      hidden: { changes: number; conflicts: number };
    }>(await client.callTool({ name: "git_status", arguments: { repository_path: "repo-conflicts" } }));
    expect(hiddenConflictStatus.isRepo).toBe(true);
    expect(hiddenConflictStatus.conflicted).toEqual([]);
    expect(hiddenConflictStatus.hidden.conflicts).toBeGreaterThan(0);
    const hiddenConflictDiff = structuredJsonOf<{ diff: string }>(
      await client.callTool({ name: "git_diff", arguments: { repository_path: "repo-conflicts", mode: "head" } })
    );
    expect(hiddenConflictDiff.diff).not.toContain("side-conflict-secret");
    expect(hiddenConflictDiff.diff).not.toContain("main-conflict-secret");
  });

  it("rejects repository selectors outside the workspace, through reparse points, and for non-directories", async () => {
    const outside = path.join(path.dirname(root), "mcp-repository-outside");
    fs.mkdirSync(outside, { recursive: true });
    const junction = path.join(root, "repository-escape");
    fs.symlinkSync(outside, junction, "junction");

    for (const repositoryPath of ["../mcp-repository-outside", outside, "repository-escape"]) {
      const result = await client.callTool({ name: "git_status", arguments: { repository_path: repositoryPath } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("PATH_OUTSIDE_WORKSPACE");
    }

    const missing = await client.callTool({ name: "git_status", arguments: { repository_path: "missing-repository" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("FILE_NOT_FOUND");

    const file = await client.callTool({ name: "git_status", arguments: { repository_path: "hello.txt" } });
    expect(file.isError).toBe(true);
    expect(textOf(file)).toContain("NOT_A_DIRECTORY");
  });

  it("git_diff paginates large diffs", async () => {
    const big = Array.from({ length: 20000 }, (_, i) => `content line ${i}`).join("\n");
    write(root, "big-change.txt", big);
    git(root, "add", "big-change.txt");
    const first = structuredJsonOf<{ hasMore: boolean; nextOffset: number; totalBytes: number; returnedBytes: number }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged", max_bytes: 4096 } })
    );
    expect(first.hasMore).toBe(true);
    expect(first.returnedBytes).toBeLessThanOrEqual(4096);
    const second = structuredJsonOf<{ offset: number; diff: string }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", max_bytes: 4096, offset: first.nextOffset },
      })
    );
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
    git(root, "reset", "big-change.txt");
  });

  it("execution_summary and test_status read harness records", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_test1",
      iteration: 1,
      changedFiles: ["src/index.ts"],
      tests: "27 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(
      await client.callTool({ name: "execution_summary", arguments: {} })
    );
    expect(summary.records[0].taskId).toBe("c2c_test1");

    const status = structuredJsonOf<{ available: boolean; tests: string; outputAvailable: boolean; outputId: number | null }>(
      await client.callTool({ name: "test_status", arguments: {} })
    );
    expect(status.available).toBe(true);
    expect(status.tests).toBe("27 passed");
    expect(status.outputAvailable).toBe(false);
    expect(status.outputId).toBeNull();
  });

  it("skips invalid persisted records when reporting execution status", async () => {
    appendExecutionRecord(bridge.workspace.id, {
      taskId: "c2c_valid_before_invalid",
      iteration: 2,
      changedFiles: 0,
      tests: "31 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    fs.appendFileSync(
      path.join(stateDir, "executions", `${bridge.workspace.id}.jsonl`),
      JSON.stringify({
        taskId: "c2c_invalid",
        iteration: null,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      }) + "\n"
    );

    const statusResult = await client.callTool({ name: "test_status", arguments: {} });
    expect(statusResult.isError ?? false).toBe(false);
    const status = structuredJsonOf<{ taskId: string; iteration: number }>(statusResult);
    expect(status.taskId).toBe("c2c_valid_before_invalid");
    expect(status.iteration).toBe(2);

    const summaryResult = await client.callTool({ name: "execution_summary", arguments: { limit: 1 } });
    expect(summaryResult.isError ?? false).toBe(false);
    const summary = structuredJsonOf<{ records: { taskId: string }[] }>(summaryResult);
    expect(summary.records.map((record) => record.taskId)).toEqual(["c2c_valid_before_invalid"]);
  });

  it("execution_output lists readable items and refuses restricted bodies", async () => {
    const readable = saveExecutionOutput(bridge.workspace.id, {
      command: "pnpm test",
      raw: "FAIL src/a.test.ts\nAssertionError: expected true",
      exitCode: 1,
    });
    const hidden = saveExecutionOutput(bridge.workspace.id, {
      command: "print-key",
      raw: "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----",
      exitCode: 0,
    });
    const listResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    const list = structuredJsonOf<{
      action: "list";
      items: { id: number; status: string; command: string; text?: string }[];
    }>(listResult);
    expect(list.action).toBe("list");
    expect(list.items.some((item) => item.id === readable.id && item.status === "readable")).toBe(true);
    expect(list.items.some((item) => item.id === hidden.id && item.status === "restricted")).toBe(true);
    expect(list.items.every((item) => item.text === undefined)).toBe(true);

    const readResult = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: readable.id },
    });
    const body = structuredJsonOf<{ action: "read"; text: string }>(readResult);
    expect(body.action).toBe("read");
    expect(body.text).toContain("AssertionError");

    const denied = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: hidden.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("OUTPUT_RESTRICTED");
    expect(textOf(denied)).not.toContain("BEGIN RSA");

    const missing = await client.callTool({
      name: "execution_output",
      arguments: { action: "read", id: 999999 },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("NOT_FOUND");
  });

  it("enforces scopes per tool", async () => {
    const limited = bridge.authStore.issueTokens({ clientId: "limited", scopes: ["workspace.read"] });
    const limitedClient = new Client({ name: "limited", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${limited.accessToken}` } },
    });
    await limitedClient.connect(transport);
    const denied = await limitedClient.callTool({ name: "git_diff", arguments: {} });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    const head = git(root, "rev-parse", "HEAD").trim();
    const deniedCompare = await limitedClient.callTool({
      name: "git_compare",
      arguments: { base_commit: head, head_commit: head },
    });
    expect(deniedCompare.isError).toBe(true);
    expect(textOf(deniedCompare)).toContain("INSUFFICIENT_SCOPE");
    const outputDenied = await limitedClient.callTool({
      name: "execution_output",
      arguments: { action: "list" },
    });
    expect(outputDenied.isError).toBe(true);
    expect(textOf(outputDenied)).toContain("INSUFFICIENT_SCOPE");
    const allowed = await limitedClient.callTool({ name: "read_file", arguments: { path: "hello.txt" } });
    expect(allowed.isError ?? false).toBe(false);
    await limitedClient.close();
  });

  it("git_diff over MCP excludes sensitive files like .npmrc and service-account*.json", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=supersecret-npm-token\n");
    write(root, "service-account-test.json", '{"private_key": "supersecret-sa-key"}\n');
    write(root, "src/visible.ts", "export const visible = 'safe-change';\n");

    git(root, "add", "-f", ".npmrc", "service-account-test.json", "src/visible.ts");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).toContain("safe-change");
    expect(result.diff).not.toContain("supersecret-npm-token");
    expect(result.diff).not.toContain("supersecret-sa-key");

    git(root, "rm", "-f", "--cached", ".npmrc", "service-account-test.json", "src/visible.ts");
  });

  it("git_diff over MCP blocks sensitive-to-safe renames from leaking original content", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=mcp-secret-token-123\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add secret to rename");

    git(root, "mv", ".npmrc", "public_harmless.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({ name: "git_diff", arguments: { mode: "staged" } })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("mcp-secret-token-123");
    expect(result.diff).not.toContain("public_harmless.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("git_diff over MCP with path='src' blocks cross-boundary rename leaks from root secrets", async () => {
    write(root, ".npmrc", "//registry.npmjs.org/:_authToken=root-mcp-scoped-secret\n");
    git(root, "add", "-f", ".npmrc");
    git(root, "commit", "-m", "add root secret for scoped test");

    // Rename root .npmrc to src/public.txt
    git(root, "mv", ".npmrc", "src/public.txt");

    const result = jsonOf<{ diff: string; isRepo: boolean }>(
      await client.callTool({
        name: "git_diff",
        arguments: { mode: "staged", path: "src" },
      })
    );

    expect(result.isRepo).toBe(true);
    expect(result.diff).not.toContain("root-mcp-scoped-secret");
    expect(result.diff).not.toContain("src/public.txt");

    git(root, "reset", "--hard", "HEAD");
  });

  it("fails closed without authInfo and isolates execution jobs between OAuth clients", async () => {
    const localServer = createMcpServer({
      workspace: bridge.workspace,
      logger: nullLogger,
      executionSupervisor: bridge.executionSupervisor,
    });
    const [localClientTransport, localServerTransport] = InMemoryTransport.createLinkedPair();
    const localClient = new Client({ name: "c2c-local-no-auth", version: "1.0.0" });
    await localServer.connect(localServerTransport);
    await localClient.connect(localClientTransport);
    const unauthenticated = await localClient.callTool({
      name: "execution_status",
      arguments: { job_id: "a".repeat(24) },
    });
    expect(unauthenticated.isError).toBe(true);
    expect(textOf(unauthenticated)).toContain("UNAUTHENTICATED");
    const unauthenticatedEvidence = await localClient.callTool({
      name: "collect_evidence",
      arguments: { execution_jobs: [{ id: "job", job_id: "a".repeat(24) }] },
    });
    expect(unauthenticatedEvidence.isError).toBe(true);
    expect(textOf(unauthenticatedEvidence)).toContain("UNAUTHENTICATED");
    await localClient.close();
    await localServer.close();

    const noExecutionScope = await client.callTool({
      name: "execution_start",
      arguments: {
        repository_path: ".",
        kind: "test",
        target: "test",
        timeout_seconds: 30,
        idempotency_key: "mcp-no-scope-00000001",
      },
    });
    expect(noExecutionScope.isError).toBe(true);
    expect(textOf(noExecutionScope)).toContain("INSUFFICIENT_SCOPE");

    const startClient = new Client({ name: "c2c-execution-client-a", version: "1.0.0" });
    const otherClient = new Client({ name: "c2c-execution-client-b", version: "1.0.0" });
    await startClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${executionToken}` } },
    }));
    await otherClient.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${secondExecutionToken}` } },
    }));
    try {
      setPermission(bridge.workspace.id, "level1");
      const repository = resolveRepositoryIdentity(bridge.workspace, ".");
      const unapproved = await startClient.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "test",
          target: "test",
          timeout_seconds: 30,
          idempotency_key: "mcp-unapproved-000001",
        },
      });
      expect(unapproved.isError).toBe(true);
      expect(textOf(unapproved)).toContain("COMMAND_NOT_APPROVED");

      const maliciousTarget = await startClient.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "package_script",
          target: "../test && whoami",
          timeout_seconds: 30,
          idempotency_key: "mcp-malicious-000001",
        },
      });
      expect(maliciousTarget.isError).toBe(true);

      approveTrustedCommand({
        workspaceId: bridge.workspace.id,
        repositoryIdentity: repository.identity,
        canonicalRepositoryPath: repository.canonicalPath,
        kind: "test",
        target: "test",
        packageManager: "npm",
        localApproval: true,
      });
      const started = structuredJsonOf<{ job: McpExecutionJob; duplicate: boolean }>(await startClient.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "test",
          target: "test",
          timeout_seconds: 30,
          idempotency_key: "mcp-start-000000000001",
        },
      }));
      expect(started.duplicate).toBe(false);
      expect(started.job.state).toBe("running");

      const ownedEvidence = structuredContentOf<{ page: { artifacts: Array<{ jobId: string; ownerVerified: true }> } }>(
        await startClient.callTool({
          name: "collect_evidence",
          arguments: { execution_jobs: [{ id: "owned", job_id: started.job.job_id }] },
        })
      );
      expect(ownedEvidence.page.artifacts).toMatchObject([{ jobId: started.job.job_id, ownerVerified: true }]);

      executionRunner.emit(started.job.job_id, "stdout", `ready\n${"x".repeat(200)}`);
      executionRunner.emit(started.job.job_id, "stdout", "FOREIGN_OWNER_OUTPUT_SENTINEL");

      const foreignEvidence = structuredContentOf<{
        page: { artifacts: unknown[]; omitted: Array<{ id: string; code: string }> };
      }>(await otherClient.callTool({
        name: "collect_evidence",
        arguments: { execution_jobs: [{ id: "foreign", job_id: started.job.job_id }] },
      }));
      expect(foreignEvidence.page.artifacts).toEqual([]);
      expect(foreignEvidence.page.omitted).toContainEqual({
        kind: "execution_job", id: "foreign", code: "JOB_NOT_FOUND_OR_NOT_OWNED",
      });
      const foreignJson = JSON.stringify(foreignEvidence);
      for (const restrictedField of ["state", "exitCode", "failureCode", "stdout", "stderr"]) {
        expect(foreignJson).not.toContain(`"${restrictedField}"`);
      }
      expect(foreignJson).not.toContain("FOREIGN_OWNER_OUTPUT_SENTINEL");

      const listed = structuredJsonOf<{ jobs: McpExecutionJob[] }>(await startClient.callTool({
        name: "execution_list",
        arguments: { limit: 20 },
      }));
      expect(listed.jobs.map((job) => job.job_id)).toContain(started.job.job_id);

      const statusDenied = await otherClient.callTool({
        name: "execution_status",
        arguments: { job_id: started.job.job_id },
      });
      expect(statusDenied.isError).toBe(true);
      expect(textOf(statusDenied)).toContain("NOT_FOUND");
      const cancelDenied = await otherClient.callTool({
        name: "execution_cancel",
        arguments: { job_id: started.job.job_id },
      });
      expect(cancelDenied.isError).toBe(true);
      expect(textOf(cancelDenied)).toContain("NOT_FOUND");

      const output = structuredJsonOf<{ offset: number; next_offset: number; text: string; eof: boolean }>(
        await startClient.callTool({
          name: "execution_job_output",
          arguments: { job_id: started.job.job_id, stream: "stdout", offset: 0, max_bytes: 5 },
        })
      );
      expect(output).toMatchObject({ offset: 0, next_offset: 5, text: "ready", eof: false });

      const cancel = structuredJsonOf<{ job: McpExecutionJob }>(await startClient.callTool({
        name: "execution_cancel",
        arguments: { job_id: started.job.job_id },
      }));
      expect(cancel.job.state).toBe("cancelling");
      executionRunner.finish(started.job.job_id, 1);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const status = structuredJsonOf<{ job: McpExecutionJob }>(await startClient.callTool({
          name: "execution_status",
          arguments: { job_id: started.job.job_id },
        }));
        if (status.job.state === "cancelled") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const finalStatus = structuredJsonOf<{ job: McpExecutionJob }>(await startClient.callTool({
        name: "execution_status",
        arguments: { job_id: started.job.job_id },
      }));
      expect(finalStatus.job.state).toBe("cancelled");

      const hostCwd = makeTmpDir("mcp-full-access-cwd");
      const level1Denied = await startClient.callTool({
        name: "execution_run",
        arguments: {
          engine: "program", executable: process.execPath, args: [], cwd: hostCwd,
          timeout_seconds: 30, idempotency_key: "mcp-full-access-level1-001", wait_seconds: 0,
        },
      });
      expect(level1Denied.isError).toBe(true);
      expect(textOf(level1Denied)).toContain("FULL_ACCESS_REQUIRED");

      setPermission(bridge.workspace.id, "level2");
      const hostArguments = {
        engine: "program",
        executable: process.execPath,
        args: [],
        cwd: hostCwd,
        timeout_seconds: 30,
        idempotency_key: "mcp-full-access-host-000001",
        wait_seconds: 0,
      };
      const hostStarted = structuredJsonOf<{
        job: McpExecutionJob & { execution_context: string };
        job_id: string;
        state: string;
        duplicate: boolean;
        stdout_tail?: string;
      }>(await startClient.callTool({ name: "execution_run", arguments: hostArguments }));
      expect(hostStarted.job.execution_context).toBe("host");
      expect(hostStarted.duplicate).toBe(false);
      expect(["queued", "running"]).toContain(hostStarted.state);
      expect(hostStarted.stdout_tail).toBeUndefined();
      for (let attempt = 0; attempt < 1000 && !executionRunner.runs.has(hostStarted.job_id); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!executionRunner.runs.has(hostStarted.job_id)) {
        const queuedStatus = structuredJsonOf<{ job: McpExecutionJob }>(await startClient.callTool({
          name: "execution_status", arguments: { job_id: hostStarted.job_id },
        }));
        throw new Error(`FULL_ACCESS_RUNNER_START_TIMEOUT:${queuedStatus.job.state}`);
      }
      executionRunner.emit(hostStarted.job_id, "stdout", "full access stdout tail\n");
      executionRunner.emit(hostStarted.job_id, "stderr", "full access stderr tail\n");
      executionRunner.finish(hostStarted.job_id, 0);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = structuredJsonOf<{ job: McpExecutionJob }>(await startClient.callTool({
          name: "execution_status", arguments: { job_id: hostStarted.job_id },
        }));
        if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(status.job.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const hostDuplicate = structuredJsonOf<{
        job: McpExecutionJob;
        state: string;
        exit_code: number | null;
        duplicate: boolean;
        stdout_tail: string;
        stderr_tail: string;
      }>(await startClient.callTool({ name: "execution_run", arguments: hostArguments }));
      expect(hostDuplicate).toMatchObject({
        state: "succeeded", exit_code: 0, duplicate: true,
        stdout_tail: "full access stdout tail\n", stderr_tail: "full access stderr tail\n",
      });

      const inlineCwd = makeTmpDir("mcp-inline-wait-cwd");
      const inlineArgs = {
        engine: "program", executable: process.execPath, args: [], cwd: inlineCwd,
        timeout_seconds: 30, idempotency_key: "mcp-full-access-inline-0001", wait_seconds: 10,
      };
      const beforeInline = new Set(executionRunner.runs.keys());
      const inlinePending = startClient.callTool({ name: "execution_run", arguments: inlineArgs });
      let inlineJobId: string | undefined;
      try {
        await waitUntil(() => {
          inlineJobId = [...executionRunner.runs.keys()].find((jobId) => !beforeInline.has(jobId));
          return inlineJobId !== undefined;
        }, 9_000);
      } catch {
        const inlineResponse = structuredJsonOf<{ job_id: string; state: string }>(await inlinePending);
        inlineJobId = [...executionRunner.runs.keys()].find((jobId) => !beforeInline.has(jobId));
        if (!inlineJobId) throw new Error(`MCP_INLINE_RUNNER_START_TIMEOUT:${inlineResponse.state}`);
      }
      expect(inlineJobId).toBeDefined();
      executionRunner.emit(inlineJobId!, "stdout", "finished inside inline wait\n");
      executionRunner.finish(inlineJobId!, 0);
      const inlineResult = structuredJsonOf<{ state: string; stdout_tail: string }>(await inlinePending);
      expect(inlineResult).toMatchObject({ state: "succeeded", stdout_tail: "finished inside inline wait\n" });

      setPermission(bridge.workspace.id, "readonly");
      const readonlyDenied = await startClient.callTool({
        name: "execution_run",
        arguments: { ...hostArguments, idempotency_key: "mcp-full-access-readonly-001" },
      });
      expect(readonlyDenied.isError).toBe(true);
      expect(textOf(readonlyDenied)).toContain("FULL_ACCESS_REQUIRED");

      setPermission(bridge.workspace.id, "readonly");
      const downgraded = await startClient.callTool({
        name: "execution_start",
        arguments: {
          repository_path: ".",
          kind: "test",
          target: "test",
          timeout_seconds: 30,
          idempotency_key: "mcp-readonly-00000001",
        },
      });
      expect(downgraded.isError).toBe(true);
      expect(textOf(downgraded)).toContain("EXECUTION_PERMISSION_DENIED");
    } finally {
      setPermission(bridge.workspace.id, "readonly");
      await startClient.close();
      await otherClient.close();
    }
  }, 60_000);

  it("uses the Bridge-owned persistent Task runtime through the production MCP route", async () => {
    const taskClient = await connectHttpClient(executionToken, "task-api-bridge-owner");
    try {
      const listedTools = await taskClient.listTools();
      expect(listedTools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "task_create", "task_status", "task_list", "task_result", "task_output", "task_cancel",
      ]));
      const created = structuredContentOf<{ task_id: string; state: string; plan_hash: string; duplicate: boolean }>(
        await taskClient.callTool({
          name: "task_create",
          arguments: {
            idempotency_key: "bridge-task-api-empty-plan-001",
            plan: { version: 1, maxDurationMs: 60_000, steps: [] },
          },
        }),
      );
      expect(created).toMatchObject({ state: "QUEUED", duplicate: false });
      await waitUntil(() => bridge.taskStore.get(created.task_id)?.state === "COMPLETED");
      const status = structuredContentOf<{ task_id: string; state: string; completed_steps: number; total_steps: number }>(
        await taskClient.callTool({ name: "task_status", arguments: { task_id: created.task_id } }),
      );
      expect(status).toEqual(expect.objectContaining({ task_id: created.task_id, state: "COMPLETED", completed_steps: 0, total_steps: 0 }));
    } finally {
      await taskClient.close();
    }
  });
});

describe("V1.3.2 Git compare tool surface", () => {
  it("publishes git_compare as a read-only git.read tool with structured output", async () => {
    const tools = await client.listTools();
    const compare = tools.tools.find((tool) => tool.name === "git_compare");
    expect(compare).toBeDefined();
    expect(compare?.annotations?.readOnlyHint).toBe(true);
    expectToolOutputSchema(tools.tools, "git_compare", [
      "isRepo",
      "repositoryPath",
      "topLevel",
      "baseCommit",
      "headCommit",
      "files",
      "totalBytes",
      "offset",
      "returnedBytes",
      "hasMore",
      "nextOffset",
      "diff",
    ]);
  });

  it("compares exact historical commits through the MCP boundary", async () => {
    const nested = path.join(root, "nested-compare");
    fs.mkdirSync(nested, { recursive: true });
    makeGitRepo(nested);
    const base = git(nested, "rev-parse", "HEAD").trim();
    write(nested, "hello.txt", "changed through MCP compare\n");
    git(nested, "add", "hello.txt");
    git(nested, "commit", "-m", "historical compare");
    const head = git(nested, "rev-parse", "HEAD").trim();
    const linkedWorktree = path.join(nested, "linked-worktree");
    git(nested, "worktree", "add", "--detach", linkedWorktree, head);

    const compared = structuredJsonOf<{
      isRepo: boolean;
      repositoryPath: string;
      baseCommit: string;
      headCommit: string;
      files: Array<{ path: string; status: string }>;
      diff: string;
    }>(await client.callTool({
      name: "git_compare",
      arguments: {
        repository_path: "nested-compare/linked-worktree",
        base_commit: base,
        head_commit: head,
        offset: 0,
        max_bytes: 65536,
      },
    }));

    expect(compared.isRepo).toBe(true);
    expect(compared.repositoryPath).toBe("nested-compare/linked-worktree");
    expect(compared.baseCommit).toBe(base);
    expect(compared.headCommit).toBe(head);
    expect(compared.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "hello.txt", status: "M" }),
    ]));
    expect(compared.diff).toContain("changed through MCP compare");
  });
});
