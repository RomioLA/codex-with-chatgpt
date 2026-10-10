import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PackageManager } from "./job-types.js";

export const PINNED_PNPM_VERSION = "11.24.0";

export interface TrustedRuntime {
  nodeExecutable: string;
  managerCli: string;
  nodeFileIdentity: string;
  managerFileIdentity: string;
  managerHash: string;
}

export interface RuntimeDiscoveryOptions {
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
  homeDirectory?: string;
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileIdentity(file: string): string {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile() || stat.dev === 0n || stat.ino === 0n) throw new Error("EXECUTABLE_UNAVAILABLE");
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function assertNoReparseComponents(file: string): void {
  const absolute = path.resolve(file);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  if (normalized(fs.realpathSync.native(absolute)) !== normalized(absolute)) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
}

function requirePackageVersion(directory: string, packageName: string, version?: string): void {
  const packageFile = path.join(directory, "package.json");
  assertNoReparseComponents(packageFile);
  const value = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { name?: unknown; version?: unknown };
  if (value.name !== packageName || typeof value.version !== "string" ||
      (version !== undefined && value.version !== version)) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
}

function resolveTrustedFile(candidate: string, allowedRoot: string, expectedName: string): string {
  const absoluteRoot = path.resolve(allowedRoot);
  const absoluteCandidate = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absoluteCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  assertNoReparseComponents(absoluteCandidate);
  const stat = fs.lstatSync(absoluteCandidate);
  if (!stat.isFile() || stat.isSymbolicLink() ||
      path.basename(absoluteCandidate).toLowerCase() !== expectedName.toLowerCase()) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  return fs.realpathSync.native(absoluteCandidate);
}

function trustedNode(nodeInput: string): { file: string; directory: string; identity: string } {
  const file = fs.realpathSync.native(nodeInput);
  if (path.basename(file).toLowerCase() !== "node.exe") throw new Error("EXECUTABLE_UNAVAILABLE");
  assertNoReparseComponents(file);
  const identity = fileIdentity(file);
  return { file, directory: path.dirname(file), identity };
}

function npmCli(nodeDirectory: string): string {
  const packageDirectory = path.join(nodeDirectory, "node_modules", "npm");
  requirePackageVersion(packageDirectory, "npm");
  return resolveTrustedFile(path.join(packageDirectory, "bin", "npm-cli.js"), nodeDirectory, "npm-cli.js");
}

function pnpmCli(nodeDirectory: string, homeDirectory: string): string {
  const candidates = [
    {
      file: path.join(nodeDirectory, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      packageDirectory: path.join(nodeDirectory, "node_modules", "pnpm"),
      root: nodeDirectory,
    },
    {
      file: path.join(homeDirectory, "AppData", "Local", "node", "corepack", "v1", "pnpm", PINNED_PNPM_VERSION, "bin", "pnpm.cjs"),
      packageDirectory: path.join(homeDirectory, "AppData", "Local", "node", "corepack", "v1", "pnpm", PINNED_PNPM_VERSION),
      root: path.join(homeDirectory, "AppData", "Local", "node", "corepack", "v1", "pnpm", PINNED_PNPM_VERSION),
    },
  ];
  for (const candidate of candidates) {
    try {
      requirePackageVersion(candidate.packageDirectory, "pnpm", PINNED_PNPM_VERSION);
      return resolveTrustedFile(candidate.file, candidate.root, "pnpm.cjs");
    } catch {
      /* try only the next fixed, version-pinned runtime location */
    }
  }
  throw new Error("EXECUTABLE_UNAVAILABLE");
}

/**
 * Selects only the active Node runtime's fixed npm/pnpm package location or
 * the exact pinned Corepack pnpm location. It never searches PATH, the
 * workspace, or a repository-local node_modules directory.
 */
export function resolveTrustedRuntime(
  packageManager: PackageManager,
  options: RuntimeDiscoveryOptions = {},
): TrustedRuntime {
  if ((options.platform ?? process.platform) !== "win32") throw new Error("EXECUTABLE_UNAVAILABLE");
  try {
    const node = trustedNode(options.nodeExecutable ?? process.execPath);
    const cli = packageManager === "npm"
      ? npmCli(node.directory)
      : pnpmCli(node.directory, options.homeDirectory ?? os.homedir());
    return {
      nodeExecutable: node.file,
      managerCli: cli,
      nodeFileIdentity: node.identity,
      managerFileIdentity: fileIdentity(cli),
      managerHash: createHash("sha256").update(fs.readFileSync(cli)).digest("hex"),
    };
  } catch {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
}
