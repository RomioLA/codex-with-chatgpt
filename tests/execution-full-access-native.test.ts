import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { resolveFullAccessCommand } from "../src/execution/full-access-command.js";
import { resolveExecutionHelperPath, resolveExecutionLauncherPath, WindowsNativeExecutionRunner, type NativeRunnerCompletion, type NativeRunnerHandle, type NativeRunnerRequest } from "../src/execution/native-runner.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { planGitWrite } from "../src/git-write/index.js";
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
  it.skipIf(process.platform !== "win32")(
    "runs program-mode cmd.exe /d /c as CMD command text without CRT re-quoting",
    async () => {
      const previousStateRoot = process.env.C2C_STATE_DIR;
      const stateRoot = makeSystemTempDir("full-access-program-cmd-state");
      const workspace = new Workspace(makeSystemTempDir("full-access-program-cmd-workspace"));
      const cwd = makeSystemTempDir("full-access-program-cmd-cwd");
      process.env.C2C_STATE_DIR = stateRoot;
      try {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
        const cmdExe = path.join(systemRoot, "System32", "cmd.exe");
        const command = 'echo C2C spaced "quoted" 中文 ^& echo INJECTED tail\\';
        const run = start(new WindowsNativeExecutionRunner({ moduleDirectory }), await createRequest(stateRoot, workspace, {
          engine: "program",
          executable: cmdExe,
          args: ["/d", "/c", command],
          cwd,
        }));
        const completion = await waitCompletion(run.handle, 15_000);
        const output = joinedOutput(run.output);
        const stdoutBytes = Buffer.concat(run.output.stdout);
        const failureSummary = JSON.stringify({
          result: completion.result,
          helperExitCode: completion.helperExitCode,
          tempCleanupConfirmed: completion.tempCleanupConfirmed,
          stdout: output.stdout.slice(-512),
          stdoutBytesHex: stdoutBytes.toString("hex").slice(-256),
          stderr: output.stderr.slice(-512),
          diagnostics: run.diagnostics.join("\n").slice(-512),
        });
        expect(completion.result, failureSummary).toMatchObject({ outcome: 0, exitCode: 0 });
        expect(completion.tempCleanupConfirmed).toBe(true);
        // CMD redirects builtin output using its active code page; inspect bytes without assuming UTF-8.
        let contentEnd = stdoutBytes.length;
        if (contentEnd >= 2 && stdoutBytes[contentEnd - 2] === 0x0d && stdoutBytes[contentEnd - 1] === 0x0a) contentEnd -= 2;
        else if (contentEnd >= 1 && stdoutBytes[contentEnd - 1] === 0x0a) contentEnd -= 1;
        const content = stdoutBytes.subarray(0, contentEnd);
        const prefix = Buffer.from('C2C spaced "quoted" ', "ascii");
        const suffix = Buffer.from(' & echo INJECTED tail\\', "ascii");
        expect(content.subarray(0, prefix.length)).toEqual(prefix);
        expect(content.subarray(content.length - suffix.length)).toEqual(suffix);
        const nonAsciiPayload = content.subarray(prefix.length, content.length - suffix.length);
        expect(nonAsciiPayload.length).toBeGreaterThan(0);
        expect([...nonAsciiPayload].every((byte) => byte >= 0x80)).toBe(true);
        expect(output.stderr).toBe("");
      } finally {
        if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateRoot;
      }
    },
    60_000,
  );
  it.skipIf(process.platform !== "win32")(
    "compares helper-free public HTTPS fetch from ordinary Git and Native program",
    async () => {
      const fixtureRoot = makeSystemTempDir("https-no-helper-ab");
      const stateRoot = path.join(fixtureRoot, "state");
      const workspaceRoot = path.join(fixtureRoot, "workspace");
      const gitRoot = path.join(fixtureRoot, "bare-repo");
      const profile = path.join(fixtureRoot, "profile");
      const hooks = path.join(fixtureRoot, "empty-hooks");
      for (const dir of [stateRoot, workspaceRoot, gitRoot, profile, hooks]) fs.mkdirSync(dir);
      const workspace = new Workspace(workspaceRoot);
      const previousStateRoot = process.env.C2C_STATE_DIR;
      const savedEnvironment = new Map<string, string | undefined>();
      const controlledNames = Object.keys(process.env).filter((name) =>
        name.toUpperCase().startsWith("GIT_") ||
        name.toUpperCase().startsWith("GCM_") ||
        /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name) ||
        ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].includes(name.toUpperCase()),
      );
      for (const name of controlledNames) {
        savedEnvironment.set(name, process.env[name]);
        delete process.env[name];
      }
      const setEnvironment = (name: string, value: string) => { process.env[name] = value; };
      setEnvironment("HOME", profile);
      setEnvironment("USERPROFILE", profile);
      setEnvironment("APPDATA", profile);
      setEnvironment("LOCALAPPDATA", profile);
      setEnvironment("TEMP", profile);
      setEnvironment("TMP", profile);
      setEnvironment("GIT_CONFIG_GLOBAL", "NUL");
      setEnvironment("GIT_CONFIG_SYSTEM", "NUL");
      setEnvironment("GIT_CONFIG_NOSYSTEM", "1");
      setEnvironment("GIT_ATTR_NOSYSTEM", "1");
      setEnvironment("GIT_NO_REPLACE_OBJECTS", "1");
      setEnvironment("GIT_CONFIG_COUNT", "2");
      setEnvironment("GIT_CONFIG_KEY_0", "core.hooksPath");
      setEnvironment("GIT_CONFIG_VALUE_0", hooks);
      setEnvironment("GIT_CONFIG_KEY_1", "credential.helper");
      setEnvironment("GIT_CONFIG_VALUE_1", "");
      setEnvironment("GIT_TERMINAL_PROMPT", "0");
      setEnvironment("GCM_INTERACTIVE", "Never");
      process.env.C2C_STATE_DIR = stateRoot;

      try {
        const gitExecutable = resolveGitExecutable().path;
        const directEnv = { ...process.env };
        const init = spawnSync(gitExecutable, ["init", "--bare"], {
          cwd: gitRoot, env: directEnv, encoding: "buffer", timeout: 10_000,
        });
        expect(init.status, "isolated git init failed; errorCode=" + (init.error?.code ?? "none")).toBe(0);

        const directConfig = spawnSync(gitExecutable, [
          "-c", "credential.helper=", "config", "--get-all", "credential.helper",
        ], { cwd: gitRoot, env: directEnv, encoding: "buffer", timeout: 5_000 });
        expect([0, 1]).toContain(directConfig.status);
        expect(directConfig.stdout.toString("utf8").trim()).toBe("");

        const runner = new WindowsNativeExecutionRunner({ moduleDirectory });
        const nativeConfigRun = start(runner, await createRequest(stateRoot, workspace, {
          engine: "program",
          executable: gitExecutable,
          args: ["-c", "credential.helper=", "config", "--get-all", "credential.helper"],
          cwd: gitRoot,
        }, 5));
        const nativeConfig = await waitCompletion(nativeConfigRun.handle, 10_000);
        expect(nativeConfig.result.outcome).toBe(0);
        expect([0, 1]).toContain(nativeConfig.result.exitCode);
        expect(nativeConfig.tempCleanupConfirmed).toBe(true);
        const nativeHelperConfigOutput = Buffer.concat(nativeConfigRun.output.stdout);
        expect(nativeHelperConfigOutput.toString("utf8").trim()).toBe("");

        const fetchArgs = [
          "--no-pager",
          "-c", "credential.helper=",
          "-c", "credential.interactive=false",
          "-c", "credential.guiPrompt=false",
          "-c", "core.askPass=",
          "-c", "http.sslVerify=true",
          "-c", "http.followRedirects=false",
          "-c", "protocol.allow=never",
          "-c", "protocol.https.allow=always",
          "fetch", "--dry-run", "--no-write-fetch-head", "--depth=1",
          "https://github.com/octocat/Hello-World.git",
        ];
        const directStarted = Date.now();
        const direct = spawnSync(gitExecutable, fetchArgs, {
          cwd: gitRoot, env: directEnv, encoding: "buffer", timeout: 15_000, maxBuffer: 1_048_576,
        });
        const directElapsedMs = Date.now() - directStarted;

        const nativeStarted = Date.now();
        const nativeRun = start(runner, await createRequest(stateRoot, workspace, {
          engine: "program", executable: gitExecutable, args: fetchArgs, cwd: gitRoot,
        }, 15));
        const nativeCompletion = await waitCompletion(nativeRun.handle, 20_000);
        const nativeElapsedMs = Date.now() - nativeStarted;
        const nativeStdout = Buffer.concat(nativeRun.output.stdout);
        const nativeStderr = Buffer.concat(nativeRun.output.stderr);
        const classify = (bytes: Buffer): string => {
          const value = bytes.toString("utf8").toLowerCase();
          if (value.includes("could not resolve") || value.includes("resolve host")) return "dns";
          if (value.includes("timed out") || value.includes("timeout")) return "timeout";
          if (value.includes("ssl") || value.includes("tls") || value.includes("certificate")) return "tls";
          if (value.includes("proxy")) return "proxy";
          if (value.length === 0) return "empty";
          return "other";
        };
        console.log("HTTPS_NO_HELPER_GIT_NATIVE_AB=" + JSON.stringify({
          fixtureRoot,
          remoteHost: "github.com",
          repository: "octocat/Hello-World",
          timeoutMs: 15_000,
          sameGitExecutable: true,
          sameArgs: true,
          sameHomeAndGitConfig: true,
          nativeRecipe: "3/full-access-program",
          nativeOnlyEnvDifference: "TEMP/TMP use the Native job-owned directory",
          helperConfigProbe: {
            directExitCode: directConfig.status,
            directStdoutBytes: directConfig.stdout.byteLength,
            nativeOutcome: nativeConfig.result.outcome,
            nativeExitCode: nativeConfig.result.exitCode,
            nativeStdoutBytes: nativeHelperConfigOutput.byteLength,
            nativeStdoutHex: nativeHelperConfigOutput.toString("hex"),
            nativeOutputWhitespaceOnly: nativeHelperConfigOutput.toString("utf8").trim() === "",
          },
          credentialHelperConfigEmptyInDirectAndNative: true,
          gcmCredentialStoreEnvPresent: Boolean(process.env.GCM_CREDENTIAL_STORE),
          proxyEnvironmentPresent: Object.keys(process.env).some((name) => /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name)),
          direct: {
            exitCode: direct.status,
            timedOut: direct.error?.code === "ETIMEDOUT",
            errorCode: direct.error?.code ?? null,
            elapsedMs: directElapsedMs,
            stdoutBytes: direct.stdout.byteLength,
            stderrBytes: direct.stderr.byteLength,
            stderrClass: classify(direct.stderr),
          },
          native: {
            outcome: nativeCompletion.result.outcome,
            exitCode: nativeCompletion.result.exitCode,
            win32Error: nativeCompletion.result.win32Error,
            tempCleanupConfirmed: nativeCompletion.tempCleanupConfirmed,
            elapsedMs: nativeElapsedMs,
            stdoutBytes: nativeStdout.byteLength,
            stderrBytes: nativeStderr.byteLength,
            stderrClass: classify(nativeStderr),
            diagnostics: nativeRun.diagnostics.map((value) => value.slice(0, 120)),
          },
        }));
      } finally {
        for (const [name, value] of savedEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateRoot;
      }
    },
    60_000,
  );
  it.skipIf(process.platform !== "win32")(
    "runs structured recipe-2 HTTPS fetch with isolated credential.credentialStore=none",
    async () => {
      const fixtureRoot = makeSystemTempDir("recipe2-gcm-none");
      const stateRoot = path.join(fixtureRoot, "state");
      const repositoryRoot = path.join(fixtureRoot, "workspace");
      const profileRoot = path.join(fixtureRoot, "profile");
      const hooksRoot = path.join(fixtureRoot, "empty-hooks");
      const configRoot = path.join(fixtureRoot, "empty-config");
      const tracePath = path.join(fixtureRoot, "git-trace2.json");
      for (const dir of [stateRoot, repositoryRoot, profileRoot, hooksRoot, configRoot]) fs.mkdirSync(dir);
      const globalConfig = path.join(configRoot, "empty-global.gitconfig");
      const systemConfig = path.join(configRoot, "empty-system.gitconfig");
      fs.writeFileSync(globalConfig, "", { flag: "wx" });
      fs.writeFileSync(systemConfig, "", { flag: "wx" });

      const previousStateRoot = process.env.C2C_STATE_DIR;
      const savedEnvironment = new Map<string, string | undefined>();
      const controlledNames = Object.keys(process.env).filter((name) =>
        name.toUpperCase().startsWith("GIT_") ||
        name.toUpperCase().startsWith("GCM_") ||
        /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name) ||
        ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"].includes(name.toUpperCase()),
      );
      for (const name of controlledNames) {
        savedEnvironment.set(name, process.env[name]);
        delete process.env[name];
      }
      process.env.C2C_STATE_DIR = stateRoot;
      process.env.HOME = profileRoot;
      process.env.USERPROFILE = profileRoot;
      process.env.APPDATA = profileRoot;
      process.env.LOCALAPPDATA = profileRoot;
      process.env.TEMP = profileRoot;
      process.env.TMP = profileRoot;
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_SYSTEM = systemConfig;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      process.env.GIT_TERMINAL_PROMPT = "0";
      process.env.GCM_INTERACTIVE = "Never";

      let supervisor: ExecutionSupervisor | undefined;
      try {
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
        const system32 = path.join(systemRoot, "System32");
        const directEnv: NodeJS.ProcessEnv = {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          ComSpec: path.join(system32, "cmd.exe"),
          PATH: system32,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
          TEMP: profileRoot,
          TMP: profileRoot,
          USERPROFILE: profileRoot,
          HOME: profileRoot,
          APPDATA: profileRoot,
          LOCALAPPDATA: profileRoot,
          GIT_CONFIG_GLOBAL: "NUL",
          GIT_CONFIG_SYSTEM: "NUL",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_ATTR_NOSYSTEM: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "Never",
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: hooksRoot,
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_1: "",
        };
        const gitExecutable = resolveGitExecutable().path;


        const requireGitSuccess = (args: string[]) => {
          const result = spawnSync(gitExecutable, args, {
            cwd: repositoryRoot,
            env: directEnv,
            encoding: "buffer",
            timeout: 10_000,
            maxBuffer: 1_048_576,
            windowsHide: true,
            shell: false,
          });
          if (result.error || result.status !== 0) {
            throw new Error("ISOLATED_REPOSITORY_SETUP_FAILED:" + (result.error?.code ?? result.status));
          }
          return result.stdout;
        };
        requireGitSuccess(["init", "--initial-branch=main"]);
        requireGitSuccess(["remote", "add", "origin", "https://github.com/octocat/Hello-World.git"]);
        requireGitSuccess(["config", "--local", "credential.credentialStore", "none"]);
        requireGitSuccess(["config", "--local", "trace2.eventTarget", tracePath]);

        const effectiveStore = requireGitSuccess([
          "config", "--show-origin", "--local", "--get", "credential.credentialStore",
        ]).toString("utf8").trim();
        expect(effectiveStore.endsWith("none")).toBe(true);
        expect(process.env.GCM_CREDENTIAL_STORE).toBeUndefined();
        expect(process.env.GCM_PLAINTEXT_STORE_PATH).toBeUndefined();
        expect(Object.keys(process.env).some((name) => /^(HTTP|HTTPS|ALL|NO)_PROXY$/i.test(name))).toBe(false);
        expect(directEnv.GCM_CREDENTIAL_STORE).toBeUndefined();
        expect(directEnv.GCM_PLAINTEXT_STORE_PATH).toBeUndefined();

        const workspace = new Workspace(repositoryRoot);
        expect(setPermission(workspace.id, "level2")).toBe("level2");
        const isolatedPermission = readPermissionStatus(workspace.id);
        expect(isolatedPermission.effectiveMode).toBe("level2");
        expect(isolatedPermission.sessionElevation.active).toBe(true);
        const grant = readCurrentSessionGrant(workspace.id);
        if (!grant) throw new Error("FULL_ACCESS_TEST_GRANT_UNAVAILABLE");
        const operation = {
          kind: "fetch" as const,
          remote: "origin",
          branches: ["master"],
          expectedHead: null,
          expectedBranch: "main",
        };
        const authorization = {
          source: "full_access" as const,
          permissionMode: "level2" as const,
          sessionGrantFingerprint: grant.identityFingerprint,
          sessionGrantId: grant.grantId,
        };
        const plan = planGitWrite(workspace, ".", operation, authorization);
        const helperValues = plan.args
          .filter((value) => value.toLowerCase().startsWith("credential.helper="));
        const selectedHelper = helperValues.at(-1)?.slice("credential.helper=".length) ?? "";
        expect(selectedHelper.toLowerCase()).toContain("git-credential-manager");
        expect(plan.args).toContain("credential.helper=");
        expect(plan.environment).not.toHaveProperty("GCM_CREDENTIAL_STORE");
        expect(plan.environment).not.toHaveProperty("GCM_PLAINTEXT_STORE_PATH");
        const injectedStoreConfigOverride = Object.entries(plan.environment)
          .some(([name, value]) => /^GIT_CONFIG_KEY_\d+$/.test(name) && String(value ?? "").toLowerCase() === "credential.credentialstore");
        const commandLineStoreOverride = plan.args
          .some((value) => value.toLowerCase().startsWith("credential.credentialstore="));
        const higherPriorityGitAndGcmConfigPresent =
          injectedStoreConfigOverride || commandLineStoreOverride ||
          plan.environment.GIT_CONFIG_GLOBAL !== "NUL" ||
          plan.environment.GIT_CONFIG_SYSTEM !== "NUL" ||
          plan.environment.GIT_CONFIG_NOSYSTEM !== "1" ||
          plan.environment.GCM_CREDENTIAL_STORE !== undefined ||
          plan.environment.GCM_PLAINTEXT_STORE_PATH !== undefined;
        expect(higherPriorityGitAndGcmConfigPresent).toBe(false);

        const helperValueIndex = plan.args.lastIndexOf("credential.helper=" + selectedHelper);
        const clearedHelperIndex = plan.args.lastIndexOf("credential.helper=");
        expect(clearedHelperIndex).toBeGreaterThan(-1);
        expect(clearedHelperIndex).toBeLessThan(helperValueIndex);
        expect(helperValueIndex).toBeGreaterThan(0);
        expect(plan.args[helperValueIndex - 1]).toBe("-c");


        const traceChildren = (offset: number) => {
          if (!fs.existsSync(tracePath)) return [];
          const bytes = fs.readFileSync(tracePath);
          const events = bytes.subarray(offset).toString("utf8").split(/\r?\n/).filter(Boolean);
          const names = new Map<string, string>();
          const result: Array<Record<string, unknown>> = [];
          for (const line of events) {
            let event: Record<string, unknown>;
            try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
            const kind = event.event;
            const childId = String(event.child_id ?? "");
            const argv = Array.isArray(event.argv) ? event.argv.map(String).join(" ") : String(event.argv ?? "");
            const lower = argv.toLowerCase();
            const processName = lower.includes("git-credential-manager") ? "gcm"
              : lower.includes("git-remote-https") ? "git-remote-https"
                : "";
            if (kind === "child_start" && processName) {
              names.set(childId, processName);
              result.push({ event: "start", process: processName, childId });
            } else if (kind === "child_exit" && names.has(childId)) {
              result.push({
                event: "exit",
                process: names.get(childId),
                childId,
                code: event.code ?? null,
                elapsed: event.elapsed ?? null,
              });
            }
          }
          return result;
        };
        const traceSize = () => fs.existsSync(tracePath) ? fs.statSync(tracePath).size : 0;

        const candidateHelperPath = resolveExecutionHelperPath({ moduleDirectory });
        const candidateLauncherPath = resolveExecutionLauncherPath({ moduleDirectory });
        const candidateHelperSha256 = createHash("sha256").update(fs.readFileSync(candidateHelperPath)).digest("hex");
        const candidateLauncherSha256 = createHash("sha256").update(fs.readFileSync(candidateLauncherPath)).digest("hex");



        let nativeCompletionObserved: NativeRunnerCompletion | null = null;
        const native = new WindowsNativeExecutionRunner({ moduleDirectory });
        const runner: ExecutionRunner = {
          start(request, callbacks) {
            const handle = native.start(request, callbacks);
            return {
              ...handle,
              completion: handle.completion.then((completion) => {
                nativeCompletionObserved = completion;
                return completion;
              }),
            };
          },
        };
        supervisor = new ExecutionSupervisor(workspace, { runner });
        const nativeTraceOffset = traceSize();
        const started = supervisor.startGitWrite({
          repositoryPath: ".",
          operation,
          timeoutSeconds: 15,
          oauthClientId: "v15-gcm-none-test",
          scopes: ["git.write"],
          idempotencyKey: "v15-gcm-none-" + randomBytes(12).toString("hex"),
        });
        let nativeJob: Record<string, unknown> | null = null;
        let nativeStartError: string | null = null;
        let nativeJobId: string | null = null;
        let nativeAuthorizationSource: string | null = null;
        if (!started.ok) {
          nativeStartError = started.error;
        } else {
          nativeJobId = started.job.jobId;
          const authorization = started.job.authorization;
          nativeAuthorizationSource = authorization?.type === "git" ? authorization.source : null;
          expect(authorization).toMatchObject({ type: "git", source: "full_access", permissionMode: "level2" });
          const deadline = Date.now() + 25_000;
          while (Date.now() < deadline) {
            const job = supervisor.store.get(started.job.jobId);
            if (job?.finishedAt) {
              nativeJob = {
                jobId: job.jobId,
                authorizationType: job.authorization?.type ?? null,
                authorizationSource: job.authorization?.type === "git" ? job.authorization.source : null,
                recipeKind: job.recipe.kind,
                operationKind: operation.kind,
                repositoryIdentity: job.repositoryIdentity,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                state: job.state,
                failureCode: job.failureCode,
                exitCode: job.exitCode,
                outcome: nativeCompletionObserved?.result.outcome ?? null,
                nativeExitCode: nativeCompletionObserved?.result.exitCode ?? null,
                win32Error: nativeCompletionObserved?.result.win32Error ?? null,
                helperExitCode: nativeCompletionObserved?.helperExitCode ?? null,
                tempCleanupConfirmed: nativeCompletionObserved?.tempCleanupConfirmed ?? null,
                stdoutBytes: job.stdout.totalBytes,
                stderrBytes: job.stderr.totalBytes,
                gitResultKeys: job.gitResult && typeof job.gitResult === "object"
                  ? Object.keys(job.gitResult as Record<string, unknown>)
                  : [],
                remoteOutcome: (job.gitResult as { remoteOutcome?: string } | null)?.remoteOutcome ?? null,
              };
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (nativeJob === null) nativeStartError = "NATIVE_JOB_NO_TERMINAL_STATE_WITHIN_25S";
        }
        const nativeStages = traceChildren(nativeTraceOffset);
        const summary = {
          fixtureRoot,
          candidateModuleDirectory: moduleDirectory,
          candidateHelperPath,
          candidateHelperSha256,
          candidateLauncherPath,
          candidateLauncherSha256,
          candidateStateRoot: stateRoot,
          candidateWorkspaceId: workspace.id,
          candidateRepositoryRoot: repositoryRoot,
          candidateGitExecutable: gitExecutable,
          isolatedPermissionEffectiveMode: isolatedPermission.effectiveMode,
          sessionElevationActive: isolatedPermission.sessionElevation.active,
          authorizationSource: nativeAuthorizationSource,
          repositoryApprovalUsed: false,
          recipeKind: "structured-git-write-recipe-2",
          operationKind: operation.kind,
          nativeJobId,
          repoConfigStore: "none",
          repoConfigStoreOrigin: effectiveStore.split(/\s+/)[0] ?? "",
          gcmCredentialStoreEnvironmentPresent: false,
          gcmPlaintextStorePathEnvironmentPresent: false,
          higherPriorityGitAndGcmConfigPresent,
          operation: "read-only public fetch",
          remote: "github.com/octocat/Hello-World.git",
          timeoutSeconds: 15,
          c2cPlanAcceptedNoneConfig: true,
          plannedHelper: path.basename(selectedHelper),

          nativeStartError,
          nativeJob,
          nativeStages,
          trace2Bytes: fs.existsSync(tracePath) ? fs.statSync(tracePath).size : 0,
        };
        fs.writeFileSync(path.join(fixtureRoot, "recipe2-gcm-none-evidence.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
        console.log("RECIPE2_GCM_NONE_PUBLIC_FETCH=" + JSON.stringify(summary));
        expect(nativeStartError).toBeNull();
        expect(nativeAuthorizationSource).toBe("full_access");
        expect((nativeJob as { state?: string } | null)?.state).toBe("succeeded");
      } finally {
        if (supervisor) await supervisor.shutdown();
        for (const [name, value] of savedEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        if (previousStateRoot === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateRoot;
      }
    },
    90_000,
  );
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
