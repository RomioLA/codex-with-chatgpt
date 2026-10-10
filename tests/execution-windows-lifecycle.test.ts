import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { resolveExecutionHelperPath, WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
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

function createRealSupervisor(
  workspaceRoot: string,
  runner?: ExecutionRunner,
  packageManager: "npm" | "pnpm" = "npm",
): { supervisor: ExecutionSupervisor; workspace: Workspace } {
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
    packageManager,
    localApproval: true,
  });
  return { supervisor: new ExecutionSupervisor(workspace, { runner }), workspace };
}

function expectNoOwnedJobTemps(supervisor: ExecutionSupervisor): void {
  const tempRoot = path.join(supervisor.store.directory, "execution-temp");
  const leftovers = fs.readdirSync(tempRoot).filter((name) => name.startsWith("tmp-"));
  expect(leftovers).toEqual([]);
}

async function stopRaceWorker(worker: Worker | null, onAttempts: (count: number) => void): Promise<void> {
  if (!worker) return;
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
  await worker.terminate();
}

async function runNativeTreeOutcome(name: string, outcome: "cancelled" | "timed_out" | "shutdown"): Promise<void> {
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
    const root = makeTmpDir("windows-normal-execution");
    makeGitRepo(root);
    const marker = `${root}.approved`;
    write(root, "package.json", JSON.stringify({ name: "normal-execution-fixture", scripts: { test: "node approved.mjs" } }));
    write(root, "approved.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'approved');\n`);
    const { supervisor } = createRealSupervisor(root);
    try {
      const started = supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 30,
        idempotencyKey: "windows-normal-execution-key-0001", oauthClientId: "windows-normal-client",
        scopes: ["execution.run"],
      });
      expect(started.ok).toBe(true);
      if (!started.ok) throw new Error(started.error);
      await waitUntil(() => supervisor.store.get(started.job.jobId)?.state === "succeeded", 30_000,
        "The approved native recipe did not succeed.");
      expect(fs.readFileSync(marker, "utf8")).toBe("approved");
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await supervisor.shutdown();
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("native helper runs through the fixed pinned pnpm runtime", async () => {
    const root = makeTmpDir("windows-pnpm-execution");
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
      expect(supervisor.store.get(started.job.jobId)?.state).toBe("succeeded");
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
    const root = makeTmpDir("windows-failed-execution");
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
    const root = makeTmpDir("windows-helper-start-failure");
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ name: "helper-failure-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
    const workspace = new Workspace(root);
    const repository = resolveRepositoryIdentity(workspace, ".");
    const trustedCommand = approveTrustedCommand({
      workspaceId: workspace.id, repositoryIdentity: repository.identity,
      canonicalRepositoryPath: repository.canonicalPath, kind: "test", target: "test",
      packageManager: "npm", localApproval: true,
    });
    const stateDirectory = makeTmpDir("windows-helper-failure-state");
    const owner = new ExecutionTempOwner(stateDirectory, workspace.id);
    const request = {
      jobId: "start-failure-job-00000001", repository, trustedCommand,
      timeoutSeconds: 10, stateDirectory, tempOwner: owner,
    };
    const callbacks = { onOutput: () => undefined };
    const validHelper = resolveExecutionHelperPath();
    const throwingSpawn = (() => { throw new Error("start failure fixture"); }) as never;

    expect(() => new WindowsNativeExecutionRunner({ helperPath: validHelper, spawnImpl: throwingSpawn }).start(request, callbacks))
      .toThrow("EXECUTION_HELPER_START_FAILED");
    expect(fs.readdirSync(owner.root).filter((name) => name.startsWith("tmp-")).length).toBe(0);

    const corrupt = path.join(stateDirectory, "corrupt-helper.exe");
    fs.writeFileSync(corrupt, "not a Windows executable");
    for (const [index, helperPath] of [path.join(stateDirectory, "missing-helper.exe"), corrupt].entries()) {
      let handle: ReturnType<WindowsNativeExecutionRunner["start"]> | null = null;
      try {
        handle = new WindowsNativeExecutionRunner({ helperPath }).start({
          ...request, jobId: `helper-failure-job-${String(index).padStart(8, "0")}`,
        }, callbacks);
      } catch (error) {
        expect(error).toMatchObject({ message: "EXECUTION_HELPER_START_FAILED" });
      }
      if (handle) await expect(handle.completion).rejects.toThrow("EXECUTION_HELPER_START_FAILED");
      expect(fs.readdirSync(owner.root).filter((name) => name.startsWith("tmp-")).length).toBe(0);
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("package.json replacement race never runs an unapproved script", async () => {
    const root = makeTmpDir("windows-package-race");
    makeGitRepo(root);
    const approvedMarker = `${root}.approved`;
    const deniedMarker = `${root}.unauthorized`;
    const manifestPath = path.join(root, "package.json");
    write(root, "approved.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(approvedMarker)}, 'approved');\nawait new Promise((resolve) => setTimeout(resolve, 1800));\n`);
    write(root, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);
    write(root, "package.json", JSON.stringify({ name: "package-race-fixture", scripts: { test: "node approved.mjs" } }));

    let attacker: Worker | null = null;
    let attackAttempts = 0;
    const nativeRunner = new WindowsNativeExecutionRunner();
    const runner: ExecutionRunner = {
      start: (request, callbacks) => {
        const attackerSource = `
          const fs = require('node:fs');
          const path = require('node:path');
          const { parentPort, workerData } = require('node:worker_threads');
          let running = true; let attempts = 0;
          parentPort.on('message', () => { running = false; });
          const wait = () => new Promise((resolve) => setTimeout(resolve, 2));
          (async () => {
            const swap = workerData.manifest + '.race-swap';
            while (running) {
              const command = attempts % 2 ? 'node unauthorized.mjs' : 'node approved.mjs';
              try {
                fs.writeFileSync(swap, JSON.stringify({ name: 'package-race-fixture', scripts: { test: command } }));
                fs.renameSync(swap, workerData.manifest);
              } catch {}
              attempts++; if (attempts === 1 || attempts % 100 === 0) parentPort.postMessage({ attempts }); await wait();
            }
            parentPort.postMessage({ attempts, done: true });
          })();
        `;
        attacker = new Worker(attackerSource, { eval: true, workerData: { manifest: manifestPath } });
        attacker.on("message", (value: { attempts?: number }) => { attackAttempts = value.attempts ?? attackAttempts; });
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
      await stopRaceWorker(attacker, (count) => { attackAttempts = Math.max(attackAttempts, count); });
      expect(attackAttempts).toBeGreaterThan(0);
      expect(fs.existsSync(deniedMarker)).toBe(false);
      const finalJob = supervisor.store.get(started.job.jobId);
      if (finalJob?.state === "succeeded") expect(fs.readFileSync(approvedMarker, "utf8")).toBe("approved");
      expectNoOwnedJobTemps(supervisor);
    } finally {
      await attacker?.terminate();
      await supervisor.shutdown();
    }
  }, 45_000);

  it.skipIf(process.platform !== "win32")("repository replacement and junction races fail closed", async () => {
    for (const mode of ["replace", "junction"] as const) {
      const root = makeTmpDir(`windows-repository-${mode}-race`);
      const external = makeTmpDir(`windows-repository-${mode}-target`);
      makeGitRepo(root);
      makeGitRepo(external);
      const deniedMarker = `${root}.unauthorized`;
      const manifest = JSON.stringify({ name: "replacement-fixture", scripts: { test: "node unauthorized.mjs" } });
      write(root, "package.json", JSON.stringify({ name: "repository-race-fixture", scripts: { test: "node approved.mjs" } }));
      write(root, "approved.mjs", "await new Promise((resolve) => setTimeout(resolve, 1600));\n");
      write(root, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);
      write(external, "package.json", manifest);
      write(external, "unauthorized.mjs", `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`);

      let attacker: Worker | null = null;
      let attackAttempts = 0;
      const nativeRunner = new WindowsNativeExecutionRunner();
      const runner: ExecutionRunner = {
        start: (request, callbacks) => {
          const source = `
            const fs = require('node:fs');
            const { parentPort, workerData } = require('node:worker_threads');
            let running = true; let attempts = 0;
            parentPort.on('message', () => { running = false; });
            const wait = () => new Promise((resolve) => setTimeout(resolve, 2));
            (async () => {
              const backup = workerData.root + '.race-original';
              while (running) {
                try {
                  if (!fs.existsSync(backup) && fs.existsSync(workerData.root)) fs.renameSync(workerData.root, backup);
                  if (!fs.existsSync(workerData.root)) {
                    if (workerData.mode === 'junction') fs.symlinkSync(workerData.external, workerData.root, 'junction');
                    else {
                      fs.mkdirSync(workerData.root);
                      fs.writeFileSync(workerData.root + '/package.json', workerData.manifest);
                      fs.writeFileSync(workerData.root + '/unauthorized.mjs', workerData.script);
                    }
                  }
                } catch {}
                attempts++; if (attempts === 1 || attempts % 100 === 0) parentPort.postMessage({ attempts }); await wait();
              }
              parentPort.postMessage({ attempts, done: true });
            })();
          `;
          attacker = new Worker(source, { eval: true, workerData: {
            root, external, mode, manifest,
            script: `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(deniedMarker)}, 'unauthorized');\n`,
          } });
          attacker.on("message", (value: { attempts?: number }) => { attackAttempts = value.attempts ?? attackAttempts; });
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
        await stopRaceWorker(attacker, (count) => { attackAttempts = Math.max(attackAttempts, count); });
        expect(attackAttempts).toBeGreaterThan(0);
        expect(fs.existsSync(deniedMarker)).toBe(false);
        expectNoOwnedJobTemps(supervisor);
      } finally {
        await attacker?.terminate();
        await supervisor.shutdown();
      }
    }
  }, 90_000);
});
