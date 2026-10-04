import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { isPermissionMode, type PermissionMode } from "./mode.js";

const PERMISSION_STATE_VERSION = 1;
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{12}$/;

interface PersistedPermission {
  version: number;
  workspaceId: string;
  mode: PermissionMode;
  updatedAt: string;
}

function permissionFile(workspaceId: string): string {
  return path.join(getStateDir(), "permissions", `${workspaceId}.json`);
}

function isWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value);
}

/**
 * Read this workspace's local permission mode. Missing, malformed, mismatched,
 * or future-version state always falls back to readonly.
 */
export function readPermission(workspaceId: string): PermissionMode {
  if (!isWorkspaceId(workspaceId)) return "readonly";

  const value = readJsonIfExists<unknown>(permissionFile(workspaceId));
  if (!value || typeof value !== "object" || Array.isArray(value)) return "readonly";

  const state = value as Partial<PersistedPermission>;
  if (state.version !== PERMISSION_STATE_VERSION) return "readonly";
  if (state.workspaceId !== workspaceId) return "readonly";
  if (!isPermissionMode(state.mode)) return "readonly";
  if (typeof state.updatedAt !== "string") return "readonly";
  return state.mode;
}

/** Local control-plane mutation. Do not expose this as an MCP tool. */
export function setPermission(workspaceId: string, mode: PermissionMode): PermissionMode {
  if (!isWorkspaceId(workspaceId)) throw new TypeError("Invalid workspaceId");
  if (!isPermissionMode(mode)) throw new TypeError("Invalid permission mode");

  const state: PersistedPermission = {
    version: PERMISSION_STATE_VERSION,
    workspaceId,
    mode,
    updatedAt: new Date().toISOString(),
  };
  writeSecureJson(permissionFile(workspaceId), state);
  return mode;
}
