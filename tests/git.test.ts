import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitDiff, gitInfo, gitStatus } from "../src/workspace/git.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup, write, makeGitRepo, git } from "./helpers.js";

let repo: string;
let plain: string;

beforeAll(() => {
  repo = makeTmpDir("git-repo");
  makeGitRepo(repo);
  // Keep this fixture outside the checkout; the Git runner intentionally clears
  // inherited GIT_CEILING_DIRECTORIES along with other repository authority.
  plain = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-not-a-repo-"));
});

afterAll(() => {
  cleanup(repo);
  cleanup(plain);
});

describe("gitInfo", () => {
  it("reports branch, commit and dirty state", () => {
    const clean = gitInfo(repo);
    expect(clean.isRepo).toBe(true);
    expect(clean.branch).toBe("main");
    expect(clean.commit).toMatch(/^[a-f0-9]{7,}$/);
    expect(clean.dirty).toBe(false);

    write(repo, "hello.txt", "changed\n");
    expect(gitInfo(repo).dirty).toBe(true);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("handles non-repos gracefully", () => {
    expect(gitInfo(plain).isRepo).toBe(false);
  });
});

describe("gitStatus", () => {
  it("categorizes staged, unstaged and untracked files", () => {
    write(repo, "hello.txt", "modified content\n");
    write(repo, "staged.txt", "new staged file\n");
    write(repo, "untracked.txt", "new file\n");
    git(repo, "add", "staged.txt");

    const status = gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.unstaged.map((entry) => entry.path)).toContain("hello.txt");
    expect(status.staged.map((entry) => entry.path)).toContain("staged.txt");
    expect(status.untracked).toContain("untracked.txt");

    git(repo, "reset", "staged.txt");
    git(repo, "checkout", "--", "hello.txt");
  });

  it("parses NUL-delimited rename paths in source-to-destination order", () => {
    const isolated = makeTmpDir("git-status-rename-paths");
    makeGitRepo(isolated);
    write(isolated, "old name.txt", "rename source content\n");
    git(isolated, "add", "old name.txt");
    git(isolated, "commit", "-m", "add rename source");
    git(isolated, "mv", "old name.txt", "new name.txt");

    const status = gitStatus(isolated);
    expect(status.isRepo).toBe(true);
    expect(status.staged).toContainEqual({ path: "old name.txt -> new name.txt", change: "R" });
  });

  it("omits sensitive and .c2cignore'd paths from the names ChatGPT sees", () => {
    const isolated = makeTmpDir("git-sensitive-status");
    makeGitRepo(isolated);
    write(isolated, ".c2cignore", "private-notes/\n");
    write(isolated, ".env", "SECRET_KEY=leaked-env\n");
    write(isolated, "private-notes/secret.md", "CONFIDENTIAL DATA\n");
    write(isolated, "public.txt", "PUBLIC CONTENT\n");

    const status = gitStatus(isolated);
    expect(status.untracked).toContain("public.txt");
    expect(status.untracked).not.toContain(".env");
    expect(status.untracked).not.toContain("private-notes/secret.md");
    expect(status.hidden.changes).toBeGreaterThan(0);

    // Keep this fixture separate so later tests do not need destructive cleanup.
  });
});

describe("gitDiff workspace-relative paths", () => {
  it("keeps inventory and patch paths relative when the workspace is inside a parent repo", () => {
    const parent = makeTmpDir("git-subdirectory-workspace-parent");
    makeGitRepo(parent);
    const workspaceRoot = path.join(parent, "connected");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    write(workspaceRoot, ".c2cignore", "private/**\n");
    write(workspaceRoot, "private/tracked-secret.txt", "baseline private value\n");
    write(workspaceRoot, "public.txt", "baseline public value\n");
    git(parent, "add", "connected/.c2cignore", "connected/private/tracked-secret.txt", "connected/public.txt");
    git(parent, "commit", "-m", "add connected workspace fixture");

    write(workspaceRoot, "private/tracked-secret.txt", "sensitive changed content\n");
    write(workspaceRoot, "public.txt", "visible changed content\n");

    const workspace = new Workspace(workspaceRoot);
    const status = gitStatus(workspace);
    const diff = gitDiff(workspace, { mode: "unstaged" });
    expect(status.isRepo).toBe(true);
    expect(status.hidden.changes).toBeGreaterThan(0);
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("visible changed content");
    expect(diff.diff).not.toContain("tracked-secret.txt");
    expect(diff.diff).not.toContain("sensitive changed content");
  });
});

describe("gitDiff pagination", () => {
  it("returns the full diff when small", () => {
    write(repo, "hello.txt", "a different greeting\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("a different greeting");
    expect(diff.hasMore).toBe(false);
    expect(diff.nextOffset).toBeNull();
    git(repo, "checkout", "--", "hello.txt");
  });

  it("paginates on byte offsets and never splits lines", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}-${"x".repeat(40)}`).join("\n");
    write(repo, "hello.txt", lines);
    const first = gitDiff(repo, { mode: "unstaged", maxBytes: 8192 });
    expect(first.hasMore).toBe(true);
    expect(first.diff.endsWith("\n")).toBe(true);
    expect(first.nextOffset).toBe(first.returnedBytes);

    const second = gitDiff(repo, { mode: "unstaged", offset: first.nextOffset!, maxBytes: 8192 });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);

    // walk to the end
    let offset = 0;
    let assembled = "";
    for (let hop = 0; hop < 1000; hop++) {
      const page = gitDiff(repo, { mode: "unstaged", offset, maxBytes: 65536 });
      assembled += page.diff;
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    expect(assembled.length).toBe(first.totalBytes);
    git(repo, "checkout", "--", "hello.txt");
  });

  it("excludes sensitive files from full-repo diffs", () => {
    write(repo, ".env", "SECRET=1\n");
    git(repo, "add", "-f", ".env");
    write(repo, ".env", "SECRET=leaked-value\n");
    const diff = gitDiff(repo, { mode: "unstaged" });
    expect(diff.diff).not.toContain("leaked-value");
    git(repo, "rm", "-f", "--cached", ".env");
  });

  it("excludes sensitive files from directory-scoped diffs", () => {
    write(repo, "private/.env", "SECRET=1\n");
    git(repo, "add", "-f", "private/.env");
    const diff = gitDiff(repo, { mode: "staged" }, "private");
    expect(diff.diff).not.toContain("SECRET=1");
    git(repo, "rm", "-f", "--cached", "private/.env");
  });

  it("handles non-repos gracefully", () => {
    const diff = gitDiff(plain, { mode: "unstaged" });
    expect(diff.isRepo).toBe(false);
  });

  it("excludes all IgnoreRules sensitive patterns across unstaged, staged, and head modes", () => {
    const sensitiveFiles = [
      { path: ".env", content: "SECRET_KEY=leaked-env\n", sentinel: "leaked-env" },
      { path: ".npmrc", content: "//registry.npmjs.org/:_authToken=leaked-npm\n", sentinel: "leaked-npm" },
      { path: ".netrc", content: "machine github.com password leaked-netrc\n", sentinel: "leaked-netrc" },
      { path: ".aws/credentials", content: "aws_secret_access_key=leaked-aws\n", sentinel: "leaked-aws" },
      { path: "nested/.ssh/config", content: "IdentityFile leaked-ssh\n", sentinel: "leaked-ssh" },
      { path: "credentials.json", content: '{"client_secret": "leaked-creds"}\n', sentinel: "leaked-creds" },
      { path: "service-account-prod.json", content: '{"private_key": "leaked-sa"}\n', sentinel: "leaked-sa" },
      { path: "secrets.json", content: '{"db_pass": "leaked-secrets"}\n', sentinel: "leaked-secrets" },
      { path: "id_ed25519", content: "-----BEGIN OPENSSH PRIVATE KEY-----\nleaked-key\n", sentinel: "leaked-key" },
    ];

    // Also include a safe file to confirm normal diffs are returned alongside excluded secrets
    write(repo, "src/safe.ts", "export const safe = 1;\n");
    git(repo, "add", "src/safe.ts");
    git(repo, "commit", "-m", "add safe file");

    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content);
      git(repo, "add", "-f", item.path);
    }

    // 1. Staged mode
    const stagedDiff = gitDiff(repo, { mode: "staged" });
    for (const item of sensitiveFiles) {
      expect(stagedDiff.diff).not.toContain(item.sentinel);
    }

    // Commit them so we can test unstaged changes and HEAD diffs
    git(repo, "commit", "-m", "tracked sensitive files");

    // 2. Unstaged modifications to tracked sensitive files + normal file
    for (const item of sensitiveFiles) {
      write(repo, item.path, item.content + "# modified-unstaged\n");
    }
    write(repo, "src/safe.ts", "export const safe = 2; // modified-safe\n");

    const unstagedDiff = gitDiff(repo, { mode: "unstaged" });
    expect(unstagedDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(unstagedDiff.diff).not.toContain(item.sentinel);
      expect(unstagedDiff.diff).not.toContain("modified-unstaged");
    }

    // 3. Head mode
    const headDiff = gitDiff(repo, { mode: "head" });
    expect(headDiff.diff).toContain("modified-safe");
    for (const item of sensitiveFiles) {
      expect(headDiff.diff).not.toContain(item.sentinel);
    }

    // Clean up
    git(repo, "checkout", "--", "src/safe.ts", ...sensitiveFiles.map((s) => s.path));
  });

  it("allows .env.example while blocking .env", () => {
    write(repo, ".env.example", "API_URL=https://example.com\n");
    write(repo, ".env", "API_KEY=supersecret-123\n");
    git(repo, "add", "-f", ".env.example", ".env");

    const diff = gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain(".env.example");
    expect(diff.diff).toContain("https://example.com");
    expect(diff.diff).not.toContain("supersecret-123");

    git(repo, "rm", "-f", "--cached", ".env.example", ".env");
  });

  it("respects custom rules in .c2cignore for git diff", () => {
    write(repo, ".c2cignore", "private-notes/\ncustom-secret.txt\n");
    write(repo, "private-notes/secret.md", "CONFIDENTIAL DATA\n");
    write(repo, "custom-secret.txt", "TOP_SECRET_FLAG=1\n");
    write(repo, "public.txt", "PUBLIC CONTENT\n");
    git(repo, "add", "-f", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");

    const diff = gitDiff(repo, { mode: "staged" });
    expect(diff.diff).toContain("public.txt");
    expect(diff.diff).toContain("PUBLIC CONTENT");
    expect(diff.diff).not.toContain("CONFIDENTIAL DATA");
    expect(diff.diff).not.toContain("TOP_SECRET_FLAG");

    git(repo, "rm", "-f", "--cached", ".c2cignore", "private-notes/secret.md", "custom-secret.txt", "public.txt");
  });

  it("handles rename provenance: sensitive->safe, safe->sensitive, safe->safe", () => {
    // 1. Commit baseline files
    write(repo, "old_safe.ts", "export const value = 'old-safe-data';\n");
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=npm-secret-token\n");
    write(repo, "public_to_secret.txt", "harmless text\n");
    git(repo, "add", "-f", "old_safe.ts", ".npmrc", "public_to_secret.txt");
    git(repo, "commit", "-m", "init rename baseline");

    // Case A: Safe -> Safe rename
    git(repo, "mv", "old_safe.ts", "new_safe.ts");
    // Case B: Sensitive -> Safe rename (Must be excluded!)
    git(repo, "mv", ".npmrc", "renamed_public.txt");
    // Case C: Safe -> Sensitive rename (Must be excluded!)
    git(repo, "mv", "public_to_secret.txt", ".env.secret");

    const stagedDiff = gitDiff(repo, { mode: "staged" });

    // Safe->safe rename should appear
    expect(stagedDiff.diff).toContain("old_safe.ts");
    expect(stagedDiff.diff).toContain("new_safe.ts");

    // Sensitive->safe must NOT leak
    expect(stagedDiff.diff).not.toContain("npm-secret-token");
    expect(stagedDiff.diff).not.toContain(".npmrc");
    expect(stagedDiff.diff).not.toContain("renamed_public.txt");

    // Safe->sensitive must NOT appear as sensitive patch
    expect(stagedDiff.diff).not.toContain(".env.secret");

    // Reset repo
    git(repo, "reset", "--hard", "HEAD");
  });

  it("prevents cross-boundary scoped rename provenance leaks with path= scoping", () => {
    // Baseline files
    write(repo, ".npmrc", "//registry.npmjs.org/:_authToken=cross-scope-secret\n");
    write(repo, "src/.npmrc", "//registry.npmjs.org/:_authToken=src-secret\n");
    write(repo, "root_safe.ts", "export const rootSafe = 1;\n");
    write(repo, "public.txt", "public content\n");
    git(repo, "add", "-f", ".npmrc", "src/.npmrc", "root_safe.ts", "public.txt");
    git(repo, "commit", "-m", "baseline for cross-scope rename");

    // 1. Root .npmrc renamed to src/public.txt -> scoped git_diff(path="src")
    git(repo, "mv", ".npmrc", "src/public.txt");

    // 2. public.txt renamed to src/.env -> scoped git_diff(path="src")
    git(repo, "mv", "public.txt", "src/.env");

    // 3. Safe root_safe.ts renamed to src/new_safe.ts -> scoped git_diff(path="src")
    git(repo, "mv", "root_safe.ts", "src/new_safe.ts");

    // 4. src/.npmrc renamed to root_secret_leak.txt -> scoped git_diff(path="src")
    git(repo, "mv", "src/.npmrc", "root_secret_leak.txt");

    const srcDiff = gitDiff(repo, { mode: "staged" }, "src");

    // Safe cross-scope rename is visible
    expect(srcDiff.diff).toContain("root_safe.ts");
    expect(srcDiff.diff).toContain("src/new_safe.ts");

    // Sensitive->safe cross-scope rename MUST NOT leak
    expect(srcDiff.diff).not.toContain("cross-scope-secret");
    expect(srcDiff.diff).not.toContain("src/public.txt");

    // Safe->sensitive cross-scope rename MUST NOT appear
    expect(srcDiff.diff).not.toContain("src/.env");

    // Sensitive deletion from src MUST NOT appear
    expect(srcDiff.diff).not.toContain("src-secret");
    expect(srcDiff.diff).not.toContain("root_secret_leak.txt");

    git(repo, "reset", "--hard", "HEAD");
  });
});
