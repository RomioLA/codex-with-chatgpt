import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitCompare, gitDiff, gitInfo, gitStatus, runGit } from "../src/workspace/git.js";
import { resolveGitExecutable } from "../src/git-write/security.js";
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

it.skipIf(process.platform !== "win32")("ignores a PATH-front fake git.exe for every read-only Git operation", () => {
  const isolated = makeTmpDir("git-path-spoof-workspace");
  makeGitRepo(isolated);
  const base = git(isolated, "rev-parse", "HEAD").trim();
  write(isolated, "hello.txt", "historical update\n");
  git(isolated, "add", "hello.txt");
  git(isolated, "commit", "-m", "historical update");
  const head = git(isolated, "rev-parse", "HEAD").trim();
  write(isolated, "hello.txt", "working tree update\n");

  const fakeBin = makeTmpDir("git-path-spoof-bin");
  const fakeGit = path.join(fakeBin, "git.exe");
  const whereExecutable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
  fs.copyFileSync(whereExecutable, fakeGit);
  const marker = path.join(fakeBin, "fake-git-started.txt");
  const markerLoader = write(fakeBin, "marker-loader.cjs",
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
  const trustedGit = resolveGitExecutable().path;
  const originalPath = process.env.PATH;
  const originalTrustedGit = process.env.C2C_TRUSTED_GIT_EXECUTABLE;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = [fakeBin, originalPath ?? ""].filter(Boolean).join(path.delimiter);
  process.env.C2C_TRUSTED_GIT_EXECUTABLE = trustedGit;
  process.env.NODE_OPTIONS = `--require=${markerLoader}`;

  try {
    const info = gitInfo(isolated);
    expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: true });
    expect(gitStatus(isolated).isRepo).toBe(true);
    expect(gitDiff(isolated, { mode: "unstaged" }).diff).toContain("working tree update");
    const comparison = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(comparison.isRepo).toBe(true);
    expect(comparison.diff).toContain("historical update");
    const branches = runGit(isolated, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"]);
    expect(branches.ok).toBe(true);
    expect(branches.stdout).toContain("refs/heads/main");
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalTrustedGit === undefined) delete process.env.C2C_TRUSTED_GIT_EXECUTABLE;
    else process.env.C2C_TRUSTED_GIT_EXECUTABLE = originalTrustedGit;
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
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

describe("gitCompare historical commits", () => {
  it("returns changed-file stats and a unified diff for two exact commits", () => {
    const isolated = makeTmpDir("git-compare-basic");
    makeGitRepo(isolated);
    const base = git(isolated, "rev-parse", "HEAD").trim();

    write(isolated, "hello.txt", "historical compare changed\n");
    write(isolated, "src/new-file.ts", "export const created = true;\n");
    git(isolated, "add", "hello.txt", "src/new-file.ts");
    git(isolated, "commit", "-m", "compare fixture");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base.slice(0, 7), headCommit: head.slice(0, 7) });

    expect(compared.isRepo).toBe(true);
    expect(compared.baseCommit).toBe(base);
    expect(compared.headCommit).toBe(head);
    expect(compared.diff).toContain("historical compare changed");
    expect(compared.diff).toContain("src/new-file.ts");
    expect(compared.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "hello.txt", status: "M", binary: false }),
      expect.objectContaining({ path: "src/new-file.ts", status: "A", binary: false }),
    ]));
    const hello = compared.files.find((item) => item.path === "hello.txt");
    expect(hello?.additions).not.toBeNull();
    expect(hello?.deletions).not.toBeNull();
  });

  it("preserves rename provenance while withholding sensitive historical paths", () => {
    const isolated = makeTmpDir("git-compare-rename-sensitive");
    makeGitRepo(isolated);
    write(isolated, "rename-source.txt", "rename me\n");
    write(isolated, ".env", "SECRET=baseline-secret\n");
    git(isolated, "add", "-f", "rename-source.txt", ".env");
    git(isolated, "commit", "-m", "compare rename baseline");
    const base = git(isolated, "rev-parse", "HEAD").trim();

    git(isolated, "mv", "rename-source.txt", "rename-target.txt");
    write(isolated, ".env", "SECRET=changed-secret\n");
    git(isolated, "add", "-f", ".env", "rename-target.txt");
    git(isolated, "commit", "-m", "rename and sensitive change");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base, headCommit: head });

    expect(compared.isRepo).toBe(true);
    expect(compared.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "rename-target.txt",
        previousPath: "rename-source.txt",
        status: expect.stringMatching(/^R/),
      }),
    ]));
    expect(compared.diff).toContain("rename-source.txt");
    expect(compared.diff).toContain("rename-target.txt");
    expect(compared.diff).not.toContain(".env");
    expect(compared.diff).not.toContain("changed-secret");
    expect(compared.files.some((item) => item.path === ".env")).toBe(false);
  });

  it("reports binary historical changes without inventing line statistics", () => {
    const isolated = makeTmpDir("git-compare-binary");
    makeGitRepo(isolated);
    fs.writeFileSync(path.join(isolated, "asset.bin"), Buffer.from([0, 1, 2, 3]));
    git(isolated, "add", "asset.bin");
    git(isolated, "commit", "-m", "binary baseline");
    const base = git(isolated, "rev-parse", "HEAD").trim();

    fs.writeFileSync(path.join(isolated, "asset.bin"), Buffer.from([0, 1, 9, 3, 4]));
    git(isolated, "add", "asset.bin");
    git(isolated, "commit", "-m", "binary change");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(compared.isRepo).toBe(true);
    expect(compared.files).toEqual([
      expect.objectContaining({
        path: "asset.bin",
        status: "M",
        additions: null,
        deletions: null,
        binary: true,
      }),
    ]);
    expect(compared.diff).toContain("Binary files");
  });

  it("supports repository-relative path scoping", () => {
    const isolated = makeTmpDir("git-compare-scope");
    makeGitRepo(isolated);
    write(isolated, "docs/a.txt", "a0\n");
    write(isolated, "src/a.ts", "export const a = 0;\n");
    git(isolated, "add", "docs/a.txt", "src/a.ts");
    git(isolated, "commit", "-m", "scope baseline");
    const base = git(isolated, "rev-parse", "HEAD").trim();

    write(isolated, "docs/a.txt", "a1\n");
    write(isolated, "src/a.ts", "export const a = 1;\n");
    git(isolated, "add", "docs/a.txt", "src/a.ts");
    git(isolated, "commit", "-m", "scope change");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base, headCommit: head }, "src");

    expect(compared.isRepo).toBe(true);
    expect(compared.diff).toContain("src/a.ts");
    expect(compared.diff).not.toContain("docs/a.txt");
    expect(compared.files.map((item) => item.path)).toEqual(["src/a.ts"]);
  });

  it("uses exact A/B tree comparison semantics instead of merge-base semantics", () => {
    const isolated = makeTmpDir("git-compare-diverged");
    makeGitRepo(isolated);
    write(isolated, "forked.txt", "common-base\n");
    git(isolated, "add", "forked.txt");
    git(isolated, "commit", "-m", "common compare base");
    const common = git(isolated, "rev-parse", "HEAD").trim();

    git(isolated, "checkout", "-b", "compare-left");
    write(isolated, "forked.txt", "left-only\n");
    git(isolated, "add", "forked.txt");
    git(isolated, "commit", "-m", "left side");
    const left = git(isolated, "rev-parse", "HEAD").trim();

    git(isolated, "checkout", "-b", "compare-right", common);
    write(isolated, "forked.txt", "right-only\n");
    git(isolated, "add", "forked.txt");
    git(isolated, "commit", "-m", "right side");
    const right = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: left, headCommit: right });
    expect(compared.isRepo).toBe(true);
    expect(compared.diff).toContain("-left-only");
    expect(compared.diff).toContain("+right-only");
    expect(compared.diff).not.toContain("-common-base");
  });

  it("does not run configured external diff or textconv helpers", () => {
    const isolated = makeTmpDir("git-compare-no-helpers");
    makeGitRepo(isolated);
    write(isolated, ".gitattributes", "*.txt diff=c2c\n");
    write(isolated, "compare.txt", "base contents\n");
    git(isolated, "add", ".gitattributes", "compare.txt");
    git(isolated, "commit", "-m", "helper test baseline");
    const base = git(isolated, "rev-parse", "HEAD").trim();
    write(isolated, "compare.txt", "changed contents\n");
    git(isolated, "add", "compare.txt");
    git(isolated, "commit", "-m", "helper test change");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const marker = path.join(isolated, "diff-helper.marker");
    const helper = write(isolated, "diff-helper.mjs", [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`,
      "console.log('helper output');",
      "",
    ].join("\n"));
    const helperCommand = `"${process.execPath.replace(/\\/g, "/")}" "${helper.replace(/\\/g, "/")}"`;
    git(isolated, "config", "diff.external", helperCommand);
    git(isolated, "config", "diff.c2c.textconv", helperCommand);
    expect(git(isolated, "config", "diff.external").trim()).toBe(helperCommand);
    expect(git(isolated, "config", "diff.c2c.textconv").trim()).toBe(helperCommand);

    git(isolated, "diff", "--ext-diff", base, head, "--", ".");
    expect(fs.readFileSync(marker, "utf8")).toBe("executed");
    fs.unlinkSync(marker);

    const withExternalConfigured = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(withExternalConfigured.isRepo).toBe(true);
    expect(withExternalConfigured.diff).toContain("changed contents");
    expect(fs.existsSync(marker)).toBe(false);

    git(isolated, "config", "--unset", "diff.external");
    git(isolated, "diff", "--textconv", base, head, "--", ".");
    expect(fs.readFileSync(marker, "utf8")).toBe("executed");
    fs.unlinkSync(marker);

    const withTextconvConfigured = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(withTextconvConfigured.isRepo).toBe(true);
    expect(withTextconvConfigured.diff).toContain("base contents");
    expect(withTextconvConfigured.diff).toContain("changed contents");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("keeps both sides of a rename in one diff batch at the path-count boundary", () => {
    const isolated = makeTmpDir("git-compare-rename-batch");
    makeGitRepo(isolated);
    write(isolated, "rename-source.txt", "rename payload\n");
    git(isolated, "add", "rename-source.txt");
    git(isolated, "commit", "-m", "rename source");
    const base = git(isolated, "rev-parse", "HEAD").trim();

    for (let index = 0; index < 49; index += 1) {
      write(isolated, `a${String(index).padStart(2, "0")}.txt`, `added ${index}\n`);
    }
    git(isolated, "add", ".");
    git(isolated, "mv", "rename-source.txt", "rename-target.txt");
    git(isolated, "commit", "-m", "many files and rename");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(compared.isRepo).toBe(true);
    expect(compared.files).toHaveLength(50);
    expect(compared.files.filter((item) => item.status.startsWith("R"))).toHaveLength(1);
    expect(compared.diff.match(/diff --git a\/rename-source\.txt b\/rename-target\.txt/g)).toHaveLength(1);
    expect(compared.diff).toContain("rename from rename-source.txt");
    expect(compared.diff).toContain("rename to rename-target.txt");
  });

  it("paginates a long UTF-8 diff line without losing bytes or splitting a code point", () => {
    const isolated = makeTmpDir("git-compare-pagination-utf8");
    makeGitRepo(isolated);
    const base = git(isolated, "rev-parse", "HEAD").trim();
    write(isolated, "long-line.txt", `${"漢🙂".repeat(7000)}\n`);
    git(isolated, "add", "long-line.txt");
    git(isolated, "commit", "-m", "long unicode line");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const expected = git(isolated, "diff", "--relative", "--no-color", "--find-renames=1%", base, head, "--", ".");
    const pages: string[] = [];
    let offset = 0;
    for (let pageCount = 0; pageCount < 64; pageCount += 1) {
      const page = gitCompare(isolated, { baseCommit: base, headCommit: head, offset, maxBytes: 16_384 });
      pages.push(page.diff);
      expect(page.returnedBytes).toBe(Buffer.byteLength(page.diff, "utf8"));
      expect(page.diff).not.toContain("\uFFFD");
      if (!page.hasMore) break;
      expect(page.nextOffset).toBe(page.offset + page.returnedBytes);
      offset = page.nextOffset!;
      if (pageCount === 63) throw new Error("UTF8_DIFF_PAGINATION_DID_NOT_FINISH");
    }
    expect(pages.join("")).toBe(expected);
  });

  it.skipIf(process.platform !== "win32")("withholds case variants of sensitive historical paths on Windows", () => {
    const isolated = makeTmpDir("git-compare-sensitive-case");
    makeGitRepo(isolated);
    write(isolated, ".ENV", "TOKEN=case-variant-secret\n");
    git(isolated, "add", "-f", ".ENV");
    git(isolated, "commit", "-m", "sensitive case baseline");
    const base = git(isolated, "rev-parse", "HEAD").trim();
    write(isolated, ".ENV", "TOKEN=changed-case-variant-secret\n");
    git(isolated, "add", "-f", ".ENV");
    git(isolated, "commit", "-m", "sensitive case change");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const compared = gitCompare(isolated, { baseCommit: base, headCommit: head });
    expect(compared.isRepo).toBe(true);
    expect(compared.files.some((item) => item.path.toLowerCase() === ".env")).toBe(false);
    expect(compared.diff).not.toContain("case-variant-secret");
  });

  it("paginates historical diff output by byte offset", () => {
    const isolated = makeTmpDir("git-compare-pagination");
    makeGitRepo(isolated);
    const base = git(isolated, "rev-parse", "HEAD").trim();

    const body = Array.from({ length: 3000 }, (_, i) => `row-${i}-${"x".repeat(50)}`).join("\n") + "\n";
    write(isolated, "large.txt", body);
    git(isolated, "add", "large.txt");
    git(isolated, "commit", "-m", "large compare fixture");
    const head = git(isolated, "rev-parse", "HEAD").trim();

    const first = gitCompare(isolated, { baseCommit: base, headCommit: head, maxBytes: 8192 });
    expect(first.hasMore).toBe(true);
    expect(first.diff.endsWith("\n")).toBe(true);
    expect(first.nextOffset).toBe(first.returnedBytes);

    const second = gitCompare(isolated, {
      baseCommit: base,
      headCommit: head,
      offset: first.nextOffset!,
      maxBytes: 8192,
    });
    expect(second.offset).toBe(first.nextOffset);
    expect(second.diff.length).toBeGreaterThan(0);
  });
});
