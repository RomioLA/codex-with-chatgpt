import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveGitRepository,
  confirmGitWriteState,
  GitWriteError,
  planGitWrite,
  previewGitRepositoryApproval,
  type GitWriteOperation,
  type GitWritePlan,
} from "../src/git-write/index.js";
import { getGitWriteEnvironment, validateGitConfig } from "../src/git-write/security.js";
import { Workspace } from "../src/workspace/manager.js";
import { git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let previousStateDir: string | undefined;

function makeApprovedRepo() {
  const root = makeTmpDir("git-write-repo");
  makeGitRepo(root);
  git(root, "config", "user.name", "C2C local author");
  git(root, "config", "user.email", "c2c-author@example.invalid");
  git(root, "remote", "add", "origin", "https://example.invalid/c2c.git");
  const workspace = new Workspace(root);
  const policy = {
    localApproval: true as const,
    allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
    allowedBranches: ["main", "feature/test"],
    allowedOperations: ["add", "commit", "push", "branch_list", "branch_create", "switch", "fetch", "pull_ff_only"] as GitWriteOperation["kind"][],
    approvedProxy: "http://127.0.0.1:7897",
  };
  const preview = previewGitRepositoryApproval(workspace, ".", policy);
  approveGitRepository(workspace, ".", policy, preview.digest);
  const expectedHead = git(root, "rev-parse", "HEAD").trim();
  return { root, workspace, expectedHead };
}

function baseOperation(expectedHead: string): GitWriteOperation {
  return { kind: "branch_list", expectedHead, expectedBranch: "main" };
}

function executePlannedGit(plan: GitWritePlan, cwd: string): string {
  const cleared = new Set(plan.clearEnvironment.map((key) => key.toUpperCase()));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith("GIT_") && !cleared.has(key.toUpperCase()) && process.env[key] !== undefined
  )) as NodeJS.ProcessEnv;
  Object.assign(env, plan.environment);
  const result = spawnSync(plan.executable, plan.args, {
    cwd,
    encoding: "utf8",
    env,
    timeout: 30_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`planned git failed (${result.status ?? result.signal ?? result.error?.message}): ${result.stderr ?? ""}`);
  }
  return result.stdout;
}

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  isolateStateDir();
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("Git write planning", () => {
  it("executes the exact planned add, commit, branch-create, list, and switch commands", () => {
    const { root, workspace } = makeApprovedRepo();
    const initialHead = git(root, "rev-parse", "HEAD").trim();
    const stagedFile = write(root, "planned.txt", "created by plan execution\n");

    const add = planGitWrite(workspace, ".", {
      kind: "add", paths: ["planned.txt"], expectedHead: initialHead, expectedBranch: "main",
    });
    expect(add.args.some((argument) => argument.startsWith("http.proxy="))).toBe(false);
    expect(add.args.at(-2)).toBe("--");
    executePlannedGit(add, root);
    expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("planned.txt");

    const commit = planGitWrite(workspace, ".", {
      kind: "commit", message: "commit via planned args", expectedHead: initialHead, expectedBranch: "main",
    });
    executePlannedGit(commit, root);
    const committedHead = git(root, "rev-parse", "HEAD").trim();
    expect(committedHead).not.toBe(initialHead);
    expect(git(root, "show", "-s", "--format=%s", "HEAD").trim()).toBe("commit via planned args");
    expect(fs.existsSync(stagedFile)).toBe(true);

    const create = planGitWrite(workspace, ".", {
      kind: "branch_create", name: "feature/test", expectedHead: committedHead, expectedBranch: "main",
    });
    executePlannedGit(create, root);
    expect(git(root, "show-ref", "--verify", "refs/heads/feature/test")).toContain("refs/heads/feature/test");

    const list = planGitWrite(workspace, ".", {
      kind: "branch_list", expectedHead: committedHead, expectedBranch: "main",
    });
    const branches = executePlannedGit(list, root);
    expect(branches).toContain("main");
    expect(branches).toContain("feature/test");

    const switching = planGitWrite(workspace, ".", {
      kind: "switch", name: "feature/test", expectedHead: committedHead, expectedBranch: "main",
    });
    expect(switching.materials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}HEAD`))).toBe(false);
    expect(switching.snapshotMaterials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}HEAD`))).toBe(true);
    executePlannedGit(switching, root);
    expect(git(root, "branch", "--show-current").trim()).toBe("feature/test");
  });

  it("normalizes the optional status hash and confirms the expected repository state", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    const operation = baseOperation(expectedHead);
    const plan = planGitWrite(workspace, ".", operation);

    expect(plan.operation.expectedStatusHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(plan.before).toMatchObject({ repositoryIdentity: plan.repository.identity, head: expectedHead, branch: "main" });
    expect(plan.before.executableFileIdentity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    expect(plan.before.executableHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(plan.snapshotMaterials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}index`))).toBe(true);
    expect(plan.materials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}index`))).toBe(false);
    expect(plan.materials.some((item) => item.path.endsWith(`${path.sep}git-remote-https.exe`))).toBe(true);
    expect(plan.materials.some((item) => item.path.toLowerCase().includes(`${path.sep}mingw64${path.sep}bin${path.sep}git.exe`.toLowerCase()))).toBe(true);
    expect(plan.materials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}HEAD`))).toBe(true);
    expect(plan.materials.length).toBeLessThanOrEqual(256);
    expect(plan.environment).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "NUL",
      GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GCM_INTERACTIVE: "Never",
    });
    expect(confirmGitWriteState(workspace, ".", plan.before).state).toBe("confirmed");

    write(root, "hello.txt", "changed after planning\n");
    expect(confirmGitWriteState(workspace, ".", plan.before).state).toBe("changed");
    expect(() => planGitWrite(workspace, ".", plan.operation)).toThrowError(
      expect.objectContaining({ code: "EXPECTED_STATE_CHANGED" }),
    );
  });

  it("locks selected add sources but keeps the mutable index as digest-only state", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    const source = write(root, "new-file.txt", "source bytes\n");
    const operation: GitWriteOperation = {
      kind: "add",
      paths: ["new-file.txt"],
      expectedHead,
      expectedBranch: "main",
    };
    const plan = planGitWrite(workspace, ".", operation);

    expect(plan.materials.some((item) => item.path === source)).toBe(true);
    expect(plan.snapshotMaterials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}index`))).toBe(true);
    expect(plan.args.slice(-2)).toEqual(["--", "new-file.txt"]);
  });

  it("fails closed when committing staged sensitive files or unresolved conflicts", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    write(root, ".env", "SECRET=value\n");
    git(root, "add", "-f", ".env");
    const commit: GitWriteOperation = {
      kind: "commit",
      message: "must reject sensitive staged path",
      expectedHead,
      expectedBranch: "main",
    };
    expect(() => planGitWrite(workspace, ".", commit)).toThrowError(
      expect.objectContaining({ code: "SENSITIVE_PATH" }),
    );
  });

  it("rejects helper, redirect, insecure TLS and caller-selected trust configuration", () => {
    const unsafe: Array<{ key: string; value: string }> = [
      { key: "credential.https://example.invalid.helper", value: "unsafe" },
      { key: "http.followRedirects", value: "true" },
      { key: "http.sslVerify", value: "false" },
      { key: "http.sslCAInfo", value: "C:/private/custom-ca.pem" },
      { key: "http.cookieFile", value: "C:/private/cookies.txt" },
      { key: "protocol.file.allow", value: "always" },
      { key: "submodule.recurse", value: "true" },
      { key: "core.alternateRefsCommand", value: "cmd.exe /c echo marker" },
      { key: "extensions.partialClone", value: "origin" },
      { key: "remote.origin.promisor", value: "true" },
      { key: "remote.origin.partialCloneFilter", value: "blob:none" },
    ];
    for (const entry of unsafe) {
      expect(() => validateGitConfig([{ origin: "file:C:/repo/.git/config", ...entry }])).toThrowError(GitWriteError);
    }
    expect(() => validateGitConfig([
      { origin: "file:C:/repo/.git/config", key: "http.sslVerify", value: "true" },
    ])).not.toThrow();
  });

  it("accepts only the fixed hook and credential overrides from the planned environment", () => {
    const environment = getGitWriteEnvironment();
    expect(() => validateGitConfig([
      { origin: "command line:", key: "core.hookspath", value: environment.GIT_CONFIG_VALUE_0 },
      { origin: "command line:", key: "credential.helper", value: "" },
    ])).not.toThrow();
    expect(() => validateGitConfig([
      { origin: "command line:", key: "core.hookspath", value: "C:/attacker/hooks" },
    ])).toThrowError(GitWriteError);
  });

  it("binds only canonical loopback proxies into remote-operation arguments", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    const fetch = planGitWrite(workspace, ".", {
      kind: "fetch", remote: "origin", branches: ["main"], expectedHead, expectedBranch: "main",
    });
    expect(fetch.args).toContain("http.proxy=http://127.0.0.1:7897");
    expect(fetch.args).toContain("--no-recurse-submodules");
    expect(fetch.args).toContain("--no-prune");

    const ipv6Preview = previewGitRepositoryApproval(workspace, ".", {
      allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
      allowedBranches: ["main"],
      allowedOperations: ["fetch"],
      approvedProxy: "http://[::1]:7897",
    });
    expect(ipv6Preview.approvedProxy).toBe("http://[::1]:7897");
    const noProxyPreview = previewGitRepositoryApproval(workspace, ".", {
      allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
      allowedBranches: ["main"],
      allowedOperations: ["fetch"],
    });
    expect(ipv6Preview.digest).not.toBe(noProxyPreview.digest);
    for (const approvedProxy of [
      "http://example.com:7897",
      "http://127.0.0.1:7897/path",
      "http://user:pass@127.0.0.1:7897",
      "https://127.0.0.1:7897",
      "http://127.0.0.1:70000",
    ]) {
      expect(() => previewGitRepositoryApproval(workspace, ".", {
        allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
        allowedBranches: ["main"],
        allowedOperations: ["fetch"],
        approvedProxy,
      })).toThrowError(GitWriteError);
    }

    git(root, "config", "http.proxy", "http://127.0.0.1:7897");
    expect(() => previewGitRepositoryApproval(workspace, ".", {
      allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
      allowedBranches: ["main"],
      allowedOperations: ["fetch"],
      approvedProxy: "http://127.0.0.1:7897",
    })).toThrowError(GitWriteError);
  });

  it("pins push to the planned HEAD and disables signed and recursive pushes", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    const marker = path.join(root, "gpg-helper-was-called.marker");
    git(root, "config", "push.gpgSign", "true");
    git(root, "config", "push.recurseSubmodules", "on-demand");
    git(root, "config", "gpg.program", marker);

    const push = planGitWrite(workspace, ".", {
      kind: "push", remote: "origin", branch: "main", expectedHead, expectedBranch: "main",
    });
    expect(push.args).toContain("push.gpgSign=false");
    expect(push.args).toContain("push.recurseSubmodules=false");
    expect(push.args).toContain("--signed=false");
    expect(push.args).toContain("--recurse-submodules=no");
    expect(push.args.slice(-3)).toEqual(["--", "origin", `${expectedHead}:refs/heads/main`]);
    expect(push.args.at(-1)).not.toContain("HEAD:");
    expect(fs.existsSync(marker)).toBe(false);

    expect(() => planGitWrite(workspace, ".", {
      kind: "push", remote: "origin", branch: "main", expectedHead: null, expectedBranch: "main",
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
    expect(() => planGitWrite(workspace, ".", {
      kind: "push", remote: "origin", branch: "main", expectedHead: "not-a-sha", expectedBranch: "main",
    } as GitWriteOperation)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));

    const pull = planGitWrite(workspace, ".", {
      kind: "pull_ff_only", remote: "origin", branch: "main", expectedHead, expectedBranch: "main",
    });
    expect(pull.args).toContain("--no-verify-signatures");
    expect(pull.args).toContain("--no-recurse-submodules");
    expect(pull.args).toContain("merge.verifySignatures=false");
  });

  it("rejects alternate object stores and partial-clone markers before planning", () => {
    const alternate = makeApprovedRepo();
    const alternateMarker = path.join(alternate.root, "alternate-command-was-called.marker");
    git(alternate.root, "config", "core.alternateRefsCommand", `cmd.exe /c echo called>${alternateMarker}`);
    expect(() => planGitWrite(alternate.workspace, ".", baseOperation(alternate.expectedHead)))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));
    expect(fs.existsSync(alternateMarker)).toBe(false);

    const alternateFileRepo = makeApprovedRepo();
    write(alternateFileRepo.root, ".git/objects/info/alternates", "C:/outside/objects\n");
    expect(() => planGitWrite(alternateFileRepo.workspace, ".", baseOperation(alternateFileRepo.expectedHead)))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));

    const promisorRepo = makeApprovedRepo();
    write(promisorRepo.root, ".git/objects/pack/pack-probe.promisor", "");
    expect(() => planGitWrite(promisorRepo.workspace, ".", baseOperation(promisorRepo.expectedHead)))
      .toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));
  });

  it("checks the linked worktree Git directory for alternate object stores and binds its HEAD", () => {
    const { root, workspace } = makeApprovedRepo();
    const linked = path.join(root, "linked-worktree");
    git(root, "worktree", "add", "-b", "feature/test", linked);
    const policy = {
      localApproval: true as const,
      allowedRemotes: [{ name: "origin", url: "https://example.invalid/c2c.git" }],
      allowedBranches: ["main", "feature/test"],
      allowedOperations: ["branch_list"] as GitWriteOperation["kind"][],
    };
    const preview = previewGitRepositoryApproval(workspace, "linked-worktree", policy);
    approveGitRepository(workspace, "linked-worktree", policy, preview.digest);
    const head = git(linked, "rev-parse", "HEAD").trim();
    const plan = planGitWrite(workspace, "linked-worktree", {
      kind: "branch_list", expectedHead: head, expectedBranch: "feature/test",
    });
    const worktreeGitDirectory = git(linked, "rev-parse", "--absolute-git-dir").trim();
    expect(plan.materials.some((item) => item.path === path.join(worktreeGitDirectory, "HEAD"))).toBe(true);

    const alternatePath = write(worktreeGitDirectory, "objects/info/alternates", "C:/outside/worktree-objects\n");
    expect(() => planGitWrite(workspace, "linked-worktree", {
      kind: "branch_list", expectedHead: head, expectedBranch: "feature/test",
    })).toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));
    fs.unlinkSync(alternatePath);
    write(worktreeGitDirectory, "objects/pack/pack-worktree.promisor", "");
    expect(() => planGitWrite(workspace, "linked-worktree", {
      kind: "branch_list", expectedHead: head, expectedBranch: "feature/test",
    })).toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));
  });

  it("requires switch and fast-forward pull to start with a clean worktree", () => {
    const { root, workspace, expectedHead } = makeApprovedRepo();
    write(root, "untracked.txt", "must block state-changing operations\n");
    expect(() => planGitWrite(workspace, ".", {
      kind: "switch", name: "feature/test", expectedHead, expectedBranch: "main",
    })).toThrowError(expect.objectContaining({ code: "EXPECTED_STATE_CHANGED" }));
    expect(() => planGitWrite(workspace, ".", {
      kind: "pull_ff_only", remote: "origin", branch: "main", expectedHead, expectedBranch: "main",
    })).toThrowError(expect.objectContaining({ code: "EXPECTED_STATE_CHANGED" }));
  });

  it("rejects a commit while the index is unmerged or Git has an in-progress merge", () => {
    const { root, workspace } = makeApprovedRepo();
    git(root, "switch", "-c", "feature/test");
    write(root, "hello.txt", "feature side\n");
    git(root, "add", "hello.txt");
    git(root, "commit", "-m", "feature edit");
    git(root, "switch", "main");
    write(root, "hello.txt", "main side\n");
    git(root, "add", "hello.txt");
    git(root, "commit", "-m", "main edit");
    const conflict = spawnSync("git", ["merge", "feature/test"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      windowsHide: true,
      shell: false,
    });
    expect(conflict.status).not.toBe(0);
    const head = git(root, "rev-parse", "HEAD").trim();
    expect(() => planGitWrite(workspace, ".", {
      kind: "commit", message: "must reject unresolved conflict", expectedHead: head, expectedBranch: "main",
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
    expect(() => planGitWrite(workspace, ".", {
      kind: "branch_list", expectedHead: head, expectedBranch: "main",
    })).not.toThrow();
  });

  it("rejects a commit even when a merge is in progress without index conflicts", () => {
    const { root, workspace } = makeApprovedRepo();
    git(root, "switch", "-c", "feature/test");
    write(root, "feature-only.txt", "feature\n");
    git(root, "add", "feature-only.txt");
    git(root, "commit", "-m", "feature file");
    git(root, "switch", "main");
    write(root, "main-only.txt", "main\n");
    git(root, "add", "main-only.txt");
    git(root, "commit", "-m", "main file");
    git(root, "merge", "--no-commit", "feature/test");
    const head = git(root, "rev-parse", "HEAD").trim();
    expect(git(root, "ls-files", "--unmerged").trim()).toBe("");
    expect(() => planGitWrite(workspace, ".", {
      kind: "commit", message: "must reject pending merge commit", expectedHead: head, expectedBranch: "main",
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
  });

  it("rejects approval when repository data changes after preview", () => {
    const root = makeTmpDir("git-write-preview-drift");
    makeGitRepo(root);
    git(root, "config", "user.name", "C2C local author");
    git(root, "config", "user.email", "c2c-author@example.invalid");
    const workspace = new Workspace(root);
    const policy = {
      allowedRemotes: [],
      allowedBranches: ["main"],
      allowedOperations: ["branch_list"] as GitWriteOperation["kind"][],
    };
    const preview = previewGitRepositoryApproval(workspace, ".", policy);
    git(root, "config", "user.name", "changed after preview");
    expect(() => approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest))
      .toThrowError(expect.objectContaining({ code: "APPROVAL_PREVIEW_CHANGED" }));
  });
});
