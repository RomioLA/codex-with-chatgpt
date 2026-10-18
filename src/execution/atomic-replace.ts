import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export interface AtomicReplaceOptions {
  /** Use the fixed native FileRenameInfoEx operation and preserve target metadata. */
  preserveAcl?: boolean;
  /** Hash captured before the replacement file was prepared. */
  expectedHash?: string;
  /** File identity captured from the same handle used to read the original bytes. */
  expectedIdentity?: { dev: string; ino: string };
  /** Hash of the complete replacement bytes, computed in memory before publication. */
  expectedNewHash?: string;
}

export interface AtomicReplaceTimings {
  finalValidationMs: number;
  atomicReplaceMs: number;
  postVerificationMs: number;
}

export interface AtomicReplaceResult {
  finalHash: string;
  timings: AtomicReplaceTimings;
}

export class AtomicReplaceError extends Error {
  readonly stage: string;
  readonly retryCount: number;
  readonly systemCode?: string;
  readonly failureCode: "STALE_FILE" | "WRITE_FAILED";
  readonly currentHash?: string;
  readonly finalHash?: string;
  readonly operationApplied: boolean;
  readonly readOnly: boolean;
  readonly timings?: AtomicReplaceTimings;

  constructor(
    error: unknown,
    details: {
      stage?: string;
      retryCount?: number;
      systemCode?: string;
      failureCode?: "STALE_FILE" | "WRITE_FAILED";
      currentHash?: string;
      finalHash?: string;
      operationApplied?: boolean;
      readOnly?: boolean;
      timings?: AtomicReplaceTimings;
    } = {},
  ) {
    const systemCode = details.systemCode ?? (error as NodeJS.ErrnoException | undefined)?.code;
    super("Atomic replacement failed" + (systemCode ? " (" + systemCode + ")" : ""));
    this.name = "AtomicReplaceError";
    this.stage = details.stage ?? "publish";
    this.retryCount = details.retryCount ?? 0;
    this.systemCode = systemCode;
    this.failureCode = details.failureCode ?? "WRITE_FAILED";
    this.currentHash = details.currentHash;
    this.finalHash = details.finalHash;
    this.operationApplied = details.operationApplied ?? false;
    this.readOnly = details.readOnly ?? false;
    this.timings = details.timings;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let cachedExecutionHelperPath: string | undefined;

function verifiedExecutionHelperPath(): string {
  if (cachedExecutionHelperPath) return cachedExecutionHelperPath;
  try {
    const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const helperPath = path.resolve(packageRoot, "build/native/c2c-execution-helper.exe");
    const helperDirectory = path.dirname(helperPath);
    const metadataDirectory = path.join(packageRoot, "dist/execution");
    const metadataPath = path.join(metadataDirectory, "c2c-execution-helper-integrity.json");
    for (const directory of [path.join(packageRoot, "build"), helperDirectory, metadataDirectory]) {
      const stat = fs.lstatSync(directory, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("INVALID_HELPER_DIRECTORY");
    }
    const named = fs.lstatSync(helperPath, { bigint: true });
    const target = fs.statSync(helperPath, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.dev !== target.dev || named.ino !== target.ino) {
      throw new Error("INVALID_HELPER_FILE");
    }
    const metadataStat = fs.lstatSync(metadataPath, { bigint: true });
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) throw new Error("INVALID_HELPER_METADATA");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      version?: unknown;
      protocolVersion?: unknown;
      helperPath?: unknown;
      sha256?: unknown;
    };
    if (metadata.version !== 2 || metadata.protocolVersion !== 7 ||
        metadata.helperPath !== "build/native/c2c-execution-helper.exe" ||
        typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
      throw new Error("INVALID_HELPER_METADATA");
    }
    const helperBytes = fs.readFileSync(helperPath);
    if (helperBytes.byteLength < 0x40 || helperBytes.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("INVALID_HELPER_IMAGE");
    }
    const peOffset = helperBytes.readUInt32LE(0x3c);
    if (peOffset > helperBytes.byteLength - 4 || helperBytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0" ||
        sha256(helperBytes) !== metadata.sha256) {
      throw new Error("HELPER_INTEGRITY_MISMATCH");
    }
    cachedExecutionHelperPath = helperPath;
    return helperPath;
  } catch {
    throw new AtomicReplaceError(undefined, { systemCode: "EXECUTION_HELPER_UNAVAILABLE" });
  }
}

function systemCodeFromWin32(value: string): string {
  if (value === "WIN32_5") return "EACCES";
  if (value === "WIN32_32" || value === "WIN32_33") return "EBUSY";
  if (value === "WIN32_2" || value === "WIN32_3") return "ENOENT";
  if (value === "WIN32_1314") return "EPERM";
  return value;
}

function parseMicroseconds(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 0;
  return Number(value) / 1000;
}

function windowsTimings(helperWallMs: number, validationMs: number, postVerificationMs: number): AtomicReplaceTimings {
  return {
    finalValidationMs: validationMs,
    // Includes the single fixed native helper launch and FileRenameInfoEx call.
    atomicReplaceMs: Math.max(0, helperWallMs - validationMs - postVerificationMs),
    postVerificationMs,
  };
}

function replaceWindowsPreservingAcl(
  source: string,
  destination: string,
  options: AtomicReplaceOptions,
): AtomicReplaceResult {
  if (!options.expectedHash || !options.expectedNewHash || !options.expectedIdentity) {
    throw new AtomicReplaceError(undefined, { systemCode: "WINDOWS_REPLACE_EXPECTATIONS_MISSING" });
  }
  const started = performance.now();
  const helperPath = verifiedExecutionHelperPath();
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const systemDirectory = path.join(systemRoot, "System32");
  const result = childProcess.spawnSync(helperPath, [
    "--atomic-replace",
    destination,
    source,
    options.expectedHash.toLowerCase(),
    options.expectedNewHash.toLowerCase(),
    options.expectedIdentity.dev,
    options.expectedIdentity.ino,
  ], {
    cwd: path.dirname(destination),
    encoding: "utf8",
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: systemDirectory },
    maxBuffer: 64 * 1024,
    timeout: 10_000,
    windowsHide: true,
    shell: false,
  });
  const helperWallMs = performance.now() - started;
  if (result.error) throw new AtomicReplaceError(result.error);
  const stdout = result.stdout ?? "";
  const marker = stdout.split(/\r?\n/).find((line) => line.startsWith("C2C_RESULT|"));
  if (!marker || result.status !== 0) {
    throw new AtomicReplaceError(undefined, { systemCode: "WINDOWS_REPLACE_HELPER_FAILED" });
  }
  const parts = marker.split("|");
  if (parts[1] === "STALE" && parts.length >= 4 && /^[a-f0-9]{64}$/i.test(parts[2]!)) {
    const validationMs = parseMicroseconds(parts[3]);
    throw new AtomicReplaceError(undefined, {
      stage: "final-validation",
      failureCode: "STALE_FILE",
      currentHash: parts[2]!.toLowerCase(),
      timings: windowsTimings(helperWallMs, validationMs, 0),
    });
  }
  if (parts[1] === "READONLY" && parts.length >= 3) {
    const validationMs = parseMicroseconds(parts[2]);
    throw new AtomicReplaceError(undefined, {
      stage: "final-validation",
      systemCode: "EACCES",
      readOnly: true,
      timings: windowsTimings(helperWallMs, validationMs, 0),
    });
  }
  const errorShapeIsValid = parts[1] === "ERROR" &&
    ((parts.length === 7 && parts[4] === "0") ||
      (parts.length === 8 && (parts[4] === "0" || parts[4] === "1"))) &&
    /^\d+$/.test(parts[2]!) && /^\d+$/.test(parts[5]!) && /^\d+$/.test(parts[6]!) &&
    (parts.length !== 8 || parts[7] === "" || /^[a-f0-9]{64}$/i.test(parts[7]!));
  if (errorShapeIsValid) {
    const validationMs = parseMicroseconds(parts[5]);
    const postVerificationMs = parseMicroseconds(parts[6]);
    const applied = parts[4] === "1";
    const finalHash = parts[7] && /^[a-f0-9]{64}$/i.test(parts[7]) ? parts[7].toLowerCase() : undefined;
    throw new AtomicReplaceError(undefined, {
      stage: parts[3] || "publish",
      systemCode: systemCodeFromWin32("WIN32_" + parts[2]),
      operationApplied: applied,
      ...(finalHash ? { finalHash } : {}),
      ...(applied ? { timings: windowsTimings(helperWallMs, validationMs, postVerificationMs) } : {}),
    });
  }
  if (parts[1] === "OK" && parts.length >= 6 && /^[a-f0-9]{64}$/i.test(parts[2]!)) {
    const finalHash = parts[2]!.toLowerCase();
    if (finalHash !== options.expectedNewHash.toLowerCase()) {
      throw new AtomicReplaceError(undefined, {
        stage: "post-verification",
        systemCode: "POST_HASH_MISMATCH",
        operationApplied: true,
        finalHash,
      });
    }
    return {
      finalHash,
      timings: windowsTimings(helperWallMs, parseMicroseconds(parts[3]), parseMicroseconds(parts[5])),
    };
  }
  throw new AtomicReplaceError(undefined, { systemCode: "WINDOWS_REPLACE_HELPER_FAILED" });
}

