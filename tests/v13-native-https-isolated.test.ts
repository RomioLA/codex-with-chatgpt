import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { setPermission } from "../src/permission/store.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { resolveExecutionHelperPath, resolveExecutionLauncherPath, WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { approveGitRepository, previewGitRepositoryApproval, type GitWriteOperation } from "../src/git-write/index.js";
import { makeTmpDir, write } from "./helpers.js";
import {
  resolveGitExecutableFromPath,
  startIsolatedGitHttpsFixture,
  type IsolatedGitHttpFault,
  type IsolatedGitHttpRoute,
  type IsolatedGitHttpsFixture,
} from "./helpers/isolated-git-https.js";

const ISOLATED_HTTPS_ENABLED = process.env.C2C_V13_ISOLATED_HTTPS_TEST === "1";
const APPROVED_PROXY = "http://127.0.0.1:7897";
const JOB_TIMEOUT_SECONDS = 75;
const JOB_WAIT_TIMEOUT_MS = 105_000;
const EVIDENCE_LIMIT_BYTES = 16 * 1024;

type ScenarioName = "push-success" | "pull-success" | "push-401" | "push-drop-response" | "pull-external-dirty" | "pull-external-index" | "pull-external-head" | "pull-external-refs" | "unapproved-policy";

interface PreparedRepository {
  name: ScenarioName;
  root: string;
  bareRepository: string;
  route: IsolatedGitHttpRoute;
  workspace: Workspace;
  stateDirectory: string;
  gitConfigDirectory: string;
  baseHead: string;
  remoteHead: string | null;
  approvedExecutable: string;
}

interface JobObservation {
  jobId: string;
  state: string;
  failureCode: string | null;
  exitCode: number | null;
  gitResult: unknown;
  finishedAt: string | null;
}

interface ExternalWriteObservation {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  errorCode: string | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

let fixture: IsolatedGitHttpsFixture | null = null;
let gitExecutable = "";
let priorStateDirectory: string | undefined;

function controlledGitEnvironment(configRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: path.join(configRoot, "empty-global.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(configRoot, "empty-system.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "C2C isolated HTTPS fixture",
    GIT_AUTHOR_EMAIL: "https-fixture@c2c.local",
    GIT_COMMITTER_NAME: "C2C isolated HTTPS fixture",
    GIT_COMMITTER_EMAIL: "https-fixture@c2c.local",
  };
}

function runGit(cwd: string, configRoot: string, args: string[], timeoutMs = 20_000): string {
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env: controlledGitEnvironment(configRoot),
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
    maxBuffer: EVIDENCE_LIMIT_BYTES,
  });
  if (result.error || result.status !== 0) {
    const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code ?? "none";
    throw new Error(`BLOCKED_FIXTURE_GIT_FAILED:${args[0] ?? "empty"}:${result.status ?? "null"}:${errorCode}`);
  }
  return (result.stdout ?? "").trim();
}

function runGitObservation(cwd: string, configRoot: string, args: string[]): { exitCode: number | null; output: string; errorCode: string | null } {
  const result = spawnSync(gitExecutable, args, {
    cwd,
    encoding: "utf8",
    env: controlledGitEnvironment(configRoot),
    timeout: 10_000,
    windowsHide: true,
    shell: false,
    maxBuffer: EVIDENCE_LIMIT_BYTES,
  });
  return {
    exitCode: result.status,
    output: ((result.status === 0 ? result.stdout : result.stderr) ?? "").trim().slice(0, 1_000),
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
  };
}

function evidenceFile(name: ScenarioName): string {
  return path.join(makeTmpDir(`v13-native-https-evidence-${name}`), "evidence.json");
}

