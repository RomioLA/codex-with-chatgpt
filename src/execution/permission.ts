import type { PermissionMode } from "../permission/mode.js";

export type ExecutionAction = "start" | "read" | "cancel";

export interface ExecutionPermissionInput {
  mode: PermissionMode;
  scopes: readonly string[];
  action: ExecutionAction;
  hasTrustedCommand?: boolean;
}

const REQUIRED_SCOPE: Record<ExecutionAction, string> = {
  start: "execution.run",
  read: "execution.jobs.read",
  cancel: "execution.cancel",
};

/** Execution permission is independent from file permission and fails closed. */
export function checkExecutionPermission(input: ExecutionPermissionInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!(input.mode === "readonly" || input.mode === "level1" || input.mode === "level2")) return false;
  if (!Array.isArray(input.scopes) || !input.scopes.includes(REQUIRED_SCOPE[input.action])) return false;
  if (input.action === "start") {
    return input.mode !== "readonly" && input.hasTrustedCommand === true;
  }
  // Read and cancel must remain available after a local downgrade so a client
  // can observe and coordinate already-created jobs.
  return true;
}
