import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ExecutionTempOwnership } from "./job-types.js";
import { runExecutionTempCleanup } from "./execution-temp-cleanup.js";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const ROOT_MARKER = ".c2c-execution-temp-owner";
const JOB_MARKER = ".c2c-job-owner";
const JOB_AUTHORITY_PREFIX = ".c2c-execution-temp-job-";

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileIdentity(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.dev === 0n || stat.ino === 0n) throw new Error("TEMP_DIRECTORY_INVALID");
  return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
}

function isRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() &&
      normalized(fs.realpathSync.native(file)) === normalized(file);
  } catch {
    return false;
  }
}

function creationTimeMs(stat: { birthtimeNs: bigint }): number {
  const value = Number(stat.birthtimeNs / 1_000_000n);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("TEMP_DIRECTORY_INVALID");
  return value;
}

export interface ExecutionTempLease extends ExecutionTempOwnership {
  workspaceId: string;
  jobId: string;
  rootPath: string;
  directoryPath: string;
}

export interface ExecutionTempRecord {
  jobId: string;
  ownership: ExecutionTempOwnership;
}

/**
 * Owns only job-scoped temporary data under the fixed state-directory root.
 * A cleanup operation requires the matching persisted ownership record; a
 * marker alone is never sufficient authority.
 */
export class ExecutionTempOwner {
  readonly root: string;
  readonly rootFileIdentity: string;
  private readonly canonicalParent: string;
  private establishedRootIdentity: string | null = null;

  constructor(stateDirectory: string, readonly workspaceId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("TEMP_OWNER_INVALID");
    this.canonicalParent = fs.realpathSync.native(stateDirectory);
    this.root = path.join(this.canonicalParent, "execution-temp");
    this.rootFileIdentity = this.ensureRoot();
    this.establishedRootIdentity = this.rootFileIdentity;
  }

  private rootMarkerText(identity: string): string {
    return `C2C-EXECUTION-TEMP-ROOT-V2\n${this.workspaceId}\n${identity}\n`;
  }

