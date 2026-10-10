import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionJobStore } from "../src/execution/job-store.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { makeTmpDir, write } from "./helpers.js";

function makeJob(workspaceId: string): ExecutionJob {
  return {
    jobId: randomBytes(24).toString("base64url"),
    workspaceId,
    repositoryIdentity: "a".repeat(64),
    repositoryPath: ".",
    oauthClientId: "store-corruption-client",
    recipe: { kind: "test", target: "test", packageManager: "npm", scriptHash: "b".repeat(64) },
    state: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    timeoutSeconds: 60,
    idempotencyKeyHash: "c".repeat(64),
    exitCode: null,
    failureCode: null,
    stdout: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
    stderr: { totalBytes: 0, retainedBytes: 0, oldestAvailableOffset: 0, truncated: false, restrictedReason: null },
  };
}

function writeStoreDirectory(name: string, contents: string): { directory: string; file: string } {
  const directory = makeTmpDir(name);
  const file = path.join(directory, "jobs.json");
  fs.writeFileSync(file, contents);
  return { directory, file };
}

describe("ExecutionJobStore corruption handling", () => {
  it("fails closed on duplicate IDs without changing ownership or replacing evidence", () => {
    const workspaceId = "duplicate-store";
    const job = makeJob(workspaceId);
    const duplicate = { ...job, oauthClientId: "different-owner", state: "succeeded" as const, finishedAt: new Date().toISOString() };
    const original = JSON.stringify({ version: 1, workspaceId, jobs: [job, duplicate] });
    const { directory, file } = writeStoreDirectory("job-store-duplicate", original);
    const store = new ExecutionJobStore(workspaceId, { directory });

    expect(store.corruption).toEqual({ code: "STORE_CORRUPT", reason: "duplicate_job_id" });
    expect(store.get(job.jobId)).toBeNull();
    expect(store.listAll()).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(() => store.create(job)).toThrow("STORE_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("preserves invalid, truncated, partial, and unsupported stores across restart", () => {
    const cases: Array<{ name: string; text: string; reason: string }> = [
      { name: "invalid-json", text: "{not json", reason: "invalid_json" },
      { name: "truncated-json", text: '{"version":1,"workspaceId":"partial","jobs":[', reason: "invalid_json" },
      { name: "partial-write", text: '{"version":1,"workspaceId":"partial","jobs":[]', reason: "invalid_json" },
      { name: "unknown-schema", text: JSON.stringify({ version: 99, workspaceId: "unknown", jobs: [] }), reason: "unsupported_schema" },
    ];

    for (const entry of cases) {
      const { directory, file } = writeStoreDirectory(`job-store-${entry.name}`, entry.text);
      const first = new ExecutionJobStore(entry.name, { directory });
      const second = new ExecutionJobStore(entry.name, { directory });
      expect(first.corruption).toEqual({ code: "STORE_CORRUPT", reason: entry.reason });
      expect(second.corruption).toEqual({ code: "STORE_CORRUPT", reason: entry.reason });
      expect(second.listAll()).toEqual([]);
      expect(fs.readFileSync(file, "utf8")).toBe(entry.text);
    }
  });

  it("does not start or cancel jobs from a corrupt store and preserves the evidence", async () => {
    const root = makeTmpDir("corrupt-store-supervisor-workspace");
    const workspace = new Workspace(root);
    const job = makeJob(workspace.id);
    const original = JSON.stringify({ version: 1, workspaceId: workspace.id, jobs: [job, job] });
    const directory = makeTmpDir("corrupt-store-supervisor-state");
    const file = write(directory, "jobs.json", original);
    const store = new ExecutionJobStore(workspace.id, { directory });
    const tempOwner = new ExecutionTempOwner(directory, workspace.id);
    const staleTemp = tempOwner.create("preserve-corrupt-store-temp-01");
    const supervisor = new ExecutionSupervisor(workspace, { store });

    try {
      expect(supervisor.start({
        repositoryPath: ".", kind: "test", target: "test", timeoutSeconds: 60,
        idempotencyKey: "corrupt-store-start-key-0001", oauthClientId: "corrupt-store-client",
        scopes: ["execution.run"],
      })).toEqual({ ok: false, error: "STORE_CORRUPT" });
      expect(supervisor.cancel(job.jobId, job.oauthClientId)).toEqual({ ok: false, error: "STORE_CORRUPT" });
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(supervisor.store.listAll()).toEqual([]);
      expect(fs.existsSync(staleTemp)).toBe(true);
    } finally {
      await supervisor.shutdown();
    }
  });
});