function saveEvidence(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function createBareRepository(route: IsolatedGitHttpRoute, configRoot: string): void {
  const projectRoot = path.dirname(path.dirname(route.bareRepository));
  runGit(projectRoot, configRoot, ["init", "--bare", route.bareRepository]);
  runGit(projectRoot, configRoot, ["--git-dir", route.bareRepository, "config", "http.receivepack", "true"]);
  runGit(projectRoot, configRoot, ["--git-dir", route.bareRepository, "config", "http.uploadpack", "true"]);
}

function createLocalRepository(root: string, configRoot: string, remoteUrl: string): string {
  fs.mkdirSync(root, { recursive: true });
  runGit(root, configRoot, ["init", "--initial-branch=main"]);
  write(root, "hello.txt", "base fixture content\n");
  runGit(root, configRoot, ["add", "--", "hello.txt"]);
  runGit(root, configRoot, ["commit", "-m", "isolated HTTPS base"]);
  runGit(root, configRoot, ["remote", "add", "origin", remoteUrl]);
  return runGit(root, configRoot, ["rev-parse", "HEAD"]);
}

function seedRemoteAdvance(context: PreparedRepository, configRoot: string): string {
  runGit(context.root, configRoot, ["-c", "protocol.file.allow=always", "push", context.bareRepository, "main:refs/heads/main"]);
  const seedRoot = makeTmpDir(`v13-native-https-seed-${context.name}`);
  runGit(seedRoot, configRoot, ["clone", context.root, seedRoot]);
  write(seedRoot, "hello.txt", "remote fast-forward content\n");
  runGit(seedRoot, configRoot, ["add", "--", "hello.txt"]);
  runGit(seedRoot, configRoot, ["commit", "-m", "isolated HTTPS remote advance"]);
  runGit(seedRoot, configRoot, ["-c", "protocol.file.allow=always", "push", context.bareRepository, "main:refs/heads/main"]);
  return runGit(context.bareRepository, configRoot, ["rev-parse", "refs/heads/main"]);
}

function prepareRepository(name: ScenarioName, fault: IsolatedGitHttpFault = "normal", seedForPull = false): PreparedRepository {
  if (!fixture) throw new Error("BLOCKED_ISOLATED_HTTPS_FIXTURE_NOT_STARTED");
  const route = fixture.createRoute();
  const root = makeTmpDir(`v13-native-https-local-${name}`);
  const configRoot = makeTmpDir(`v13-native-https-git-config-${name}`);
  fs.writeFileSync(path.join(configRoot, "empty-global.gitconfig"), "", { flag: "wx" });
  fs.writeFileSync(path.join(configRoot, "empty-system.gitconfig"), "", { flag: "wx" });
  createBareRepository(route, configRoot);
  const baseHead = createLocalRepository(root, configRoot, route.url);
  const stateDirectory = makeTmpDir(`v13-native-https-state-${name}`);
  process.env.C2C_STATE_DIR = stateDirectory;
  const workspace = new Workspace(root);
  setPermission(workspace.id, "level1");
  const policy = {
    allowedRemotes: [{ name: "origin", url: route.url }],
    allowedBranches: ["main"],
    allowedOperations: ["push", "pull_ff_only"] as GitWriteOperation["kind"][],
    approvedProxy: APPROVED_PROXY,
  };
  const preview = previewGitRepositoryApproval(workspace, ".", policy);
  fixture.setGitExecutable(preview.executable);
  approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest);
  const context: PreparedRepository = {
    name, root, bareRepository: route.bareRepository, route, workspace, stateDirectory, gitConfigDirectory: configRoot, baseHead,
    remoteHead: null, approvedExecutable: preview.executable,
  };
  route.setFault(fault);
  if (seedForPull) context.remoteHead = seedRemoteAdvance(context, configRoot);
  return context;
}

async function waitForFinishedJob(supervisor: ExecutionSupervisor, jobId: string) {
  const deadline = Date.now() + JOB_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = supervisor.store.get(jobId);
    if (job?.finishedAt && job.gitResult) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("BLOCKED_NATIVE_HTTPS_JOB_TIMEOUT");
}

