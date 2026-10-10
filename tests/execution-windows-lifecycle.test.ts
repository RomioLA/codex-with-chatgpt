import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { Logger } from "../src/logger/index.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { resolveExecutionHelperPath, resolveExecutionLauncherPath, WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { resolveTrustedRuntime } from "../src/execution/runtime-discovery.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { setPermission } from "../src/permission/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeGitRepo, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function isolateWindowsStateDir(): string {
  const directory = makeSystemTempDir("windows-execution-state");
  process.env.C2C_STATE_DIR = directory;
  return directory;
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

async function waitUntil(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The owner supervisor did not exit after forced termination.")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function writeProcessTreeProject(root: string, name: string, injectNpmConfig = false): void {
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name, scripts: { test: "node owner-main.mjs" } }));
  if (injectNpmConfig) {
    write(root, ".npmrc", [
      "node-options=--require=./npm-injector.cjs",
      "script-shell=./attacker-script-shell.exe",
      "cache=./attacker-cache",
    ].join("\n"));
    write(root, "npm-injector.cjs", "require('node:fs').writeFileSync('npm-node-options-injected.txt', 'unexpected');\n");
  }
  write(root, "owner-main.mjs", [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const record = (pid) => { const current = fs.existsSync('pids.txt') ? fs.readFileSync('pids.txt', 'utf8').trim().split(/\\r?\\n/).filter(Boolean) : []; if (!current.includes(String(pid))) fs.appendFileSync('pids.txt', String(pid) + '\\n'); };",
    "record(process.pid);",
    "const child = spawn(process.execPath, ['owner-child.mjs'], { stdio: 'ignore' });",
    "record(child.pid);",
    "const deadline = Date.now() + 10000;",
    "while (!fs.existsSync('child-ready.txt') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));",
    "if (!fs.existsSync('child-ready.txt')) process.exit(19);",
    "fs.writeFileSync('tree-ready.txt', 'ready');",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
  write(root, "owner-child.mjs", [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const record = (pid) => { const current = fs.existsSync('pids.txt') ? fs.readFileSync('pids.txt', 'utf8').trim().split(/\\r?\\n/).filter(Boolean) : []; if (!current.includes(String(pid))) fs.appendFileSync('pids.txt', String(pid) + '\\n'); };",
    "record(process.pid);",
    "const grandchild = spawn(process.execPath, ['owner-grandchild.mjs'], { stdio: 'ignore' });",
    "record(grandchild.pid);",
    "const deadline = Date.now() + 10000;",
    "while (!fs.existsSync('grandchild-ready.txt') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));",
    "if (!fs.existsSync('grandchild-ready.txt')) process.exit(19);",
    "fs.writeFileSync('child-ready.txt', 'ready');",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
  write(root, "owner-grandchild.mjs", [
    "import fs from 'node:fs';",
    "const current = fs.existsSync('pids.txt') ? fs.readFileSync('pids.txt', 'utf8').trim().split(/\\r?\\n/).filter(Boolean) : [];",
    "if (!current.includes(String(process.pid))) fs.appendFileSync('pids.txt', String(process.pid) + '\\n');",
    "fs.writeFileSync('grandchild-ready.txt', 'ready');",
    "setInterval(() => undefined, 1000);",
  ].join("\n"));
}

async function waitForProcessTree(root: string, timeoutMs = 20_000): Promise<number[]> {
  const readyFile = path.join(root, "tree-ready.txt");
  const pidFile = path.join(root, "pids.txt");
  await waitUntil(
    () => fs.existsSync(readyFile) && fs.existsSync(pidFile),
    timeoutMs,
    "The nested execution process tree did not become ready.",
  );
  const processIds = [...new Set(fs.readFileSync(pidFile, "utf8").split(/\r?\n/).filter(Boolean).map(Number))];
  expect(processIds.length).toBeGreaterThanOrEqual(3);
  return processIds;
}

async function waitForProcessesToExit(processIds: number[], timeoutMs = 20_000): Promise<void> {
  await waitUntil(
    () => processIds.every((pid) => !processExists(pid)),
    timeoutMs,
    `Job processes remained: ${processIds.filter(processExists).join(",")}`,
  );
}

function createRealSupervisor(
  workspaceRoot: string,
  runner?: ExecutionRunner,
  packageManager: "npm" | "pnpm" = "npm",
  logger?: Logger,
): { supervisor: ExecutionSupervisor; workspace: Workspace } {
  isolateWindowsStateDir();
  const workspace = new Workspace(workspaceRoot);
  setPermission(workspace.id, "level1");
  const repository = resolveRepositoryIdentity(workspace, ".");
  approveTrustedCommand({
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "test",
    target: "test",
    packageManager,
    localApproval: true,
  });
  return { supervisor: new ExecutionSupervisor(workspace, { runner, logger }), workspace };
}

function expectNoOwnedJobTemps(supervisor: ExecutionSupervisor): void {
  const tempRoot = path.join(supervisor.store.directory, "execution-temp");
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name.startsWith("tmp-"));
  expect(leftovers).toEqual([]);
}

function runtimeFixture(root: string, started: string, executed: string): {
  node: string;
  npmCli: string;
  npmLibCli: string;
  npmValidateEngines: string;
  npmMainEntry: string;
  npmPackageJson: string;
  npmExitHandler: string;
  npmCore: string;
  pnpmCli: string;
  pnpmLauncher: string;
  pnpmBundle: string;
} {
  const runtimeDirectory = path.join(root, "runtime");
  const node = path.join(runtimeDirectory, "node.exe");
  const npmRoot = path.join(runtimeDirectory, "node_modules", "npm");
  const npmCli = path.join(npmRoot, "bin", "npm-cli.js");
  const npmLibCli = path.join(npmRoot, "lib", "cli.js");
  const npmValidateEngines = path.join(npmRoot, "lib", "cli", "validate-engines.js");
  const npmMainEntry = path.join(npmRoot, "lib", "cli", "entry.js");
  const npmPackageJson = path.join(npmRoot, "package.json");
  const npmExitHandler = path.join(npmRoot, "lib", "cli", "exit-handler.js");
  const npmCore = path.join(npmRoot, "lib", "npm.js");
  const pnpmRoot = path.join(runtimeDirectory, "node_modules", "pnpm");
  const pnpmCli = path.join(pnpmRoot, "bin", "pnpm.cjs");
  const pnpmLauncher = path.join(pnpmRoot, "bin", "pnpm.mjs");
  const pnpmBundle = path.join(pnpmRoot, "dist", "pnpm.mjs");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(path.dirname(npmMainEntry), { recursive: true });
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.mkdirSync(path.dirname(pnpmBundle), { recursive: true });
  fs.mkdirSync(path.dirname(pnpmCli), { recursive: true });
  fs.copyFileSync(process.execPath, node);
  fs.writeFileSync(npmPackageJson, JSON.stringify({ name: "npm", version: "11.12.1", type: "commonjs" }));
  fs.writeFileSync(npmCli, "require('../lib/cli.js')(process);\n");
  fs.writeFileSync(npmLibCli, "require('./cli/validate-engines.js')(process, () => require('./cli/entry.js'));\n");
  fs.writeFileSync(npmValidateEngines, "require('../../package.json'); module.exports = (_process, run) => run();\n");
  fs.writeFileSync(npmMainEntry, "require('./exit-handler.js'); require('../npm.js');\n");
  fs.writeFileSync(npmExitHandler, "module.exports = () => undefined;\n");
  fs.writeFileSync(npmCore, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(executed)}, 'original'), 2500);`,
  ].join("\n"));
  fs.writeFileSync(path.join(pnpmRoot, "package.json"), JSON.stringify({ name: "pnpm", version: "11.24.0" }));
  fs.writeFileSync(pnpmCli, "import('./pnpm.mjs');\n");
  fs.writeFileSync(pnpmLauncher, "await import('../dist/pnpm.mjs');\n");
  fs.writeFileSync(pnpmBundle, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    `setTimeout(() => fs.writeFileSync(${JSON.stringify(executed)}, 'original'), 2500);`,
  ].join("\n"));
  return {
    node, npmCli, npmLibCli, npmValidateEngines, npmMainEntry, npmPackageJson, npmExitHandler, npmCore,
    pnpmCli, pnpmLauncher, pnpmBundle,
  };
}

function makeDirectNativeRequest(root: string, jobId: string, packageManager: "npm" | "pnpm" = "npm"): {
  request: Parameters<WindowsNativeExecutionRunner["start"]>[0];
  owner: ExecutionTempOwner;
} {
  makeGitRepo(root);
  write(root, "package.json", JSON.stringify({ name: "runtime-integrity-fixture", scripts: { test: "node approved.mjs" } }));
  const workspace = new Workspace(root);
  const repository = resolveRepositoryIdentity(workspace, ".");
  const trustedCommand = approveTrustedCommand({
    workspaceId: workspace.id, repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath, kind: "test", target: "test",
    packageManager, localApproval: true,
  });
  const stateRoot = makeSystemTempDir("windows-runtime-integrity-state");
  const stateDirectory = path.join(stateRoot, "execution-jobs", workspace.id);
  fs.mkdirSync(stateDirectory, { recursive: true });
  const owner = new ExecutionTempOwner(stateDirectory, workspace.id);
  const tempLease = owner.create(jobId);
  return {
    owner,
    request: { jobId, repository, trustedCommand, timeoutSeconds: 20, stateDirectory, tempLease },
  };
}

function winFileIdentity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function makeExecutionDistributionFixture(root: string): {
  moduleDirectory: string;
  helperPath: string;
  launcherPath: string;
  helperHash: string;
} {
  const moduleDirectory = path.join(root, "dist", "execution");
  const nativeDirectory = path.join(root, "build", "native");
  const helperPath = path.join(nativeDirectory, "c2c-execution-helper.exe");
  const launcherPath = path.join(nativeDirectory, "c2c-execution-launcher.exe");
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.copyFileSync(resolveExecutionHelperPath(), helperPath);
  fs.copyFileSync(resolveExecutionLauncherPath(), launcherPath);
  const helperHash = sha256File(helperPath);
  const launcherHash = sha256File(launcherPath);
  fs.writeFileSync(path.join(moduleDirectory, "c2c-execution-helper-integrity.json"), JSON.stringify({
    version: 2,
    protocolVersion: 5,
    helperPath: "build/native/c2c-execution-helper.exe",
    sha256: helperHash,
    launcherPath: "build/native/c2c-execution-launcher.exe",
    launcherSha256: launcherHash,
  }));
  return { moduleDirectory, helperPath, launcherPath, helperHash };
}

function buildUntrustedHelperFixture(outputPath: string): void {
  const scriptPath = path.join(projectRoot, "tools", "build-untrusted-helper-fixture.ps1");
  const result = spawnSync("pwsh", ["-NoProfile", "-File", scriptPath, outputPath], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not build the valid untrusted PE fixture: ${result.error?.message ?? result.stderr}`);
  }
  const bytes = fs.readFileSync(outputPath);
  if (bytes.toString("ascii", 0, 2) !== "MZ" ||
      bytes.toString("binary", bytes.readUInt32LE(0x3c), bytes.readUInt32LE(0x3c) + 4) !== "PE\0\0") {
    throw new Error("The untrusted helper fixture is not a valid PE executable.");
  }
}

