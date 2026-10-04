import { isPermissionMode, type PermissionMode } from "./mode.js";

const PERMISSION_LOCATIONS = ["workspace", "outside"] as const;
export type PermissionLocation = (typeof PERMISSION_LOCATIONS)[number];

const PERMISSION_OPERATIONS = ["read", "write", "delete"] as const;
export type PermissionOperation = (typeof PERMISSION_OPERATIONS)[number];

export interface PermissionCheckInput {
  mode: PermissionMode;
  location: PermissionLocation;
  operation: PermissionOperation;
}

export interface MovePermissionCheckInput {
  mode: PermissionMode;
  sourceLocation: PermissionLocation;
  destinationLocation: PermissionLocation;
}

type PolicyMatrix = Record<
  PermissionMode,
  Record<PermissionLocation, Record<PermissionOperation, boolean>>
>;

/** The sole authority for file permission decisions. */
const PERMISSION_POLICY: PolicyMatrix = {
  readonly: {
    workspace: { read: true, write: false, delete: false },
    outside: { read: false, write: false, delete: false },
  },
  level1: {
    workspace: { read: true, write: true, delete: false },
    outside: { read: true, write: false, delete: false },
  },
  level2: {
    workspace: { read: true, write: true, delete: true },
    outside: { read: true, write: true, delete: false },
  },
};

function isPermissionLocation(value: unknown): value is PermissionLocation {
  return typeof value === "string" && (PERMISSION_LOCATIONS as readonly string[]).includes(value);
}

function isPermissionOperation(value: unknown): value is PermissionOperation {
  return typeof value === "string" && (PERMISSION_OPERATIONS as readonly string[]).includes(value);
}

/** Unknown or malformed input fails closed. */
export function checkPermission(input: PermissionCheckInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!isPermissionMode(input.mode)) return false;
  if (!isPermissionLocation(input.location)) return false;
  if (!isPermissionOperation(input.operation)) return false;
  return PERMISSION_POLICY[input.mode][input.location][input.operation];
}

/** Moves are allowed only between workspace locations in writable modes. */
export function checkMovePermission(input: MovePermissionCheckInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (!isPermissionMode(input.mode)) return false;
  if (!isPermissionLocation(input.sourceLocation)) return false;
  if (!isPermissionLocation(input.destinationLocation)) return false;

  return (
    input.mode !== "readonly" &&
    input.sourceLocation === "workspace" &&
    input.destinationLocation === "workspace"
  );
}
