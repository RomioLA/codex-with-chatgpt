import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { ensureDir, getStateDir } from "../config/paths.js";
import { observeBridgeProcessOwner } from "../process/bridge-process-identity.js";

const RECOVERY_PORT_START = 49_152;
const RECOVERY_PORT_COUNT = 16_384;

export interface BridgeInstanceLock {
  release(): Promise<void>;
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
}

interface StateLockRecord {
  version: 1;
  workspaceId: string;
  pid: number;
  token: string;
  createdAt: string;
}

export type BridgeInstanceLockStatus =
  | "missing"
  | "live_pid_unverified"
  | "stale"
  | "unknown";

const localLockOwners = new Map<string, string>();

function lockKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** The per-workspace owner record always lives beneath the active state root. */
export function bridgeInstanceLockFile(workspaceId: string): string {
  if (!/^[a-f0-9]{12}$/i.test(workspaceId)) throw new TypeError("Invalid workspaceId");
  return path.join(getStateDir(), "bridge-instances", `${workspaceId.toLowerCase()}.lock`);
}

function isStateLockRecord(value: unknown, workspaceId: string): value is StateLockRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StateLockRecord>;
  return record.version === 1 &&
    record.workspaceId === workspaceId &&
    Number.isInteger(record.pid) && Number(record.pid) > 0 &&
    typeof record.token === "string" && /^[a-f0-9]{32}$/i.test(record.token) &&
    typeof record.createdAt === "string";
}

function readStateLock(file: string, workspaceId: string): StateLockRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read the Bridge instance lock; refusing to start another Bridge.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("The Bridge instance lock is malformed; refusing to start another Bridge.");
  }
  if (!isStateLockRecord(value, workspaceId)) {
    throw new Error("The Bridge instance lock cannot be verified; refusing to start another Bridge.");
  }
  return value;
}

function processPresence(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

function isLocallyOwnedLock(file: string, record: StateLockRecord): boolean {
  return record.pid === process.pid && localLockOwners.get(lockKey(file)) === record.token;
}

async function canRecoverLockOwner(
  file: string,
  record: StateLockRecord,
  workspaceRoot: string,
): Promise<boolean> {
  const presence = processPresence(record.pid);
  if (presence === "dead") return true;
  if (presence !== "alive" || isLocallyOwnedLock(file, record)) return false;
  const owner = await observeBridgeProcessOwner(record.pid, workspaceRoot);
  return owner === "unrelated";
}

/**
 * A live PID only blocks a new start; it never proves that PID owns a Bridge.
 * Callers may use this for a fast fail-closed check before spawning a daemon.
 */
export async function inspectBridgeInstanceLock(workspaceId: string, workspaceRoot: string): Promise<BridgeInstanceLockStatus> {
  const file = bridgeInstanceLockFile(workspaceId);
  let record: StateLockRecord | null;
  try {
    record = readStateLock(file, workspaceId);
  } catch {
    return "unknown";
  }
  if (!record) return "missing";
  const presence = processPresence(record.pid);
  if (presence === "dead") return "stale";
  if (presence === "unknown") return "unknown";
  return await canRecoverLockOwner(file, record, workspaceRoot) ? "stale" : "live_pid_unverified";
}

function writeNewStateLock(tempFile: string, record: StateLockRecord): void {
  const fd = fs.openSync(tempFile, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tempFile, 0o600);
  } catch {
    // Some Windows filesystems do not expose POSIX permission bits.
  }
}

/**
 * Serialize stale-lock recovery. If recovery itself is already in progress,
 * fail closed; never remove a possibly fresh lock based on a stale read.
 */
async function recoverDeadOwner(
  file: string,
  workspaceId: string,
  workspaceRoot: string,
  observed: StateLockRecord,
): Promise<void> {
  const digest = createHash("sha256").update(`c2c-bridge-lock-recovery:${workspaceId}`).digest();
  const recoveryPort = RECOVERY_PORT_START + (digest.readUInt32BE(0) % RECOVERY_PORT_COUNT);
  const recoveryServer = net.createServer();
  try {
    // This socket only serializes stale-file recovery and is released by the
    // OS after a crash. The state-root file remains the Bridge authority.
    await listen(recoveryServer, recoveryPort);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error("Cannot serialize Bridge lock recovery; refusing to start another Bridge.");
    }
    throw error;
  }

  try {
    const current = readStateLock(file, workspaceId);
    if (!current || current.token !== observed.token) return;
    if (!await canRecoverLockOwner(file, current, workspaceRoot)) {
      throw new Error("The Bridge instance lock owner cannot be safely verified; refusing to start another Bridge.");
    }
    const latest = readStateLock(file, workspaceId);
    if (!latest || latest.token !== current.token || latest.pid !== current.pid) return;
    fs.unlinkSync(file);
  } finally {
    await new Promise<void>((resolve) => recoveryServer.close(() => resolve()));
  }
}

/**
 * Atomically publish one per-workspace lock file under getStateDir(). The
 * filesystem record is the authority; ports are never scanned to acquire it.
 */
export async function acquireBridgeInstanceLock(workspaceId: string, workspaceRoot: string): Promise<BridgeInstanceLock> {
  if (!/^[a-f0-9]{12}$/i.test(workspaceId)) throw new TypeError("Invalid workspaceId");
  const normalizedWorkspaceId = workspaceId.toLowerCase();
  const file = bridgeInstanceLockFile(normalizedWorkspaceId);
  ensureDir(path.dirname(file));

  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomBytes(16).toString("hex");
    const record: StateLockRecord = {
      version: 1,
      workspaceId: normalizedWorkspaceId,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
    };
    const tempFile = `${file}.${process.pid}.${token}.tmp`;
    writeNewStateLock(tempFile, record);
    try {
      try {
        // link() gives an atomic no-replace publish on the same filesystem.
        fs.linkSync(tempFile, file);
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // The published lock remains authoritative if only temp cleanup fails.
        }
        localLockOwners.set(lockKey(file), token);
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            try {
              const current = readStateLock(file, normalizedWorkspaceId);
              if (current?.token === token && current.pid === process.pid) {
                fs.unlinkSync(file);
              }
            } finally {
              if (localLockOwners.get(lockKey(file)) === token) localLockOwners.delete(lockKey(file));
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // It may have been removed after publication or be unavailable.
      }
    }

    const existing = readStateLock(file, normalizedWorkspaceId);
    if (!existing) continue;
    const presence = processPresence(existing.pid);
    if (presence === "unknown") {
      throw new Error("The Bridge instance lock owner cannot be verified; refusing to start another Bridge.");
    }
    if (!await canRecoverLockOwner(file, existing, workspaceRoot)) {
      if (presence === "alive") {
        throw new Error("A Bridge instance lock has a live but unverified PID; refusing to start another Bridge.");
      }
      throw new Error("The Bridge instance lock owner cannot be verified; refusing to start another Bridge.");
    }
    await recoverDeadOwner(file, normalizedWorkspaceId, workspaceRoot, existing);
  }

  throw new Error("Unable to acquire the per-workspace Bridge instance lock.");
}