async function stopRaceWorker(worker: Worker | null, onAttempts: (count: number) => void,
                              alreadyStopped: () => boolean = () => false): Promise<void> {
  if (!worker) return;
  if (!alreadyStopped()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { void worker.terminate().finally(resolve); }, 5000);
      worker.on("message", (value: { attempts?: number; done?: boolean }) => {
        if (value.attempts !== undefined) onAttempts(value.attempts);
        if (value.done) {
          clearTimeout(timer);
          resolve();
        }
      });
      worker.postMessage("stop");
    });
  }
  await worker.terminate();
}

async function runNativeTreeOutcome(name: string, outcome: "cancelled" | "timed_out" | "shutdown"): Promise<void> {
  const helperPath = path.join(projectRoot, "build", "native", "c2c-execution-helper.exe");
  if (!fs.existsSync(helperPath)) throw new Error("Build the native helper before this acceptance test.");
  const root = makeSystemTempDir(name);
  writeProcessTreeProject(root, name);
  const { supervisor } = createRealSupervisor(root);
  const clientId = `windows-${outcome}-client`;

  try {
    const started = supervisor.start({
      repositoryPath: ".",
      kind: "test",
      target: "test",
      timeoutSeconds: outcome === "timed_out" ? 5 : 60,
      idempotencyKey: `windows-${outcome}-key-0001`,
      oauthClientId: clientId,
      scopes: ["execution.run"],
    });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    expect(started.job.state).toBe("running");
    const processIds = await waitForProcessTree(root);

    if (outcome === "cancelled") {
      const cancelled = supervisor.cancel(started.job.jobId, clientId);
      expect(cancelled.ok).toBe(true);
    } else if (outcome === "shutdown") {
      await supervisor.shutdown();
    }
    const expectedState = outcome === "shutdown" ? "cancelled" : outcome;
    await waitUntil(() => {
      const job = supervisor.store.get(started.job.jobId);
      if (job?.finishedAt && job.state !== expectedState) {
        throw new Error(`Expected terminal state ${expectedState}, received ${job.state}.`);
      }
      return job?.state === expectedState;
    }, outcome === "timed_out" ? 20_000 : 15_000, `Job did not reach ${expectedState}.`);
    await waitForProcessesToExit(processIds);
    expectNoOwnedJobTemps(supervisor);
  } finally {
    await supervisor.shutdown();
  }
}

