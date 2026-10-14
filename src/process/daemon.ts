import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { findBridgeObservation, findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { inspectBridgeInstanceLock } from "../bridge/instance-lock.js";
import { Workspace } from "../workspace/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

interface AdminIdentity {
  service?: unknown;
  workspaceId?: unknown;
  workspaceRoot?: unknown;
  pid?: unknown;
  port?: unknown;
  startedAt?: unknown;
}

export class BridgeAdminIdentityError extends Error {
  constructor() {
    super("Bridge admin authentication or identity mismatch; refusing to reuse the runtime.");
    this.name = "BridgeAdminIdentityError";
  }
}

/** Returns false only for transient transport failures; identity failures are terminal. */
async function verifyAdminReady(runtime: RuntimeState, workspace: Workspace): Promise<boolean> {
  let info: AdminIdentity;
  try {
    info = await adminFetch<AdminIdentity>(runtime, "GET", "/admin/info", 1500);
  } catch (error) {
    const status = (error as Error & { httpStatus?: number }).httpStatus;
    if (status === 401 || status === 403 || status === 404) {
      throw new BridgeAdminIdentityError();
    }
    const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
    const code = (error as NodeJS.ErrnoException).code ?? cause?.code;
    if (code && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return false;
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) return false;
    throw error;
  }
  const sameRoot = typeof info?.workspaceRoot === "string" &&
    (process.platform === "win32"
      ? path.resolve(info.workspaceRoot).toLowerCase() === path.resolve(workspace.root).toLowerCase()
      : path.resolve(info.workspaceRoot) === path.resolve(workspace.root));
  if (
    info?.service !== runtime.service ||
    info.workspaceId !== workspace.id ||
    !sameRoot ||
    info.pid !== runtime.pid ||
    info.port !== runtime.port ||
    info.startedAt !== runtime.startedAt
  ) {
    throw new BridgeAdminIdentityError();
  }
  return true;
}

/** Retry only transport-level admin unavailability, not authentication or identity failures. */
async function waitForExistingAdminReady(runtime: RuntimeState, workspace: Workspace): Promise<void> {
  const deadline = Date.now() + 4_000;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await verifyAdminReady(runtime, workspace)) return;
    if (attempt === 5 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    const observed = await findBridgeObservation(workspace.id);
    if (
      observed.state !== "healthy" ||
      observed.runtime.pid !== runtime.pid ||
      observed.runtime.port !== runtime.port ||
      observed.runtime.startedAt !== runtime.startedAt ||
      observed.runtime.adminToken !== runtime.adminToken
    ) {
      throw new BridgeAdminIdentityError();
    }
  }
  throw new Error("Existing Bridge admin interface did not become ready within the bounded retry window.");
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") {
    await waitForExistingAdminReady(observation.runtime, workspace);
    return { runtime: observation.runtime, spawned: false };
  }
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }
  const lockStatus = inspectBridgeInstanceLock(workspace.id);
  if (lockStatus === "live_pid_unverified" || lockStatus === "unknown") {
    throw new Error("Bridge instance lock is present but its owner cannot be verified; refusing to start another bridge.");
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    [...args, "serve", "--workspace", workspace.root, ...(opts.port !== undefined ? ["--port", String(opts.port)] : [])],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
      windowsHide: true,
    }
  );
  const spawnedPid = child.pid;
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    // During startup the new listener can briefly answer /health while the
    // runtime file still contains the previous Bridge identity. Only accept
    // the runtime published by the child we just spawned.
    if (runtime && spawnedPid !== undefined && runtime.pid === spawnedPid) {
      if (await verifyAdminReady(runtime, workspace)) return { runtime, spawned: true };
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      const concurrentStartDeadline = Date.now() + 2000;
      while (Date.now() < concurrentStartDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const concurrentRuntime = await findLiveBridge(workspace.id);
        if (concurrentRuntime && await verifyAdminReady(concurrentRuntime, workspace)) {
          return { runtime: concurrentRuntime, spawned: false };
        }
      }
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      const failure = new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
      Object.assign(failure, { httpStatus: response.status });
      throw failure;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  const healthy = await probeBridge(runtime.port);
  if (healthy && healthy.workspaceId === workspace.id) {
    try {
      await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
      return true;
    } catch {
      // fall through to kill
    }
  }
  // A PID alone is not proof of Bridge ownership. If health and the authenticated
  // admin shutdown path both fail, do not signal a possibly reused PID.
  return false;
}
