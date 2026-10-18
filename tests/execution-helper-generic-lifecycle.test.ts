import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { WindowsNativeExecutionRunner, type GenericCommand } from "../src/execution/native-runner.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { resolveTrustedRuntime } from "../src/execution/runtime-discovery.js";
import type { TrustedCommand } from "../src/execution/trusted-registry.js";
import type { NativeRunnerRequest } from "../src/execution/native-runner.js";
import { resolveGitExecutable } from "../src/git-write/security.js";
import {
  approveLevel3Request,
  consumeLevel3Request,
  createLevel3Request,
  resolveConsumedLevel3Request,
  setLevel3Enabled,
} from "../src/execution/level3-approval.js";
import { Workspace } from "../src/workspace/manager.js";
import { git, makeGitRepo } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeModuleDirectory = process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY ?? path.join(projectRoot, "dist", "execution");
const LEVEL3_TEST_CLIENT = "native-git-signer-client";

interface GenericSpec {
  mode: GenericCommand["mode"];
  executable?: string;
  args?: string[];
  commandText?: string;
  materialPath?: string;
}

interface NativeFixture {
  root: string;
  stateRoot: string;
  manifestPath: string;
  materialPath: string;
  request: NativeRunnerRequest;
  runner: WindowsNativeExecutionRunner;
}

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function compileSignerMarker(root: string, markerPath: string): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const compiler = [
    path.join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((candidate) => fs.existsSync(candidate));
  if (!compiler) throw new Error("A Windows .NET Framework C# compiler is required for the native signer regression.");
  const executable = path.join(root, "signer-marker.exe");
  const source = path.join(root, "signer-marker.cs");
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

function fileIdentity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  if (stat.dev === 0n || stat.ino === 0n) throw new Error("GENERIC_TEST_IDENTITY_UNAVAILABLE");
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function fileHash(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function makeNativeFixture(
  name: string,
  spec: GenericSpec,
  timeoutSeconds = 20,
  manifestKind: "level3" | "git-plan" = "level3",
  stateRootOverride?: string,
): NativeFixture {
  const root = makeSystemTempDir(name);
  makeGitRepo(root);
  const workspace = new Workspace(root);
  const repository = resolveRepositoryIdentity(workspace, ".");
  const runtime = resolveTrustedRuntime("npm");
  const executable = spec.executable ?? runtime.nodeExecutable;
  const executableFileIdentity = fileIdentity(executable);
  const executableHash = fileHash(executable);
  const cwdFileIdentity = fileIdentity(root);
  const materialPath = spec.materialPath ?? path.join(root, "approved-material.txt");
  if (!fs.existsSync(materialPath)) fs.writeFileSync(materialPath, "approved material\n", { flag: "wx" });
  const materials = [{ path: materialPath, fileIdentity: fileIdentity(materialPath), hash: fileHash(materialPath) }];
  const stateRoot = stateRootOverride ?? makeSystemTempDir(`${name}-state`);
  const approvalDirectory = path.join(stateRoot, "execution", manifestKind === "level3" ? "level3" : "git-plans", workspace.id);
  fs.mkdirSync(approvalDirectory, { recursive: true });
  const requestId = randomBytes(24).toString("base64url");
  const manifestName = manifestKind === "level3" ? `${requestId}.manifest.json` : `${requestId}.json`;
  const manifestPath = path.join(approvalDirectory, manifestName);
  const manifestBytes = Buffer.from(JSON.stringify({
    version: 1,
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    command: {
      mode: spec.mode,
      executable,
      executableFileIdentity,
      executableHash,
      args: spec.args ?? [],
      ...(spec.commandText === undefined ? {} : { commandText: spec.commandText }),
      cwd: root,
      cwdFileIdentity,
      materials,
    },
  }), "utf8");
  fs.writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
  fs.writeFileSync(`${manifestPath}.permit`, createHash("sha256").update(manifestBytes).digest("hex"), { flag: "wx" });
  const genericCommand: GenericCommand = {
    mode: spec.mode,
    executable,
    executableFileIdentity,
    executableHash,
    args: spec.args ?? [],
    ...(spec.commandText === undefined ? {} : { commandText: spec.commandText }),
    cwd: root,
    cwdFileIdentity,
    approvalManifest: manifestPath,
    approvalManifestFileIdentity: fileIdentity(manifestPath),
    approvalManifestHash: createHash("sha256").update(manifestBytes).digest("hex"),
    materials,
  };
  const trustedCommand: TrustedCommand = {
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "package_script",
    target: "generic",
    packageManager: "npm",
    scriptHash: createHash("sha256").update("generic-test-placeholder").digest("hex"),
    packageJsonHash: "0".repeat(64),
    approvedAt: new Date().toISOString(),
    approvalSource: "local-cli",
  };
  const stateDirectory = path.join(stateRoot, "execution-jobs", workspace.id);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const owner = new ExecutionTempOwner(stateDirectory, workspace.id);
  const jobId = `job_${randomBytes(16).toString("hex")}`;
  const request: NativeRunnerRequest = {
    jobId,
    repository,
    trustedCommand,
    timeoutSeconds,
    stateDirectory,
    tempLease: owner.create(jobId),
    genericCommand,
  };
  return { root, stateRoot, manifestPath, materialPath, request,
    runner: new WindowsNativeExecutionRunner({ moduleDirectory: nativeModuleDirectory }) };
}

function redirectManifest(fixture: NativeFixture, manifestPath: string): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, fs.readFileSync(fixture.manifestPath), { flag: "wx" });
  const genericCommand = fixture.request.genericCommand;
  if (!genericCommand) throw new Error("GENERIC_TEST_COMMAND_MISSING");
  genericCommand.approvalManifest = manifestPath;
  genericCommand.approvalManifestFileIdentity = fileIdentity(manifestPath);
  genericCommand.approvalManifestHash = fileHash(manifestPath);
  fixture.manifestPath = manifestPath;
}