describe("Windows execution lifecycle acceptance", () => {
  it.skipIf(process.platform !== "win32")("A: owner process loss closes the full native Job tree", async () => {
    const helperPath = path.join(projectRoot, "build", "native", "c2c-execution-helper.exe");
    if (!fs.existsSync(helperPath)) throw new Error("Build the native helper before this acceptance test.");

    const root = makeSystemTempDir("windows-owner-loss");
    writeProcessTreeProject(root, "owner-loss-fixture", true);
    const stateDirectory = path.join(root, "c2c-state");
    fs.mkdirSync(stateDirectory);

    const readyFile = path.join(root, "supervisor-ready.txt");
    const errorFile = path.join(root, "supervisor-error.txt");
    const ownerScript = path.join(projectRoot, "tests", "windows", "execution-supervisor-owner.ts");
    const owner = spawn(process.execPath, ["--import", "tsx", ownerScript, root, stateDirectory, readyFile, errorFile], {
      cwd: projectRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    if (!owner.pid) throw new Error("Could not start the isolated owner supervisor process.");

    try {
      await waitUntil(
        () => fs.existsSync(readyFile) || fs.existsSync(errorFile) || owner.exitCode !== null,
        30_000,
        "The isolated supervisor did not start its execution job.",
      );
      if (fs.existsSync(errorFile)) throw new Error(fs.readFileSync(errorFile, "utf8"));
      if (owner.exitCode !== null) throw new Error(`Owner supervisor exited early with code ${owner.exitCode}.`);
      const processIds = await waitForProcessTree(root);
      expect(fs.existsSync(path.join(root, "npm-node-options-injected.txt"))).toBe(false);
      expect(fs.existsSync(path.join(root, "attacker-cache"))).toBe(false);

      owner.kill(); // abrupt owner loss; no Bridge shutdown handler runs
      await waitForExit(owner, 10_000);
      await waitForProcessesToExit(processIds);

      const priorStateDirectory = process.env.C2C_STATE_DIR;
      process.env.C2C_STATE_DIR = stateDirectory;
      const restarted = new ExecutionSupervisor(new Workspace(root));
      try {
        expect(restarted.store.listAll().every((job) => job.state === "interrupted")).toBe(true);
        expectNoOwnedJobTemps(restarted);
      } finally {
        await restarted.shutdown();
        if (priorStateDirectory === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = priorStateDirectory;
      }
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    }
  }, 90_000);

  it.skipIf(process.platform !== "win32")("cancel confirms the entire native Job tree is empty", async () => {
    await runNativeTreeOutcome("windows-cancel-tree", "cancelled");
  }, 45_000);

  it.skipIf(process.platform !== "win32")("timeout confirms the entire native Job tree is empty", async () => {
    await runNativeTreeOutcome("windows-timeout-tree", "timed_out");
  }, 45_000);

  it.skipIf(process.platform !== "win32")("Supervisor shutdown removes the active execution temp", async () => {
    await runNativeTreeOutcome("windows-shutdown-tree", "shutdown");
  }, 45_000);

  it.skipIf(process.platform !== "win32")("native helper runs the approved recipe and removes its temp", async () => {
    const root = makeSystemTempDir("windows-normal-execution");
    makeGitRepo(root);
    const marker = `${root}.approved`;
    write(root, "package.json", JSON.stringify({ name: "normal-execution-fixture", scripts: { test: "node approved.mjs" } }));
    write(root, "approved.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'approved');\n`);
    const { supervisor } = createRealSupervisor(root, undefined, "npm", new Logger({ file: null, console: true, level: "debug" }));
    try {
      const started = supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 30,
        idempotencyKey: "windows-normal-execution-key-0001", oauthClientId: "windows-normal-client",
        scopes: ["execution.run"],
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      await waitUntil(() => {
        const state = supervisor.store.get(started.job.jobId)?.state;
        return state === "succeeded" || state === "failed" || state === "interrupted";
      }, 30_000, "The approved native recipe did not settle.");
      const completed = supervisor.store.get(started.job.jobId);
      if (completed?.state !== "succeeded") {
        const stdout = supervisor.store.readOutput(started.job.jobId, "stdout");
        const stderr = supervisor.store.readOutput(started.job.jobId, "stderr");
        throw new Error(`The approved native recipe did not succeed; state=${completed?.state ?? "missing"}; ` +
          `failure=${completed?.failureCode ?? "none"}; stdout=${stdout.ok ? stdout.text : stdout.error}; ` +
          `stderr=${stderr.ok ? stderr.text : stderr.error}`);
      }
      expect(fs.readFileSync(marker, "utf8")).toBe("approved");
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await supervisor.shutdown();
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("native helper runs through the fixed pinned pnpm runtime", async () => {
    const root = makeSystemTempDir("windows-pnpm-execution");
    makeGitRepo(root);
    const marker = `${root}.pnpm-approved`;
    write(root, "package.json", JSON.stringify({ name: "pnpm-execution-fixture", scripts: { test: "node approved.mjs" } }));
    write(root, "approved.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'approved');\n`);
    const { supervisor } = createRealSupervisor(root, undefined, "pnpm");
    try {
      const started = supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 45,
        idempotencyKey: "windows-pnpm-execution-key-0001", oauthClientId: "windows-pnpm-client",
        scopes: ["execution.run"],
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      await waitUntil(() => {
        const state = supervisor.store.get(started.job.jobId)?.state;
        return state === "succeeded" || state === "failed" || state === "interrupted";
      }, 45_000, "The approved pnpm recipe did not settle.");
      const completed = supervisor.store.get(started.job.jobId);
      if (completed?.state !== "succeeded") {
        const stdout = supervisor.store.readOutput(started.job.jobId, "stdout");
        const stderr = supervisor.store.readOutput(started.job.jobId, "stderr");
        throw new Error(`The approved pnpm recipe did not succeed; state=${completed?.state ?? "missing"}; ` +
          `failure=${completed?.failureCode ?? "none"}; stdout=${stdout.ok ? stdout.text : stdout.error}; ` +
          `stderr=${stderr.ok ? stderr.text : stderr.error}`);
      }
      if (!fs.existsSync(marker)) {
        const stdout = supervisor.store.readOutput(started.job.jobId, "stdout");
        const stderr = supervisor.store.readOutput(started.job.jobId, "stderr");
        throw new Error(`pnpm completed without its marker; stdout=${stdout.ok ? stdout.text : stdout.error}; stderr=${stderr.ok ? stderr.text : stderr.error}`);
      }
      expect(fs.readFileSync(marker, "utf8")).toBe("approved");
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await supervisor.shutdown();
    }
  }, 60_000);

  it.skipIf(process.platform !== "win32")("native helper failure removes its execution temp", async () => {
    const root = makeSystemTempDir("windows-failed-execution");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "failed-execution-fixture", scripts: { test: "node failed.mjs" } }));
    write(root, "failed.mjs", "process.exitCode = 7;\n");
    const { supervisor } = createRealSupervisor(root);
    try {
      const started = supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 30,
        idempotencyKey: "windows-failed-execution-key-0001", oauthClientId: "windows-failed-client",
        scopes: ["execution.run"],
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      await waitUntil(() => supervisor.store.get(started.job.jobId)?.state === "failed", 30_000,
        "The failing approved native recipe did not reach failed state.");
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await supervisor.shutdown();
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("start, missing-helper, and corrupt-helper failures clean owned temp", async () => {
    const root = makeSystemTempDir("windows-helper-start-failure");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "helper-failure-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const workspace = new Workspace(root);
    const repository = resolveRepositoryIdentity(workspace, ".");
    const trustedCommand = approveTrustedCommand({
      workspaceId: workspace.id, repositoryIdentity: repository.identity,
      canonicalRepositoryPath: repository.canonicalPath, kind: "test", target: "test",
      packageManager: "npm", localApproval: true,
    });
    const stateRoot = makeSystemTempDir("windows-helper-failure-state");
    const stateDirectory = path.join(stateRoot, "execution-jobs", workspace.id);
    fs.mkdirSync(stateDirectory, { recursive: true });
    const owner = new ExecutionTempOwner(stateDirectory, workspace.id);
    const jobId = "start-failure-job-00000001";
    const tempLease = owner.create(jobId);
    const request = {
      jobId, repository, trustedCommand,
      timeoutSeconds: 10, stateDirectory, tempLease,
    };
    const callbacks = { onOutput: () => undefined };
    const validHelper = resolveExecutionHelperPath();
    const throwingSpawn = (() => { throw new Error("start failure fixture"); }) as never;

    expect(() => new WindowsNativeExecutionRunner({ helperPath: validHelper, spawnImpl: throwingSpawn }).start(request, callbacks))
      .toThrow("EXECUTION_HELPER_START_FAILED");
    expect(fs.readdirSync(owner.root).filter((name) => name.startsWith("tmp-")).length).toBe(0);
  }, 45_000);

  it.skipIf(process.platform !== "win32")("VALID_BUT_UNTRUSTED_HELPER_REJECTED before helper or recipe code can run", () => {
    const root = makeSystemTempDir("windows-untrusted-valid-helper");
    const moduleDirectory = path.join(root, "dist", "execution");
    const candidate = path.join(root, "build", "native", "c2c-execution-helper.exe");
    const launcherCandidate = path.join(root, "build", "native", "c2c-execution-launcher.exe");
    fs.mkdirSync(moduleDirectory, { recursive: true });
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.copyFileSync(resolveExecutionLauncherPath(), launcherCandidate);
    const systemWhere = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
    fs.copyFileSync(systemWhere, candidate);
    const candidateBytes = fs.readFileSync(candidate);
    expect(candidateBytes.toString("ascii", 0, 2)).toBe("MZ");
    expect(candidateBytes.toString("binary", candidateBytes.readUInt32LE(0x3c), candidateBytes.readUInt32LE(0x3c) + 4))
      .toBe("PE\0\0");
    const trustedHelperHash = createHash("sha256").update(fs.readFileSync(resolveExecutionHelperPath())).digest("hex");
    const launcherHash = sha256File(launcherCandidate);
    fs.writeFileSync(path.join(moduleDirectory, "c2c-execution-helper-integrity.json"), JSON.stringify({
      version: 2,
      protocolVersion: 5,
      helperPath: "build/native/c2c-execution-helper.exe",
      sha256: trustedHelperHash,
      launcherPath: "build/native/c2c-execution-launcher.exe",
      launcherSha256: launcherHash,
    }));
    let spawnCalls = 0;
    const spawnImpl = (() => { spawnCalls += 1; throw new Error("candidate should never be started"); }) as never;
    const workspaceId = "untrusted-helper-workspace";
    const stateRoot = makeSystemTempDir("windows-untrusted-helper-state");
    const stateDirectory = path.join(stateRoot, "execution-jobs", workspaceId);
    fs.mkdirSync(stateDirectory, { recursive: true });
    const owner = new ExecutionTempOwner(stateDirectory, workspaceId);
    const jobId = "untrusted-helper-job-00000001";
    const lease = owner.create(jobId);
    const rootRepo = makeSystemTempDir("windows-untrusted-helper-repo");
    makeGitRepo(rootRepo);
    write(rootRepo, "package.json", JSON.stringify({ name: "untrusted-helper-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const workspace = new Workspace(rootRepo);
    const repository = resolveRepositoryIdentity(workspace, ".");
    const trustedCommand = approveTrustedCommand({
      workspaceId: workspace.id, repositoryIdentity: repository.identity,
      canonicalRepositoryPath: repository.canonicalPath, kind: "test", target: "test",
      packageManager: "npm", localApproval: true,
    });

    let rejected = false;
    try {
      new WindowsNativeExecutionRunner({ moduleDirectory, spawnImpl }).start({
        jobId, repository, trustedCommand, timeoutSeconds: 10,
        stateDirectory, tempLease: lease,
      }, { onOutput: () => undefined });
    } catch (error) {
      rejected = (error as Error).message === "EXECUTION_HELPER_UNAVAILABLE";
    }
    const evidence = {
      validPe: candidateBytes.toString("ascii", 0, 2) === "MZ" &&
        candidateBytes.toString("binary", candidateBytes.readUInt32LE(0x3c), candidateBytes.readUInt32LE(0x3c) + 4) === "PE\0\0",
      rejectedBeforeSpawn: rejected && spawnCalls === 0,
      authorizedHash: trustedHelperHash,
      replacementHash: sha256File(candidate),
      replacementExecuted: spawnCalls > 0,
    };
    console.info("VALID_BUT_UNTRUSTED_HELPER_REJECTED", JSON.stringify(evidence));
    expect(evidence.validPe).toBe(true);
    expect(evidence.rejectedBeforeSpawn).toBe(true);
    expect(evidence.authorizedHash).not.toBe(evidence.replacementHash);
    expect(evidence.replacementExecuted).toBe(false);
    expect(sha256File(candidate)).not.toBe(trustedHelperHash);
    expect(owner.cleanup(jobId, lease)).toBe(true);
    expect(fs.existsSync(lease.directoryPath)).toBe(false);
  }, 45_000);

  it.skipIf(process.platform !== "win32")("helper launch keeps the verified image locked through CreateProcess", async () => {
    const distributionRoot = makeSystemTempDir("windows-helper-launch-race-distribution");
    const distribution = makeExecutionDistributionFixture(distributionRoot);
    const repositoryRoot = makeSystemTempDir("windows-helper-launch-race-repository");
    const { request, owner } = makeDirectNativeRequest(repositoryRoot, "helper-launch-race-job-0001");
    const approvedMarker = path.join(repositoryRoot, "approved-execution.txt");
    const untrustedMarker = path.join(path.dirname(distribution.launcherPath), "c2c-untrusted-helper-executed.marker");
    write(repositoryRoot, "approved.mjs", [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(approvedMarker)}, 'approved');`,
      "await new Promise((resolve) => setTimeout(resolve, 1800));",
    ].join("\n"));
    const untrustedCandidate = path.join(distributionRoot, "valid-untrusted-helper.exe");
    buildUntrustedHelperFixture(untrustedCandidate);
    const candidateHash = sha256File(untrustedCandidate);
    const authorizedBytes = fs.readFileSync(distribution.helperPath);
    const initialIdentity = winFileIdentity(distribution.helperPath);

    let lockedEvidence: { identity: string; hash: string } | null = null;
    let helperProcessId: number | null = null;
    let attackStoppedAtCreate = false;
    let attacker: Worker | null = null;
    let attackEvidence = {
      attempts: 0,
      writeAttempts: 0,
      directReplacementAttempts: 0,
      renameAttempts: 0,
      deleteAttempts: 0,
      replacementAttempts: 0,
      blockedBySharing: 0,
      writeSucceeded: 0,
      directReplacementSucceeded: 0,
      renameSucceeded: 0,
      deleteSucceeded: 0,
      replacementSucceeded: 0,
      replacementFailed: 0,
      blockedByOperation: { write: 0, directReplacement: 0, rename: 0, delete: 0, replacement: 0 },
      errorCodes: {} as Record<string, number>,
      done: false,
    };
    const workerSource = `
      const fs = require('node:fs');
      const { parentPort, workerData } = require('node:worker_threads');
      let running = true;
      const evidence = {
        attempts: 0, writeAttempts: 0, directReplacementAttempts: 0, renameAttempts: 0,
        deleteAttempts: 0, replacementAttempts: 0, blockedBySharing: 0,
        writeSucceeded: 0, directReplacementSucceeded: 0, renameSucceeded: 0,
        deleteSucceeded: 0, replacementSucceeded: 0, replacementFailed: 0,
        blockedByOperation: { write: 0, directReplacement: 0, rename: 0, delete: 0, replacement: 0 },
        errorCodes: {}, done: false,
      };
      const recordError = (operation, error) => {
        const code = error.code || 'UNKNOWN';
        evidence.errorCodes[code] = (evidence.errorCodes[code] || 0) + 1;
        if (['EPERM', 'EBUSY', 'EACCES'].includes(code)) {
          evidence.blockedBySharing++;
          evidence.blockedByOperation[operation]++;
        }
      };
      const restore = (backup) => {
        try {
          if (fs.existsSync(backup)) {
            if (fs.existsSync(workerData.target)) fs.unlinkSync(workerData.target);
            fs.renameSync(backup, workerData.target);
          }
        } catch (error) { recordError('replacement', error); }
      };
      const attemptReplacement = () => {
        const backup = workerData.target + '.race-displaced';
        evidence.renameAttempts++;
        try {
          fs.renameSync(workerData.target, backup);
          evidence.renameSucceeded++;
          evidence.replacementAttempts++;
          try {
            fs.copyFileSync(workerData.candidate, workerData.target);
            evidence.replacementSucceeded++;
          } catch (error) { evidence.replacementFailed++; recordError('replacement', error); }
          restore(backup);
        } catch (error) { recordError('rename', error); }
      };
      const publish = (done = false) => {
        evidence.done = done;
        parentPort.postMessage({ ...evidence });
      };
      parentPort.on('message', (message) => {
        if (message === 'stop') { running = false; publish(true); }
      });
      (async () => {
        while (running) {
          evidence.attempts++;
          evidence.writeAttempts++;
          try {
            fs.writeFileSync(workerData.target, workerData.candidateBytes);
            evidence.writeSucceeded++;
          } catch (error) { recordError('write', error); }

          evidence.directReplacementAttempts++;
          evidence.replacementAttempts++;
          try {
            fs.copyFileSync(workerData.candidate, workerData.target);
            evidence.directReplacementSucceeded++;
            evidence.replacementSucceeded++;
          } catch (error) {
            evidence.replacementFailed++;
            recordError('directReplacement', error);
          }

          attemptReplacement();
          evidence.deleteAttempts++;
          try {
            fs.unlinkSync(workerData.target);
            evidence.deleteSucceeded++;
            evidence.replacementAttempts++;
            try {
              fs.copyFileSync(workerData.candidate, workerData.target);
              evidence.replacementSucceeded++;
            } catch (error) { evidence.replacementFailed++; recordError('replacement', error); }
          } catch (error) { recordError('delete', error); }
          if (evidence.attempts % 8 === 0) publish();
          await new Promise((resolve) => setTimeout(resolve, 3));
        }
      })();
    `;

    const runner = new WindowsNativeExecutionRunner({
      moduleDirectory: distribution.moduleDirectory,
      launcherTestHoldMs: 1200,
      launcherEvidence: (line) => {
        const locked = line.match(/LOCKED:([^:]+:[^:]+):([a-f0-9]{64})$/);
        if (locked && lockedEvidence === null) {
          lockedEvidence = { identity: locked[1]!, hash: locked[2]! };
          attacker = new Worker(workerSource, {
            eval: true,
            workerData: {
              target: distribution.helperPath,
              candidate: untrustedCandidate,
              candidateBytes: fs.readFileSync(untrustedCandidate),
            },
          });
          attacker.on("message", (value: typeof attackEvidence) => { attackEvidence = value; });
        }
        const created = line.match(/CREATED:(\d+)$/);
        if (created) {
          helperProcessId = Number(created[1]);
          if (attacker && !attackStoppedAtCreate) {
            attackStoppedAtCreate = true;
            attacker.postMessage("stop");
          }
        }
      },
    });

    let completion: Awaited<ReturnType<WindowsNativeExecutionRunner["start"]>["completion"]> | null = null;
    let completionError: unknown = null;
    try {
      const handle = runner.start(request, { onOutput: () => undefined });
      try {
        completion = await handle.completion;
      } catch (error) {
        completionError = error;
      }
    } finally {
      await stopRaceWorker(attacker, (count) => { attackEvidence.attempts = Math.max(attackEvidence.attempts, count); },
        () => attackEvidence.done);
      if (sha256File(distribution.helperPath) !== distribution.helperHash) {
        fs.writeFileSync(distribution.helperPath, authorizedBytes);
      }
      if (fs.existsSync(request.tempLease.directoryPath)) owner.cleanup(request.jobId, request.tempLease);
    }

    const finalIdentity = winFileIdentity(distribution.helperPath);
    const finalHash = sha256File(distribution.helperPath);
    const evidence = {
      attempted: attackEvidence.attempts,
      writeAttempts: attackEvidence.writeAttempts,
      directReplacementAttempts: attackEvidence.directReplacementAttempts,
      renameAttempts: attackEvidence.renameAttempts,
      deleteAttempts: attackEvidence.deleteAttempts,
      replacementAttempts: attackEvidence.replacementAttempts,
      blockedBySharing: attackEvidence.blockedBySharing,
      blockedByOperation: attackEvidence.blockedByOperation,
      writeSucceeded: attackEvidence.writeSucceeded,
      directReplacementSucceeded: attackEvidence.directReplacementSucceeded,
      renameSucceeded: attackEvidence.renameSucceeded,
      deleteSucceeded: attackEvidence.deleteSucceeded,
      replacementSucceeded: attackEvidence.replacementSucceeded,
      replacementFailed: attackEvidence.replacementFailed,
      errorCodes: attackEvidence.errorCodes,
      helperProcessId,
      attackStoppedAtCreate,
      verifiedHelperIdentity: lockedEvidence?.identity ?? null,
      verifiedHelperHash: lockedEvidence?.hash ?? null,
      authorizedHelperHash: distribution.helperHash,
      untrustedCandidateHash: candidateHash,
      finalIdentity,
      finalHash,
      executionObserved: fs.existsSync(approvedMarker),
      untrustedHelperExecuted: fs.existsSync(untrustedMarker),
      completionOutcome: completion?.result.outcome ?? null,
      completionError: completionError instanceof Error ? completionError.message : null,
    };
    console.info("HELPER_LAUNCH_TOCTOU_EVIDENCE", JSON.stringify(evidence));
    expect(lockedEvidence).not.toBeNull();
    expect(attackEvidence.attempts).toBeGreaterThan(0);
    expect(attackEvidence.replacementAttempts).toBeGreaterThan(0);
    expect(attackEvidence.replacementFailed).toBeGreaterThan(0);
    expect(attackStoppedAtCreate).toBe(true);
    expect(attackEvidence.writeAttempts).toBeGreaterThan(0);
    expect(attackEvidence.directReplacementAttempts).toBeGreaterThan(0);
    expect(attackEvidence.renameAttempts).toBeGreaterThan(0);
    expect(attackEvidence.deleteAttempts).toBeGreaterThan(0);
    expect(attackEvidence.blockedByOperation.write).toBeGreaterThan(0);
    expect(attackEvidence.blockedByOperation.directReplacement).toBeGreaterThan(0);
    expect(attackEvidence.blockedByOperation.rename).toBeGreaterThan(0);
    expect(attackEvidence.blockedByOperation.delete).toBeGreaterThan(0);
    expect(attackEvidence.blockedBySharing).toBeGreaterThanOrEqual(4);
    expect(attackEvidence.writeSucceeded).toBe(0);
    expect(attackEvidence.directReplacementSucceeded).toBe(0);
    expect(attackEvidence.renameSucceeded).toBe(0);
    expect(attackEvidence.deleteSucceeded).toBe(0);
    expect(attackEvidence.replacementSucceeded).toBe(0);
    expect(attackEvidence.replacementFailed).toBeGreaterThan(0);
    expect(helperProcessId).toBeGreaterThan(0);
    expect(completionError).toBeNull();
    expect(completion?.result.outcome).toBe(0);
    expect(lockedEvidence?.identity).toBe(initialIdentity);
    expect(lockedEvidence?.hash).toBe(distribution.helperHash);
    expect(finalIdentity).toBe(initialIdentity);
    expect(finalHash).toBe(distribution.helperHash);
    expect(fs.existsSync(approvedMarker)).toBe(true);
    expect(fs.existsSync(untrustedMarker)).toBe(false);
    expect(attackEvidence.errorCodes).not.toEqual({});
  }, 90_000);

  for (const attack of [
    "node-in-place", "node-replacement",
    "manager-in-place", "manager-replacement",
    "manager-lib-cli-in-place", "manager-lib-cli-replacement",
    "manager-validate-engines-in-place", "manager-validate-engines-replacement",
    "manager-main-entry-in-place", "manager-main-entry-replacement",
    "manager-package-json-in-place", "manager-package-json-replacement",
    "manager-exit-handler-in-place", "manager-exit-handler-replacement",
    "manager-core-in-place", "manager-core-replacement",
    "pnpm-shim-in-place", "pnpm-shim-replacement",
    "pnpm-launcher-in-place", "pnpm-launcher-replacement",
    "pnpm-bundle-in-place", "pnpm-bundle-replacement",
    "pnpm-package-json-in-place", "pnpm-package-json-replacement",
  ] as const) {
    it.skipIf(process.platform !== "win32")(`${attack} after discovery fails closed before unauthorized material executes`, async () => {
      const root = makeSystemTempDir(`windows-${attack}`);
      const started = path.join(root, "runtime-started.txt");
      const executed = path.join(root, "runtime-executed.txt");
      const denied = path.join(root, "unauthorized-runtime.txt");
      const runtime = runtimeFixture(root, started, executed);
      const systemWhere = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
      const replacementBytes = fs.readFileSync(systemWhere);
      const packageManager = attack.startsWith("pnpm-") ? "pnpm" : "npm";
      const managerMaterial = attack.startsWith("pnpm-shim-") ? runtime.pnpmCli
        : attack.startsWith("pnpm-launcher-") ? runtime.pnpmLauncher
          : attack.startsWith("pnpm-bundle-") ? runtime.pnpmBundle
            : attack.startsWith("pnpm-package-json-") ? path.join(path.dirname(runtime.pnpmCli), "..", "package.json")
              : attack.startsWith("manager-package-json-") ? runtime.npmPackageJson
                : attack.startsWith("manager-exit-handler-") ? runtime.npmExitHandler
                  : attack.startsWith("manager-core-") ? runtime.npmCore
            : attack.startsWith("manager-lib-cli-") ? runtime.npmLibCli
        : attack.startsWith("manager-validate-engines-") ? runtime.npmValidateEngines
          : attack.startsWith("manager-main-entry-") ? runtime.npmMainEntry : runtime.npmCli;
      const targetMaterial = attack.startsWith("node-") ? runtime.node : managerMaterial;
      const initialIdentity = winFileIdentity(targetMaterial);
      const initialHash = sha256File(targetMaterial);
      const jobId = `runtime-integrity-${attack}-0001`;
      const { owner, request } = makeDirectNativeRequest(makeSystemTempDir(`runtime-repo-${attack}`), jobId, packageManager);
      let attempted = 0;
      let blockedBySharing = 0;
      let replacementSucceeded = false;
      let replacementFailed = false;
      const beforeHelperRequestWrite = () => {
        attempted += 1;
        const target = attack.startsWith("node-") ? runtime.node : managerMaterial;
        const malicious = Buffer.from(`import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(denied)}, 'ran'));\n`);
        try {
          if (attack.endsWith("in-place")) {
            fs.writeFileSync(target, attack.startsWith("node-") ? replacementBytes : malicious);
            replacementSucceeded = true;
          } else {
            const displaced = `${target}.unapproved`;
            fs.renameSync(target, displaced);
            fs.writeFileSync(target, attack.startsWith("node-") ? replacementBytes : malicious);
            replacementSucceeded = true;
          }
        } catch (error) {
          replacementFailed = true;
          if (["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) blockedBySharing += 1;
          else throw error;
        }
      };
      const runner = new WindowsNativeExecutionRunner({
        runtimeResolver: (manager) => resolveTrustedRuntime(manager, {
          platform: "win32", nodeExecutable: runtime.node, homeDirectory: root,
        }),
        beforeHelperRequestWrite,
      });
      const handle = runner.start(request, { onOutput: () => undefined });
      const completion = await handle.completion;
      const finalMaterial = attack.startsWith("node-") ? runtime.node : managerMaterial;
      const result = {
        attempted,
        blockedBySharing,
        replacementSucceeded,
        replacementFailed,
        executionObserved: fs.existsSync(executed) || fs.existsSync(denied),
        finalIdentity: winFileIdentity(finalMaterial),
        finalHash: sha256File(finalMaterial),
      };
      console.info("RUNTIME_MATERIAL_ATTACK_EVIDENCE", JSON.stringify({ attack, ...result }));
      expect(result.attempted).toBe(1);
      expect(result.blockedBySharing).toBe(0);
      expect(result.replacementSucceeded).toBe(true);
      expect(completion.result.outcome).toBe(3);
      expect(result.executionObserved).toBe(false);
      if (attack.endsWith("in-place")) {
        expect(result.finalIdentity).toBe(initialIdentity);
        expect(result.finalHash).not.toBe(initialHash);
      } else {
        expect(result.finalIdentity).not.toBe(initialIdentity);
      }
      expect(fs.existsSync(started)).toBe(false);
      expect(fs.existsSync(request.tempLease.directoryPath)).toBe(false);
    }, 45_000);
  }

  it.skipIf(process.platform !== "win32")("runtime mutation after discovery is blocked or fails closed before code runs", async () => {
    const root = makeSystemTempDir("windows-runtime-lock-window");
    const started = path.join(root, "runtime-started.txt");
    const executed = path.join(root, "runtime-executed.txt");
    const denied = path.join(root, "unauthorized-runtime.txt");
    const runtime = runtimeFixture(root, started, executed);
    fs.writeFileSync(runtime.npmCli, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
      `fs.writeFileSync(${JSON.stringify(executed)}, 'approved');`,
    ].join("\n"));
    const nodeBytes = fs.readFileSync(runtime.node);
    const managerBytes = fs.readFileSync(runtime.npmCli);
    const managerMainEntryBytes = fs.readFileSync(runtime.npmMainEntry);
    const managerAttackBytes = Buffer.from(
      `require('node:fs').writeFileSync(${JSON.stringify(denied)}, 'ran');\n`,
    );
    const nodeAttackBytes = fs.readFileSync(path.join(
      process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe",
    ));
    const initial = {
      nodeIdentity: winFileIdentity(runtime.node),
      nodeHash: sha256File(runtime.node),
      managerIdentity: winFileIdentity(runtime.npmCli),
      managerHash: sha256File(runtime.npmCli),
      managerMainEntryIdentity: winFileIdentity(runtime.npmMainEntry),
      managerMainEntryHash: sha256File(runtime.npmMainEntry),
    };
    const jobId = "runtime-lock-window-job-0001";
    const { owner, request } = makeDirectNativeRequest(makeSystemTempDir("runtime-lock-window-repo"), jobId);
    const discoveredRuntime = resolveTrustedRuntime("npm", {
      platform: "win32", nodeExecutable: runtime.node, homeDirectory: root,
    });
    const attackState: { worker: Worker | null; evidencePromise: Promise<{
      attempted: Record<string, number>;
      blockedBySharing: Record<string, number>;
      mutationSucceeded: Record<string, number>;
      errorCodes: Record<string, number>;
      replacementSucceeded: { node: boolean; manager: boolean; managerMain: boolean };
      replacementFailed: { node: number; manager: number; managerMain: number };
    }> | null } = { worker: null, evidencePromise: null };
    const runner = new WindowsNativeExecutionRunner({
      runtimeResolver: () => discoveredRuntime,
      beforeHelperRequestWrite: () => {
        attackState.worker = new Worker(`
          const { parentPort, workerData } = require('node:worker_threads');
          const fs = require('node:fs');
          const evidence = {
            attempted: { nodeWrite: 0, nodeReplace: 0, managerWrite: 0, managerReplace: 0, managerMainWrite: 0, managerMainReplace: 0 },
            blockedBySharing: { nodeWrite: 0, nodeReplace: 0, managerWrite: 0, managerReplace: 0, managerMainWrite: 0, managerMainReplace: 0 },
            mutationSucceeded: { nodeWrite: 0, managerWrite: 0, managerMainWrite: 0 },
            errorCodes: {},
            replacementSucceeded: { node: false, manager: false, managerMain: false },
            replacementFailed: { node: 0, manager: 0, managerMain: 0 },
          };
          const recordError = (key, error) => {
            const code = error.code || 'UNKNOWN';
            evidence.errorCodes[key + ':' + code] = (evidence.errorCodes[key + ':' + code] || 0) + 1;
          };
          const denied = (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code || '');
          const mutate = (key, file, firstByte) => {
            evidence.attempted[key]++;
            let handle;
            let changed = false;
            try {
              handle = fs.openSync(file, 'r+');
              fs.writeSync(handle, Buffer.from([firstByte ^ 1]), 0, 1, 0);
              changed = true;
              evidence.mutationSucceeded[key]++;
            } catch (error) {
              recordError(key, error);
              if (denied(error)) evidence.blockedBySharing[key]++;
            } finally {
              if (changed) {
                try { fs.writeSync(handle, Buffer.from([firstByte]), 0, 1, 0); }
                catch (error) { recordError(key + '.restore', error); }
              }
              if (handle !== undefined) fs.closeSync(handle);
            }
          };
          const replace = (key, file, kind, attackBytes) => {
            evidence.attempted[key]++;
            const displaced = file + '.race-displaced'; let moved = false;
            try {
              fs.renameSync(file, displaced); moved = true;
              fs.writeFileSync(file, attackBytes);
              evidence.replacementSucceeded[kind] = true;
              fs.unlinkSync(file);
              fs.renameSync(displaced, file); moved = false;
            } catch (error) {
              evidence.replacementFailed[kind]++;
              recordError(key, error);
              if (denied(error)) evidence.blockedBySharing[key]++;
              if (moved && fs.existsSync(displaced)) {
                try {
                  if (fs.existsSync(file)) fs.unlinkSync(file);
                  fs.renameSync(displaced, file);
                } catch (restoreError) { recordError(key + '.restore', restoreError); }
              }
            }
          };
          const deadline = Date.now() + 1200;
          const pauseView = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
          while (Date.now() < deadline && !fs.existsSync(workerData.started)) {
            mutate('nodeWrite', workerData.node, workerData.nodeFirstByte);
            mutate('managerWrite', workerData.manager, workerData.managerFirstByte);
            replace('nodeReplace', workerData.node, 'node', workerData.nodeAttackBytes);
            replace('managerReplace', workerData.manager, 'manager', workerData.managerAttackBytes);
            mutate('managerMainWrite', workerData.managerMainEntry, workerData.managerMainEntryFirstByte);
            replace('managerMainReplace', workerData.managerMainEntry, 'managerMain', workerData.managerAttackBytes);
            Atomics.wait(pauseView, 0, 0, 1);
          }
          parentPort.postMessage(evidence);
          parentPort.close();
        `, { eval: true, workerData: {
          node: runtime.node, manager: runtime.npmCli,
          managerMainEntry: runtime.npmMainEntry,
          started,
          nodeFirstByte: nodeBytes[0],
          managerFirstByte: managerBytes[0],
          managerMainEntryFirstByte: managerMainEntryBytes[0],
          nodeAttackBytes: Uint8Array.from(nodeAttackBytes),
          managerAttackBytes: Uint8Array.from(managerAttackBytes),
        } });
        const worker = attackState.worker;
        if (!worker) throw new Error("Runtime attack worker was not created.");
        attackState.evidencePromise = new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        });
      },
    });
    const output: Buffer[] = [];
    const diagnostics: string[] = [];
    const handle = runner.start(request, {
      onOutput: (_stream, data) => output.push(Buffer.from(data)),
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const attacker = attackState.worker;
    const evidencePromise = attackState.evidencePromise;
    if (!attacker || !evidencePromise) throw new Error("Runtime attack worker was not started.");
    const evidence = await evidencePromise;
    const completion = await handle.completion;
    await new Promise<void>((resolve) => {
      if (attacker?.threadId === -1) resolve();
      else attacker?.once("exit", () => resolve());
    });
    for (const [file, bytes] of [
      [runtime.node, nodeBytes],
      [runtime.npmCli, managerBytes],
      [runtime.npmMainEntry, managerMainEntryBytes],
    ] as const) {
      const displaced = `${file}.race-displaced`;
      if (fs.existsSync(displaced)) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.renameSync(displaced, file);
      }
      if (!fs.existsSync(file) || sha256File(file) !== createHash("sha256").update(bytes).digest("hex")) {
        fs.writeFileSync(file, bytes);
      }
    }
    const final = {
      nodeIdentity: winFileIdentity(runtime.node),
      nodeHash: sha256File(runtime.node),
      managerIdentity: winFileIdentity(runtime.npmCli),
      managerHash: sha256File(runtime.npmCli),
      managerMainEntryIdentity: winFileIdentity(runtime.npmMainEntry),
      managerMainEntryHash: sha256File(runtime.npmMainEntry),
      started: fs.existsSync(started),
      executionObserved: fs.existsSync(executed),
      unauthorizedExecutionObserved: fs.existsSync(denied),
    };
    console.info("RUNTIME_TOCTOU_EVIDENCE", JSON.stringify({
      attempted: evidence.attempted,
      blockedBySharing: evidence.blockedBySharing,
      mutationSucceeded: evidence.mutationSucceeded,
      replacementSucceeded: evidence.replacementSucceeded,
      replacementFailed: evidence.replacementFailed,
      errorCodes: evidence.errorCodes,
      outcome: completion.result.outcome,
      win32Error: completion.result.win32Error,
      exitCode: completion.result.exitCode,
      diagnostics,
      output: Buffer.concat(output).toString("utf8").slice(-1024),
      final,
    }));
    expect(evidence.attempted.nodeWrite + evidence.attempted.nodeReplace).toBeGreaterThan(0);
    expect(evidence.attempted.managerWrite + evidence.attempted.managerReplace).toBeGreaterThan(0);
    expect(evidence.attempted.managerMainWrite + evidence.attempted.managerMainReplace).toBeGreaterThan(0);
    const allBlockedBySharing = [
      evidence.blockedBySharing.nodeWrite,
      evidence.blockedBySharing.nodeReplace,
      evidence.blockedBySharing.managerWrite,
      evidence.blockedBySharing.managerReplace,
      evidence.blockedBySharing.managerMainWrite,
      evidence.blockedBySharing.managerMainReplace,
    ].every((count) => count > 0);
    const failedClosedBeforeCode = completion.result.outcome === 3 && !final.started && !final.executionObserved;
    expect(allBlockedBySharing || failedClosedBeforeCode, JSON.stringify({ evidence, final, completion })).toBe(true);
    expect(final.unauthorizedExecutionObserved, JSON.stringify({ evidence, final })).toBe(false);
    expect(final).toMatchObject(initial);
    if (completion.result.outcome === 0) {
      expect(allBlockedBySharing).toBe(true);
      expect(final.started).toBe(true);
      expect(final.executionObserved).toBe(true);
    } else {
      expect(completion.result.outcome).toBe(3);
      expect(final.started).toBe(false);
      expect(final.executionObserved).toBe(false);
    }
    expect(fs.existsSync(request.tempLease.directoryPath)).toBe(false);
    expect(owner.rootFileIdentity).toBeTruthy();
  }, 60_000);

  it.skipIf(process.platform !== "win32")("package.json replacement race never runs an unapproved script", async () => {
    const root = makeSystemTempDir("windows-package-race");
    makeGitRepo(root);
    const approvedMarker = `${root}.approved`;
    const deniedMarker = `${root}.unauthorized`;
    const manifestPath = path.join(root, "package.json");
    write(root, "approved.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(approvedMarker)}, 'approved');\nawait new Promise((resolve) => setTimeout(resolve, 1800));\n`);
    write(root, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);
    write(root, "package.json", JSON.stringify({ name: "package-race-fixture", scripts: { test: "node approved.mjs" } }));
    const approvedManifestHash = sha256File(manifestPath);

    const attackerState: { current: Worker | null } = { current: null };
    let attackAttempts = 0;
    const attackEvidenceState: { current: { attempted: number; blockedBySharing: number; replacementSucceeded: number; replacementFailed: number; errorCodes: Record<string, number> } | null } = { current: null };
    const nativeRunner = new WindowsNativeExecutionRunner();
    const runner: ExecutionRunner = {
      start: (request, callbacks) => {
        const attackerSource = `
          const fs = require('node:fs');
          const path = require('node:path');
          const { parentPort, workerData } = require('node:worker_threads');
          let running = true;
          const evidence = { attempted: 0, blockedBySharing: 0, replacementSucceeded: 0, replacementFailed: 0, errorCodes: {} };
          const recordError = (error) => {
            const code = error.code || 'UNKNOWN';
            evidence.errorCodes[code] = (evidence.errorCodes[code] || 0) + 1;
            if (['EPERM', 'EBUSY', 'EACCES'].includes(code)) evidence.blockedBySharing++;
          };
          parentPort.on('message', () => { running = false; });
          const wait = () => new Promise((resolve) => setTimeout(resolve, 2));
          (async () => {
            const swap = workerData.manifest + '.race-swap';
            const backup = workerData.manifest + '.race-original';
            while (running) {
              evidence.attempted++;
              const command = evidence.attempted % 2 ? 'node unauthorized.mjs' : 'node approved.mjs';
              let moved = false;
              try {
                fs.writeFileSync(swap, JSON.stringify({ name: 'package-race-fixture', scripts: { test: command } }));
                fs.renameSync(workerData.manifest, backup); moved = true;
                fs.renameSync(swap, workerData.manifest);
                evidence.replacementSucceeded++;
              } catch (error) {
                evidence.replacementFailed++;
                recordError(error);
              } finally {
                if (moved && fs.existsSync(backup)) {
                  try {
                    if (fs.existsSync(workerData.manifest)) fs.unlinkSync(workerData.manifest);
                    fs.renameSync(backup, workerData.manifest);
                  } catch (error) { recordError(error); }
                }
                if (fs.existsSync(swap)) {
                  try { fs.unlinkSync(swap); } catch (error) { recordError(error); }
                }
              }
              if (evidence.attempted === 1 || evidence.attempted % 100 === 0) parentPort.postMessage({ attempts: evidence.attempted, evidence }); await wait();
            }
            parentPort.postMessage({ attempts: evidence.attempted, evidence, done: true });
          })();
        `;
        attackerState.current = new Worker(attackerSource, { eval: true, workerData: { manifest: manifestPath } });
        attackerState.current.on("message", (value: { attempts?: number; evidence?: { attempted: number; blockedBySharing: number; replacementSucceeded: number; replacementFailed: number; errorCodes: Record<string, number> } }) => {
          attackAttempts = value.attempts ?? attackAttempts;
          attackEvidenceState.current = value.evidence ?? attackEvidenceState.current;
        });
        return nativeRunner.start(request, callbacks);
      },
    };
    const { supervisor } = createRealSupervisor(root, runner);
    try {
      const started = supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 30,
        idempotencyKey: "windows-package-race-key-0001", oauthClientId: "windows-package-race-client",
        scopes: ["execution.run"],
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      await waitUntil(() => {
        const state = supervisor.store.get(started.job.jobId)?.state;
        return state === "succeeded" || state === "failed" || state === "interrupted";
      }, 30_000, "The package manifest race did not settle.");
      await stopRaceWorker(attackerState.current, (count) => { attackAttempts = Math.max(attackAttempts, count); });
      const finalManifestHash = sha256File(manifestPath);
      const finalJob = supervisor.store.get(started.job.jobId);
      const attackEvidence = attackEvidenceState.current;
      console.info("PACKAGE_MANIFEST_TOCTOU_EVIDENCE", JSON.stringify({
        ...attackEvidence, attackAttempts, finalManifestHash, approvedManifestHash,
        executionObserved: fs.existsSync(approvedMarker), unauthorizedExecutionObserved: fs.existsSync(deniedMarker),
        finalState: finalJob?.state,
      }));
      expect(attackEvidence?.attempted ?? attackAttempts).toBeGreaterThan(0);
      expect((attackEvidence?.replacementSucceeded ?? 0) + (attackEvidence?.blockedBySharing ?? 0)).toBeGreaterThan(0);
      expect(finalManifestHash).toBe(approvedManifestHash);
      expect(fs.existsSync(deniedMarker)).toBe(false);
      if (finalJob?.state === "succeeded") expect(fs.readFileSync(approvedMarker, "utf8")).toBe("approved");
      else expect(fs.existsSync(approvedMarker)).toBe(false);
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await attackerState.current?.terminate();
      await supervisor.shutdown();
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("repository replacement and junction races fail closed", async () => {
    for (const mode of ["replace", "junction"] as const) {
      const root = makeSystemTempDir(`windows-repository-${mode}-race`);
      const external = makeSystemTempDir(`windows-repository-${mode}-target`);
      makeGitRepo(root);
      makeGitRepo(external);
      const deniedMarker = `${root}.unauthorized`;
      const manifest = JSON.stringify({ name: "replacement-fixture", scripts: { test: "node unauthorized.mjs" } });
      write(root, "package.json", JSON.stringify({ name: "repository-race-fixture", scripts: { test: "node approved.mjs" } }));
      write(root, "approved.mjs", "await new Promise((resolve) => setTimeout(resolve, 1600));\n");
      write(root, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);
      write(external, "package.json", manifest);
      write(external, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);

      const attackerState: { current: Worker | null } = { current: null };
      let attackAttempts = 0;
      const attackEvidenceState: { current: { attempted: number; blockedBySharing: number; replacementSucceeded: number; replacementFailed: number; errorCodes: Record<string, number> } | null } = { current: null };
      const nativeRunner = new WindowsNativeExecutionRunner();
      const runner: ExecutionRunner = {
        start: (request, callbacks) => {
          const source = `
            const fs = require('node:fs');
            const { parentPort, workerData } = require('node:worker_threads');
            let running = true;
            const evidence = { attempted: 0, blockedBySharing: 0, replacementSucceeded: 0, replacementFailed: 0, errorCodes: {} };
            const recordError = (error) => {
              const code = error.code || 'UNKNOWN';
              evidence.errorCodes[code] = (evidence.errorCodes[code] || 0) + 1;
              if (['EPERM', 'EBUSY', 'EACCES'].includes(code)) evidence.blockedBySharing++;
            };
            parentPort.on('message', () => { running = false; });
            const wait = () => new Promise((resolve) => setTimeout(resolve, 2));
            (async () => {
              const backup = workerData.root + '.race-original';
              while (running) {
                try {
                  evidence.attempted++;
                  if (!fs.existsSync(backup) && fs.existsSync(workerData.root)) fs.renameSync(workerData.root, backup);
                  if (!fs.existsSync(workerData.root)) {
                    if (workerData.mode === 'junction') fs.symlinkSync(workerData.external, workerData.root, 'junction');
                    else {
                      fs.mkdirSync(workerData.root);
                      fs.writeFileSync(workerData.root + '/package.json', workerData.manifest);
                      fs.writeFileSync(workerData.root + '/unauthorized.mjs', workerData.script);
                    }
                    evidence.replacementSucceeded++;
                  }
                } catch (error) { evidence.replacementFailed++; recordError(error); }
                if (evidence.attempted === 1 || evidence.attempted % 100 === 0) parentPort.postMessage({ attempts: evidence.attempted, evidence }); await wait();
              }
              parentPort.postMessage({ attempts: evidence.attempted, evidence, done: true });
            })();
          `;
          attackerState.current = new Worker(source, { eval: true, workerData: {
            root, external, mode, manifest,
            script: `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`,
          } });
          attackerState.current.on("message", (value: { attempts?: number; evidence?: { attempted: number; blockedBySharing: number; replacementSucceeded: number; replacementFailed: number; errorCodes: Record<string, number> } }) => {
            attackAttempts = value.attempts ?? attackAttempts;
            attackEvidenceState.current = value.evidence ?? attackEvidenceState.current;
          });
          return nativeRunner.start(request, callbacks);
        },
      };
      const { supervisor } = createRealSupervisor(root, runner);
      try {
        approveTrustedCommand({
          workspaceId: supervisor.workspace.id,
          repositoryIdentity: resolveRepositoryIdentity(supervisor.workspace, ".").identity,
          canonicalRepositoryPath: root,
          kind: "test", target: "test", packageManager: "npm", localApproval: true,
        });
        const started = supervisor.start({
          repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 30,
          idempotencyKey: `windows-${mode}-race-key-0001`, oauthClientId: `windows-${mode}-race-client`,
          scopes: ["execution.run"],
        });
        expect(started.ok).toBe(true);
        if (!started.ok) throw new Error(started.error);
        await waitUntil(() => {
          const state = supervisor.store.get(started.job.jobId)?.state;
          return state === "succeeded" || state === "failed" || state === "interrupted";
        }, 30_000, `The ${mode} repository race did not settle.`);
        await stopRaceWorker(attackerState.current, (count) => { attackAttempts = Math.max(attackAttempts, count); });
        const attackEvidence = attackEvidenceState.current;
        console.info("REPOSITORY_TOCTOU_EVIDENCE", JSON.stringify({ mode, ...attackEvidence, attackAttempts,
          unauthorizedExecutionObserved: fs.existsSync(deniedMarker), finalState: supervisor.store.get(started.job.jobId)?.state }));
        expect(attackEvidence?.attempted ?? attackAttempts).toBeGreaterThan(0);
        expect((attackEvidence?.replacementSucceeded ?? 0) + (attackEvidence?.blockedBySharing ?? 0)).toBeGreaterThan(0);
        expect(fs.existsSync(deniedMarker)).toBe(false);
        expectNoOwnedJobTemps(supervisor);
      } finally {
        await attackerState.current?.terminate();
        await supervisor.shutdown();
      }
    }
  }, 90_000);
});