async function executeGitWrite(
  context: PreparedRepository,
  operation: GitWriteOperation,
  nativeOptions: ConstructorParameters<typeof WindowsNativeExecutionRunner>[0] = {},
): Promise<JobObservation> {
  const native = new WindowsNativeExecutionRunner(nativeOptions);
  const runner: ExecutionRunner = { start: (request, callbacks) => native.start(request, callbacks) };
  const supervisor = new ExecutionSupervisor(context.workspace, { runner });
  try {
    const started = supervisor.startGitWrite({
      repositoryPath: ".",
      operation,
      timeoutSeconds: JOB_TIMEOUT_SECONDS,
      oauthClientId: "v13-isolated-https-test",
      scopes: ["git.write"],
      idempotencyKey: `v13-isolated-${context.name}-${randomBytes(12).toString("hex")}`,
    });
    if (!started.ok) throw new Error(`NATIVE_GIT_WRITE_START_REJECTED:${started.error}`);
    const job = await waitForFinishedJob(supervisor, started.job.jobId);
    if (job.state !== "succeeded") {
      const retry = supervisor.startGitWrite({ repositoryPath: ".", operation, timeoutSeconds: JOB_TIMEOUT_SECONDS,
        oauthClientId: "v13-isolated-https-test", scopes: ["git.write"], idempotencyKey: `fresh-${randomBytes(12).toString("hex")}` });
      expect(retry).toMatchObject({ ok: false, error: "GIT_REVIEW_REQUIRED" });
    }
    return {
      jobId: job.jobId,
      state: job.state,
      failureCode: job.failureCode,
      exitCode: job.exitCode,
      gitResult: job.gitResult ?? null,
      finishedAt: job.finishedAt,
    };
  } finally {
    await supervisor.shutdown();
  }
}

function currentHead(context: PreparedRepository, configRoot: string) {
  return runGitObservation(context.root, configRoot, ["rev-parse", "HEAD"]);
}

function remoteHead(context: PreparedRepository, configRoot: string) {
  return runGitObservation(context.bareRepository, configRoot, ["rev-parse", "refs/heads/main"]);
}

function trackedFile(context: PreparedRepository): string {
  return fs.readFileSync(path.join(context.root, "hello.txt"), "utf8");
}

function writeFromSecondProcess(target: string, content: string): ExternalWriteObservation {
  const result = spawnSync(process.execPath, [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], process.argv[2], 'utf8')",
    target,
    content,
  ], {
    cwd: path.dirname(target),
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP },
    timeout: 3_000,
    windowsHide: true,
    shell: false,
    maxBuffer: 1_000,
  });
  return {
    pid: result.pid ?? null,
    exitCode: result.status,
    signal: result.signal,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
    stderrBytes: Buffer.byteLength(result.stderr ?? ""),
  };
}

function pushOperation(context: PreparedRepository, branch = "main"): Extract<GitWriteOperation, {kind:"push"}> {
  return { kind: "push", remote: "origin", branch, expectedHead: context.baseHead, expectedBranch: "main" };
}

function pullOperation(context: PreparedRepository): GitWriteOperation {
  return { kind: "pull_ff_only", remote: "origin", branch: "main", expectedHead: context.baseHead, expectedBranch: "main" };
}