function identity(stat: fs.BigIntStats): string {
  return stat.dev.toString() + ":" + stat.ino.toString();
}

const renameRetryWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function renameWithWindowsRetry(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(code ?? "") || attempt >= 10) {
        throw new AtomicReplaceError(error, { retryCount: attempt });
      }
      // Windows security/indexing filters can briefly hold a just-published file.
      // Keep retries bounded and confined to the generic atomic state-file path.
      Atomics.wait(renameRetryWait, 0, 0, 10);
    }
  }
}

function readTarget(filePath: string): { bytes: Buffer; stat: fs.BigIntStats } {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new AtomicReplaceError(undefined, { stage: "final-validation", systemCode: "NOT_A_FILE" });
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || identity(before) !== identity(opened)) {
      throw new AtomicReplaceError(undefined, { stage: "final-validation", failureCode: "STALE_FILE" });
    }
    const bytes = fs.readFileSync(fd);
    const afterHandle = fs.fstatSync(fd, { bigint: true });
    const afterPath = fs.lstatSync(filePath, { bigint: true });
    if (identity(opened) !== identity(afterHandle) || identity(opened) !== identity(afterPath) ||
        opened.size !== afterHandle.size || opened.mtimeNs !== afterHandle.mtimeNs || opened.ctimeNs !== afterHandle.ctimeNs) {
      throw new AtomicReplaceError(undefined, { stage: "final-validation", failureCode: "STALE_FILE" });
    }
    return { bytes, stat: opened };
  } finally { fs.closeSync(fd); }
}

