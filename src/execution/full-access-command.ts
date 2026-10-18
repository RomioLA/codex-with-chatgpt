import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FullAccessCommand } from "./job-types.js";

export type FullAccessCommandInput =
  | { engine: "program"; executable: string; args: string[]; cwd: string }
  | { engine: "powershell" | "cmd"; command: string; cwd: string };

interface IdentifiedPath {
  path: string;
  fileIdentity: string;
}

interface IdentifiedFile extends IdentifiedPath {
  hash: string;
}

function normalizedPath(value: string): string {
  return path.win32.normalize(value).toLowerCase();
}

function isBlockedDevicePath(value: string): boolean {
  const normalized = value.replaceAll("/", "\\");
  if (/^(?:\\\\\.\\|\\\?\?\\|\\device\\)/i.test(normalized)) return true;
  const extended = /^\\\\\?\\([^\\]+)/i.exec(normalized)?.[1];
  if (extended && !/^[a-z]:$/i.test(extended) && extended.toUpperCase() !== "UNC") return true;
  return normalized.split("\\").some((component) =>
    /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component)
  );
}

function assertUsablePath(value: string, errorCode: string): void {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.length > 32767) {
    throw new Error(errorCode);
  }
  if (isBlockedDevicePath(value)) throw new Error("DEVICE_PATH_NOT_ALLOWED");
}

