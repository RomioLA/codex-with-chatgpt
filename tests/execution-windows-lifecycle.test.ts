import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { approveTrustedCommand } from "../src/execution/trusted-registry.js";
import { setPermission } from "../src/permission/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function createRealSupervisor(workspaceRoot: string): { supervisor: ExecutionSupervisor; workspace: Workspace } {
  isolateStateDir();
  const workspace = new Workspace(workspaceRoot);
  setPermission(workspace.id, "level1");
  const repository = resolveRepositoryIdentity(workspace, ".");
  approveTrustedCommand({
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "test",
    target: "test",
    packageManager: "npm",
    localApproval: true,
  });
  return { supervisor: new ExecutionSupervisor(workspace), workspace };
}

async function runNativeTreeOutcome(name: string, outcome: "cancelled" | "timed_out"): Promise<void> {
  const helperPath = path.join(projectRoot, "build", "native", "c2c-execution-helper.exe");
  if (!fs.existsSync(helperPath)) throw new Error("Build the native helper before this acceptance test.");
  const root = makeTmpDir(name);
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
    }
    await waitUntil(() => {
      const job = supervisor.store.get(started.job.jobId);
      if (job?.finishedAt && job.state !== outcome) {
        throw new Error(`Expected terminal state ${outcome}, received ${job.state}.`);
      }
      return job?.state === outcome;
    }, outcome === "timed_out" ? 20_000 : 15_000, `Job did not reach ${outcome}.`);
    await waitForProcessesToExit(processIds);
  } finally {
    await supervisor.shutdown();
  }
}

describe("Windows execution lifecycle acceptance", () => {
  it.skipIf(process.platform !== "win32")("A: owner process loss closes the full native Job tree", async () => {
    const helperPath = path.join(projectRoot, "build", "native", "c2c-execution-helper.exe");
    if (!fs.existsSync(helperPath)) throw new Error("Build the native helper before this acceptance test.");

    const root = makeTmpDir("windows-owner-loss");
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
});