/** Publish a fully flushed same-directory temp file. */
export function atomicReplace(source: string, destination: string, options: AtomicReplaceOptions = {}): AtomicReplaceResult {
  if (process.platform === "win32" && options.preserveAcl) {
    return replaceWindowsPreservingAcl(source, destination, options);
  }

  const validationStarted = performance.now();
  if (options.expectedHash || options.expectedIdentity) {
    const current = readTarget(destination);
    if ((options.expectedIdentity &&
         (current.stat.dev.toString() !== options.expectedIdentity.dev || current.stat.ino.toString() !== options.expectedIdentity.ino)) ||
        (options.expectedHash && sha256(current.bytes) !== options.expectedHash.toLowerCase())) {
      throw new AtomicReplaceError(undefined, {
        stage: "final-validation",
        failureCode: "STALE_FILE",
        currentHash: sha256(current.bytes),
      });
    }
  }
  const finalValidationMs = performance.now() - validationStarted;
  const replaceStarted = performance.now();
  renameWithWindowsRetry(source, destination);
  const atomicReplaceMs = performance.now() - replaceStarted;
  const verifyStarted = performance.now();
  const finalHash = sha256(readTarget(destination).bytes);
  if (options.expectedNewHash && finalHash !== options.expectedNewHash.toLowerCase()) {
    throw new AtomicReplaceError(undefined, { stage: "post-verification", systemCode: "POST_HASH_MISMATCH", operationApplied: true, finalHash });
  }
  return { finalHash, timings: { finalValidationMs, atomicReplaceMs, postVerificationMs: performance.now() - verifyStarted } };
}