function identityOf(stat: fs.BigIntStats): string {
  if (stat.dev === 0n || stat.ino === 0n) throw new Error("PATH_IDENTITY_UNAVAILABLE");
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

async function identifyDirectory(inputPath: string, workspaceRoot: string): Promise<IdentifiedPath> {
  assertUsablePath(inputPath, "INVALID_CWD");
  if (/^[a-z]:[^\\/]/i.test(inputPath)) throw new Error("INVALID_CWD");
  const candidate = path.win32.isAbsolute(inputPath)
    ? inputPath
    : path.win32.resolve(workspaceRoot, inputPath);
  assertUsablePath(candidate, "INVALID_CWD");
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(candidate);
    const stat = await fs.promises.lstat(canonical, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("INVALID_CWD");
    return { path: canonical, fileIdentity: identityOf(stat) };
  } catch (error) {
    if (error instanceof Error && error.message === "DEVICE_PATH_NOT_ALLOWED") throw error;
    if (error instanceof Error && error.message === "PATH_IDENTITY_UNAVAILABLE") throw error;
    throw new Error("INVALID_CWD", { cause: error });
  }
}

async function identifyExecutable(inputPath: string): Promise<IdentifiedFile> {
  assertUsablePath(inputPath, "INVALID_EXECUTABLE");
  let canonical: string;
  try {
    canonical = await fs.promises.realpath(inputPath);
  } catch (error) {
    throw new Error("EXECUTABLE_NOT_FOUND", { cause: error });
  }
  assertUsablePath(canonical, "INVALID_EXECUTABLE");
  const initialStat = await fs.promises.lstat(canonical, { bigint: true }).catch((error) => {
    throw new Error("EXECUTABLE_NOT_FOUND", { cause: error });
  });
  if (initialStat.isDirectory()) throw new Error("EXECUTABLE_IS_DIRECTORY");
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) throw new Error("INVALID_EXECUTABLE");

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(canonical, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "EACCES" || code === "EPERM" ? "EXECUTABLE_ACCESS_DENIED" : "EXECUTABLE_NOT_FOUND", { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (before.isDirectory()) throw new Error("EXECUTABLE_IS_DIRECTORY");
    if (!before.isFile()) throw new Error("INVALID_EXECUTABLE");
    const fileIdentity = identityOf(before);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathStat = await fs.promises.lstat(canonical, { bigint: true });
    const currentPath = await fs.promises.realpath(inputPath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
        normalizedPath(currentPath) !== normalizedPath(canonical) ||
        fileIdentity !== identityOf(after) || fileIdentity !== identityOf(pathStat) ||
        before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs || after.size !== BigInt(position)) {
      throw new Error("EXECUTION_MATERIAL_CHANGED");
    }
    return { path: canonical, fileIdentity, hash: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

function executableCandidates(name: string): string[] {
  const extension = path.win32.extname(name).toLowerCase();
  if (extension === ".bat" || extension === ".cmd") throw new Error("PROGRAM_REQUIRES_EXECUTABLE");
  if (extension && extension !== ".exe" && extension !== ".com") throw new Error("PROGRAM_REQUIRES_EXECUTABLE");
  return extension ? [name] : [`${name}.exe`, `${name}.com`];
}

async function resolveProgramExecutable(name: string, cwd: string): Promise<IdentifiedFile> {
  assertUsablePath(name, "INVALID_EXECUTABLE");
  if (/^[a-z]:[^\\/]/i.test(name)) throw new Error("INVALID_EXECUTABLE");
  const pathLike = path.win32.isAbsolute(name) || /[\\/]/.test(name);
  const names = executableCandidates(name);
  const folders = pathLike
    ? [path.win32.isAbsolute(name) ? "" : cwd]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).slice(0, 1024)
      .map((entry) => entry.replace(/^"(.*)"$/, "$1"));

  for (const folder of folders) {
    for (const candidateName of names) {
      const candidate = pathLike
        ? (path.win32.isAbsolute(name) ? candidateName : path.win32.resolve(folder, candidateName))
        : path.win32.resolve(folder, candidateName);
      try {
        return await identifyExecutable(candidate);
      } catch (error) {
        if (pathLike && error instanceof Error && error.message === "EXECUTABLE_IS_DIRECTORY") throw error;
        if (pathLike && error instanceof Error && error.message === "DEVICE_PATH_NOT_ALLOWED") throw error;
      }
    }
  }
  throw new Error("EXECUTABLE_NOT_FOUND");
}

function commandProcessorPath(): string {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.win32.join(windowsRoot, "System32", "cmd.exe");
}

function powerShellCandidates(): string[] {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return [
    path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe"),
    // Match the established C2C Host Observation resolver when PS7 is bundled with Codex Desktop.
    path.win32.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe"),
  ];
}

async function resolveEngineExecutable(engine: "powershell" | "cmd"): Promise<IdentifiedFile> {
  const candidates = engine === "cmd" ? [commandProcessorPath()] : powerShellCandidates();
  for (const candidate of candidates) {
    try { return await identifyExecutable(candidate); } catch { /* try the next established system candidate */ }
  }
  throw new Error(engine === "cmd" ? "CMD_NOT_FOUND" : "POWERSHELL_NOT_FOUND");
}

export async function resolveFullAccessCommand(input: FullAccessCommandInput, workspaceRoot: string): Promise<FullAccessCommand> {
  const cwd = await identifyDirectory(input.cwd, workspaceRoot);
  const executable = input.engine === "program"
    ? await resolveProgramExecutable(input.executable, cwd.path)
    : await resolveEngineExecutable(input.engine);

  if (input.engine === "program") {
    if (!Array.isArray(input.args) || input.args.length > 256 || input.args.some((arg) =>
      typeof arg !== "string" || arg.includes("\0") || arg.length > 32767)) {
      throw new Error("INVALID_ARGUMENTS");
    }
    return {
      engine: "program",
      executable: executable.path,
      executableFileIdentity: executable.fileIdentity,
      executableHash: executable.hash,
      args: [...input.args],
      cwd: cwd.path,
      cwdFileIdentity: cwd.fileIdentity,
    };
  }
  if (typeof input.command !== "string" || input.command.length === 0 || input.command.length > 32767 || input.command.includes("\0")) {
    throw new Error("INVALID_ARGUMENTS");
  }
  return {
    engine: input.engine,
    executable: executable.path,
    executableFileIdentity: executable.fileIdentity,
    executableHash: executable.hash,
    command: input.command,
    cwd: cwd.path,
    cwdFileIdentity: cwd.fileIdentity,
  };
}

export async function verifyFullAccessCommand(command: FullAccessCommand): Promise<void> {
  const cwd = await identifyDirectory(command.cwd, command.cwd);
  if (normalizedPath(cwd.path) !== normalizedPath(command.cwd) || cwd.fileIdentity !== command.cwdFileIdentity) {
    throw new Error("EXECUTION_MATERIAL_CHANGED");
  }
  const executable = await identifyExecutable(command.executable);
  if (normalizedPath(executable.path) !== normalizedPath(command.executable) ||
      executable.fileIdentity !== command.executableFileIdentity || executable.hash !== command.executableHash) {
    throw new Error("EXECUTION_MATERIAL_CHANGED");
  }
  if (command.engine === "program") {
    if (command.args.length > 256 || command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
      throw new Error("INVALID_ARGUMENTS");
    }
  } else if (command.command.length === 0 || command.command.length > 32767 || command.command.includes("\0")) {
    throw new Error("INVALID_ARGUMENTS");
  }
}
