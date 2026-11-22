import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnHooks = vi.hoisted(() => ({
  onSpawnSync: null as null | ((args: string[], options: Record<string, unknown>) => void),
  onSpawn: null as null | ((args: string[], options: Record<string, unknown>) => void),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (file: string, args: string[], options: Record<string, unknown>) => {
      spawnHooks.onSpawnSync?.(args, options);
      return actual.spawnSync(file, args, options);
    },
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      spawnHooks.onSpawn?.(args, options);
      return actual.spawn(file, args, options);
    },
  };
});

import {
  gitCompare,
  gitCompareAsync,
  gitDiff,
  gitDiffAsync,
  gitInfo,
  gitInfoAsync,
  gitRepositoryInfo,
  gitRepositoryInfoAsync,
  gitStatus,
  gitStatusAsync,
  resolveGitCommit,
  resolveGitCommitAsync,
  selectGitRepository,
  selectGitRepositoryAsync,
} from "../src/workspace/git.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeGitRepo, makeTmpDir, git, write } from "./helpers.js";

interface GitFixture {
  root: string;
  markerCommand(marker: string): string;
}

function makeFixture(name: string): GitFixture {
  const root = makeTmpDir(`git-security-${name}`);
  makeGitRepo(root);
  const markerScript = write(
    root,
    "marker.mjs",
    "import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'executed');\n"
  );
  return {
    root,
    markerCommand(marker: string) {
      return `node ${markerScript.replace(/\\/g, "/")} ${marker.replace(/\\/g, "/")}`;
    },
  };
}

