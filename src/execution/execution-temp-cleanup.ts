import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionTempLease } from "./execution-temp.js";
import { resolveExecutionHelperPath } from "./native-runner.js";
import { serializeTempCleanupRequest } from "./helper-protocol.js";

/** Invoke only the fixed helper's identity-bound execution-temp cleanup operation. */
export function runExecutionTempCleanup(
  lease: ExecutionTempLease,
  trustedStoreDirectory: string,
  onDiagnostic?: (message: string) => void,
): boolean {
  if (process.platform !== "win32") {
    onDiagnostic?.("Execution temp cleanup requires the Windows native primitive.");
    return false;
  }
  let canonicalStoreDirectory: string;
  let stateRoot: string;
  try {
    canonicalStoreDirectory = fs.realpathSync.native(trustedStoreDirectory);
    stateRoot = fs.realpathSync.native(path.resolve(canonicalStoreDirectory, "..", ".."));
  } catch {
    onDiagnostic?.("Execution temp cleanup rejected an unavailable trusted store directory.");
    return false;
  }
  const expectedStoreDirectory = path.join(stateRoot, "execution-jobs", lease.workspaceId);
  const expectedRoot = path.join(canonicalStoreDirectory, "execution-temp");
  if (path.resolve(canonicalStoreDirectory).toLowerCase() !== path.resolve(expectedStoreDirectory).toLowerCase() ||
      path.resolve(lease.rootPath).toLowerCase() !== path.resolve(expectedRoot).toLowerCase()) {
    onDiagnostic?.("Execution temp cleanup rejected a root outside the fixed state-directory layout.");
    return false;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    const helperPath = resolveExecutionHelperPath();
    const input = serializeTempCleanupRequest(lease);
    result = spawnSync(helperPath, ["--cleanup-temp"], {
      input,
      env: { ...process.env, C2C_STATE_DIR: stateRoot },
      windowsHide: true,
      shell: false,
      timeout: 30_000,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (error) {
    onDiagnostic?.(`Execution temp cleanup request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return false;
  }
  if (result.error) onDiagnostic?.(`Execution temp cleanup helper failed to start: ${result.error.message}`);
  else if (result.status !== 0) {
    const message = result.stderr.toString("utf8").trim();
    onDiagnostic?.(message || `Execution temp cleanup helper exited with status ${String(result.status)}.`);
  }
  return !result.error && result.status === 0;
}
