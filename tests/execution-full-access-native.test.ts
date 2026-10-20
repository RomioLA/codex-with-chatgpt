import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { resolveFullAccessCommand } from "../src/execution/full-access-command.js";
import { WindowsNativeExecutionRunner, type NativeRunnerCompletion, type NativeRunnerHandle, type NativeRunnerRequest } from "../src/execution/native-runner.js";
import { Workspace } from "../src/workspace/manager.js";
import type { OutputStream } from "../src/execution/job-types.js";
import { resolveGitExecutable } from "../src/git-write/security.js";
import { readCurrentSessionGrant, readPermissionStatus, setPermission } from "../src/permission/store.js";
import { git, makeGitRepo } from "./helpers.js";

const moduleDirectory = process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY
  ? path.resolve(process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/execution");

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

async function createRequest(
  stateRoot: string,
  workspace: Workspace,
  commandInput: Parameters<typeof resolveFullAccessCommand>[0],
  timeoutSeconds = 30,
): Promise<NativeRunnerRequest> {
  const stateDirectory = path.join(stateRoot, "execution-jobs", workspace.id);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const owner = new ExecutionTempOwner(stateDirectory, workspace.id);
  setPermission(workspace.id, "level2");
  const grant = readCurrentSessionGrant(workspace.id);
  if (!grant) throw new Error("FULL_ACCESS_TEST_GRANT_UNAVAILABLE");
  const jobId = randomBytes(24).toString("base64url");
  const command = await resolveFullAccessCommand(commandInput, workspace.root);
  return {
    jobId,
    timeoutSeconds,
    stateDirectory,
    tempLease: owner.create(jobId),
    fullAccess: {
      workspaceId: workspace.id,
      oauthClientId: "native-full-access-test-client",
      permissionMode: "level2",
      sessionGrantFingerprint: grant.identityFingerprint,
      sessionGrantId: grant.grantId,
      idempotencyKeyHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      command,
    },
  };
}

function start(runner: WindowsNativeExecutionRunner, request: NativeRunnerRequest) {
  const output: Record<OutputStream, Buffer[]> = { stdout: [], stderr: [] };
  const diagnostics: string[] = [];
  const nativeHandle = runner.start(request, {
    onOutput: (stream, data) => { output[stream].push(Buffer.from(data)); },
    onDiagnostic: (message) => diagnostics.push(message),
  });
  const handle: NativeRunnerHandle = {
    ...nativeHandle,
    completion: nativeHandle.completion.catch((error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${diagnostics.join(" | ")}`);
    }),
  };
  return { handle, output, diagnostics };
}

async function waitCompletion(handle: NativeRunnerHandle, timeoutMs: number): Promise<NativeRunnerCompletion> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      handle.completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          handle.cancel();
          reject(new Error("FULL_ACCESS_NATIVE_TEST_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function joinedOutput(output: Record<OutputStream, Buffer[]>): Record<OutputStream, string> {
  return {
    stdout: Buffer.concat(output.stdout).toString("utf8"),
    stderr: Buffer.concat(output.stderr).toString("utf8"),
  };
}

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("FULL_ACCESS_NATIVE_TEST_CONDITION_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("Windows Full Access native execution", () => {
  it.skipIf(process.platform !== "win32")("runs all engines in an external cwd and preserves the Job Object lifecycle", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
    const previousSystemGitConfig = process.env.GIT_CONFIG_SYSTEM;
    const previousGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const stateRoot = makeSystemTempDir("full-access-state");
    const workspace = new Workspace(makeSystemTempDir("full-access-workspace"));
    const externalCwd = makeSystemTempDir("full-access-external-cwd");
    const gitRoot = makeSystemTempDir("full-access-git-outside-workspace");
    const isolatedGitConfig = path.join(stateRoot, "gitconfig");
    fs.writeFileSync(isolatedGitConfig, "", { flag: "wx" });
    process.env.C2C_STATE_DIR = stateRoot;
    process.env.GIT_CONFIG_GLOBAL = isolatedGitConfig;
    process.env.GIT_CONFIG_SYSTEM = "NUL";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    const runner = new WindowsNativeExecutionRunner({ moduleDirectory });
    try {
      makeGitRepo(gitRoot);
      git(gitRoot, "config", "user.name", "Full Access Native Test");
      git(gitRoot, "config", "user.email", "full-access-native-test@c2c.local");

      const operationScript = [
        "const fs=require('node:fs')",
        "const path=require('node:path')",
        "const file=path.join(process.cwd(),'full-access-created.txt')",
        "const dir=path.join(process.cwd(),'full-access-created-dir')",
        "fs.writeFileSync(file,'created')",
        "fs.appendFileSync(file,'-modified')",
        "const value=fs.readFileSync(file,'utf8')",
        "fs.unlinkSync(file)",
        "fs.mkdirSync(dir)",
        "fs.rmdirSync(dir)",
        "console.log('external-operations:'+value)",
        "console.error('program-stderr')",
      ].join(";");
      const program = start(runner, await createRequest(stateRoot, workspace, {
        engine: "program", executable: process.execPath, args: ["-e", operationScript], cwd: externalCwd,
      }));
      const programResult = await waitCompletion(program.handle, 15_000);
      expect(programResult.result).toMatchObject({ outcome: 0, exitCode: 0 });
      expect(joinedOutput(program.output)).toMatchObject({
        stdout: expect.stringContaining("external-operations:created-modified"),
        stderr: expect.stringContaining("program-stderr"),
      });
      expect(fs.existsSync(path.join(externalCwd, "full-access-created.txt"))).toBe(false);
      expect(fs.existsSync(path.join(externalCwd, "full-access-created-dir"))).toBe(false);

      const comExecutable = path.join(externalCwd, "node-copy.com");
      fs.copyFileSync(process.execPath, comExecutable);
      const comProgram = start(runner, await createRequest(stateRoot, workspace, {
        engine: "program", executable: comExecutable,
        args: ["-e", "console.log('full-access-com')"], cwd: externalCwd,
      }));
      expect((await waitCompletion(comProgram.handle, 15_000)).result).toMatchObject({ outcome: 0, exitCode: 0 });
      expect(joinedOutput(comProgram.output).stdout).toContain("full-access-com");

      const powershell = start(runner, await createRequest(stateRoot, workspace, {
        engine: "powershell", command: "[Console]::Out.WriteLine('powershell-full-access')", cwd: externalCwd,
      }));
      expect((await waitCompletion(powershell.handle, 15_000)).result).toMatchObject({ outcome: 0, exitCode: 0 });
      expect(joinedOutput(powershell.output).stdout).toContain("powershell-full-access");

      const cmd = start(runner, await createRequest(stateRoot, workspace, {
        engine: "cmd", command: "echo cmd-full-access", cwd: externalCwd,
      }));
      const cmdResult = await waitCompletion(cmd.handle, 15_000);
      expect(cmdResult.result, JSON.stringify({ diagnostics: cmd.diagnostics, output: joinedOutput(cmd.output), helperExitCode: cmdResult.helperExitCode }))
        .toMatchObject({ outcome: 0, exitCode: 0 });
      expect(joinedOutput(cmd.output).stdout).toContain("cmd-full-access");

      const gitExecutable = resolveGitExecutable().path;
      const runGit = async (args: string[]): Promise<string> => {
        const run = start(runner, await createRequest(stateRoot, workspace, {
          engine: "program", executable: gitExecutable, args, cwd: gitRoot,
        }));
        const completion = await waitCompletion(run.handle, 15_000);
        expect(completion.result, JSON.stringify({ args, diagnostics: run.diagnostics, output: joinedOutput(run.output) }))
          .toMatchObject({ outcome: 0, exitCode: 0 });
        return joinedOutput(run.output).stdout;
      };
      expect(await runGit(["status", "--short", "--branch"])).toContain("## main");
      await runGit(["branch", "full-access-generic"]);
      await runGit(["switch", "full-access-generic"]);
      fs.writeFileSync(path.join(gitRoot, "full-access-git.txt"), "generic git change\n", { flag: "wx" });
      await runGit(["add", "full-access-git.txt"]);
      await runGit(["commit", "-m", "Full Access generic commit"]);
      expect(git(gitRoot, "branch", "--show-current").trim()).toBe("full-access-generic");
      expect(git(gitRoot, "status", "--porcelain")).toBe("");

      const pidFile = path.join(externalCwd, "full-access-child.pid");
      const childTreeScript = [
        "const {spawn}=require('node:child_process')",
        "const fs=require('node:fs')",
        `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})`,
        `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
        "setInterval(()=>{},1000)",
      ].join(";");
      const childTree = start(runner, await createRequest(stateRoot, workspace, {
        engine: "program", executable: process.execPath, args: ["-e", childTreeScript], cwd: externalCwd,
      }));
      await waitUntil(() => fs.existsSync(pidFile), 8_000);
      const childPid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(childPid)).toBe(true);
      childTree.handle.cancel();
      expect((await waitCompletion(childTree.handle, 15_000)).result.outcome).toBe(1);
      await waitUntil(() => !processExists(childPid), 5_000);

      const timeout = start(runner, await createRequest(stateRoot, workspace, {
        engine: "program", executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: externalCwd,
      }, 1));
      expect((await waitCompletion(timeout.handle, 15_000)).result.outcome).toBe(2);
    } finally {
      if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateRoot;
      if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
      if (previousSystemGitConfig === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousSystemGitConfig;
      if (previousGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousGitConfigNoSystem;
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("does not resume a suspended child after Full Access revocation succeeds", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("full-access-revoke-state");
    const workspace = new Workspace(makeSystemTempDir("full-access-revoke-workspace"));
    const cwd = makeSystemTempDir("full-access-revoke-cwd");
    const marker = path.join(cwd, "must-not-exist.txt");
    const releaseFile = path.join(stateRoot, "release-suspended-child");
    let suspendedPid = 0;
    let revokeMode: string | undefined;
    let revokeError: unknown;
    process.env.C2C_STATE_DIR = stateRoot;
    const runner = new WindowsNativeExecutionRunner({
      moduleDirectory,
      helperBeforeResumeTest: {
        releaseFile,
        phase: "suspended",
        onSuspended: (line) => {
          suspendedPid = Number(line.split(":")[1]);
          try { revokeMode = setPermission(workspace.id, "level1"); }
          catch (error) { revokeError = error; }
          finally { fs.writeFileSync(releaseFile, "release", { flag: "wx" }); }
        },
      },
    });
    try {
      const request = await createRequest(stateRoot, workspace, {
        engine: "program",
        executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`],
        cwd,
      });
      const run = start(runner, request);
      const completion = await waitCompletion(run.handle, 15_000);
      expect(revokeError).toBeUndefined();
      expect(revokeMode).toBe("level1");
      expect(completion.result.outcome).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(suspendedPid).toBeGreaterThan(0);
      await waitUntil(() => !processExists(suspendedPid), 5_000);
    } finally {
      if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateRoot;
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("rejects malformed or schema-invalid permission manifests before child execution", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("full-access-invalid-state");
    const workspace = new Workspace(makeSystemTempDir("full-access-invalid-workspace"));
    const cwd = makeSystemTempDir("full-access-invalid-cwd");
    const permissionFile = path.join(stateRoot, "permissions", `${workspace.id}.json`);
    process.env.C2C_STATE_DIR = stateRoot;
    try {
      const variants: Array<(state: Record<string, unknown>) => string> = [
        (state) => {
          const withoutUpdatedAt = { ...state };
          delete withoutUpdatedAt.updatedAt;
          return JSON.stringify(withoutUpdatedAt);
        },
        (state) => {
          const grant = state.sessionGrant as Record<string, unknown>;
          return JSON.stringify({ ...state, sessionGrant: { ...grant, createdAt: "not-a-timestamp" } });
        },
        (state) => JSON.stringify({ nested: state }),
        (state) => `${JSON.stringify(state)} trailing-data`,
      ];

      let validState: Record<string, unknown> | undefined;
      for (let index = 0; index < variants.length; index += 1) {
        if (validState) fs.writeFileSync(permissionFile, JSON.stringify(validState));
        const marker = path.join(cwd, `invalid-state-${index}.txt`);
        const request = await createRequest(stateRoot, workspace, {
          engine: "program",
          executable: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`],
          cwd,
        });
        validState = JSON.parse(fs.readFileSync(permissionFile, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(permissionFile, variants[index](validState));
        const run = start(new WindowsNativeExecutionRunner({ moduleDirectory }), request);
        const completion = await waitCompletion(run.handle, 15_000);
        expect(completion.result.outcome).not.toBe(0);
        expect(fs.existsSync(marker)).toBe(false);
      }
    } finally {
      if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateRoot;
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("serializes repeated revocation and Resume races", async () => {
    const previousStateRoot = process.env.C2C_STATE_DIR;
    const stateRoot = makeSystemTempDir("full-access-race-state");
    const workspace = new Workspace(makeSystemTempDir("full-access-race-workspace"));
    const cwd = makeSystemTempDir("full-access-race-cwd");
    process.env.C2C_STATE_DIR = stateRoot;
    try {
      for (let iteration = 0; iteration < 12; iteration += 1) {
        const nativeWins = iteration % 2 === 0;
        const marker = path.join(cwd, `race-${iteration}.txt`);
        const releaseFile = path.join(stateRoot, `release-${iteration}`);
        let revokeMode: string | undefined;
        let revokeError: unknown;
        let suspendedPid = 0;
        let permitReadMode: string | undefined;
        let permitGrantId: string | undefined;
        const runner = new WindowsNativeExecutionRunner({
          moduleDirectory,
          helperBeforeResumeTest: {
            releaseFile,
            phase: nativeWins ? "permit" : "suspended",
            onSuspended: (line) => {
              suspendedPid = Number(line.split(":")[1]);
              if (nativeWins) {
                permitReadMode = readPermissionStatus(workspace.id).effectiveMode;
                permitGrantId = readCurrentSessionGrant(workspace.id)?.grantId;
              }
              try { revokeMode = setPermission(workspace.id, "level1"); }
              catch (error) { revokeError = error; }
              finally { fs.writeFileSync(releaseFile, "release", { flag: "wx" }); }
            },
          },
        });
        const request = await createRequest(stateRoot, workspace, {
          engine: "program",
          executable: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
          cwd,
        });
        const run = start(runner, request);
        const completion = await waitCompletion(run.handle, 15_000);
        expect(suspendedPid).toBeGreaterThan(0);
        await waitUntil(() => !processExists(suspendedPid), 5_000);
        if (nativeWins) {
          expect(permitReadMode).toBe("level2");
          expect(permitGrantId).toBe(request.fullAccess?.sessionGrantId);
          expect(revokeMode).toBeUndefined();
          expect((revokeError as { code?: string } | undefined)?.code).toBe("PERMISSION_STATE_BUSY");
          expect(completion.result).toMatchObject({ outcome: 0, exitCode: 0 });
          expect(fs.readFileSync(marker, "utf8")).toBe("ran");
          expect(setPermission(workspace.id, "level1")).toBe("level1");
        } else {
          expect(revokeError).toBeUndefined();
          expect(revokeMode).toBe("level1");
          expect(completion.result.outcome).not.toBe(0);
          expect(fs.existsSync(marker)).toBe(false);
        }
      }
    } finally {
      if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateRoot;
    }
  }, 90_000);
});
