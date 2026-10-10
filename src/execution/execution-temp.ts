import fs from "node:fs";
import path from "node:path";

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/;
const ROOT_MARKER = ".c2c-execution-temp-owner";
const JOB_MARKER = ".c2c-job-owner";

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

/**
 * Owns only job-scoped temporary data under a fixed state-directory root.
 * Job paths are derived from validated IDs; persisted job metadata never supplies
 * a cleanup path. Unknown or unmarked directories are preserved.
 */
export class ExecutionTempOwner {
  readonly root: string;
  private readonly canonicalParent: string;
  private readonly rootMarkerText: string;

  constructor(stateDirectory: string, readonly workspaceId: string) {
    if (!workspaceId || /[\\/\0]/.test(workspaceId)) throw new Error("TEMP_OWNER_INVALID");
    this.canonicalParent = fs.realpathSync.native(stateDirectory);
    this.root = path.join(this.canonicalParent, "execution-temp");
    this.rootMarkerText = `C2C-EXECUTION-TEMP-ROOT-V1\n${workspaceId}\n`;
    this.ensureRoot();
  }

  private ensureRoot(): void {
    let created = false;
    try {
      fs.mkdirSync(this.root, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        normalized(fs.realpathSync.native(this.root)) !== normalized(this.root) ||
        !isContained(this.canonicalParent, fs.realpathSync.native(this.root))) {
      throw new Error("TEMP_ROOT_INVALID");
    }
    const marker = path.join(this.root, ROOT_MARKER);
    if (created) {
      fs.writeFileSync(marker, this.rootMarkerText, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    }
    if (!isRegularFile(marker) || fs.readFileSync(marker, "utf8") !== this.rootMarkerText) {
      throw new Error("TEMP_ROOT_UNOWNED");
    }
  }

  create(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("TEMP_JOB_ID_INVALID");
    this.ensureRoot();
    const directory = path.join(this.root, `tmp-${jobId}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      const stat = fs.lstatSync(directory);
      const canonical = fs.realpathSync.native(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          normalized(canonical) !== normalized(directory) ||
          !isContained(this.root, canonical)) {
        throw new Error("TEMP_DIRECTORY_INVALID");
      }
      const marker = path.join(directory, JOB_MARKER);
      const markerText = `C2C-EXECUTION-TEMP-JOB-V1\n${this.workspaceId}\n${jobId}\n`;
      fs.writeFileSync(marker, markerText, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return canonical;
    } catch (error) {
      try {
        fs.rmdirSync(directory);
      } catch {
        /* preserve anything that replaced the newly created empty directory */
      }
      throw error;
    }
  }

  fileIdentity(jobId: string): string {
    if (!JOB_ID_PATTERN.test(jobId)) throw new Error("TEMP_JOB_ID_INVALID");
    this.ensureRoot();
    const directory = path.join(this.root, `tmp-${jobId}`);
    const stat = fs.lstatSync(directory, { bigint: true });
    const canonical = fs.realpathSync.native(directory);
    const marker = path.join(directory, JOB_MARKER);
    const expectedMarker = `C2C-EXECUTION-TEMP-JOB-V1\n${this.workspaceId}\n${jobId}\n`;
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        normalized(canonical) !== normalized(directory) || !isContained(this.root, canonical) ||
        !isRegularFile(marker) || fs.readFileSync(marker, "utf8") !== expectedMarker ||
        stat.dev === 0n || stat.ino === 0n) {
      throw new Error("TEMP_DIRECTORY_INVALID");
    }
    return `${stat.dev.toString(16)}:${stat.ino.toString(16)}`;
  }

  cleanup(jobId: string): boolean {
    if (!JOB_ID_PATTERN.test(jobId)) return false;
    this.ensureRoot();
    const directory = path.join(this.root, `tmp-${jobId}`);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return false;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(directory);
    } catch {
      return false;
    }
    if (normalized(canonical) !== normalized(directory) || !isContained(this.root, canonical)) return false;
    const marker = path.join(directory, JOB_MARKER);
    const expectedMarker = `C2C-EXECUTION-TEMP-JOB-V1\n${this.workspaceId}\n${jobId}\n`;
    if (!isRegularFile(marker) || fs.readFileSync(marker, "utf8") !== expectedMarker) return false;

    // This recursive removal is confined to the canonical, marked directory
    // created for this job. Node removes reparse entries themselves, not their
    // targets; an unmarked or reparse job directory is left untouched.
    fs.rmSync(directory, { recursive: true, force: false });
    return true;
  }

  reconcileStaleTemps(activeJobIds: ReadonlySet<string> = new Set()): { removed: number; skipped: number } {
    this.ensureRoot();
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
      if (this.cleanup(jobId)) removed += 1;
      else skipped += 1;
    }
    return { removed, skipped };
  }
}
