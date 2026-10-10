import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { runExecutionTempCleanup } from "../src/execution/execution-temp-cleanup.js";
import { serializeTempCleanupRequest } from "../src/execution/helper-protocol.js";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { resolveExecutionHelperPath } from "../src/execution/native-runner.js";

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function makeExecutionTempOwner(name: string, workspaceId: string): ExecutionTempOwner {
  const stateRoot = makeSystemTempDir(name);
  const storeDirectory = path.join(stateRoot, "execution-jobs", workspaceId);
  fs.mkdirSync(storeDirectory, { recursive: true });
  return new ExecutionTempOwner(storeDirectory, workspaceId);
}

function jobId(value: string): string {
  return value.padEnd(24, "x").slice(0, 24);
}

describe("ExecutionTempOwner", () => {
  it.skipIf(process.platform !== "win32")("removes only a marked job directory under its fixed root", () => {
    const owner = makeExecutionTempOwner("execution-temp-owned", "temp-owner-test");
    const id = jobId("success");
    const lease = owner.create(id);
    const temp = lease.directoryPath;
    expect(owner.fileIdentity(id)).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    fs.writeFileSync(path.join(temp, "private.npmrc"), "private=true");

    expect(owner.cleanup(id, lease)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
    expect(owner.cleanup("../outside", lease)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("fails closed on platforms without the identity-bound native cleanup primitive", () => {
    const owner = makeExecutionTempOwner("execution-temp-unsupported-cleanup", "temp-unsupported-test");
    const id = jobId("unsupported");
    const lease = owner.create(id);
    fs.writeFileSync(path.join(lease.directoryPath, "keep.txt"), "keep");

    expect(owner.cleanup(id, lease)).toBe(false);
    expect(fs.readFileSync(path.join(lease.directoryPath, "keep.txt"), "utf8")).toBe("keep");
  });

  it("simulates Bridge crash recovery and preserves unknown stale directories", () => {
    const workspaceId = "temp-restart-test";
    const stateRoot = makeSystemTempDir("execution-temp-restart");
    const storeDirectory = path.join(stateRoot, "execution-jobs", workspaceId);
    fs.mkdirSync(storeDirectory, { recursive: true });
    const storeBeforeCrash = new ExecutionJobStore(workspaceId, { directory: storeDirectory });
    const ownerBeforeCrash = new ExecutionTempOwner(storeDirectory, workspaceId);
    const staleId = jobId("stale");
    const stale = ownerBeforeCrash.create(staleId);
    const job: ExecutionJob = {
      jobId: staleId,
      workspaceId,
      repositoryIdentity: "a".repeat(64),
      repositoryPath: ".",
      oauthClientId: "execution-temp-restart-test",
      recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
      state: "running",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      timeoutSeconds: 30,
      idempotencyKeyHash: "c".repeat(64),
      tempOwnership: {
        rootFileIdentity: stale.rootFileIdentity,
        directoryFileIdentity: stale.directoryFileIdentity,
        nonce: stale.nonce,
        createdAtMs: stale.createdAtMs,
      },
      exitCode: null,
      failureCode: null,
      stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
      stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    };
    storeBeforeCrash.create(job);
    const restartedOwner = new ExecutionTempOwner(storeDirectory, workspaceId);
    const restartedStore = new ExecutionJobStore(workspaceId, { directory: storeDirectory });
    const persistedOwnership = restartedStore.get(staleId)?.tempOwnership;
    expect(persistedOwnership).toMatchObject({
      rootFileIdentity: stale.rootFileIdentity,
      directoryFileIdentity: stale.directoryFileIdentity,
      nonce: stale.nonce,
      createdAtMs: stale.createdAtMs,
    });
    const unknownId = jobId("unknown");
    const unknown = path.join(restartedOwner.root, `tmp-${unknownId}`);
    fs.mkdirSync(unknown);

    const records = restartedStore.listAll().flatMap((record) => record.tempOwnership
      ? [{ jobId: record.jobId, ownership: record.tempOwnership }]
      : []);
    const result = restartedOwner.reconcileStaleTemps(records);
    if (process.platform === "win32") {
      expect(result).toEqual({ removed: 1, skipped: 1 });
      expect(fs.existsSync(stale.directoryPath)).toBe(false);
    } else {
      expect(result).toEqual({ removed: 0, skipped: 2 });
      expect(fs.existsSync(stale.directoryPath)).toBe(true);
    }
    expect(fs.existsSync(unknown)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("native cleanup rejects a caller-supplied root outside C2C_STATE_DIR", () => {
    const expectedWorkspaceId = "native-cleanup-root-check";
    const expectedStateRoot = makeSystemTempDir("execution-temp-fixed-state-root");
    const expectedStore = path.join(expectedStateRoot, "execution-jobs", expectedWorkspaceId);
    fs.mkdirSync(expectedStore, { recursive: true });
    new ExecutionTempOwner(expectedStore, expectedWorkspaceId);
    const outsideOwner = makeExecutionTempOwner("execution-temp-outside-state-root", expectedWorkspaceId);
    const id = jobId("outside-root");
    const lease = outsideOwner.create(id);
    const result = spawnSync(resolveExecutionHelperPath(), ["--cleanup-temp"], {
      input: serializeTempCleanupRequest(lease),
      env: { ...process.env, C2C_STATE_DIR: expectedStateRoot },
      windowsHide: true,
      shell: false,
      timeout: 30_000,
      stdio: ["pipe", "ignore", "ignore"],
    });

    const evidence = { exitCode: result.status, spawnError: result.error?.message ?? null, targetPreserved: fs.existsSync(lease.directoryPath) };
    console.info("TEMP_HELPER_FIXED_ROOT_REJECTION", JSON.stringify(evidence));
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(lease.directoryPath)).toBe(true);
  }, 45_000);

  it.skipIf(process.platform !== "win32")("cleanup wrapper rejects a lease outside its trusted job store", () => {
    const workspaceId = "cleanup-wrapper-root-check";
    const trustedStateRoot = makeSystemTempDir("execution-temp-wrapper-trusted-state");
    const trustedStore = path.join(trustedStateRoot, "execution-jobs", workspaceId);
    fs.mkdirSync(trustedStore, { recursive: true });
    new ExecutionTempOwner(trustedStore, workspaceId);
    const outsideOwner = makeExecutionTempOwner("execution-temp-wrapper-outside-state", workspaceId);
    const lease = outsideOwner.create(jobId("wrapper-outside"));

    const result = runExecutionTempCleanup(lease, trustedStore);
    console.info("TEMP_CLEANUP_WRAPPER_ROOT_REJECTION", JSON.stringify({
      attempted: true,
      cleanupAccepted: result,
      targetPreserved: fs.existsSync(lease.directoryPath),
    }));
    expect(result).toBe(false);
    expect(fs.existsSync(lease.directoryPath)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("accepts a legacy V1 root marker while preserving unknown old job directories", () => {
    const workspaceId = "legacy-temp-root-test";
    const stateRoot = makeSystemTempDir("execution-temp-legacy-root");
    const storeDirectory = path.join(stateRoot, "execution-jobs", workspaceId);
    fs.mkdirSync(storeDirectory, { recursive: true });
    const root = path.join(storeDirectory, "execution-temp");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".c2c-execution-temp-owner"),
      `C2C-EXECUTION-TEMP-ROOT-V1\n${workspaceId}\n`);
    const legacyJob = path.join(root, `tmp-${jobId("legacy")}`);
    fs.mkdirSync(legacyJob);
    fs.writeFileSync(path.join(legacyJob, ".c2c-job-owner"),
      `C2C-EXECUTION-TEMP-JOB-V1\n${workspaceId}\n${jobId("legacy")}\n`);

    const owner = new ExecutionTempOwner(storeDirectory, workspaceId);
    const lease = owner.create(jobId("new-job"));
    const recovery = owner.reconcileStaleTemps([{ jobId: lease.jobId, ownership: lease }]);
    console.info("TEMP_LEGACY_ROOT_RECOVERY", JSON.stringify({
      legacyDirectoryPreserved: fs.existsSync(legacyJob),
      newJobCleanupCount: recovery.removed,
      unknownSkipped: recovery.skipped,
    }));
    expect(fs.existsSync(legacyJob)).toBe(true);
    expect(recovery).toEqual({ removed: 1, skipped: 1 });
  }, 45_000);

  it.skipIf(process.platform !== "win32")("native cleanup preserves a job when its sidecar ownership record is missing", () => {
    const workspaceId = "native-cleanup-sidecar-check";
    const stateRoot = makeSystemTempDir("execution-temp-sidecar-state");
    const storeDirectory = path.join(stateRoot, "execution-jobs", workspaceId);
    fs.mkdirSync(storeDirectory, { recursive: true });
    const owner = new ExecutionTempOwner(storeDirectory, workspaceId);
    const id = jobId("missing-sidecar");
    const lease = owner.create(id);
    fs.unlinkSync(path.join(storeDirectory, `.c2c-execution-temp-job-${id}`));
    const result = spawnSync(resolveExecutionHelperPath(), ["--cleanup-temp"], {
      input: serializeTempCleanupRequest(lease),
      env: { ...process.env, C2C_STATE_DIR: stateRoot },
      windowsHide: true,
      shell: false,
      timeout: 30_000,
      stdio: ["pipe", "ignore", "ignore"],
    });

    const evidence = { exitCode: result.status, spawnError: result.error?.message ?? null, targetPreserved: fs.existsSync(lease.directoryPath) };
    console.info("TEMP_HELPER_MISSING_SIDECAR_REJECTION", JSON.stringify(evidence));
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(lease.directoryPath)).toBe(true);
  }, 45_000);

  it("preserves a reparse job path and its external target", () => {
    const owner = makeExecutionTempOwner("execution-temp-job-junction", "temp-job-junction-test");
    const external = makeSystemTempDir("execution-temp-job-junction-target");
    const sentinel = path.join(external, "keep.txt");
    fs.writeFileSync(sentinel, "keep");
    const id = jobId("fake-link");
    const link = path.join(owner.root, `tmp-${id}`);
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");

    expect(owner.validate(id, {
      rootFileIdentity: owner.rootFileIdentity,
      directoryFileIdentity: "1:1",
      nonce: "0".repeat(64),
      createdAtMs: Date.now(),
    })).toBe(false);
    expect(() => owner.fileIdentity(id)).toThrow("TEMP_DIRECTORY_INVALID");
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("does not follow a reparse entry outside an owned temp directory", () => {
    const owner = makeExecutionTempOwner("execution-temp-junction", "temp-junction-test");
    const id = jobId("junction");
    const lease = owner.create(id);
    const temp = lease.directoryPath;
    const external = makeSystemTempDir("execution-temp-external");
    const sentinel = path.join(external, "keep.txt");
    fs.writeFileSync(sentinel, "keep");

    const link = path.join(temp, "external");
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    const cleaned = owner.cleanup(id, lease);
    expect(cleaned).toBe(process.platform === "win32");
    expect(fs.existsSync(temp)).toBe(process.platform !== "win32");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("preserves an unmarked temp root instead of claiming it", () => {
    const stateDirectory = makeSystemTempDir("execution-temp-unowned-root");
    const root = path.join(stateDirectory, "execution-temp");
    fs.mkdirSync(root);
    const unknown = path.join(root, "keep");
    fs.writeFileSync(unknown, "evidence");

    expect(() => new ExecutionTempOwner(stateDirectory, "unowned-root-test")).toThrow("TEMP_ROOT_UNOWNED");
    expect(fs.readFileSync(unknown, "utf8")).toBe("evidence");
  });

  it("rejects a forged nonce even when the target path and visible marker look valid", () => {
    const owner = makeExecutionTempOwner("execution-temp-forged-nonce", "temp-forged-test");
    const id = jobId("forged-marker");
    const lease = owner.create(id);
    const forged = { ...lease, nonce: "0".repeat(64) };
    expect(owner.cleanup(id, forged)).toBe(false);
    expect(fs.existsSync(lease.directoryPath)).toBe(true);
  });

  it("does not treat a forged marker with valid workspace and job IDs as ownership", () => {
    const owner = makeExecutionTempOwner("execution-temp-forged-marker", "forged-marker-workspace");
    const id = jobId("forged-marker");
    const lease = owner.create(id);
    const forgedMarker = [
      "C2C-EXECUTION-TEMP-JOB-V2",
      lease.workspaceId,
      lease.jobId,
      "f".repeat(64),
      lease.rootFileIdentity,
      lease.directoryFileIdentity,
      String(lease.createdAtMs),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(lease.directoryPath, ".c2c-job-owner"), forgedMarker);

    expect(owner.cleanup(id, lease)).toBe(false);
    expect(fs.existsSync(lease.directoryPath)).toBe(true);
  });

  it("preserves a replacement directory whose identity differs from the persisted owner", () => {
    const owner = makeExecutionTempOwner("execution-temp-identity-mismatch", "temp-identity-test");
    const id = jobId("identity-mismatch");
    const lease = owner.create(id);
    const replacement = `${lease.directoryPath}.replacement`;
    fs.renameSync(lease.directoryPath, replacement);
    fs.mkdirSync(lease.directoryPath);
    fs.copyFileSync(path.join(replacement, ".c2c-job-owner"), path.join(lease.directoryPath, ".c2c-job-owner"));
    fs.writeFileSync(path.join(lease.directoryPath, "keep.txt"), "replacement must remain");

    expect(owner.cleanup(id, lease)).toBe(false);
    expect(fs.readFileSync(path.join(lease.directoryPath, "keep.txt"), "utf8")).toBe("replacement must remain");
  });

  for (const mode of ["rename", "replace", "junction"] as const) {
    it.skipIf(process.platform !== "win32")(`${mode} race after validation deletes only the original owned object or fails closed`, async () => {
      const workspaceId = `temp-${mode}-race`;
      const owner = makeExecutionTempOwner(`execution-temp-${mode}-race`, workspaceId);
      const id = jobId(`race-${mode}`);
      const lease = owner.create(id);
      const external = makeSystemTempDir(`execution-temp-${mode}-external`);
      const externalSentinel = path.join(external, "outside-keep.txt");
      fs.writeFileSync(externalSentinel, "outside");
      const backup = `${lease.directoryPath}.race-original`;
      const replacementSentinel = path.join(lease.directoryPath, "replacement-keep.txt");
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const fs = require('node:fs');
        let running = false;
        const evidence = { attempted: 0, blockedBySharing: 0, replacementSucceeded: false, replacementFailed: 0 };
        const denied = (error) => ['EPERM', 'EBUSY', 'EACCES'].includes(error.code || '');
        parentPort.postMessage({ ready: true });
        parentPort.on('message', (message) => { if (message === 'start') { running = true; attack(); } });
        function attack() {
          if (!running || evidence.attempted >= 250) { parentPort.postMessage({ done: true, evidence }); parentPort.close(); return; }
          evidence.attempted++;
          try {
            if (workerData.mode === 'rename') {
              const transient = workerData.target + '.race-' + evidence.attempted;
              fs.renameSync(workerData.target, transient);
              evidence.replacementSucceeded = true;
              fs.renameSync(transient, workerData.target);
            } else if (!evidence.replacementSucceeded) {
              fs.renameSync(workerData.target, workerData.backup);
              if (workerData.mode === 'replace') {
                fs.mkdirSync(workerData.target);
                fs.copyFileSync(workerData.backup + '/.c2c-job-owner', workerData.target + '/.c2c-job-owner');
                fs.writeFileSync(workerData.sentinel, 'replacement');
              } else {
                fs.symlinkSync(workerData.external, workerData.target, 'junction');
              }
              evidence.replacementSucceeded = true;
            }
          } catch (error) {
            evidence.replacementFailed++;
            if (denied(error)) evidence.blockedBySharing++;
          }
          setImmediate(attack);
        }
      `, { eval: true, workerData: {
        mode, target: lease.directoryPath, backup, sentinel: replacementSentinel, external,
      } });
      await new Promise<void>((resolve, reject) => {
        worker.once("message", (value: { ready?: boolean }) => value.ready ? resolve() : undefined);
        worker.once("error", reject);
      });
      const cleanupResult = owner.cleanup(id, lease, () => worker.postMessage("start"));
      const race = await new Promise<{ attempted: number; blockedBySharing: number; replacementSucceeded: boolean; replacementFailed: number }>((resolve, reject) => {
        worker.on("message", (value: { done?: boolean; evidence?: { attempted: number; blockedBySharing: number; replacementSucceeded: boolean; replacementFailed: number } }) => {
          if (value.done && value.evidence) resolve(value.evidence);
        });
        worker.once("error", reject);
      });
      await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      const finalExists = fs.existsSync(lease.directoryPath);
      const finalStat = finalExists ? fs.lstatSync(lease.directoryPath, { bigint: true }) : null;
      const finalIdentity = finalStat ? `${finalStat.dev.toString(16)}:${finalStat.ino.toString(16)}` : null;
      const finalMarkerHash = finalExists && fs.existsSync(path.join(lease.directoryPath, ".c2c-job-owner"))
        ? createHash("sha256").update(fs.readFileSync(path.join(lease.directoryPath, ".c2c-job-owner"))).digest("hex")
        : null;
      console.info("TEMP_CLEANUP_RACE_EVIDENCE", JSON.stringify({
        mode,
        ...race,
        cleanupResult,
        executionObserved: false,
        finalIdentity,
        finalMarkerHash,
        externalSentinelPreserved: fs.readFileSync(externalSentinel, "utf8") === "outside",
      }));

      expect(race.attempted).toBeGreaterThan(0);
      expect(race.blockedBySharing + Number(race.replacementSucceeded)).toBeGreaterThan(0);
      expect(fs.readFileSync(externalSentinel, "utf8")).toBe("outside");
      if (mode === "replace" && race.replacementSucceeded) {
        expect(cleanupResult).toBe(false);
        expect(fs.readFileSync(replacementSentinel, "utf8")).toBe("replacement");
        expect(finalIdentity).not.toBe(lease.directoryFileIdentity);
        expect(finalMarkerHash).not.toBeNull();
      } else if (mode === "junction" && race.replacementSucceeded) {
        expect(cleanupResult).toBe(false);
        expect(fs.lstatSync(lease.directoryPath).isSymbolicLink()).toBe(true);
      } else if (mode === "rename") {
        if (cleanupResult) expect(finalExists).toBe(false);
        else expect(finalIdentity).toBe(lease.directoryFileIdentity);
      } else if (!race.replacementSucceeded) {
        expect(cleanupResult).toBe(true);
        expect(finalExists).toBe(false);
      }
    }, 60_000);
  }
});