function withProcessEnv<T>(values: Record<string, string>, action: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Git subprocess execution policy", () => {
  afterEach(() => {
    spawnHooks.onSpawnSync = null;
    spawnHooks.onSpawn = null;
  });

  it("blocks repo-local fsmonitor commands for git_info and git_status", () => {
    const fixture = makeFixture("fsmonitor");
    const marker = path.join(fixture.root, "fsmonitor.marker");
    git(fixture.root, "config", "core.fsmonitor", fixture.markerCommand(marker));

    const info = gitInfo(fixture.root);
    const repositoryInfo = gitRepositoryInfo(selectGitRepository(new Workspace(fixture.root)));
    const status = gitStatus(fixture.root);
    expect(info).toMatchObject({ isRepo: true, branch: "main" });
    expect(repositoryInfo).toMatchObject({ isRepo: true, branch: "main", dirty: true });
    expect(status).toMatchObject({ isRepo: true, branch: "main" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks diff.external in unstaged, staged, and head modes", () => {
    const fixture = makeFixture("external-diff");
    const marker = path.join(fixture.root, "external-diff.marker");
    write(fixture.root, "unstaged.txt", "unstaged base\n");
    write(fixture.root, "staged.txt", "staged base\n");
    git(fixture.root, "add", "unstaged.txt", "staged.txt");
    git(fixture.root, "commit", "-m", "add diff fixtures");
    write(fixture.root, "unstaged.txt", "unstaged safe change\n");
    write(fixture.root, "staged.txt", "staged safe change\n");
    git(fixture.root, "add", "staged.txt");
    git(fixture.root, "config", "diff.external", fixture.markerCommand(marker));

    const unstaged = gitDiff(fixture.root, { mode: "unstaged" });
    const staged = gitDiff(fixture.root, { mode: "staged" });
    const head = gitDiff(fixture.root, { mode: "head" });
    expect(unstaged).toMatchObject({ isRepo: true });
    expect(unstaged.diff).toContain("unstaged safe change");
    expect(staged).toMatchObject({ isRepo: true });
    expect(staged.diff).toContain("staged safe change");
    expect(head).toMatchObject({ isRepo: true });
    expect(head.diff).toContain("unstaged safe change");
    expect(head.diff).toContain("staged safe change");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks a diff driver command selected by .gitattributes", () => {
    const fixture = makeFixture("diff-driver");
    const marker = path.join(fixture.root, "diff-driver.marker");
    write(fixture.root, ".gitattributes", "*.driver diff=external\n");
    write(fixture.root, "sample.driver", "base driver content\n");
    git(fixture.root, "add", ".gitattributes", "sample.driver");
    git(fixture.root, "commit", "-m", "add driver fixture");
    write(fixture.root, "sample.driver", "safe driver change\n");
    git(fixture.root, "config", "diff.external.command", fixture.markerCommand(marker));

    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("safe driver change");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks textconv selected by .gitattributes", () => {
    const fixture = makeFixture("textconv");
    const marker = path.join(fixture.root, "textconv.marker");
    write(fixture.root, ".gitattributes", "*.conv diff=converted\n");
    write(fixture.root, "sample.conv", "base textconv content\n");
    git(fixture.root, "add", ".gitattributes", "sample.conv");
    git(fixture.root, "commit", "-m", "add textconv fixture");
    write(fixture.root, "sample.conv", "safe textconv change\n");
    git(fixture.root, "config", "diff.converted.textconv", fixture.markerCommand(marker));

    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("safe textconv change");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("clears inherited Git authority and config injection variables", () => {
    const fixture = makeFixture("environment");
    const alternate = makeFixture("environment-alternate");
    const marker = path.join(fixture.root, "injected.marker");
    write(fixture.root, "target.txt", "base\n");
    git(fixture.root, "add", "target.txt");
    git(fixture.root, "commit", "-m", "add target");
    write(fixture.root, "target.txt", "safe environment test change\n");

    const injected = {
      GIT_EXTERNAL_DIFF: fixture.markerCommand(marker),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: fixture.markerCommand(marker),
      GIT_DIR: path.join(alternate.root, ".git"),
      GIT_WORK_TREE: alternate.root,
      GIT_COMMON_DIR: path.join(alternate.root, ".git"),
      GIT_INDEX_FILE: path.join(alternate.root, "missing-index"),
      GIT_OBJECT_DIRECTORY: path.join(alternate.root, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(alternate.root, ".git", "objects"),
      GIT_ATTR_NOSYSTEM: "1",
    };

    withProcessEnv(injected, () => {
      const info = gitInfo(fixture.root);
      const status = gitStatus(fixture.root);
      const diff = gitDiff(fixture.root, { mode: "unstaged" });
      expect(info).toMatchObject({ isRepo: true, branch: "main" });
      expect(status).toMatchObject({ isRepo: true, branch: "main" });
      expect(diff.isRepo).toBe(true);
      expect(diff.diff).toContain("safe environment test change");
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  it("disables configured clean filters while keeping ordinary diffs", () => {
    const fixture = makeFixture("clean-filter");
    const marker = path.join(fixture.root, "clean-filter.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
    write(fixture.root, "sample.filtered", "base filter content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add clean filter fixture");
    write(fixture.root, "sample.filtered", "safe filter change\n");
    git(fixture.root, "config", "filter.external.clean", fixture.markerCommand(marker));

    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("safe filter change");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks process filters in diff inventory and patch queries", () => {
    const fixture = makeFixture("diff-process-filter");
    const marker = path.join(fixture.root, "diff-process-filter.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
    write(fixture.root, "sample.filtered", "base process content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add diff process filter fixture");
    write(fixture.root, "sample.filtered", "safe process content\n");
    git(fixture.root, "config", "filter.external.process", fixture.markerCommand(marker));

    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("safe process content");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks clean filters during racy-index status checks", () => {
    const fixture = makeFixture("status-clean-filter");
    const marker = path.join(fixture.root, "status-clean-filter.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
    write(fixture.root, "sample.filtered", "base content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add status filter fixture");
    write(fixture.root, "sample.filtered", "evil content\n");

    const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
    const indexPath = path.join(fixture.root, ".git", "index");
    const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
    fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);
    git(fixture.root, "config", "filter.external.clean", fixture.markerCommand(marker));

    const info = gitInfo(fixture.root);
    const status = gitStatus(fixture.root);
    expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: true });
    expect(status).toMatchObject({ isRepo: true, branch: "main" });
    expect(status.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("blocks process filters during racy-index status checks", () => {
    const fixture = makeFixture("status-process-filter");
    const marker = path.join(fixture.root, "status-process-filter.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
    write(fixture.root, "sample.filtered", "base content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add status process filter fixture");
    write(fixture.root, "sample.filtered", "evil content\n");

    const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
    const indexPath = path.join(fixture.root, ".git", "index");
    const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
    fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);
    git(fixture.root, "config", "filter.external.process", fixture.markerCommand(marker));

    const status = gitStatus(fixture.root);
    expect(status).toMatchObject({ isRepo: true, branch: "main" });
    expect(status.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails closed when a filter subsection contains an equals sign", () => {
    const fixture = makeFixture("filter-key-equals");
    const marker = path.join(fixture.root, "filter-key-equals.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=foo=bar\n");
    write(fixture.root, "sample.filtered", "base content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add filter key fixture");
    write(fixture.root, "sample.filtered", "evil content\n");

    const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
    const indexPath = path.join(fixture.root, ".git", "index");
    const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
    fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);
    fs.appendFileSync(
      path.join(fixture.root, ".git", "config"),
      `\n[filter "foo=bar"]\n\tclean = ${fixture.markerCommand(marker)}\n`
    );

    expect(git(fixture.root, "check-attr", "filter", "--", "sample.filtered").trim())
      .toMatch(/filter: foo=bar$/);
    const info = gitInfo(fixture.root);
    const repositoryInfo = gitRepositoryInfo(selectGitRepository(new Workspace(fixture.root)));
    const status = gitStatus(fixture.root);
    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: null });
    expect(repositoryInfo).toMatchObject({ isRepo: true, dirty: null });
    expect(status.isRepo).toBe(false);
    expect(diff.isRepo).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails closed when a filter subsection contains a Unicode line separator", () => {
    const fixture = makeFixture("filter-key-line-separator");
    const marker = path.join(fixture.root, "filter-key-line-separator.marker");
    const filterName = `foo\u2028bar`;
    write(fixture.root, ".gitattributes", `*.filtered filter=${filterName}\n`);
    write(fixture.root, "sample.filtered", "base content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add Unicode filter key fixture");
    write(fixture.root, "sample.filtered", "evil content\n");

    const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
    const indexPath = path.join(fixture.root, ".git", "index");
    const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
    fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);
    fs.appendFileSync(
      path.join(fixture.root, ".git", "config"),
      `\n[filter "${filterName}"]\n\tclean = ${fixture.markerCommand(marker)}\n`
    );

    expect(git(fixture.root, "check-attr", "filter", "--", "sample.filtered"))
      .toContain(`filter: ${filterName}`);
    const info = gitInfo(fixture.root);
    const repositoryInfo = gitRepositoryInfo(selectGitRepository(new Workspace(fixture.root)));
    const status = gitStatus(fixture.root);
    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: null });
    expect(repositoryInfo).toMatchObject({ isRepo: true, dirty: null });
    expect(status.isRepo).toBe(false);
    expect(diff.isRepo).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails closed before worktree inspection when .git/config contains [include] or [includeIf]", async () => {
    for (const directive of ["include", "includeIf"] as const) {
      const fixture = makeFixture(`config-${directive.toLowerCase()}`);
      const marker = path.join(fixture.root, `${directive}.marker`);
      write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
      write(fixture.root, "sample.filtered", "base content\n");
      git(fixture.root, "add", ".gitattributes", "sample.filtered");
      git(fixture.root, "commit", "-m", "add include filter fixture");
      write(fixture.root, "sample.filtered", "evil content\n");

      const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
      const indexPath = path.join(fixture.root, ".git", "index");
      const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
      fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);

      const includedConfig = write(
        fixture.root,
        "included.gitconfig",
        `[filter "external"]\n\tclean = ${fixture.markerCommand(marker)}\n`
      );
      const sectionHeader =
        directive === "include"
          ? "[include]"
          : `[includeIf "gitdir:${fixture.root.replace(/\\/g, "/")}/"]`;
      fs.appendFileSync(
        path.join(fixture.root, ".git", "config"),
        `\n${sectionHeader}\n\tpath = ${includedConfig.replace(/\\/g, "/")}\n`
      );

      const info = gitInfo(fixture.root);
      const infoAsync = await gitInfoAsync(fixture.root);
      const workspace = new Workspace(fixture.root);
      const repositoryInfo = gitRepositoryInfo(selectGitRepository(workspace));
      const repositoryInfoAsync = await gitRepositoryInfoAsync(await selectGitRepositoryAsync(workspace));
      const status = gitStatus(fixture.root);
      const statusAsync = await gitStatusAsync(fixture.root);
      const diff = gitDiff(fixture.root, { mode: "unstaged" });
      const diffAsync = await gitDiffAsync(fixture.root, { mode: "unstaged" });

      expect(info).toMatchObject({ isRepo: true, branch: "main", dirty: null });
      expect(infoAsync).toMatchObject({ isRepo: true, branch: "main", dirty: null });
      expect(repositoryInfo).toMatchObject({ isRepo: true, dirty: null });
      expect(repositoryInfoAsync).toMatchObject({ isRepo: true, dirty: null });
      expect(status.isRepo).toBe(false);
      expect(statusAsync.isRepo).toBe(false);
      expect(diff.isRepo).toBe(false);
      expect(diffAsync.isRepo).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  it("blocks filters configured in .git/config.worktree across sync and async status and diff", async () => {
    const fixture = makeFixture("config-worktree");
    const marker = path.join(fixture.root, "worktree-filter.marker");
    write(fixture.root, ".gitattributes", "*.filtered filter=external\n");
    write(fixture.root, "sample.filtered", "base worktree content\n");
    git(fixture.root, "add", ".gitattributes", "sample.filtered");
    git(fixture.root, "commit", "-m", "add worktree config filter fixture");
    write(fixture.root, "sample.filtered", "changed worktree content\n");

    const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
    const indexPath = path.join(fixture.root, ".git", "index");
    const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
    fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);

    git(fixture.root, "config", "extensions.worktreeConfig", "true");
    git(fixture.root, "config", "--worktree", "filter.external.clean", fixture.markerCommand(marker));

    const status = gitStatus(fixture.root);
    const statusAsync = await gitStatusAsync(fixture.root);
    const diff = gitDiff(fixture.root, { mode: "unstaged" });
    const diffAsync = await gitDiffAsync(fixture.root, { mode: "unstaged" });

    expect(status).toMatchObject({ isRepo: true, branch: "main" });
    expect(status.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(statusAsync).toMatchObject({ isRepo: true, branch: "main" });
    expect(statusAsync.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(diff.isRepo).toBe(true);
    expect(diff.diff).toContain("changed worktree content");
    expect(diffAsync.isRepo).toBe(true);
    expect(diffAsync.diff).toContain("changed worktree content");
    expect(fs.existsSync(marker)).toBe(false);

    // Unsafe filter key inside config.worktree must also fail closed.
    fs.appendFileSync(
      path.join(fixture.root, ".git", "config.worktree"),
      `\n[filter "foo=bar"]\n\tclean = ${fixture.markerCommand(marker)}\n`
    );
    expect(gitStatus(fixture.root).isRepo).toBe(false);
    expect((await gitStatusAsync(fixture.root)).isRepo).toBe(false);
    expect(gitDiff(fixture.root, { mode: "unstaged" }).isRepo).toBe(false);
    expect((await gitDiffAsync(fixture.root, { mode: "unstaged" })).isRepo).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("isolates status and diff from concurrent .git/config filter injection after enumeration", async () => {
    const setupRaceFixture = (name: string) => {
      const fixture = makeFixture(name);
      const marker = path.join(fixture.root, `${name}.marker`);
      write(fixture.root, ".gitattributes", "*.filtered filter=race\n");
      write(fixture.root, "sample.filtered", "base race content\n");
      git(fixture.root, "add", ".gitattributes", "sample.filtered");
      git(fixture.root, "commit", "-m", "add TOCTOU race fixture");
      write(fixture.root, "sample.filtered", "modified race content\n");

      const sampleMtime = fs.statSync(path.join(fixture.root, "sample.filtered")).mtime;
      const indexPath = path.join(fixture.root, ".git", "index");
      const oldIndexMtime = new Date(sampleMtime.getTime() - 5000);
      fs.utimesSync(indexPath, oldIndexMtime, oldIndexMtime);
      return { fixture, marker };
    };

    const assertControlledViewAndInject = (
      args: string[],
      options: Record<string, unknown>,
      repoRoot: string,
      marker: string,
      injectedFlag: { count: number }
    ) => {
      const isWorktreeCommand = args.includes("status") || args.includes("diff");
      if (!isWorktreeCommand) return;
      const env = options.env as NodeJS.ProcessEnv;
      expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
      expect(env.GIT_ATTR_NOSYSTEM).toBe("1");
      expect(env.GIT_DIR).toBeTruthy();
      expect(path.resolve(env.GIT_DIR!)).not.toBe(path.resolve(path.join(repoRoot, ".git")));

      injectedFlag.count += 1;
      fs.appendFileSync(
        path.join(repoRoot, ".git", "config"),
        `\n[filter "race"]\n\tclean = ${`node ${path.join(repoRoot, "marker.mjs").replace(/\\/g, "/")} ${marker.replace(/\\/g, "/")}`}\n`
      );
    };

    // Sync TOCTOU race test
    const syncCase = setupRaceFixture("toctou-sync");
    const syncInjected = { count: 0 };
    spawnHooks.onSpawnSync = (args, options) => {
      assertControlledViewAndInject(args, options, syncCase.fixture.root, syncCase.marker, syncInjected);
    };
    const syncStatus = gitStatus(syncCase.fixture.root);
    expect(syncInjected.count).toBe(1);
    expect(syncStatus).toMatchObject({ isRepo: true, branch: "main" });
    expect(syncStatus.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(fs.existsSync(syncCase.marker)).toBe(false);

    // Async TOCTOU race test (status + diff)
    const asyncCase = setupRaceFixture("toctou-async");
    const asyncInjected = { count: 0 };
    spawnHooks.onSpawn = (args, options) => {
      assertControlledViewAndInject(args, options, asyncCase.fixture.root, asyncCase.marker, asyncInjected);
    };
    const asyncStatus = await gitStatusAsync(asyncCase.fixture.root);
    expect(asyncInjected.count).toBeGreaterThanOrEqual(1);
    expect(asyncStatus).toMatchObject({ isRepo: true, branch: "main" });
    expect(asyncStatus.unstaged.map((entry) => entry.path)).toContain("sample.filtered");
    expect(fs.existsSync(asyncCase.marker)).toBe(false);

    // Clean config before testing gitDiffAsync race so enumeration sees no filter yet.
    const diffCase = setupRaceFixture("toctou-async-diff");
    const diffInjected = { count: 0 };
    spawnHooks.onSpawn = (args, options) => {
      assertControlledViewAndInject(args, options, diffCase.fixture.root, diffCase.marker, diffInjected);
    };
    const asyncDiff = await gitDiffAsync(diffCase.fixture.root, { mode: "unstaged" });
    expect(diffInjected.count).toBeGreaterThanOrEqual(1);
    expect(asyncDiff.isRepo).toBe(true);
    expect(asyncDiff.diff).toContain("modified race content");
    expect(fs.existsSync(diffCase.marker)).toBe(false);
  });

  it("fails closed when repository metadata directories are reparse points", () => {
    const fixture = makeFixture("reparse-info");
    const realInfo = path.join(fixture.root, ".git", "info");
    const targetDir = makeTmpDir("git-security-reparse-target");
    fs.writeFileSync(path.join(targetDir, "exclude"), "*.tmp\n");
    fs.unlinkSync(path.join(realInfo, "exclude"));
    fs.rmdirSync(realInfo);
    fs.symlinkSync(targetDir, realInfo, process.platform === "win32" ? "junction" : "dir");

    expect(gitStatus(fixture.root).isRepo).toBe(false);
    expect(gitDiff(fixture.root, { mode: "unstaged" }).isRepo).toBe(false);
    expect(gitInfo(fixture.root)).toMatchObject({ isRepo: true, dirty: null });
  });

  it("blocks submodule worktree recursion and inline diff while preserving gitlink changes", async () => {
    const subSource = makeTmpDir("git-security-sub-source");
    makeGitRepo(subSource);
    write(subSource, "tracked.sub", "sub v1\n");
    write(subSource, ".gitattributes", "*.sub filter=subtrap\n");
    git(subSource, "add", ".");
    git(subSource, "commit", "-m", "sub v1");
    const subCommit1 = git(subSource, "rev-parse", "HEAD").trim();

    write(subSource, "tracked.sub", "sub v2\n");
    git(subSource, "add", ".");
    git(subSource, "commit", "-m", "sub v2");
    const subCommit2 = git(subSource, "rev-parse", "HEAD").trim();

    const fixture = makeFixture("submodule-filter");
    const subMarker = path.join(fixture.root, "submodule-filter.marker");
    git(fixture.root, "-c", "protocol.file.allow=always", "submodule", "add", subSource, "sub");
    const subWorktree = path.join(fixture.root, "sub");
    git(subWorktree, "checkout", subCommit1);
    git(fixture.root, "add", ".gitmodules", "sub");
    git(fixture.root, "commit", "-m", "add submodule at v1");
    const baseSuperCommit = git(fixture.root, "rev-parse", "HEAD").trim();

    // Configure an active clean filter inside the submodule's own config, plus recursive/inline settings in superproject.
    git(subWorktree, "config", "filter.subtrap.clean", fixture.markerCommand(subMarker));
    git(fixture.root, "config", "diff.submodule", "diff");
    git(fixture.root, "config", "status.submodulesummary", "true");
    git(fixture.root, "config", "submodule.recurse", "true");

    // Dirty the submodule worktree and backdate its index so any child git status/diff inside sub would invoke subtrap.
    write(subWorktree, "tracked.sub", "dirty in submodule worktree\n");
    write(subWorktree, "untracked.txt", "untracked inside submodule\n");
    const subGitModulesIndex = path.join(fixture.root, ".git", "modules", "sub", "index");
    if (fs.existsSync(subGitModulesIndex)) {
      const stale = new Date(fs.statSync(path.join(subWorktree, "tracked.sub")).mtime.getTime() - 5000);
      fs.utimesSync(subGitModulesIndex, stale, stale);
    }

    // Dirty submodule worktree alone should be ignored without running submodule filters.
    expect(gitStatus(fixture.root).unstaged.map((e) => e.path)).not.toContain("sub");
    expect((await gitStatusAsync(fixture.root)).unstaged.map((e) => e.path)).not.toContain("sub");
    expect(gitDiff(fixture.root, { mode: "unstaged" }).diff).toBe("");
    expect((await gitDiffAsync(fixture.root, { mode: "unstaged" })).diff).toBe("");
    expect(fs.existsSync(subMarker)).toBe(false);

    // Advance submodule gitlink commit while keeping dirty worktree inside submodule.
    git(subWorktree, "-c", "filter.subtrap.clean=", "checkout", "-f", subCommit2);
    write(subWorktree, "tracked.sub", "dirty after checkout\n");
    if (fs.existsSync(subGitModulesIndex)) {
      const stale = new Date(fs.statSync(path.join(subWorktree, "tracked.sub")).mtime.getTime() - 5000);
      fs.utimesSync(subGitModulesIndex, stale, stale);
    }

    const unstagedStatus = gitStatus(fixture.root);
    const unstagedStatusAsync = await gitStatusAsync(fixture.root);
    expect(unstagedStatus.unstaged.map((e) => e.path)).toContain("sub");
    expect(unstagedStatusAsync.unstaged.map((e) => e.path)).toContain("sub");

    const unstagedDiff = gitDiff(fixture.root, { mode: "unstaged" });
    const unstagedDiffAsync = await gitDiffAsync(fixture.root, { mode: "unstaged" });
    expect(unstagedDiff.diff).toContain(`-Subproject commit ${subCommit1}`);
    expect(unstagedDiff.diff).toContain(`+Subproject commit ${subCommit2}`);
    expect(unstagedDiff.diff).not.toContain("dirty after checkout");
    expect(unstagedDiffAsync.diff).toContain(`+Subproject commit ${subCommit2}`);
    expect(unstagedDiffAsync.diff).not.toContain("dirty after checkout");

    git(fixture.root, "add", "sub");
    git(fixture.root, "commit", "-m", "advance submodule gitlink");
    const headSuperCommit = git(fixture.root, "rev-parse", "HEAD").trim();

    const compareSync = gitCompare(fixture.root, { baseCommit: baseSuperCommit, headCommit: headSuperCommit });
    const compareAsync = await gitCompareAsync(fixture.root, { baseCommit: baseSuperCommit, headCommit: headSuperCommit });
    expect(compareSync.files.map((f) => f.path)).toContain("sub");
    expect(compareSync.diff).toContain(`+Subproject commit ${subCommit2}`);
    expect(compareSync.diff).not.toContain("sub v2");
    expect(compareAsync.files.map((f) => f.path)).toContain("sub");
    expect(fs.existsSync(subMarker)).toBe(false);
  });

  it("disables partial-clone lazy fetch across read-only Git entry points", async () => {
    const originRoot = makeTmpDir("git-security-partial-origin");
    makeGitRepo(originRoot);
    git(originRoot, "config", "uploadpack.allowFilter", "true");
    write(originRoot, "secret-blob.txt", "first partial blob content\n");
    git(originRoot, "add", ".");
    git(originRoot, "commit", "-m", "c1");
    const c1 = git(originRoot, "rev-parse", "HEAD").trim();

    write(originRoot, "secret-blob.txt", "second partial blob content\n");
    git(originRoot, "add", ".");
    git(originRoot, "commit", "-m", "c2");
    const c2 = git(originRoot, "rev-parse", "HEAD").trim();

    const partialParent = makeTmpDir("git-security-partial-clone");
    const partialRoot = path.join(partialParent, "clone");
    const originFileUrl = `file:///${originRoot.replace(/\\/g, "/").replace(/^\/+/, "")}`;
    git(partialParent, "-c", "protocol.file.allow=always", "clone", "--no-local", "--filter=blob:none", "--no-checkout", originFileUrl, partialRoot);

    const markerHost = makeFixture("partial-marker-host");
    const fetchMarker = path.join(markerHost.root, "lazy-fetch.marker");
    git(partialRoot, "config", "remote.origin.uploadpack", markerHost.markerCommand(fetchMarker));

    const observedCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    spawnHooks.onSpawnSync = (args, options) => {
      observedCalls.push({ args: [...args], env: { ...(options.env as NodeJS.ProcessEnv) } });
    };
    spawnHooks.onSpawn = (args, options) => {
      observedCalls.push({ args: [...args], env: { ...(options.env as NodeJS.ProcessEnv) } });
    };

    // Diffing c1..c2 requires missing promisor blobs; read-only Git must fail closed without lazy-fetching.
    const compareSync = gitCompare(partialRoot, { baseCommit: c1, headCommit: c2 });
    const compareAsync = await gitCompareAsync(partialRoot, { baseCommit: c1, headCommit: c2 });
    expect(compareSync.isRepo).toBe(false);
    expect(compareAsync.isRepo).toBe(false);

    expect(gitStatus(partialRoot).isRepo).toBe(true);
    expect((await gitStatusAsync(partialRoot)).isRepo).toBe(true);
    expect(gitDiff(partialRoot, { mode: "head" }).isRepo).toBe(false);
    expect((await gitDiffAsync(partialRoot, { mode: "head" })).isRepo).toBe(false);
    expect(resolveGitCommit(partialRoot, c1)).toBe(c1);
    expect(await resolveGitCommitAsync(partialRoot, c2)).toBe(c2);
    expect(fs.existsSync(fetchMarker)).toBe(false);

    // Pre-Git-2.45 compatibility: lazy fetch is disabled via GIT_NO_LAZY_FETCH=1 env rather than CLI --no-lazy-fetch.
    expect(observedCalls.length).toBeGreaterThan(0);
    for (const call of observedCalls) {
      expect(call.args).not.toContain("--no-lazy-fetch");
      expect(call.env.GIT_NO_LAZY_FETCH).toBe("1");
      expect(call.env.GIT_ALLOW_PROTOCOL).toBe("");
    }
  });
});
