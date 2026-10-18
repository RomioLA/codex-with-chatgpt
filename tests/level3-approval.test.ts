import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { resolveGitExecutable, validateGitConfig, validateLevel3GitConfig } from "../src/git-write/security.js";
import {
  approveLevel3Request,
  completeLevel3Request,
  consumeLevel3Request,
  createLevel3Request,
  getLevel3Request,
  getLevel3RequestPreview,
  isLevel3Enabled,
  listLevel3Requests,
  resolveConsumedLevel3Request,
  revokeLevel3Request,
  setLevel3Enabled,
  type Level3Spec,
} from "../src/execution/level3-approval.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const CLIENT_ID = "level3-test-client";

interface Fixture {
  root: string;
  repo: string;
  workspace: Workspace;
  executable: string;
  material: string;
}

function fixture(name: string): Fixture {
  const root = makeTmpDir(`level3-${name}`);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  makeGitRepo(repo);
  const executable = write(root, "tools/program.exe", "level3 test executable\n");
  const material = write(repo, "src/task.txt", "approved material\n");
  return { root, repo, workspace: new Workspace(root), executable, material };
}

interface IsolatedGitBundle {
  root: string;
  executable: string;
  remoteHttps: string;
  internalGit: string;
  searchPath: string;
}

function isolatedGitBundle(): IsolatedGitBundle {
  const sourceExecutable = resolveGitExecutable().path;
  const normalizedSource = sourceExecutable.replace(/\\/g, "/").toLowerCase();
  const sourceRoot = normalizedSource.endsWith("/mingw64/bin/git.exe")
    ? path.dirname(path.dirname(path.dirname(sourceExecutable)))
    : path.dirname(path.dirname(sourceExecutable));
  const root = makeTmpDir("level3-isolated-git-bundle");
  const files = [
    "mingw64/bin/git.exe",
    "mingw64/libexec/git-core/git.exe",
    "mingw64/libexec/git-core/git-remote-https.exe",
    "bin/sh.exe",
    "usr/bin/sh.exe",
  ];
  for (const relative of files) {
    const source = path.join(sourceRoot, ...relative.split("/"));
    const target = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const executable = path.join(root, "mingw64", "bin", "git.exe");
  return {
    root,
    executable,
    remoteHttps: path.join(root, "mingw64", "libexec", "git-core", "git-remote-https.exe"),
    internalGit: path.join(root, "mingw64", "libexec", "git-core", "git.exe"),
    searchPath: [path.dirname(executable), path.join(sourceRoot, "mingw64", "bin"), process.env.PATH ?? ""]
      .filter(Boolean).join(path.delimiter),
  };
}

function directSpec(f: Fixture, overrides: Partial<Extract<Level3Spec, { engine: "program" }>> = {}): Level3Spec {
  return {
    engine: "program",
    repositoryPath: "repo",
    executable: f.executable,
    args: ["--mode", "check"],
    cwd: "repo",
    timeoutSeconds: 60,
    materials: ["repo/src/task.txt"],
    ...overrides,
  };
}

function enabled(f: Fixture): void {
  setLevel3Enabled(f.workspace.id, true, true);
}

function compileSignerMarker(root: string, markerPath: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const compiler = [
    path.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new Error("A Windows .NET Framework C# compiler is required for the signer marker regression.");
  const executable = path.join(root, "tools", "signer-marker.exe");
  const source = path.join(root, "tools", "signer-marker.cs");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, [
    "using System;",
    "using System.IO;",
    "public static class SignerMarker {",
    `  public static int Main(string[] args) { File.WriteAllText(${JSON.stringify(markerPath)}, \"SIGNER_EXECUTED\"); return 1; }`,
    "}",
  ].join("\n"));
  const result = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], {
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not compile isolated signer marker: ${result.error?.code ?? result.stderr}`);
  }
  return executable;
}

describe("Level 3 one-time local approval", () => {
  let originalStateDirectory: string | undefined;

  beforeEach(() => {
    originalStateDirectory = process.env.C2C_STATE_DIR;
    isolateStateDir();
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (originalStateDirectory === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDirectory;
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("stays disabled by default and returns a safe pending preview", () => {
    const f = fixture("default-disabled");
    expect(isLevel3Enabled(f.workspace.id)).toBe(false);
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f))).toThrowError(
      expect.objectContaining({ code: "LEVEL3_DISABLED" }),
    );

    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(pending.status).toBe("pending");
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(1);
    const preview = getLevel3RequestPreview(f.workspace.id, pending.requestId, CLIENT_ID)!;
    expect(preview.spec.engine).toBe("program");
    expect("snapshot" in preview).toBe(false);
    expect("manifestPath" in preview).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("fileIdentity");
    cleanup(f.root);
  });

  it("keeps the Level 3 feature switch enabled across a fresh runtime process", () => {
    const f = fixture("persistent-feature-switch");
    enabled(f);
    expect(isLevel3Enabled(f.workspace.id)).toBe(true);

    const sourceUrl = pathToFileURL(path.resolve("src/execution/level3-approval.ts")).href;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import { isLevel3Enabled } from ${JSON.stringify(sourceUrl)}; console.log(JSON.stringify(isLevel3Enabled(${JSON.stringify(f.workspace.id)})));`,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: process.env.C2C_STATE_DIR },
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout.trim()).toBe("true");
    cleanup(f.root);
  });


  it.skipIf(process.platform !== "win32")("auto-authorizes a materially bound syntax-only Node check", () => {
    const f = fixture("safe-development-auto");
    const node = process.execPath;
    write(f.repo, "src/safe-task.js", "console.log('safe development fixture');\n");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: node,
      args: ["--check", "src/safe-task.js"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    expect(request.status).toBe("approved");
    expect(request.approvalRequired).toBe(false);
    expect(request.riskClass).toBe("safe-development");
    expect(request.launchExpiresAt).toBeTruthy();

    const record = getLevel3Request(f.workspace.id, request.requestId)!;
    expect(record.status).toBe("approved");
    expect(record.risk).toBe("development");
    expect(record.allowSystem).toBe(false);
    expect(record.manifestPath).toBeTruthy();

    const consumed = consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest);
    expect(consumed.request.status).toBe("consumed");
    expect(consumed.genericCommand.mode).toBe("direct");
    expect(consumed.genericCommand.args).toEqual(["--check", "src/safe-task.js"]);
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("keeps executable Node scripts behind local review even when the entry file is bound", () => {
    const f = fixture("node-script-needs-review");
    const node = process.execPath;
    write(f.repo, "src/safe-task.js", "import './dependency.js';\n");
    write(f.repo, "src/dependency.js", "console.log('dependency fixture');\n");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: node,
      args: ["src/safe-task.js"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("needs-review");
    cleanup(f.root);
  });

  it("does not auto-authorize a repository-controlled executable just because it has a trusted tool name", () => {
    const f = fixture("safe-name-spoof");
    const fakeNode = write(f.repo, "tools/node.exe", "repository-controlled executable fixture\n");
    write(f.repo, "src/task.js", "console.log('fixture');\n");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: fakeNode,
      args: ["src/task.js"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("needs-review");
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("keeps only explicitly shaped local Git development operations outside Git Write", () => {
    const f = fixture("git-risk-classification");
    const gitExe = resolveGitExecutable().path;
    enabled(f);

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: gitExe,
      args: ["worktree", "add", "../integration-worktree", "-b", "integration/test"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_GIT_WORKTREE_ADD_UNSUPPORTED" }));
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["-C", f.repo, "worktree", "add", "../integration-worktree"],
      cwd: "repo", timeoutSeconds: 30, materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_GIT_WORKTREE_ADD_UNSUPPORTED" }));

    const status = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["status", "--porcelain"], cwd: "repo", timeoutSeconds: 30, materials: [],
    });
    expect(status.status).toBe("approved");
    expect(status.riskClass).toBe("safe-development");

    write(f.repo, "src/stage-me.txt", "bound staged material\n");
    const add = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["add", "--", "src/stage-me.txt"], cwd: "repo", timeoutSeconds: 30, materials: [],
    });
    expect(add.status).toBe("approved");
    expect(add.riskClass).toBe("safe-development");
    const addRecord = getLevel3Request(f.workspace.id, add.requestId)!;
    expect(addRecord.snapshot.materials.some((item) => item.relativePath === "repo/src/stage-me.txt")).toBe(true);

    git(f.repo, "add", "src/stage-me.txt");
    git(f.repo, "remote", "add", "origin", "https://example.invalid/repository.git");
    const commit = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["commit", "-m", "reviewed local change"], cwd: "repo", timeoutSeconds: 30, materials: [],
    });
    expect(commit.status).toBe("approved");
    expect(commit.riskClass).toBe("safe-development");
    const commitRecord = getLevel3Request(f.workspace.id, commit.requestId)!;
    expect(commitRecord.snapshot.materials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}index`))).toBe(true);
    expect(commitRecord.snapshot.materials.some((item) => item.path.endsWith(`${path.sep}.git${path.sep}HEAD`))).toBe(true);
    if (commitRecord.spec.engine !== "program") throw new Error("Expected a direct Git command.");
    expect(commitRecord.spec.gitSafetyArgs).toEqual(expect.arrayContaining([
      "commit.gpgsign=false",
      "gpg.format=openpgp",
      "gpg.program=",
      "gpg.openpgp.program=",
      "gpg.x509.program=",
      "gpg.ssh.program=",
      "gpg.ssh.defaultKeyCommand=",
    ]));
    const consumedCommit = consumeLevel3Request(f.workspace, commit.requestId, CLIENT_ID, commit.digest);
    expect(consumedCommit.genericCommand.args.slice(0, commitRecord.spec.gitSafetyArgs!.length))
      .toEqual(commitRecord.spec.gitSafetyArgs);

    const fetch = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["fetch", "origin"], cwd: "repo", timeoutSeconds: 30, materials: [],
    });
    expect(fetch.status).toBe("approved");
    expect(fetch.riskClass).toBe("safe-development");
    const fetchRecord = getLevel3Request(f.workspace.id, fetch.requestId)!;
    expect(fetchRecord.spec.engine === "program" && fetchRecord.spec.gitFetchHelpersBound).toBe(true);
    expect(fetchRecord.snapshot.materials.some((item) => item.path.toLowerCase().endsWith("git-remote-https.exe"))).toBe(true);
    expect(fetchRecord.snapshot.materials.some((item) => item.path.toLowerCase().endsWith("git-core" + path.sep + "git.exe"))).toBe(true);
    const consumedFetch = consumeLevel3Request(f.workspace, fetch.requestId, CLIENT_ID, fetch.digest);
    expect(consumedFetch.genericCommand.materials.some((item) => item.path.toLowerCase().endsWith("git-remote-https.exe"))).toBe(true);

    const reviewArgs = [
      ["add", "-A"],
      ["fetch", "unconfigured"],
      ["push", "origin", "main"],
    ];
    write(f.repo, ".env", "TOKEN=hidden\n");
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: gitExe,
      args: ["add", "--", ".env"], cwd: "repo", timeoutSeconds: 30, materials: [],
    })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
    for (const args of reviewArgs) {
      const writeRequest = createLevel3Request(f.workspace, CLIENT_ID, {
        engine: "program",
        repositoryPath: "repo",
        executable: gitExe,
        args,
        cwd: "repo",
        timeoutSeconds: 30,
        materials: [],
      });
      expect(writeRequest.status).toBe("pending");
      expect(writeRequest.riskClass).toBe("needs-review");
      expect(writeRequest.approvalRequired).toBe(true);
    }
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("keeps signer-configured commit requests out of auto-approval and signer launch", () => {
    const f = fixture("git-signer-program-review");
    const marker = path.join(f.root, "signer-called.txt");
    const markerExecutable = compileSignerMarker(f.root, marker);
    git(f.repo, "config", "user.name", "c2c-test");
    git(f.repo, "config", "user.email", "test@c2c.local");
    git(f.repo, "config", "commit.gpgSign", "true");
    git(f.repo, "config", "gpg.program", markerExecutable);
    write(f.repo, "hello.txt", "staged attacker fixture\n");
    git(f.repo, "add", "hello.txt");

    // Positive control: this isolated marker really is called by Git's signer path.
    const markerControl = spawnSync(resolveGitExecutable().path, ["commit", "-m", "signer marker positive control"], {
      cwd: f.repo,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "c2c-test",
        GIT_AUTHOR_EMAIL: "test@c2c.local",
        GIT_COMMITTER_NAME: "c2c-test",
        GIT_COMMITTER_EMAIL: "test@c2c.local",
        GIT_CONFIG_GLOBAL: "NUL",
        GIT_CONFIG_SYSTEM: "NUL",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    expect(markerControl.status).not.toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("SIGNER_EXECUTED");
    fs.unlinkSync(marker);

    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: resolveGitExecutable().path,
      args: ["commit", "-m", "review signer configuration"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.riskClass).toBe("needs-review");
    expect(request.approvalRequired).toBe(true);
    expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_NOT_APPROVED" }),
    );
    expect(fs.existsSync(marker)).toBe(false);
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32").each([
    { format: "openpgp", key: "gpg.program" },
    { format: "openpgp", key: "gpg.openpgp.program" },
    { format: "x509", key: "gpg.x509.program" },
    { format: "ssh", key: "gpg.ssh.program" },
    { format: "ssh", key: "gpg.ssh.defaultKeyCommand" },
  ])("requires review for the %s Git signer executable configuration", ({ format, key }) => {
    const f = fixture(`git-signer-${format}-${key.split(".").at(-1)}`);
    const markerExecutable = compileSignerMarker(f.root, path.join(f.root, "signer-called.txt"));
    git(f.repo, "config", "gpg.format", format);
    git(f.repo, "config", key, markerExecutable);
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: resolveGitExecutable().path,
      args: ["commit", "-m", "review signer settings"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.riskClass).toBe("needs-review");
    expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_NOT_APPROVED" }),
    );
    expect(fs.existsSync(path.join(f.root, "signer-called.txt"))).toBe(false);
    cleanup(f.root);
  });

  it("keeps the formal Git Write config validator independent from Level 3 signer review", () => {
    const config = [{ origin: "file:.git/config", key: "gpg.ssh.program", value: "signer-marker.exe" }];
    expect(() => validateGitConfig(config)).not.toThrow();
    expect(() => validateLevel3GitConfig(config)).toThrowError(expect.objectContaining({ code: "UNSAFE_GIT_CONFIG" }));
  });

  it.skipIf(process.platform !== "win32").each([
    ["remote helper", "git-remote-https.exe"],
    ["internal Git executable", "git-core" + path.sep + "git.exe"],
  ])("rejects a %s changed after a Git fetch request", (_label, helperSuffix) => {
    const f = fixture("git-fetch-helper-replacement");
    git(f.repo, "remote", "add", "origin", "https://example.invalid/repository.git");
    const bundle = isolatedGitBundle();
    const originalPath = process.env.PATH;
    process.env.PATH = bundle.searchPath;
    try {
      enabled(f);
      const request = createLevel3Request(f.workspace, CLIENT_ID, {
        engine: "program", repositoryPath: "repo", executable: bundle.executable,
        args: ["fetch", "origin"], cwd: "repo", timeoutSeconds: 30, materials: [],
      });
      expect(request.status).toBe("approved");
      const record = getLevel3Request(f.workspace.id, request.requestId)!;
      const helper = record.snapshot.materials.find((item) => item.path.toLowerCase().endsWith(helperSuffix.toLowerCase()));
      expect(helper).toBeDefined();
      const changedPath = helperSuffix.toLowerCase().endsWith("git-remote-https.exe")
        ? bundle.remoteHttps
        : bundle.internalGit;
      fs.appendFileSync(changedPath, Buffer.from("replacement material"));
      expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
        expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("rejects a Git fetch bundle whose helper directory becomes a junction", () => {
    const f = fixture("git-fetch-helper-junction");
    git(f.repo, "remote", "add", "origin", "https://example.invalid/repository.git");
    const bundle = isolatedGitBundle();
    const originalPath = process.env.PATH;
    process.env.PATH = bundle.searchPath;
    try {
      enabled(f);
      const request = createLevel3Request(f.workspace, CLIENT_ID, {
        engine: "program", repositoryPath: "repo", executable: bundle.executable,
        args: ["fetch", "origin"], cwd: "repo", timeoutSeconds: 30, materials: [],
      });
      const coreDir = path.join(bundle.root, "mingw64", "libexec", "git-core");
      const targetDir = path.join(bundle.root, "git-core-junction-target");
      fs.mkdirSync(targetDir);
      for (const name of ["git.exe", "git-remote-https.exe"]) {
        fs.copyFileSync(path.join(coreDir, name), path.join(targetDir, name));
        fs.unlinkSync(path.join(coreDir, name));
      }
      fs.rmdirSync(coreDir);
      fs.symlinkSync(targetDir, coreDir, "junction");
      expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
        expect.objectContaining({ code: "LEVEL3_EXECUTION_TARGET_UNVERIFIED" }),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32").each([
    { args: ["--eval=process.exit(0)"] },
    { args: ["--require=preload.js"] },
    { args: ["--import=data:text/javascript,process.exit(0)"] },
    { args: ["--test"] },
  ])("keeps attached or discovered Node code execution behind local review: %j", ({ args }) => {
    const f = fixture("node-attached-dynamic");
    write(f.repo, "preload.js", "console.log('preload fixture');\n");
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: process.execPath,
      args,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("needs-review");
    cleanup(f.root);
  });

  it.each([
    ["powershell", "pwsh.exe", "Write-Output ok\nSet-Content -LiteralPath C:\\Temp\\owned.txt -Value owned"],
    ["cmd", "cmd.exe", "echo ok\nstart \"\" .\\tools\\payload.exe"],
  ] as const)("keeps multi-statement %s commands behind local review", (engine, shellName, command) => {
    const f = fixture(`multiline-${engine}`);
    const shell = write(f.root, `tools/${shellName}`, "isolated shell executable fixture\n");
    if (engine === "cmd") write(f.repo, "tools/payload.exe", "bound CMD target fixture\n");
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine,
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("needs-review");
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32").each([
    { args: ["-C..\\..", "status"] },
    { args: ["-c", "commit.gpgSign=true", "commit", "-m", "forced signer override"] },
    { args: ["commit", "-m", "forced signer override", "-c", "commit.gpgSign=true"] },
    { args: ["--git-dir=..\\..\\.git", "--work-tree=..\\..", "status"] },
    { args: ["--exec-path=tools", "fetch", "evil::url"] },
    { args: ["--config-env=core.fsmonitor=ComSpec", "status"] },
    { args: ["status", "--ext-diff"] },
    { args: ["status", "--porcelain", "--branch"] },
    { args: ["STATUS"] },
  ])("does not auto-authorize Git global/helper option escapes: %j", ({ args }) => {
    const f = fixture("git-global-option-review");
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: resolveGitExecutable().path,
      args,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("needs-review");
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32").each([
    { args: ["grep", "--open-files-in-pager=C:/Windows/System32/cmd.exe", "needle"] },
    { args: ["grep", "-O", "C:/Windows/System32/cmd.exe", "needle"] },
    { args: ["log", "--show-signature"] },
    { args: ["show", "--show-signature"] },
  ])("requires local review for Git commands with external pager or signature behavior: %j", ({ args }) => {
    const f = fixture("git-external-helper-review");
    const marker = path.join(f.root, "unexpected-marker.txt");
    const markerLoader = write(f.root, "tools/marker-loader.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
    git(f.repo, "config", "gpg.program", process.execPath);
    git(f.repo, "config", "log.showSignature", "true");
    enabled(f);
    const oldNodeOptions = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(markerLoader)}`;
    try {
      const request = createLevel3Request(f.workspace, CLIENT_ID, {
        engine: "program", repositoryPath: "repo", executable: resolveGitExecutable().path,
        args, cwd: "repo", timeoutSeconds: 30, materials: [],
      });
      expect(request.status).toBe("pending");
      expect(request.approvalRequired).toBe(true);
      expect(request.riskClass).toBe("needs-review");
      expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
        expect.objectContaining({ code: "LEVEL3_REQUEST_NOT_APPROVED" }),
      );
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = oldNodeOptions;
    }
    expect(fs.existsSync(markerLoader)).toBe(true);
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("does not auto-authorize Git aliases", () => {
    const f = fixture("git-alias-review");
    const marker = path.join(f.root, "alias-marker.txt");
    git(f.repo, "config", "alias.marker", `!node -e "require('node:fs').writeFileSync('${marker}', 'executed')"`);
    enabled(f);

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: resolveGitExecutable().path,
      args: ["marker"], cwd: "repo", timeoutSeconds: 30, materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_GIT_ALIAS_CONFIG_UNSUPPORTED" }));
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program", repositoryPath: "repo", executable: resolveGitExecutable().path,
      args: ["-c", "alias.marker=!node -e marker", "marker"], cwd: "repo", timeoutSeconds: 30, materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_GIT_ALIAS_CONFIG_UNSUPPORTED" }));
    expect(fs.existsSync(marker)).toBe(false);
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("binds and hardens local Git config used by automatic requests", () => {
    const f = fixture("git-config-material-binding");
    git(f.repo, "config", "core.fsmonitor", "C:/Temp/untrusted-fsmonitor.exe");
    git(f.repo, "config", "diff.external", "C:/Temp/untrusted-diff.exe");
    git(f.repo, "config", "filter.example.clean", "C:/Temp/untrusted-filter.exe");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: resolveGitExecutable().path,
      args: ["status"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("approved");
    const record = getLevel3Request(f.workspace.id, request.requestId)!;
    expect(record.snapshot.materials.some((item) => item.path.toLowerCase().endsWith(`${path.sep}.git${path.sep}config`))).toBe(true);
    expect(record.spec.engine).toBe("program");
    if (record.spec.engine === "program") {
      expect(record.spec.args).toContain("core.fsmonitor=false");
      expect(record.spec.args).toContain("diff.external=");
      expect(record.spec.args).toContain("filter.example.clean=");
    }
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("rejects a Git launch after its bound local config changes", () => {
    const f = fixture("git-config-toctou");
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: resolveGitExecutable().path,
      args: ["status"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("approved");
    git(f.repo, "config", "core.fsmonitor", "false");
    expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it.skipIf(process.platform !== "win32")("invalidates a safe authorization created under an older risk policy", () => {
    const f = fixture("risk-policy-version");
    write(f.repo, "src/safe-task.js", "console.log('safe development fixture');\n");
    enabled(f);
    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: process.execPath,
      args: ["--check", "src/safe-task.js"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(request.status).toBe("approved");

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{ requestId: string; riskPolicyVersion?: number }>;
    };
    state.requests.find((record) => record.requestId === request.requestId)!.riskPolicyVersion = 5;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    expect(() => consumeLevel3Request(f.workspace, request.requestId, CLIENT_ID, request.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it("keeps destructive-system commands pending and prevents risk downgrades", () => {
    const f = fixture("destructive-review");
    const shutdown = write(f.root, "tools/shutdown.exe", "isolated destructive executable fixture\n");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: shutdown,
      args: ["/r", "/t", "0"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    expect(request.status).toBe("pending");
    expect(request.approvalRequired).toBe(true);
    expect(request.riskClass).toBe("destructive-system");
    expect(() => approveLevel3Request(
      f.workspace,
      request.requestId,
      request.digest,
      true,
      { risk: "development" },
    )).toThrowError(expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }));

    const approved = approveLevel3Request(
      f.workspace,
      request.requestId,
      request.digest,
      true,
      { risk: "destructive-system", allowSystem: true, allowDynamic: true },
    );
    expect(approved.status).toBe("approved");
    expect(approved.risk).toBe("destructive-system");
    expect(approved.allowSystem).toBe(true);
    cleanup(f.root);
  });

  it("keeps dynamic interpreter execution behind local review", () => {
    const f = fixture("dynamic-review");
    const node = write(f.root, "tools/node.exe", "isolated node executable fixture\n");
    enabled(f);

    const request = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "program",
      repositoryPath: "repo",
      executable: node,
      args: ["-e", "console.log('dynamic')"],
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    expect(request.status).toBe("pending");
    expect(request.riskClass).toBe("needs-review");
    expect(request.approvalRequired).toBe(true);
    expect(() => approveLevel3Request(
      f.workspace,
      request.requestId,
      request.digest,
      true,
      { risk: "development" },
    )).toThrowError(expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }));

    const approved = approveLevel3Request(
      f.workspace,
      request.requestId,
      request.digest,
      true,
      { risk: "development", allowDynamic: true },
    );
    expect(approved.status).toBe("approved");
    expect(approved.allowDynamic).toBe(true);
    cleanup(f.root);
  });

  it("binds direct argv to one client and allows one launch resolution", () => {
    const f = fixture("single-use");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    const approved = approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    expect(approved.status).toBe("approved");
    expect(approved.manifestPath).toBeTruthy();

    const consumed = consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(consumed.request.requestId).toBe(pending.requestId);
    expect(consumed.request.spec.timeoutSeconds).toBe(60);
    expect(consumed.repository.identity).toBe(approved.repositoryIdentity);
    expect(consumed.genericCommand.mode).toBe("direct");
    expect(consumed.genericCommand.args).toEqual(["--mode", "check"]);
    expect(consumed.genericCommand.materials).toHaveLength(1);

    const launch = resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(launch.request.status).toBe("launching");
    expect(launch.genericCommand.approvalManifest).toBe(approved.manifestPath);
    expect(() => resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_ALREADY_USED" }),
    );
    expect(() => consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_ALREADY_USED" }),
    );
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "completed")).toBe(true);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("completed");
    cleanup(f.root);
  });

  it("marks a consumed request failed when canceled before launch, without allowing success", () => {
    const f = fixture("consumed-cancelled-before-launch");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);

    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "completed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("consumed");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(true);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("failed");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(false);
    cleanup(f.root);
  });

  it.each([
    ["cmd", "echo hello & echo world", "cmd"],
    ["powershell", "Write-Output 'exact command text'", "powershell"],
  ] as const)("preserves %s command text for the native runner", (engine, command, expectedMode) => {
    const f = fixture(`${engine}-text`);
    const executable = write(f.root, engine === "powershell" ? "pwsh.exe" : "cmd.exe", "shell fixture\n");
    enabled(f);
    const spec: Level3Spec = {
      engine,
      repositoryPath: "repo",
      executable,
      args: [],
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: ["repo/src/task.txt"],
    };
    const pending = createLevel3Request(f.workspace, CLIENT_ID, spec);
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    const authorization = consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(authorization.genericCommand.mode).toBe(expectedMode);
    expect(authorization.genericCommand.args).toEqual([]);
    expect(authorization.genericCommand.commandText).toBe(command);
    cleanup(f.root);
  });

  it("requires the local system-risk acknowledgement and rejects embedded credentials", () => {
    const f = fixture("risk-and-secrets");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "destructive-system",
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }));
    const approved = approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "destructive-system",
      allowSystem: true,
    });
    expect(approved.allowSystem).toBe(true);

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f, { args: ["--api-key=ghp_abcdefghijklmnopqrstuvwxyz012345"] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    );
    cleanup(f.root);
  });

  it("rechecks the approved material after a job consumes its request", () => {
    const f = fixture("queued-material-change");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    fs.writeFileSync(f.material, "changed while queued\n");
    expect(() => resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("consumed");
    cleanup(f.root);
  });

  it("rejects a pre-binding approval record when the current binder finds unresolved execution semantics", () => {
    const f = fixture("stale-entry-binding");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    write(f.repo, "entry.ts", "isolated unsupported execution target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "& .\\entry.ts",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{ requestId: string; spec: { entryBinding?: unknown } }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    // Simulate a pending record written before this binder learned to report
    // the existing unsupported PowerShell target as unresolved.
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it("rejects a pre-binding Start-Process approval record when the current binder discovers its executable material", () => {
    const f = fixture("stale-start-process-binding");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    write(f.repo, "entry.exe", "isolated Start-Process target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "Start-Process -FilePath .\\entry.exe",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{
        requestId: string;
        spec: { materials: string[]; entryBinding?: unknown };
        snapshot: { materials: unknown[] };
      }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    // Simulate a pre-binding record: it had neither a material nor its hash in
    // the approved snapshot, even though the current binder now finds the exe.
    stored.spec.materials = [];
    stored.snapshot.materials = [];
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it.each([
    "./entry.exe",
    "call ./entry.exe",
    'start "" "./entry.exe"',
  ])("rejects a pre-binding CMD approval record after discovering its executable material: %s", (command) => {
    const f = fixture("stale-cmd-entry-binding");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");
    write(f.repo, "entry.exe", "isolated CMD target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{
        requestId: string;
        spec: { materials: string[]; entryBinding?: unknown };
        snapshot: { materials: unknown[] };
      }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    stored.spec.materials = [];
    stored.snapshot.materials = [];
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it.each([
    "C:/Windows/System32/whoami.exe",
    "call C:/Windows/System32/whoami.exe",
    "start C:/Windows/System32/whoami.exe",
  ])("rejects an explicit CMD target outside the repository before approval: %s", (command) => {
    const f = fixture("external-cmd-target");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_EXECUTION_TARGET_UNVERIFIED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it.each([
    "./missing.exe",
    "call ./missing.exe",
    'start "" "./missing.exe"',
  ])("rejects a missing explicit CMD target before approval: %s", (command) => {
    const f = fixture("missing-cmd-target");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_EXECUTION_TARGET_UNVERIFIED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it("keeps unresolved Start-Process targets behind the existing dynamic-code approval", () => {
    const f = fixture("start-process-dynamic-approval");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "Start-Process notepad.exe",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.spec.entryBinding?.kind).toBe("dynamic_code");
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }),
    );
    expect(approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "development",
      allowDynamic: true,
    }).status).toBe("approved");
    cleanup(f.root);
  });

  it.each([".cmd", ".exe"])("rejects a missing explicit PowerShell %s target before creating an approval request", (extension) => {
    const f = fixture(`missing-powershell-target-${extension.slice(1)}`);
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: `& .\\missing${extension}`,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_EXECUTION_TARGET_UNVERIFIED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it.each([
    "Start-Process -FilePath .\\missing.exe",
    "Start-Process .\\missing.exe",
  ])("rejects a missing Start-Process target before creating an approval request: %s", (command) => {
    const f = fixture("missing-start-process");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_EXECUTION_TARGET_UNVERIFIED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it("rejects changed material and only revokes when called through local approval", () => {
    const f = fixture("material-revoke");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    fs.writeFileSync(f.material, "changed after request\n");
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );

    const second = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(revokeLevel3Request(f.workspace.id, second.requestId, true)).toBe(true);
    expect(getLevel3Request(f.workspace.id, second.requestId)?.status).toBe("revoked");
    expect(completeLevel3Request(f.workspace.id, second.requestId, CLIENT_ID, "failed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, second.requestId)?.status).toBe("revoked");
    expect(() => consumeLevel3Request(f.workspace, second.requestId, CLIENT_ID, second.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_NOT_APPROVED" }),
    );
    setLevel3Enabled(f.workspace.id, false, true);
    expect(isLevel3Enabled(f.workspace.id)).toBe(false);
    cleanup(f.root);
  });

  it("expires pending requests and binds them to the requesting client", () => {
    const f = fixture("expiry-owner");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(() => consumeLevel3Request(f.workspace, pending.requestId, "other-client", pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_CLIENT_MISMATCH" }),
    );
    expect(() => approveLevel3Request(f.workspace, pending.requestId, "0".repeat(64), true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_DIGEST_MISMATCH" }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_EXPIRED" }),
    );
    expect(getLevel3RequestPreview(f.workspace.id, pending.requestId, CLIENT_ID)?.status).toBe("expired");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("expired");
    cleanup(f.root);
  });

  it("refuses workspace-sensitive material paths", () => {
    const f = fixture("sensitive-material");
    write(f.repo, ".env", "not-a-real-secret\n");
    enabled(f);
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f, { materials: ["repo/.env"] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    );
    cleanup(f.root);
  });
});
