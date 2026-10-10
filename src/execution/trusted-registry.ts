import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, ensureDir, readJsonIfExists } from "../config/paths.js";
import type { ExecutionKind, PackageManager } from "./job-types.js";

const REGISTRY_VERSION = 1;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface TrustedCommand {
  workspaceId: string;
  repositoryIdentity: string;
  canonicalRepositoryPath: string;
  kind: ExecutionKind;
  target: string;
  packageManager: PackageManager;
  scriptHash: string;
  packageJsonHash: string;
  approvedAt: string;
  approvalSource: "local-cli";
}

interface TrustedRegistry {
  version: number;
  workspaceId: string;
  commands: TrustedCommand[];
}

export class CommandNotApprovedError extends Error {
  readonly code = "COMMAND_NOT_APPROVED";
  constructor() {
    super("COMMAND_NOT_APPROVED");
    this.name = "CommandNotApprovedError";
  }
}

function registryFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "execution", "trusted-commands")), `${workspaceId}.json`);
}

function validKindTarget(kind: ExecutionKind, target: string): boolean {
  if (!TARGET_PATTERN.test(target)) return false;
  if (kind === "test" || kind === "build" || kind === "lint" || kind === "typecheck") return target === kind;
  return kind === "package_script";
}

interface PackageExecutionMaterial {
  script: string;
  packageJsonHash: string;
}

function readPackageExecutionMaterial(canonicalRepositoryPath: string, target: string): PackageExecutionMaterial {
  if (!TARGET_PATTERN.test(target)) throw new CommandNotApprovedError();
  const manifest = path.join(canonicalRepositoryPath, "package.json");
  try {
    if (fs.lstatSync(manifest).isSymbolicLink()) throw new CommandNotApprovedError();
    if (fs.realpathSync.native(manifest) !== manifest) throw new CommandNotApprovedError();
    const bytes = fs.readFileSync(manifest);
    const root = JSON.parse(bytes.toString("utf8")) as { scripts?: unknown };
    if (!root.scripts || typeof root.scripts !== "object" || Array.isArray(root.scripts)) {
      throw new CommandNotApprovedError();
    }
    const script = (root.scripts as Record<string, unknown>)[target];
    if (typeof script !== "string" || script.trim() === "") throw new CommandNotApprovedError();
    return {
      script,
      packageJsonHash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof CommandNotApprovedError) throw error;
    throw new CommandNotApprovedError();
  }
}

function readPackageScript(canonicalRepositoryPath: string, target: string): string {
  return readPackageExecutionMaterial(canonicalRepositoryPath, target).script;
}

export function readPackageScriptForApproval(canonicalRepositoryPath: string, target: string): string {
  return readPackageScript(canonicalRepositoryPath, target);
}

function scriptHash(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

function readRegistry(workspaceId: string): TrustedRegistry {
  const value = readJsonIfExists<unknown>(registryFile(workspaceId));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: REGISTRY_VERSION, workspaceId, commands: [] };
  }
  const registry = value as Partial<TrustedRegistry>;
  if (
    registry.version !== REGISTRY_VERSION ||
    registry.workspaceId !== workspaceId ||
    !Array.isArray(registry.commands)
  ) {
    return { version: REGISTRY_VERSION, workspaceId, commands: [] };
  }
  return registry as TrustedRegistry;
}

function writeRegistry(file: string, registry: TrustedRegistry): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* best effort on Windows */
  }
  fs.renameSync(temporary, file);
}

/** Local CLI only. This API is intentionally not registered as an MCP tool. */
export function approveTrustedCommand(input: {
  workspaceId: string;
  repositoryIdentity: string;
  canonicalRepositoryPath: string;
  kind: ExecutionKind;
  target: string;
  packageManager: PackageManager;
  localApproval: true;
}): TrustedCommand {
  if (input.localApproval !== true || !validKindTarget(input.kind, input.target)) {
    throw new CommandNotApprovedError();
  }
  if (input.packageManager !== "npm" && input.packageManager !== "pnpm") throw new CommandNotApprovedError();
  const material = readPackageExecutionMaterial(input.canonicalRepositoryPath, input.target);
  const currentScriptHash = scriptHash(material.script);
  const entry: TrustedCommand = {
    workspaceId: input.workspaceId,
    repositoryIdentity: input.repositoryIdentity,
    canonicalRepositoryPath: input.canonicalRepositoryPath,
    kind: input.kind,
    target: input.target,
    packageManager: input.packageManager,
    scriptHash: currentScriptHash,
    packageJsonHash: material.packageJsonHash,
    approvedAt: new Date().toISOString(),
    approvalSource: "local-cli",
  };
  const file = registryFile(input.workspaceId);
  const registry = readRegistry(input.workspaceId);
  registry.commands = registry.commands.filter((item) =>
    !(item.repositoryIdentity === entry.repositoryIdentity && item.kind === entry.kind && item.target === entry.target)
  );
  registry.commands.push(entry);
  writeRegistry(file, registry);
  return entry;
}

export function listTrustedCommands(workspaceId: string): TrustedCommand[] {
  return [...readRegistry(workspaceId).commands];
}

export function revokeTrustedCommand(input: {
  workspaceId: string;
  repositoryIdentity: string;
  kind: ExecutionKind;
  target: string;
}): boolean {
  const file = registryFile(input.workspaceId);
  const registry = readRegistry(input.workspaceId);
  const before = registry.commands.length;
  registry.commands = registry.commands.filter((item) => !(
    item.workspaceId === input.workspaceId &&
    item.repositoryIdentity === input.repositoryIdentity &&
    item.kind === input.kind &&
    item.target === input.target
  ));
  if (registry.commands.length === before) return false;
  writeRegistry(file, registry);
  return true;
}

export function findTrustedCommand(input: {
  workspaceId: string;
  repositoryIdentity: string;
  canonicalRepositoryPath: string;
  kind: ExecutionKind;
  target: string;
}): TrustedCommand {
  if (!validKindTarget(input.kind, input.target)) throw new CommandNotApprovedError();
  const entry = readRegistry(input.workspaceId).commands.find((item) =>
    item.workspaceId === input.workspaceId &&
    item.repositoryIdentity === input.repositoryIdentity &&
    item.canonicalRepositoryPath === input.canonicalRepositoryPath &&
    item.kind === input.kind &&
    item.target === input.target &&
    item.approvalSource === "local-cli"
  );
  if (!entry) throw new CommandNotApprovedError();
  const material = readPackageExecutionMaterial(input.canonicalRepositoryPath, input.target);
  if (scriptHash(material.script) !== entry.scriptHash || material.packageJsonHash !== entry.packageJsonHash) {
    throw new CommandNotApprovedError();
  }
  return entry;
}
