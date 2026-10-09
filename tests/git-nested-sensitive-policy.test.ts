import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { git, makeGitRepo, makeTmpDir, write, isolateStateDir } from "./helpers.js";

interface StatusResult {
  isRepo: boolean;
  staged: { path: string }[];
  unstaged: { path: string }[];
  untracked: string[];
  conflicted: string[];
  hidden: { changes: number; conflicts: number };
}

interface DiffResult {
  isRepo: boolean;
  diff: string;
}

let root: string;
let bridge: Bridge;
let client: Client;

function contentText(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function structuredJsonOf<T>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = JSON.parse(contentText(result)) as T;
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function makeSensitiveRepo(
  relativePath: string,
  repoIgnore?: string,
  trackedPath = "private/tracked-secret.txt"
): string {
  const repo = path.join(root, relativePath);
  fs.mkdirSync(repo, { recursive: true });
  makeGitRepo(repo);
  if (repoIgnore !== undefined) write(repo, ".c2cignore", repoIgnore);
  write(repo, trackedPath, "baseline-private-content\n");
  git(repo, "add", trackedPath, ...(repoIgnore === undefined ? [] : [".c2cignore"]));
  git(repo, "commit", "-m", "add sensitive policy fixture");
  write(repo, trackedPath, `${relativePath}-tracked-secret-content\n`);
  write(repo, "private/untracked-secret.txt", `${relativePath}-untracked-secret-content\n`);
  return repo;
}

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("mcp-git-sensitive-policy");
  makeGitRepo(root);
  write(
    root,
    ".c2cignore",
    [
      "repo-workspace-only/private/**",
      "repo-both/private/**",
      "repo-negation/private/**",
      "repo-conflicts/private/**",
    ].join("\n") + "\n"
  );

  makeSensitiveRepo("repo-workspace-only");
  makeSensitiveRepo("repo-local-only", "private/**\n");
  makeSensitiveRepo("repo-both", "private/**\n");
  makeSensitiveRepo("repo-negation", "!private/allowed-secret.txt\n", "private/allowed-secret.txt");

  const conflictRepo = path.join(root, "repo-conflicts");
  fs.mkdirSync(conflictRepo, { recursive: true });
  makeGitRepo(conflictRepo);
  write(conflictRepo, "private/conflict.txt", "base conflict content\n");
  git(conflictRepo, "add", "private/conflict.txt");
  git(conflictRepo, "commit", "-m", "add workspace-hidden conflict fixture");
  git(conflictRepo, "checkout", "-b", "conflict-side");
  write(conflictRepo, "private/conflict.txt", "side-conflict-sensitive-content\n");
  git(conflictRepo, "add", "private/conflict.txt");
  git(conflictRepo, "commit", "-m", "side change");
  git(conflictRepo, "checkout", "main");
  write(conflictRepo, "private/conflict.txt", "main-conflict-sensitive-content\n");
  git(conflictRepo, "add", "private/conflict.txt");
  git(conflictRepo, "commit", "-m", "main change");
  expect(() => git(conflictRepo, "merge", "conflict-side")).toThrow();

  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("mcp-git-sensitive-auth"), "store.json"),
  });
  const tokens = bridge.authStore.issueTokens({
    clientId: "git-policy-test-client",
    scopes: ["workspace.read", "git.read"],
  });
  client = new Client({ name: "c2c-git-policy-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await bridge.close();
  // Retain isolated fixtures; no recursive deletion.
});

async function readStatus(repositoryPath: string): Promise<StatusResult> {
  return structuredJsonOf<StatusResult>(await client.callTool({
    name: "git_status",
    arguments: { repository_path: repositoryPath },
  }));
}

async function readDiff(repositoryPath: string): Promise<DiffResult> {
  return structuredJsonOf<DiffResult>(await client.callTool({
    name: "git_diff",
    arguments: { repository_path: repositoryPath, mode: "unstaged" },
  }));
}

describe("nested Git sensitive policy inheritance", () => {
  it("applies workspace-only rules to status and diff using workspace-relative paths", async () => {
    const status = await readStatus("repo-workspace-only");
    const diff = await readDiff("repo-workspace-only");
    expect(status.isRepo).toBe(true);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.hidden.changes).toBeGreaterThan(0);
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).not.toContain("private/tracked-secret.txt");
    expect(diff.diff).not.toContain("repo-workspace-only-tracked-secret-content");
    expect(diff.diff).not.toContain("repo-workspace-only-untracked-secret-content");
  });

  it("preserves repository-only deny rules", async () => {
    const status = await readStatus("repo-local-only");
    const diff = await readDiff("repo-local-only");
    expect(status.isRepo).toBe(true);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.hidden.changes).toBeGreaterThan(0);
    expect(diff.diff).not.toContain("private/tracked-secret.txt");
    expect(diff.diff).not.toContain("repo-local-only-tracked-secret-content");
    expect(diff.diff).not.toContain("repo-local-only-untracked-secret-content");
  });

  it("unions workspace and repository rules, and a repo negation cannot reopen a parent deny", async () => {
    const bothStatus = await readStatus("repo-both");
    const bothDiff = await readDiff("repo-both");
    expect(bothStatus.hidden.changes).toBeGreaterThan(0);
    expect(bothStatus.unstaged).toEqual([]);
    expect(bothStatus.untracked).toEqual([]);
    expect(bothDiff.diff).not.toContain("repo-both-tracked-secret-content");

    const negationStatus = await readStatus("repo-negation");
    const negationDiff = await readDiff("repo-negation");
    expect(negationStatus.hidden.changes).toBeGreaterThan(0);
    expect(negationStatus.unstaged).toEqual([]);
    expect(negationStatus.untracked).toEqual([]);
    expect(negationDiff.diff).not.toContain("private/allowed-secret.txt");
    expect(negationDiff.diff).not.toContain("repo-negation-tracked-secret-content");
  });

  it("hides workspace-sensitive merge conflict names and content", async () => {
    const result = await client.callTool({
      name: "git_status",
      arguments: { repository_path: "repo-conflicts" },
    });
    const status = structuredJsonOf<StatusResult>(result);
    expect(status.isRepo).toBe(true);
    expect(status.conflicted).toEqual([]);
    expect(status.hidden.conflicts).toBeGreaterThan(0);

    const diff = await client.callTool({
      name: "git_diff",
      arguments: { repository_path: "repo-conflicts", mode: "head" },
    });
    const parsedDiff = structuredJsonOf<DiffResult>(diff);
    expect(parsedDiff.diff).not.toContain("private/conflict.txt");
    expect(parsedDiff.diff).not.toContain("side-conflict-sensitive-content");
    expect(parsedDiff.diff).not.toContain("main-conflict-sensitive-content");
  });

  it("matches sensitive paths with non-ASCII characters and spaces", async () => {
    const unusualPath = "private/秘密 file.txt";
    write(path.join(root, "repo-local-only"), unusualPath, "sensitive unusual path content\n");

    const status = await readStatus("repo-local-only");
    expect(status.isRepo).toBe(true);
    expect(status.untracked).not.toContain(unusualPath);
    expect(status.untracked.join("\0")).not.toContain("private/");
    expect(status.hidden.changes).toBeGreaterThan(2);
  });
});
