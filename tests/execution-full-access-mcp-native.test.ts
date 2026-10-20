import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { readCurrentSessionGrant, setPermission } from "../src/permission/store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleDirectory = path.join(projectRoot, "dist", "execution");

interface JobView {
  job_id: string;
  state: string;
  exit_code: number | null;
}

interface RunResult {
  job: JobView;
  job_id: string;
  state: string;
  exit_code: number | null;
  stdout_tail?: string;
  stderr_tail?: string;
}

interface StatusResult {
  available: boolean;
  job?: JobView;
}

interface OutputResult {
  text: string;
  next_offset: number;
  truncated: boolean;
}

function makeSystemTempDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function structured<T>(value: unknown): T {
  const result = value as { structuredContent?: T; content?: Array<{ type?: string; text?: string }> };
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP_NATIVE_TEST_MISSING_STRUCTURED_RESULT");
  return JSON.parse(text) as T;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Level 2 Full Access over production MCP and Windows Native helper", () => {
  let bridge: Bridge | undefined;
  let client: Client | undefined;
  let previousStateDir: string | undefined;
  let accessToken: string;
  const activeJobIds = new Set<string>();

  beforeAll(async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = makeSystemTempDir("v14-full-access-mcp-state");

    bridge = await startBridge({
      workspaceRoot: projectRoot,
      port: 0,
      persistRuntime: false,
      executionRunner: new WindowsNativeExecutionRunner({ moduleDirectory }),
    });
    setPermission(bridge.workspace.id, "level2");
    expect(readCurrentSessionGrant(bridge.workspace.id)).not.toBeNull();

    accessToken = bridge.authStore.issueTokens({
      clientId: "v14-full-access-native-mcp-client",
      scopes: ["execution.run", "execution.jobs.read", "execution.cancel"],
    }).accessToken;
    client = new Client({ name: "c2c-v14-native-mcp-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${bridge.localBaseUrl()}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } },
    ));
  }, 60_000);

  afterAll(async () => {
    if (client && bridge) {
      for (const jobId of activeJobIds) {
        try {
          await client.callTool({ name: "execution_cancel", arguments: { job_id: jobId } });
        } catch {
          // Bridge shutdown below remains the final owner of any active job.
        }
      }
      await client.close();
    }
    await bridge?.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    // Test state and command fixtures are intentionally retained; no recursive cleanup.
  }, 60_000);

  async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!client) throw new Error("MCP_NATIVE_TEST_CLIENT_UNAVAILABLE");
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    return structured<T>(result);
  }

  async function runProgram(args: string[], cwd: string, key: string, waitSeconds = 20): Promise<RunResult> {
    const result = await call<RunResult>("execution_run", {
      engine: "program",
      executable: process.execPath,
      args,
      cwd,
      timeout_seconds: 60,
      idempotency_key: key,
      wait_seconds: waitSeconds,
    });
    activeJobIds.add(result.job_id);
    return result;
  }

  async function waitForJob(jobId: string, predicate: (job: JobView) => boolean, timeoutMs: number): Promise<JobView> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await call<StatusResult>("execution_status", { job_id: jobId });
      if (status.job && predicate(status.job)) return status.job;
      await delay(25);
    }
    throw new Error(`MCP_NATIVE_TEST_JOB_TIMEOUT:${jobId}`);
  }

  it.skipIf(process.platform !== "win32")("runs an unregistered generic Node command through Full Access", async () => {
    const marker = `FULL_ACCESS_NODE_${randomBytes(8).toString("hex")}`;
    const started = await runProgram(["-e", `process.stdout.write(${JSON.stringify(marker)})`], projectRoot,
      `v14-node-${randomBytes(12).toString("hex")}`);

    expect(started.job.state).toBe("succeeded");
    expect(started.state).toBe("succeeded");
    expect(started.exit_code).toBe(0);
    expect(started.stdout_tail).toContain(marker);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("honors an explicit workspace cwd and runs npm run typecheck through the same tool", async () => {
    const requestedCwd = fs.realpathSync.native(path.join(projectRoot, "tests"));
    const cwdResult = await runProgram(["-e", "process.stdout.write(process.cwd())"], requestedCwd,
      `v14-cwd-${randomBytes(12).toString("hex")}`);
    expect(cwdResult.state).toBe("succeeded");
    expect(cwdResult.exit_code).toBe(0);
    expect(cwdResult.stdout_tail).toBe(requestedCwd);

    const scriptResult = await call<RunResult>("execution_run", {
      engine: "cmd",
      command: "npm run typecheck",
      cwd: projectRoot,
      timeout_seconds: 180,
      idempotency_key: `v14-npm-typecheck-${randomBytes(12).toString("hex")}`,
      wait_seconds: 30,
    });
    activeJobIds.add(scriptResult.job_id);
    expect(scriptResult.state).toBe("succeeded");
    expect(scriptResult.exit_code).toBe(0);
  }, 240_000);

  it.skipIf(process.platform !== "win32")("bounds output and cancels the Native process tree through MCP", async () => {
    const childCode = "setInterval(() => {}, 1000)";
    const parentCode = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' })`,
      `process.stdout.write('pidinfo:' + process.pid + ':' + child.pid + '\\n' + 'x'.repeat(4096))`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const started = await runProgram(["-e", parentCode], projectRoot,
      `v14-long-job-${randomBytes(12).toString("hex")}`, 0);
    const jobId = started.job_id;

    try {
      await waitForJob(jobId, (job) => job.state === "running", 20_000);
      let page: OutputResult | undefined;
      const outputDeadline = Date.now() + 10_000;
      while (Date.now() < outputDeadline) {
        page = await call<OutputResult>("execution_job_output", {
          job_id: jobId,
          stream: "stdout",
          offset: 0,
          max_bytes: 1024,
        });
        if (page.text.includes("pidinfo:")) break;
        await delay(25);
      }
      expect(page?.text).toContain("pidinfo:");
      expect(Buffer.byteLength(page!.text, "utf8")).toBeLessThanOrEqual(1024);
      const pidMatch = page!.text.match(/pidinfo:(\d+):(\d+)/);
      expect(pidMatch).not.toBeNull();
      const pids = [Number(pidMatch![1]), Number(pidMatch![2])];

      const cancellation = await call<{ job: JobView }>("execution_cancel", { job_id: jobId });
      expect(["cancelling", "cancelled"]).toContain(cancellation.job.state);
      const finalJob = await waitForJob(jobId, (job) => job.state === "cancelled", 20_000);
      expect(finalJob.state).toBe("cancelled");

      const processDeadline = Date.now() + 10_000;
      while (pids.some(processExists) && Date.now() < processDeadline) await delay(50);
      expect(pids.map(processExists)).toEqual([false, false]);
    } finally {
      const current = await call<StatusResult>("execution_status", { job_id: jobId });
      if (current.job && ["queued", "running", "cancelling"].includes(current.job.state)) {
        await client!.callTool({ name: "execution_cancel", arguments: { job_id: jobId } });
        await waitForJob(jobId, (job) => job.state === "cancelled", 20_000).catch(() => undefined);
      }
    }
  }, 60_000);
});
