import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { createMcpServer } from "../src/mcp/server.js";
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
  it("lists read-only tools and explicitly separated permission-gated file tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
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
      "execution_start",
      "execution_status",
      "execution_summary",
      "git_diff",
      "git_info",
      "git_status",
      "host_context",
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
      "test_status",
      "workspace_info",
    ]);
    for (const forbidden of ["write_file", "move_external_file", "delete_external_file", "delete_directory", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    expectToolOutputSchema(tools, "workspace_info", ["workspaceId", "workspaceName", "projectType", "git"]);
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
    expectToolOutputSchema(tools, "execution_status", ["available", "job"]);
    expectToolOutputSchema(tools, "execution_list", ["jobs"]);
    expectToolOutputSchema(tools, "execution_job_output", ["offset", "next_offset", "oldest_available_offset", "eof", "truncated", "text"]);
    expectToolOutputSchema(tools, "execution_cancel", ["job"]);
  });

  it("documents git_diff pagination with its output field names", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "git_diff")?.description;
    expect(description).toContain("hasMore");
    expect(description).toContain("nextOffset");
    expect(description).not.toContain("has_more");
    expect(description).not.toContain("next_offset");
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
      executionRunner.emit(started.job.job_id, "stdout", `ready\n${"x".repeat(200)}`);

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
  });
});
