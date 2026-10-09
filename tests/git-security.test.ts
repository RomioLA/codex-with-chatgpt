import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitDiff, gitInfo, gitRepositoryInfo, gitStatus, selectGitRepository } from "../src/workspace/git.js";
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
});