function isCurrentTokenElevated(): boolean {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const whoami = path.join(systemRoot, "System32", "whoami.exe");
  const result = spawnSync(whoami, ["/groups", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error("GENERIC_TEST_TOKEN_QUERY_FAILED");
  return /S-1-16-12288/i.test(result.stdout);
}

const currentTokenElevated = process.platform === "win32" ? isCurrentTokenElevated() : false;

function start(fixture: NativeFixture) {
  const output = new Map<string, Buffer[]>();
  const handle = fixture.runner.start(fixture.request, {
    onOutput: (stream, data) => output.set(stream, [...(output.get(stream) ?? []), Buffer.from(data)]),
  });
  return { handle, output };
}

function waitUntil(check: () => boolean, timeoutMs: number, failure: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(failure));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EINVAL") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessTree(parentPidFile: string, childPidFile: string): Promise<number[]> {
  await waitUntil(
    () => fs.existsSync(parentPidFile) && fs.existsSync(childPidFile),
    10_000,
    "The generic native process tree did not start.",
  );
  return [parentPidFile, childPidFile].map((file) => Number(fs.readFileSync(file, "utf8").trim()));
}

async function waitForProcessesToExit(pids: number[]): Promise<void> {
  await waitUntil(() => pids.every((pid) => !processExists(pid)), 15_000,
    "A generic native process remained after the Job completed.");
}

function processTreeCommand(root: string, parentPidFile: string, childPidFile: string): GenericSpec {
  const childSource = [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const source = [
    "const fs=require('node:fs');",
    "const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'ignore',windowsHide:true});`,
    `fs.writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  return {
    mode: "direct",
    args: ["-e", source],
  };
}

describe("Windows native generic execution lifecycle", () => {
  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "executes Level 3 Git signer overrides in the Native Helper and leaves the marker untouched",
    async () => {
      const gitExecutable = resolveGitExecutable().path;
      const stateRoot = makeSystemTempDir("native-git-signer-state");
      const authorizationRoot = makeSystemTempDir("native-git-signer-authorization");
      makeGitRepo(authorizationRoot);
      const authorizationWorkspace = new Workspace(authorizationRoot);
      const previousStateDirectory = process.env.C2C_STATE_DIR;
      process.env.C2C_STATE_DIR = stateRoot;
      try {
        git(authorizationRoot, "config", "commit.gpgSign", "true");
        git(authorizationRoot, "config", "gpg.program", path.join(authorizationRoot, "signer-marker.exe"));
        setLevel3Enabled(authorizationWorkspace.id, true, true);
        const request = createLevel3Request(authorizationWorkspace, LEVEL3_TEST_CLIENT, {
          engine: "program",
          repositoryPath: ".",
          executable: gitExecutable,
          args: ["commit", "-m", "native signer override regression"],
          cwd: ".",
          timeoutSeconds: 30,
          materials: [],
        });
        expect(request.status).toBe("pending");
        expect(request.riskClass).toBe("needs-review");
        approveLevel3Request(authorizationWorkspace, request.requestId, request.digest, true, { risk: "development" });
        const consumed = consumeLevel3Request(authorizationWorkspace, request.requestId, LEVEL3_TEST_CLIENT, request.digest);
        const launching = resolveConsumedLevel3Request(authorizationWorkspace, request.requestId, LEVEL3_TEST_CLIENT, request.digest);
        if (!launching) throw new Error("LEVEL3_NATIVE_LAUNCH_MISSING");
        expect(launching.genericCommand.args).toContain("commit.gpgsign=false");
        expect(launching.genericCommand.args).toContain("gpg.program=");
        expect(launching.genericCommand.args).toContain("gpg.openpgp.program=");
        expect(launching.genericCommand.args).toContain("gpg.x509.program=");
        expect(launching.genericCommand.args).toContain("gpg.ssh.program=");

        const fixture = makeNativeFixture("native-git-signer-disabled", {
          mode: "direct",
          executable: gitExecutable,
          args: consumed.genericCommand.args,
        }, 30, "level3", stateRoot);
        const markerPath = path.join(fixture.root, "signer-called.txt");
        const markerExecutable = compileSignerMarker(fixture.root, markerPath);
        git(fixture.root, "config", "user.name", "c2c-test");
        git(fixture.root, "config", "user.email", "test@c2c.local");
        git(fixture.root, "config", "commit.gpgSign", "true");
        git(fixture.root, "config", "gpg.program", markerExecutable);
        fs.writeFileSync(path.join(fixture.root, "hello.txt"), "staged local Native Helper commit\n");
        git(fixture.root, "add", "hello.txt");
        const { handle, output } = start(fixture);
        const completion = await handle.completion;
        expect(completion.result.outcome).toBe(0);
        expect(completion.result.exitCode, Buffer.concat(output.get("stderr") ?? []).toString("utf8")).toBe(0);
        expect(fs.existsSync(markerPath)).toBe(false);
        expect(git(fixture.root, "log", "-1", "--pretty=%s").trim()).toBe("native signer override regression");
      } finally {
        if (previousStateDirectory === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateDirectory;
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "runs a direct executable with literal Windows argv and without a package.json",
    async () => {
      const root = makeSystemTempDir("native-generic-argv");
      const outputPath = path.join(root, "literal-argv.json");
      const literalArgs = ["", "two words", "quote\"and\\tail", "& | ^ %PATH%" ];
      const source = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));";
      const fixture = makeNativeFixture("native-generic-argv", {
        mode: "direct",
        args: ["-e", source, outputPath, ...literalArgs],
      });
      expect(fs.existsSync(path.join(fixture.root, "package.json"))).toBe(false);
      const { handle } = start(fixture);
      const completion = await handle.completion;
      expect(completion.result.outcome).toBe(0);
      expect(completion.result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual(literalArgs);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "keeps the legacy repository Native path restricted to .exe files",
    async () => {
      const comRoot = makeSystemTempDir("native-generic-com-denied");
      const comExecutable = path.join(comRoot, "node-copy.com");
      const marker = path.join(comRoot, "must-not-run.txt");
      fs.copyFileSync(process.execPath, comExecutable);
      const fixture = makeNativeFixture("native-generic-com-denied-request", {
        mode: "direct",
        executable: comExecutable,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`],
      });

      const completion = await start(fixture).handle.completion;
      expect(completion.result.outcome).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "waits for async output callbacks before resolving completion and preserves output order",
    async () => {
      const source = "process.stdout.write('first');setTimeout(()=>process.stdout.write('second'),150);";
      const fixture = makeNativeFixture("native-generic-async-output", { mode: "direct", args: ["-e", source] });
      const output: Buffer[] = [];
      let releaseOutput!: () => void;
      const outputGate = new Promise<void>((resolve) => { releaseOutput = resolve; });
      let settled = false;
      const handle = fixture.runner.start(fixture.request, {
        onOutput: async (stream, data) => {
          expect(stream).toBe("stdout");
          output.push(Buffer.from(data));
          if (output.length === 1) await outputGate;
        },
      });
      const completion = handle.completion;
      void completion.then(() => { settled = true; }, () => { settled = true; });
      try {
        await waitUntil(() => output.length > 0, 10_000, "Native runner did not deliver the first output frame.");
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(settled).toBe(false);
      } finally {
        releaseOutput();
      }

      const result = await completion;
      expect(result.result.outcome).toBe(0);
      expect(result.result.exitCode).toBe(0);
      expect(Buffer.concat(output).toString("utf8")).toBe("firstsecond");
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "propagates output callback failure with cleanup evidence and no unhandled rejection",
    async () => {
      const fixture = makeNativeFixture("native-generic-output-failure", {
        mode: "direct",
        args: ["-e", "process.stdout.write('trigger');"],
      });
      const unhandled: unknown[] = [];
      const captureUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", captureUnhandled);
      try {
        const handle = fixture.runner.start(fixture.request, {
          onOutput: async () => { throw new Error("controlled output callback failure"); },
        });
        await expect(handle.completion).rejects.toMatchObject({
          name: "NativeRunnerOutputError",
          message: "OUTPUT_PERSISTENCE_FAILED",
          tempCleanupConfirmed: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", captureUnhandled);
      }
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "accepts a generic approval manifest in the controlled Git plan directory",
    async () => {
      const root = makeSystemTempDir("native-generic-git-plan-manifest");
      const marker = path.join(root, "git-plan-manifest-ok.txt");
      const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'C2C_GIT_PLAN_OK');`;
      const fixture = makeNativeFixture("native-generic-git-plan-manifest", {
        mode: "direct",
        args: ["-e", source],
      }, 20, "git-plan");
      const completion = await start(fixture).handle.completion;
      expect(completion.result.outcome).toBe(0);
      expect(fs.readFileSync(marker, "utf8")).toBe("C2C_GIT_PLAN_OK");
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "runs CMD and PowerShell text only through their fixed command modes",
    async () => {
      const cmdMarkerRoot = makeSystemTempDir("native-generic-cmd");
      const cmdMarker = path.join(cmdMarkerRoot, "cmd output.txt");
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      const cmdExe = path.join(systemRoot, "System32", "cmd.exe");
      const cmdFixture = makeNativeFixture("native-generic-cmd", {
        mode: "cmd",
        executable: cmdExe,
        commandText: `echo C2C_CMD_OK>"${cmdMarker}"`,
      });
      const cmdCompletion = await start(cmdFixture).handle.completion;
      expect(cmdCompletion.result.outcome).toBe(0);
      expect(fs.readFileSync(cmdMarker, "utf8").trim()).toBe("C2C_CMD_OK");

      const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const powershellMarkerRoot = makeSystemTempDir("native-generic-powershell");
      const powershellMarker = path.join(powershellMarkerRoot, "powershell output.txt");
      const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const powershellFixture = makeNativeFixture("native-generic-powershell", {
        mode: "powershell",
        executable: powershell,
        commandText: `Set-Content -LiteralPath ${quote(powershellMarker)} -Value 'C2C_POWERSHELL_OK' -NoNewline`,
      });
      const powershellCompletion = await start(powershellFixture).handle.completion;
      expect(powershellCompletion.result.outcome).toBe(0);
      expect(fs.readFileSync(powershellMarker, "utf8")).toBe("C2C_POWERSHELL_OK");
    },
    90_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "cancels a generic process tree through the native Job Object",
    async () => {
      const root = makeSystemTempDir("native-generic-cancel");
      const parentPidFile = path.join(root, "parent.pid");
      const childPidFile = path.join(root, "child.pid");
      const fixture = makeNativeFixture("native-generic-cancel", processTreeCommand(root, parentPidFile, childPidFile), 60);
      const { handle } = start(fixture);
      const pids = await waitForProcessTree(parentPidFile, childPidFile);
      handle.cancel();
      const completion = await handle.completion;
      expect(completion.result.outcome).toBe(1);
      await waitForProcessesToExit(pids);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "times out a generic process tree through the native Job Object",
    async () => {
      const root = makeSystemTempDir("native-generic-timeout");
      const parentPidFile = path.join(root, "parent.pid");
      const childPidFile = path.join(root, "child.pid");
      const fixture = makeNativeFixture("native-generic-timeout", processTreeCommand(root, parentPidFile, childPidFile), 5);
      const { handle } = start(fixture);
      const pids = await waitForProcessTree(parentPidFile, childPidFile);
      const completion = await handle.completion;
      expect(completion.result.outcome).toBe(2);
      await waitForProcessesToExit(pids);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "refuses replacement of locked approval manifest and execution material while running",
    async () => {
      const root = makeSystemTempDir("native-generic-locks");
      const readyFile = path.join(root, "ready.txt");
      const source = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);`;
      const fixture = makeNativeFixture("native-generic-locks", { mode: "direct", args: ["-e", source] }, 60);
      const { handle } = start(fixture);
      await waitUntil(() => fs.existsSync(readyFile), 10_000, "Generic command did not reach the lock check.");
      const replacementAttempt = (file: string) => {
        try {
          fs.renameSync(file, `${file}.replacement`);
          try { fs.renameSync(`${file}.replacement`, file); } catch { /* preserve the test fixture if the OS blocks restore */ }
          return true;
        } catch {
          return false;
        }
      };
      expect(replacementAttempt(fixture.manifestPath)).toBe(false);
      expect(replacementAttempt(fixture.materialPath)).toBe(false);
      handle.cancel();
      expect((await handle.completion).result.outcome).toBe(1);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || currentTokenElevated).each([
    ["approval manifest", "manifest"],
    ["execution material", "material"],
  ])("rejects a changed %s before starting the executable", async (_label, target) => {
    const markerRoot = makeSystemTempDir(`native-generic-stale-${target}`);
    const marker = path.join(markerRoot, "should-not-run.txt");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`;
    const fixture = makeNativeFixture(`native-generic-stale-${target}`, {
      mode: "direct",
      args: ["-e", source],
    });
    const targetPath = target === "manifest" ? fixture.manifestPath : fixture.materialPath;
    fs.writeFileSync(targetPath, "changed after authorization\n");
    const completion = await start(fixture).handle.completion;
    expect(completion.result.outcome).toBe(3);
    expect(completion.result.win32Error).toBe(23);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it.skipIf(process.platform !== "win32" || currentTokenElevated).each([
    ["outside the state root", "state"],
    ["under another workspace", "workspace"],
  ])("rejects a generic approval manifest %s before starting the executable", async (_label, location) => {
    const markerRoot = makeSystemTempDir(`native-generic-manifest-${location}`);
    const marker = path.join(markerRoot, "should-not-run.txt");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`;
    const fixture = makeNativeFixture(`native-generic-manifest-${location}`, {
      mode: "direct",
      args: ["-e", source],
    });
    const workspaceId = fixture.request.tempLease.workspaceId;
    const requestId = randomBytes(24).toString("base64url");
    const manifestPath = location === "state"
      ? path.join(fixture.root, "execution", "level3", workspaceId, `${requestId}.manifest.json`)
      : path.join(fixture.stateRoot, "execution", "level3", `${workspaceId}-other`, `${requestId}.manifest.json`);
    redirectManifest(fixture, manifestPath);

    const completion = await start(fixture).handle.completion;
    expect(completion.result.outcome).toBe(3);
    expect(completion.result.win32Error).toBe(5);
    expect(fs.existsSync(marker)).toBe(false);
  }, 60_000);

  it.skipIf(process.platform !== "win32" || currentTokenElevated)(
    "rejects a changed external git-remote-https material before starting the approved executable",
    async () => {
      const helperRoot = makeSystemTempDir("native-git-remote-helper");
      const helperPath = path.join(helperRoot, "git-remote-https.exe");
      fs.writeFileSync(helperPath, "isolated helper material\n", { flag: "wx" });
      const marker = path.join(helperRoot, "should-not-run.txt");
      const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`;
      const fixture = makeNativeFixture(`native-git-remote-stale`, {
        mode: "direct", args: ["-e", source], materialPath: helperPath,
      });
      fs.writeFileSync(helperPath, "replaced helper material\n");
      const completion = await start(fixture).handle.completion;
      expect(completion.result.outcome).toBe(3);
      expect(completion.result.win32Error).toBe(23);
      expect(fs.existsSync(marker)).toBe(false);
    },
    60_000,
  );

  it.skipIf(process.platform !== "win32" || !currentTokenElevated)(
    "rejects an elevated token before generic command execution",
    async () => {
      const root = makeSystemTempDir("native-generic-elevated-denied");
      const marker = path.join(root, "should-not-run.txt");
      const source = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected');`;
      const fixture = makeNativeFixture("native-generic-elevated-denied", { mode: "direct", args: ["-e", source] });
      const completion = await start(fixture).handle.completion;
      expect(completion.result.outcome).toBe(3);
      expect(completion.result.win32Error).toBe(5);
      expect(fs.existsSync(marker)).toBe(false);
    },
    60_000,
  );
});