describe.skipIf(!ISOLATED_HTTPS_ENABLED)("V1.3 Native GitWrite over an isolated HTTPS QuickTunnel", () => {
  beforeAll(async () => {
    if (process.platform !== "win32") throw new Error("BLOCKED_NATIVE_HTTPS_TEST_REQUIRES_WINDOWS");
    priorStateDirectory = process.env.C2C_STATE_DIR;
    try {
      resolveExecutionHelperPath();
      resolveExecutionLauncherPath();
    } catch {
      throw new Error("BLOCKED_NATIVE_EXECUTION_ARTIFACTS_UNAVAILABLE");
    }
    gitExecutable = resolveGitExecutableFromPath();
    fixture = await startIsolatedGitHttpsFixture();
  }, 70_000);

  afterAll(async () => {
    try {
      await fixture?.close();
    } finally {
      fixture = null;
      if (priorStateDirectory === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = priorStateDirectory;
    }
  });

  it("pushes the approved branch through Native HTTPS and records the exact remote SHA", async () => {
    const name: ScenarioName = "push-success";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name);
      const observationStart = fixture!.observations().length;
      const job = await executeGitWrite(context, pushOperation(context));
      const actualRemote = remoteHead(context, context.gitConfigDirectory);
      const requests = fixture!.observations().slice(observationStart);
      evidence = {
        schemaVersion: 1, scenario: name, remoteUrl: context.route.url, approvedExecutable: context.approvedExecutable,
        expectedSha: context.baseHead, actualRemoteSha: actualRemote, job, requests,
      };
      expect(job.state).toBe("succeeded");
      expect((job.gitResult as { remoteOutcome?: string } | null)?.remoteOutcome).toBe("reported_success");
      expect(actualRemote.exitCode).toBe(0);
      expect(actualRemote.output).toBe(context.baseHead);
      expect(requests.some((item) => item.method === "POST" && item.path.endsWith("/git-receive-pack") && item.backendExitCode === 0)).toBe(true);
    } finally {
      saveEvidence(file, evidence);
    }
  }, 180_000);

  it("rejects an unapproved remote and branch before Native starts", async () => {
    const name: ScenarioName = "unapproved-policy";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name);
      let runnerStarted = false;
      const runner: ExecutionRunner = {
        start: () => {
          runnerStarted = true;
          throw new Error("UNAPPROVED_GIT_WRITE_REACHED_NATIVE_RUNNER");
        },
      };
      const supervisor = new ExecutionSupervisor(context.workspace, { runner });
      try {
        const unapprovedRemote = supervisor.startGitWrite({
          repositoryPath: ".", operation: { ...pushOperation(context), remote: "elsewhere" }, timeoutSeconds: JOB_TIMEOUT_SECONDS,
          oauthClientId: "v13-isolated-https-test", scopes: ["git.write"], idempotencyKey: "v13-isolated-remote-denied-0123456789",
        });
        const unapprovedBranch = supervisor.startGitWrite({
          repositoryPath: ".", operation: pushOperation(context, "not-approved"), timeoutSeconds: JOB_TIMEOUT_SECONDS,
          oauthClientId: "v13-isolated-https-test", scopes: ["git.write"], idempotencyKey: "v13-isolated-branch-denied-0123456789",
        });
        evidence = { schemaVersion: 1, scenario: name, remoteUrl: context.route.url, unapprovedRemote, unapprovedBranch, runnerStarted };
        expect(unapprovedRemote).toMatchObject({ ok: false, error: "NOT_APPROVED" });
        expect(unapprovedBranch).toMatchObject({ ok: false, error: "NOT_APPROVED" });
        expect(runnerStarted).toBe(false);
      } finally {
        await supervisor.shutdown();
      }
    } finally {
      saveEvidence(file, evidence);
    }
  }, 60_000);

  it("records an anonymous HTTPS 401 as a failed job with unknown remote outcome", async () => {
    const name: ScenarioName = "push-401";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name, "unauthorized");
      const observationStart = fixture!.observations().length;
      const job = await executeGitWrite(context, pushOperation(context));
      const requests = fixture!.observations().slice(observationStart);
      const actualRemote = remoteHead(context, context.gitConfigDirectory);
      evidence = { schemaVersion: 1, scenario: name, remoteUrl: context.route.url, job, requests, actualRemote };
      expect(job.state).toBe("failed");
      expect((job.gitResult as { remoteOutcome?: string; partialSuccessPossible?: boolean } | null)?.remoteOutcome).toBe("unknown");
      expect((job.gitResult as { partialSuccessPossible?: boolean } | null)?.partialSuccessPossible).toBe(true);
      expect(requests.some((item) => item.httpStatus === 401)).toBe(true);
      expect(actualRemote.exitCode).not.toBe(0);
    } finally {
      saveEvidence(file, evidence);
    }
  }, 180_000);

  it("reports unknown partial success when receive-pack updates refs but its HTTPS response is dropped", async () => {
    const name: ScenarioName = "push-drop-response";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name, "drop-receive-pack-response");
      const observationStart = fixture!.observations().length;
      const job = await executeGitWrite(context, pushOperation(context));
      const actualRemote = remoteHead(context, context.gitConfigDirectory);
      const requests = fixture!.observations().slice(observationStart);
      evidence = { schemaVersion: 1, scenario: name, remoteUrl: context.route.url, expectedSha: context.baseHead, actualRemoteSha: actualRemote, job, requests };
      expect(job.state).toBe("failed");
      expect((job.gitResult as { remoteOutcome?: string; partialSuccessPossible?: boolean } | null)?.remoteOutcome).toBe("unknown");
      expect((job.gitResult as { partialSuccessPossible?: boolean } | null)?.partialSuccessPossible).toBe(true);
      expect(actualRemote.exitCode).toBe(0);
      expect(actualRemote.output).toBe(context.baseHead);
      expect(requests.some((item) => item.path.endsWith("/git-receive-pack") && item.backendExitCode === 0 && item.responseDropped)).toBe(true);
    } finally {
      saveEvidence(file, evidence);
    }
  }, 180_000);

  it("fast-forwards the approved branch from the HTTPS bare repository", async () => {
    const name: ScenarioName = "pull-success";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name, "normal", true);
      const observationStart = fixture!.observations().length;
      const job = await executeGitWrite(context, pullOperation(context));
      const actualHead = currentHead(context, context.gitConfigDirectory);
      const actualFile = trackedFile(context);
      const requests = fixture!.observations().slice(observationStart);
      evidence = { schemaVersion: 1, scenario: name, remoteUrl: context.route.url, expectedHead: context.remoteHead, actualHead, actualFile, job, requests };
      expect(job.state).toBe("succeeded");
      expect((job.gitResult as { remoteOutcome?: string } | null)?.remoteOutcome).toBe("reported_success");
      expect(actualHead.exitCode).toBe(0);
      expect(actualHead.output).toBe(context.remoteHead);
      expect(actualFile).toBe("remote fast-forward content\n");
      expect(requests.some((item) => item.method === "POST" && item.path.endsWith("/git-upload-pack") && item.backendExitCode === 0)).toBe(true);
    } finally {
      saveEvidence(file, evidence);
    }
  }, 180_000);

  it("preserves an external tracked-file edit when Native pull reaches a dirty worktree", async () => {
    const name: ScenarioName = "pull-external-dirty";
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name, evidenceFile: file };
    try {
      const context = prepareRepository(name, "normal", true);
      const releaseFile = path.join(makeTmpDir("v13-native-https-pull-release"), "resume.release");
      const target = path.join(context.root, "hello.txt");
      const marker = "external process preserved this worktree data\n";
      const injectionEvidence: { nativeEvidenceLine: string | null; externalWrite: ExternalWriteObservation | null } = {
        nativeEvidenceLine: null,
        externalWrite: null,
      };
      const observationStart = fixture!.observations().length;
      const job = await executeGitWrite(context, pullOperation(context), {
        helperBeforeResumeTest: {
          releaseFile,
          phase: "suspended",
          onSuspended(line: string) {
            injectionEvidence.nativeEvidenceLine = line;
            try {
              injectionEvidence.externalWrite = writeFromSecondProcess(target, marker);
            } finally {
              fs.writeFileSync(releaseFile, "resume\n", { flag: "wx" });
            }
          },
        },
      });
      const actualHead = currentHead(context, context.gitConfigDirectory);
      const actualFile = trackedFile(context);
      const actualStatus = runGitObservation(context.root, context.gitConfigDirectory, ["status", "--porcelain=v2"]);
      const requests = fixture!.observations().slice(observationStart);
      evidence = {
        schemaVersion: 1, scenario: name, remoteUrl: context.route.url, expectedRemoteHead: context.remoteHead,
        nativeEvidenceLine: injectionEvidence.nativeEvidenceLine, releaseFile, externalWrite: injectionEvidence.externalWrite,
        job, actualHead, actualFile, actualStatus, requests,
        externalDataPreserved: actualFile === marker,
      };
      expect(injectionEvidence.nativeEvidenceLine).toMatch(/^C2C_EXECUTION_HELPER_SUSPENDED:\d+:suspended$/);
      expect(injectionEvidence.externalWrite?.exitCode).toBe(0);
      expect(job.state).toBe("failed");
      expect((job.gitResult as { remoteOutcome?: string; partialSuccessPossible?: boolean } | null)?.remoteOutcome).toBe("unknown");
      expect((job.gitResult as { partialSuccessPossible?: boolean } | null)?.partialSuccessPossible).toBe(true);
      expect(actualFile).toBe(marker);
      expect(actualHead.output).toBe(context.baseHead);
      expect(actualStatus.exitCode).toBe(0);
      expect(actualStatus.output.length).toBeGreaterThan(0);
    } finally {
      saveEvidence(file, evidence);
    }
  }, 180_000);

  it.each(["index", "head", "refs"] as const)("detects pull_ff_only external %s mutation from a second Git process", async (target) => {
    const name: ScenarioName = `pull-external-${target}`;
    const file = evidenceFile(name);
    let evidence: Record<string, unknown> = { schemaVersion: 1, scenario: name };
    try {
      const context = prepareRepository(name, "normal", true);
      runGit(context.root, context.gitConfigDirectory, ["branch", "race-external", context.baseHead]);
      if (target === "refs") {
        // update-ref cannot point at an object the local repository lacks.
        // Import fixture objects before planning; the raced update remains a
        // separate real Git process in the exact pre-helper window.
        runGit(context.root, context.gitConfigDirectory, ["-c", "protocol.file.allow=always", "fetch", context.bareRepository, "refs/heads/main"]);
      }
      const marker = "external staged index data\n";
      let external: ReturnType<typeof runGitObservation> | null = null;
      const job = await executeGitWrite(context, pullOperation(context), {
        beforeHelperRequestWrite: () => {
          if (target === "index") {
            write(context.root, "external-index.txt", marker);
            external = runGitObservation(context.root, context.gitConfigDirectory, ["add", "--", "external-index.txt"]);
          } else if (target === "head") {
            external = runGitObservation(context.root, context.gitConfigDirectory, ["switch", "race-external"]);
          } else {
            external = runGitObservation(context.root, context.gitConfigDirectory, ["update-ref", "refs/heads/main", context.remoteHead!, context.baseHead]);
          }
        },
      });
      const actualHead = currentHead(context, context.gitConfigDirectory);
      const branch = runGitObservation(context.root, context.gitConfigDirectory, ["branch", "--show-current"]);
      const actualFile = trackedFile(context);
      evidence = { schemaVersion: 1, scenario: name, external, job, actualHead, branch, actualFile, baseHead: context.baseHead, remoteHead: context.remoteHead };
      expect(external).toMatchObject({ exitCode: 0, errorCode: null });
      expect(["failed", "interrupted"]).toContain(job.state);
      expect(actualHead.output).toBe(target === "refs" ? context.remoteHead : context.baseHead);
      expect(actualFile).toBe("base fixture content\n");
      expect(branch.output).toBe(target === "head" ? "race-external" : "main");
      if (target === "index") {
        expect(job.failureCode).toBe("GIT_STATE_CHANGED");
        expect(fs.readFileSync(path.join(context.root, "external-index.txt"), "utf8")).toBe(marker);
        expect(runGit(context.root, context.gitConfigDirectory, ["show", ":external-index.txt"])).toBe(marker.trim());
      }
      if (target === "refs") expect(job.failureCode).toBe("GIT_POSTCONDITION_UNTRUSTED");
    } finally { saveEvidence(file, evidence); }
  }, 180_000);
});