  private ensureRoot(): string {
    let created = false;
    try {
      fs.mkdirSync(this.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(this.root, { bigint: true });
    const canonical = fs.realpathSync.native(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(canonical) !== normalized(this.root) ||
        !isContained(this.canonicalParent, canonical)) {
      throw new Error("TEMP_ROOT_INVALID");
    }
    const identity = `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
    if (stat.dev === 0n || stat.ino === 0n ||
        (this.establishedRootIdentity && identity !== this.establishedRootIdentity)) {
      throw new Error("TEMP_ROOT_IDENTITY_CHANGED");
    }
    const marker = path.join(this.root, ROOT_MARKER);
    if (created) {
      fs.writeFileSync(marker, this.rootMarkerText(identity), { encoding: "utf8", mode: 0o600, flag: "wx" });
      return identity;
    }
    const markerText = isRegularFile(marker) ? fs.readFileSync(marker, "utf8") : "";
    const legacyMarkerText = `C2C-EXECUTION-TEMP-ROOT-V1\n${this.workspaceId}\n`;
    if (markerText !== this.rootMarkerText(identity) && markerText !== legacyMarkerText) {
      throw new Error("TEMP_ROOT_UNOWNED");
    }
    return identity;
  }

  private static isContained(parent: string, candidate: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  create(jobId: string): ExecutionTempLease {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("TEMP_JOB_ID_INVALID");
    const rootIdentity = this.ensureRoot();
    const directory = path.join(this.root, `tmp-${jobId}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const stat = fs.lstatSync(directory, { bigint: true });
    const canonical = fs.realpathSync.native(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(canonical) !== normalized(directory) ||
        !ExecutionTempOwner.isContained(this.root, canonical) || stat.dev === 0n || stat.ino === 0n) {
      throw new Error("TEMP_DIRECTORY_INVALID");
    }
    const directoryIdentity = `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
    const nonce = randomBytes(32).toString("hex");
    const createdAtMs = creationTimeMs(stat);
    const ownership: ExecutionTempOwnership = {
      rootFileIdentity: rootIdentity,
      directoryFileIdentity: directoryIdentity,
      nonce,
      createdAtMs,
    };
    const markerText = this.jobMarkerText(jobId, ownership);
    fs.writeFileSync(path.join(directory, JOB_MARKER), markerText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.writeFileSync(this.jobAuthorityPath(jobId), this.jobAuthorityText(jobId, ownership), {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    const afterIdentity = fileIdentity(directory);
    if (afterIdentity !== directoryIdentity || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error("TEMP_DIRECTORY_IDENTITY_CHANGED");
    }
    return {
      ...ownership,
      workspaceId: this.workspaceId,
      jobId,
      rootPath: this.root,
      directoryPath: canonical,
    };
  }

  private jobMarkerText(jobId: string, ownership: ExecutionTempOwnership): string {
    return [
      "C2C-EXECUTION-TEMP-JOB-V2",
      this.workspaceId,
      jobId,
      ownership.nonce,
      ownership.rootFileIdentity,
      ownership.directoryFileIdentity,
      String(ownership.createdAtMs),
      "",
    ].join("\n");
  }

  private jobAuthorityPath(jobId: string): string {
    return path.join(this.canonicalParent, `${JOB_AUTHORITY_PREFIX}${jobId}`);
  }

  private jobAuthorityText(jobId: string, ownership: ExecutionTempOwnership): string {
    return [
      "C2C-EXECUTION-TEMP-AUTHORITY-V1",
      this.workspaceId,
      jobId,
      ownership.nonce,
      ownership.rootFileIdentity,
      ownership.directoryFileIdentity,
      String(ownership.createdAtMs),
      "",
    ].join("\n");
  }

  lease(jobId: string, ownership: ExecutionTempOwnership): ExecutionTempLease {
    if (!JOB_ID_PATTERN.test(jobId) || ownership.rootFileIdentity !== this.rootFileIdentity ||
        !/^[a-f0-9]{64}$/i.test(ownership.nonce) || !Number.isSafeInteger(ownership.createdAtMs) ||
        !/^[a-f0-9]+:[a-f0-9]+$/i.test(ownership.directoryFileIdentity)) {
      throw new Error("TEMP_OWNERSHIP_INVALID");
    }
    return {
      ...ownership,
      workspaceId: this.workspaceId,
      jobId,
      rootPath: this.root,
      directoryPath: path.join(this.root, `tmp-${jobId}`),
    };
  }

  validate(jobId: string, ownership: ExecutionTempOwnership): boolean {
    try {
      const lease = this.lease(jobId, ownership);
      this.ensureRoot();
      const stat = fs.lstatSync(lease.directoryPath, { bigint: true });
      const canonical = fs.realpathSync.native(lease.directoryPath);
      const marker = path.join(lease.directoryPath, JOB_MARKER);
      const authority = this.jobAuthorityPath(jobId);
      return stat.isDirectory() && !stat.isSymbolicLink() &&
        normalized(canonical) === normalized(lease.directoryPath) &&
        ExecutionTempOwner.isContained(this.root, canonical) &&
        `${stat.dev.toString(16)}:${stat.ino.toString(16)}` === ownership.directoryFileIdentity &&
        isRegularFile(marker) && fs.readFileSync(marker, "utf8") === this.jobMarkerText(jobId, ownership) &&
        isRegularFile(authority) && fs.readFileSync(authority, "utf8") === this.jobAuthorityText(jobId, ownership);
    } catch {
      return false;
    }
  }

  fileIdentity(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("TEMP_JOB_ID_INVALID");
    this.ensureRoot();
    const directory = path.join(this.root, `tmp-${jobId}`);
    const stat = fs.lstatSync(directory, { bigint: true });
    const canonical = fs.realpathSync.native(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(canonical) !== normalized(directory) ||
        !ExecutionTempOwner.isContained(this.root, canonical)) throw new Error("TEMP_DIRECTORY_INVALID");
    return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
  }

  cleanup(jobId: string, ownership: ExecutionTempOwnership, afterValidation?: () => void): boolean {
    if (!this.validate(jobId, ownership)) return false;
    try {
      afterValidation?.();
      if (process.platform !== "win32") return false;
      return runExecutionTempCleanup(this.lease(jobId, ownership), this.canonicalParent);
    } catch {
      return false;
    }
  }

  reconcileStaleTemps(
    records: readonly ExecutionTempRecord[],
    activeJobIds: ReadonlySet<string> = new Set(),
  ): { removed: number; skipped: number } {
    this.ensureRoot();
    const ownership = new Map(records.map((record) => [record.jobId, record.ownership]));
    let removed = 0;
    let skipped = 0;
    for (const name of fs.readdirSync(this.root)) {
      if (!name.startsWith("tmp-")) continue;
      const jobId = name.slice(4);
      if (!JOB_ID_PATTERN.test(jobId)) {
        skipped += 1;
        continue;
      }
      if (activeJobIds.has(jobId)) continue;
      const record = ownership.get(jobId);
      if (record && this.cleanup(jobId, record)) removed += 1;
      else skipped += 1;
    }
    return { removed, skipped };
  }
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
