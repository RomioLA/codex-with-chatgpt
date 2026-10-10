import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PackageManager } from "./job-types.js";

export const PINNED_PNPM_VERSION = "11.24.0";

export interface TrustedRuntime {
  nodeExecutable: string;
  managerCli: string;
  managerLibCli: string;
  managerValidateEngines: string;
  managerMainEntry: string;
  managerPackageJson: string;
  managerExitHandler: string;
  managerCore: string;
  nodeFileIdentity: string;
  nodeHash: string;
  managerFileIdentity: string;
  managerHash: string;
  managerLibCliFileIdentity: string;
  managerLibCliHash: string;
  managerValidateEnginesFileIdentity: string;
  managerValidateEnginesHash: string;
  managerMainEntryFileIdentity: string;
  managerMainEntryHash: string;
  managerPackageJsonFileIdentity: string;
  managerPackageJsonHash: string;
  managerExitHandlerFileIdentity: string;
  managerExitHandlerHash: string;
  managerCoreFileIdentity: string;
  managerCoreHash: string;
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

function fileMaterial(file: string): { identity: string; hash: string } {
  const handle = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.dev === 0n || before.ino === 0n) throw new Error("EXECUTABLE_UNAVAILABLE");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const received = fs.readSync(handle, buffer, 0, buffer.byteLength, position);
      if (received === 0) break;
      hash.update(buffer.subarray(0, received));
      position += received;
    }
    const after = fs.fstatSync(handle, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("EXECUTABLE_UNAVAILABLE");
    }
    return {
      identity: `${before.dev.toString(16)}:${before.ino.toString(16)}`,
      hash: hash.digest("hex"),
    };
  } finally {
    fs.closeSync(handle);
  }
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

function trustedNode(nodeInput: string): { file: string; directory: string; identity: string; hash: string } {
  const file = fs.realpathSync.native(nodeInput);
  if (path.basename(file).toLowerCase() !== "node.exe") throw new Error("EXECUTABLE_UNAVAILABLE");
  assertNoReparseComponents(file);
  const material = fileMaterial(file);
  return { file, directory: path.dirname(file), ...material };
}

type ManagerFiles = [string, string, string, string, string, string, string];

function npmFiles(nodeDirectory: string): ManagerFiles {
  const packageDirectory = path.join(nodeDirectory, "node_modules", "npm");
  requirePackageVersion(packageDirectory, "npm");
  return [
    resolveTrustedFile(path.join(packageDirectory, "bin", "npm-cli.js"), nodeDirectory, "npm-cli.js"),
    resolveTrustedFile(path.join(packageDirectory, "lib", "cli.js"), packageDirectory, "cli.js"),
    resolveTrustedFile(path.join(packageDirectory, "lib", "cli", "validate-engines.js"), packageDirectory, "validate-engines.js"),
    resolveTrustedFile(path.join(packageDirectory, "lib", "cli", "entry.js"), packageDirectory, "entry.js"),
    resolveTrustedFile(path.join(packageDirectory, "package.json"), packageDirectory, "package.json"),
    resolveTrustedFile(path.join(packageDirectory, "lib", "cli", "exit-handler.js"), packageDirectory, "exit-handler.js"),
    resolveTrustedFile(path.join(packageDirectory, "lib", "npm.js"), packageDirectory, "npm.js"),
  ];
}

function pnpmFiles(nodeDirectory: string, homeDirectory: string): ManagerFiles {
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
      const cli = resolveTrustedFile(candidate.file, candidate.root, "pnpm.cjs");
      const launcher = resolveTrustedFile(path.join(candidate.packageDirectory, "bin", "pnpm.mjs"), candidate.root, "pnpm.mjs");
      const bundle = resolveTrustedFile(path.join(candidate.packageDirectory, "dist", "pnpm.mjs"), candidate.root, "pnpm.mjs");
      const packageJson = resolveTrustedFile(path.join(candidate.packageDirectory, "package.json"), candidate.root, "package.json");
      return [cli, launcher, bundle, bundle, packageJson, launcher, bundle];
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
    const [cli, libCli, validateEngines, mainEntry, packageJson, exitHandler, core] = packageManager === "npm"
      ? npmFiles(node.directory)
      : pnpmFiles(node.directory, options.homeDirectory ?? os.homedir());
    const [manager, managerLibCli, managerValidateEngines, managerMainEntry] =
      [cli, libCli, validateEngines, mainEntry].map(fileMaterial);
    const [managerPackageJson, managerExitHandler, managerCore] =
      [packageJson, exitHandler, core].map(fileMaterial);
    return {
      nodeExecutable: node.file,
      managerCli: cli,
      managerLibCli: libCli,
      managerValidateEngines: validateEngines,
      managerMainEntry: mainEntry,
      managerPackageJson: packageJson,
      managerExitHandler: exitHandler,
      managerCore: core,
      nodeFileIdentity: node.identity,
      nodeHash: node.hash,
      managerFileIdentity: manager.identity,
      managerHash: manager.hash,
      managerLibCliFileIdentity: managerLibCli.identity,
      managerLibCliHash: managerLibCli.hash,
      managerValidateEnginesFileIdentity: managerValidateEngines.identity,
      managerValidateEnginesHash: managerValidateEngines.hash,
      managerMainEntryFileIdentity: managerMainEntry.identity,
      managerMainEntryHash: managerMainEntry.hash,
      managerPackageJsonFileIdentity: managerPackageJson.identity,
      managerPackageJsonHash: managerPackageJson.hash,
      managerExitHandlerFileIdentity: managerExitHandler.identity,
      managerExitHandlerHash: managerExitHandler.hash,
      managerCoreFileIdentity: managerCore.identity,
      managerCoreHash: managerCore.hash,
    };
  } catch {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
}
