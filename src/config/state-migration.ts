import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";


const PERSISTENT_DIRECTORIES = [
  "auth",
  "permissions",
  "tunnels",
  "endpoints",
  "autostart",
] as const;
const PERSISTENT_FILES = ["prefs.json"] as const;
const WORKSPACE_STATE_FILE = /^[a-f0-9]{12}\.json$/i;
const MIGRATION_MARKER = ".state-migration-v1.json";

interface MigrationEntry {
  relativePath: string;
  contents: Buffer;
  digest: string;
}

export interface StateMigrationResult {
  sourceRoot: string;
  destinationRoot: string;
  copied: string[];
  alreadyPresent: string[];
  markerPath: string;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

interface CanonicalPath {
  physicalPath: string;
  existingAncestor: string;
  exists: boolean;
}

/** Resolve missing leaves through their deepest existing ancestor, like HostFilesystem. */
function canonicalizePhysical(input: string, rejectReparseAncestors: boolean): CanonicalPath {
  const absolute = path.resolve(input);
  let current = absolute;
  const suffix: string[] = [];
  let stat: fs.Stats;
  for (;;) {
    try {
      stat = fs.lstatSync(current);
      break;
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) {
        throw new Error("Cannot verify the physical migration path.");
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }

  if (suffix.length > 0 && !stat.isDirectory() && !stat.isSymbolicLink()) {
    throw new Error("A migration path ancestor is not a directory.");
  }

  if (rejectReparseAncestors) {
    const root = path.parse(current).root;
    let component = root;
    try {
      for (const segment of path.relative(root, current).split(path.sep).filter(Boolean)) {
        component = path.join(component, segment);
        const componentStat = fs.lstatSync(component);
        if (componentStat.isSymbolicLink()) {
          throw new Error("Migration destination must not traverse a symbolic link or junction.");
        }
        if (component !== current && !componentStat.isDirectory()) {
          throw new Error("A migration destination ancestor is not a directory.");
        }
      }
    } catch (error) {
      if (error instanceof Error &&
          (error.message.startsWith("Migration destination") ||
           error.message.startsWith("A migration destination"))) throw error;
      throw new Error("Cannot verify the physical migration destination path.");
    }
  }

  let physicalAncestor: string;
  try {
    physicalAncestor = fs.realpathSync.native(current);
    if (suffix.length > 0 && !fs.statSync(physicalAncestor).isDirectory()) {
      throw new Error("A migration path ancestor is not a directory.");
    }
  } catch {
    throw new Error("Cannot canonicalize the physical migration path.");
  }
  return {
    physicalPath: suffix.length ? path.join(physicalAncestor, ...suffix) : physicalAncestor,
    existingAncestor: physicalAncestor,
    exists: suffix.length === 0,
  };
}

function samePhysicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === "" && path.relative(right, left) === "";
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DestinationObject {
  cleanupPath: string;
  identity: FileIdentity;
  parentIdentity: FileIdentity;
}

interface DirectorySnapshot {
  physicalPath: string;
  identity: FileIdentity;
}

function identityOf(stat: fs.BigIntStats): FileIdentity {
  // Refuse filesystems where Node cannot provide a useful object identity.
  if (stat.ino === 0n) throw new Error("Cannot verify migration filesystem object identity.");
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identityKey(target: string): string {
  const absolute = path.resolve(target);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** Take a stable, no-reparse snapshot of a directory path. */
function inspectDirectory(target: string): DirectorySnapshot {
  try {
    const first = canonicalizePhysical(target, true);
    const firstStat = fs.lstatSync(target, { bigint: true });
    if (!first.exists || !firstStat.isDirectory() || firstStat.isSymbolicLink() ||
        !samePhysicalPath(first.physicalPath, path.resolve(target))) {
      throw new Error("Migration directory identity changed.");
    }
    const firstIdentity = identityOf(firstStat);
    const second = canonicalizePhysical(target, true);
    const secondStat = fs.lstatSync(target, { bigint: true });
    const secondIdentity = identityOf(secondStat);
    if (!second.exists || !secondStat.isDirectory() || secondStat.isSymbolicLink() ||
        !samePhysicalPath(first.physicalPath, second.physicalPath) ||
        !sameIdentity(firstIdentity, secondIdentity)) {
      throw new Error("Migration directory identity changed.");
    }
    return { physicalPath: second.physicalPath, identity: secondIdentity };
  } catch {
    throw new Error("Cannot verify the physical identity of a migration directory.");
  }
}

/** Resolve a created target through its current parent for identity-guarded rollback. */
function physicalTargetThroughCurrentParent(target: string): string {
  const parent = canonicalizePhysical(path.dirname(target), false);
  return path.join(parent.physicalPath, path.basename(target));
}

function physicalParentSnapshotThroughCurrentParent(target: string): DirectorySnapshot {
  const parent = canonicalizePhysical(path.dirname(target), false);
  return inspectDirectory(parent.physicalPath);
}

// Rollback also uses pathname operations. These checks prevent deleting a
// replacement object, but cannot make the final check/unlink atomic on Windows.
function cleanupCreatedFiles(files: DestinationObject[]): boolean {
  let complete = true;
  for (const file of [...files].reverse()) {
    try {
      const parent = inspectDirectory(path.dirname(file.cleanupPath));
      if (!samePhysicalPath(parent.physicalPath, path.dirname(file.cleanupPath)) ||
          !sameIdentity(parent.identity, file.parentIdentity)) {
        complete = false;
        continue;
      }
      const stat = fs.lstatSync(file.cleanupPath, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() ||
          !sameIdentity(identityOf(stat), file.identity)) {
        complete = false;
        continue;
      }
      fs.unlinkSync(file.cleanupPath);
    } catch {
      complete = false;
    }
  }
  return complete;
}

function cleanupCreatedDirectories(directories: DestinationObject[]): boolean {
  let complete = true;
  for (const directory of [...directories].reverse()) {
    try {
      const parent = inspectDirectory(path.dirname(directory.cleanupPath));
      if (!samePhysicalPath(parent.physicalPath, path.dirname(directory.cleanupPath)) ||
          !sameIdentity(parent.identity, directory.parentIdentity)) {
        complete = false;
        continue;
      }
      const stat = fs.lstatSync(directory.cleanupPath, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          !sameIdentity(identityOf(stat), directory.identity)) {
        complete = false;
        continue;
      }
      fs.rmdirSync(directory.cleanupPath);
    } catch {
      complete = false;
    }
  }
  return complete;
}

function lstatOrMissing(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot verify the migration destination.");
  }
}

function parseStateJson(contents: Buffer, relativePath: string): unknown {
  try {
    return JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new Error("Malformed JSON syntax in durable state file " + relativePath + ".");
  }
}

function isPersistentJsonPath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  if (["auth", "permissions", "tunnels", "endpoints"].includes(parts[0])) {
    return parts.length === 2 && WORKSPACE_STATE_FILE.test(parts[1]);
  }
  return parts.length === 3 &&
    parts[0] === "autostart" &&
    parts[1] === "workspaces" &&
    WORKSPACE_STATE_FILE.test(parts[2]);
}

function collectJsonFiles(directory: string, relativeDirectory: string, entries: MigrationEntry[]): void {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, item.name);
    const sourcePath = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error(`Symbolic links are not supported in migration state: ${sourcePath}`);
    if (item.isDirectory()) {
      collectJsonFiles(sourcePath, relativePath, entries);
      continue;
    }
    if (!item.isFile() || !isPersistentJsonPath(relativePath)) continue;
    const sourceContents = fs.readFileSync(sourcePath);
    const parsed = parseStateJson(sourceContents, relativePath);
    if (relativeDirectory === "auth") {
      if (
        !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !Array.isArray((parsed as { clients?: unknown }).clients) ||
        !Array.isArray((parsed as { tokens?: unknown }).tokens)
      ) {
        throw new Error(`Invalid auth state in ${sourcePath}`);
      }
    }
    let contents = sourceContents;
    if (relativeDirectory === path.join("autostart", "workspaces")) {
      if (
        !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        (parsed as { workspaceId?: unknown }).workspaceId !== path.basename(item.name, ".json") ||
        typeof (parsed as { workspaceRoot?: unknown }).workspaceRoot !== "string" ||
        typeof (parsed as { taskName?: unknown }).taskName !== "string"
      ) {
        throw new Error(`Invalid autostart registration in ${sourcePath}`);
      }
      const registration = { ...(parsed as Record<string, unknown>) };
      delete registration.lastRunAt;
      delete registration.lastRunStatus;
      delete registration.lastRunMessage;
      contents = Buffer.from(JSON.stringify(registration, null, 2));
    }
    entries.push({ relativePath, contents, digest: sha256(contents) });
  }
}

function collectEntries(sourceRoot: string): MigrationEntry[] {
  const entries: MigrationEntry[] = [];
  for (const directory of PERSISTENT_DIRECTORIES) {
    const sourceDirectory = path.join(sourceRoot, directory);
    if (!fs.existsSync(sourceDirectory)) continue;
    const stat = fs.lstatSync(sourceDirectory);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in migration state: ${sourceDirectory}`);
    if (!stat.isDirectory()) continue;
    collectJsonFiles(sourceDirectory, directory, entries);
  }
  for (const file of PERSISTENT_FILES) {
    const sourcePath = path.join(sourceRoot, file);
    if (!fs.existsSync(sourcePath)) continue;
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported in migration state: ${sourcePath}`);
    if (!stat.isFile()) continue;
    const contents = fs.readFileSync(sourcePath);
    parseStateJson(contents, file);
    entries.push({ relativePath: file, contents, digest: sha256(contents) });
  }
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/**
 * Import only durable configuration from an explicitly selected, validated
 * source. Runtime files, logs, execution history, and output bodies are never
 * considered. Existing destination files are never overwritten.
 */
export function migratePersistentState(sourcePath: string, destinationPath: string): StateMigrationResult {
  const sourceCanonical = canonicalizePhysical(sourcePath, false);
  const sourceInputPath = path.resolve(sourcePath);
  const sourceInputStat = lstatOrMissing(sourceInputPath);
  if (!sourceCanonical.exists || !sourceInputStat || sourceInputStat.isSymbolicLink()) {
    throw new Error("Migration source must be an existing, regular directory.");
  }
  const sourceRoot = sourceCanonical.physicalPath;
  const sourceStat = fs.lstatSync(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("Migration source must be an existing, regular directory.");
  }

  const destinationCanonical = canonicalizePhysical(destinationPath, true);
  const destinationRoot = destinationCanonical.physicalPath;
  if (containsPath(sourceRoot, destinationRoot) || containsPath(destinationRoot, sourceRoot)) {
    throw new Error("Migration source and destination must be separate, non-nested directories.");
  }

  const entries = collectEntries(sourceRoot);
  if (entries.length === 0) {
    throw new Error("No recognized durable C2C state was found in the selected source directory.");
  }

  const markerPath = path.join(destinationRoot, MIGRATION_MARKER);
  const markerContents = Buffer.from(JSON.stringify({
    version: 1,
    completedAt: new Date().toISOString(),
    files: entries.map(({ relativePath, digest }) => ({ path: relativePath, sha256: digest })),
  }, null, 2));

  const preflight = (root: string): { pending: MigrationEntry[]; alreadyPresent: string[] } => {
    const markerStat = lstatOrMissing(path.join(root, MIGRATION_MARKER));
    if (markerStat) throw new Error("State migration has already completed.");
    const rootStat = lstatOrMissing(root);
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
      throw new Error("Migration destination must be a regular directory.");
    }

    const pending: MigrationEntry[] = [];
    const alreadyPresent: string[] = [];
    for (const entry of entries) {
      const destinationFile = path.join(root, entry.relativePath);
      if (!containsPath(root, destinationFile)) {
        throw new Error("Invalid migration destination path.");
      }
      let currentDirectory = root;
      let missingAncestor = !rootStat;
      for (const segment of path.relative(root, path.dirname(destinationFile)).split(path.sep).filter(Boolean)) {
        if (missingAncestor) break;
        currentDirectory = path.join(currentDirectory, segment);
        const directoryStat = lstatOrMissing(currentDirectory);
        if (!directoryStat) {
          missingAncestor = true;
          break;
        }
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error("Migration destination contains a non-directory path for " + entry.relativePath + ".");
        }
      }

      const existingStat = missingAncestor ? null : lstatOrMissing(destinationFile);
      if (!existingStat) {
        pending.push(entry);
        continue;
      }
      if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
        throw new Error("Migration destination is not a regular file for " + entry.relativePath + ".");
      }
      if (sha256(fs.readFileSync(destinationFile)) !== entry.digest) {
        throw new Error("Migration would overwrite different state; preserved " + entry.relativePath + ".");
      }
      alreadyPresent.push(entry.relativePath);
    }
    return { pending, alreadyPresent };
  };

  // Validate the entire source and destination before creating staging or authority directories.
  const initialPlan = preflight(destinationRoot);
  const destinationDirectoryIdentities = new Map<string, FileIdentity>();
  const rememberExistingDirectoryChain = (target: string): void => {
    const absolute = path.resolve(target);
    const root = path.parse(absolute).root;
    let current = root;
    const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
    const candidates = [current, ...segments.map((segment) => {
      current = path.join(current, segment);
      return current;
    })];
    for (const directory of candidates) {
      if (!lstatOrMissing(directory)) break;
      const snapshot = inspectDirectory(directory);
      destinationDirectoryIdentities.set(identityKey(directory), snapshot.identity);
    }
  };
  // Pin existing ancestors and destination subdirectories before staging. Missing
  // destination directories are pinned immediately after their checked creation.
  rememberExistingDirectoryChain(destinationCanonical.existingAncestor);
  rememberExistingDirectoryChain(destinationRoot);
  for (const entry of entries) {
    rememberExistingDirectoryChain(path.dirname(path.join(destinationRoot, entry.relativePath)));
  }

  const verifyDirectoryIdentity = (directory: string): DirectorySnapshot => {
    const snapshot = inspectDirectory(directory);
    const expected = destinationDirectoryIdentities.get(identityKey(directory));
    if (expected && !sameIdentity(snapshot.identity, expected)) {
      throw new Error("Migration destination directory identity changed.");
    }
    return snapshot;
  };
  const verifyDestinationParent = (target: string): DirectorySnapshot => {
    const absoluteTarget = path.resolve(target);
    const targetWithinDestination = containsPath(destinationRoot, absoluteTarget);
    const targetIsDestinationAncestor = containsPath(absoluteTarget, destinationRoot);
    if (!targetWithinDestination && !targetIsDestinationAncestor) {
      throw new Error("Migration destination path escaped its authority.");
    }
    const parentPath = path.dirname(absoluteTarget);
    const destination = canonicalizePhysical(destinationPath, true);
    if (!samePhysicalPath(destination.physicalPath, destinationRoot)) {
      throw new Error("Migration destination physical identity changed.");
    }
    if (targetWithinDestination && containsPath(destinationRoot, parentPath)) {
      if (!destination.exists) throw new Error("Migration destination directory is missing.");
      const rootSnapshot = verifyDirectoryIdentity(destinationRoot);
      const parentSnapshot = verifyDirectoryIdentity(parentPath);
      if (!containsPath(rootSnapshot.physicalPath, parentSnapshot.physicalPath)) {
        throw new Error("Migration destination parent escaped its physical authority.");
      }
      return parentSnapshot;
    }
    // Missing path components above the destination root are created from the
    // existing ancestor down. Their parents must remain the expected ancestors.
    if (targetIsDestinationAncestor && targetWithinDestination) {
      // The sole destination-contained target with an external parent is the
      // destination root itself.
      if (!samePhysicalPath(absoluteTarget, destinationRoot)) {
        throw new Error("Migration destination parent escaped its authority.");
      }
    } else if (targetIsDestinationAncestor && !containsPath(parentPath, destinationRoot)) {
      throw new Error("Migration destination parent escaped its authority.");
    }
    return verifyDirectoryIdentity(parentPath);
  };
  const parentCanonical = canonicalizePhysical(path.dirname(destinationPath), true);
  const stagingParent = parentCanonical.existingAncestor;
  if (!fs.statSync(stagingParent).isDirectory() ||
      containsPath(sourceRoot, stagingParent) || containsPath(destinationRoot, stagingParent)) {
    throw new Error("Cannot choose a staging location separate from both migration authorities.");
  }

  const stageDirectories: string[] = [];
  const stageFiles: string[] = [];
  const createdDestinationDirectories: DestinationObject[] = [];
  const committedDestinationFiles: DestinationObject[] = [];
  let stageRoot: string | undefined;

  const cleanupExact = (files: string[], directories: string[]): boolean => {
    let complete = true;
    for (const file of [...files].reverse()) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      }
    }
    for (const directory of [...directories].reverse()) {
      try {
        fs.rmdirSync(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      }
    }
    return complete;
  };

  const ensureDestinationDirectory = (target: string): void => {
    const missing: string[] = [];
    let current = target;
    for (;;) {
      const stat = lstatOrMissing(current);
      if (stat) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Migration destination path changed during commit.");
        }
        verifyDirectoryIdentity(current);
        break;
      }
      missing.unshift(current);
      const parent = path.dirname(current);
      if (parent === current) throw new Error("Cannot create migration destination directory.");
      current = parent;
    }
    for (const directory of missing) {
      // Recheck the parent immediately before every authority directory create.
      const parentBefore = verifyDestinationParent(directory);
      fs.mkdirSync(directory, { mode: 0o700 });
      const createdStat = fs.lstatSync(directory, { bigint: true });
      const createdIdentity = identityOf(createdStat);
      let cleanupPath = path.resolve(directory);
      let cleanupParentIdentity = parentBefore.identity;
      try {
        cleanupPath = physicalTargetThroughCurrentParent(directory);
        cleanupParentIdentity = physicalParentSnapshotThroughCurrentParent(directory).identity;
      } catch {
        // Keep the authorized spelling as a fallback; cleanup still verifies both identities.
      }
      createdDestinationDirectories.push({
        cleanupPath,
        identity: createdIdentity,
        parentIdentity: cleanupParentIdentity,
      });
      const createdDirectory = inspectDirectory(directory);
      const parentAfter = verifyDestinationParent(directory);
      if (!sameIdentity(createdIdentity, createdDirectory.identity) ||
          !sameIdentity(parentBefore.identity, parentAfter.identity) ||
          !samePhysicalPath(parentBefore.physicalPath, parentAfter.physicalPath)) {
        throw new Error("Migration destination changed during directory creation.");
      }
      destinationDirectoryIdentities.set(identityKey(directory), createdDirectory.identity);
    }
  };

  const writeCommittedFile = (target: string, stagedFile: string): void => {
    const contents = fs.readFileSync(stagedFile);
    // The selected parent is checked just before open and compared again after
    // open. Node's Windows API does not expose O_NOFOLLOW here; this narrows the
    // path race but cannot eliminate a concurrent swap between the checks.
    const parentBefore = verifyDestinationParent(target);
    const fd = fs.openSync(target, "wx", 0o600);
    try {
      const openedStat = fs.fstatSync(fd, { bigint: true });
      const openedIdentity = identityOf(openedStat);
      const openedObject: DestinationObject = {
        cleanupPath: path.resolve(target),
        identity: openedIdentity,
        parentIdentity: parentBefore.identity,
      };
      committedDestinationFiles.push(openedObject);
      if (!openedStat.isFile()) throw new Error("Migration opened a non-regular destination file.");

      // Compare the pathname to the opened handle before doing any further work.
      const pathStat = fs.lstatSync(target, { bigint: true });
      if (!pathStat.isFile() || pathStat.isSymbolicLink() ||
          !sameIdentity(identityOf(pathStat), openedIdentity)) {
        throw new Error("Migration destination path and opened file identity differ.");
      }
      try {
        const currentParent = physicalParentSnapshotThroughCurrentParent(target);
        openedObject.cleanupPath = path.join(currentParent.physicalPath, path.basename(target));
        openedObject.parentIdentity = currentParent.identity;
      } catch {
        // Leave the authorized spelling in place; identity checks prevent unsafe cleanup.
      }
      const targetCanonical = canonicalizePhysical(target, true);
      if (!targetCanonical.exists || !samePhysicalPath(targetCanonical.physicalPath, path.resolve(target))) {
        throw new Error("Migration destination file became a reparse path.");
      }
      const parentAfter = verifyDestinationParent(target);
      if (!sameIdentity(parentBefore.identity, parentAfter.identity) ||
          !samePhysicalPath(parentBefore.physicalPath, parentAfter.physicalPath)) {
        throw new Error("Migration destination parent identity changed during open.");
      }

      let offset = 0;
      while (offset < contents.length) {
        const written = fs.writeSync(fd, contents, offset, contents.length - offset);
        if (written <= 0) throw new Error("Migration file write made no progress.");
        offset += written;
      }
      fs.fsyncSync(fd);
      try { fs.fchmodSync(fd, 0o600); } catch { /* Best effort on platforms without chmod semantics. */ }
    } finally {
      fs.closeSync(fd);
    }
  };

  try {
    stageRoot = fs.mkdtempSync(path.join(stagingParent, ".c2c-state-migration-"));
    stageDirectories.push(stageRoot);
    if (containsPath(sourceRoot, stageRoot) || containsPath(destinationRoot, stageRoot)) {
      throw new Error("Staging path overlaps a migration authority.");
    }

    const stagedEntries = [
      ...initialPlan.pending.map((entry) => ({ relativePath: entry.relativePath, contents: entry.contents })),
      { relativePath: MIGRATION_MARKER, contents: markerContents },
    ];
    const stagedByRelativePath = new Map<string, string>();
    for (const staged of stagedEntries) {
      let stageDirectory = stageRoot;
      for (const segment of path.dirname(staged.relativePath).split(path.sep).filter((part) => part !== ".")) {
        stageDirectory = path.join(stageDirectory, segment);
        if (!stageDirectories.includes(stageDirectory)) {
          fs.mkdirSync(stageDirectory, { mode: 0o700 });
          stageDirectories.push(stageDirectory);
        }
      }
      const stagedFile = path.join(stageRoot, staged.relativePath);
      stageFiles.push(stagedFile);
      fs.writeFileSync(stagedFile, staged.contents, { flag: "wx", mode: 0o600 });
      stagedByRelativePath.set(staged.relativePath, stagedFile);
    }

    const currentDestination = canonicalizePhysical(destinationPath, true);
    if (!samePhysicalPath(currentDestination.physicalPath, destinationRoot)) {
      throw new Error("Migration destination physical path changed after preflight.");
    }
    const commitPlan = preflight(destinationRoot);
    const samePlan = initialPlan.pending.length === commitPlan.pending.length &&
      initialPlan.pending.every((entry, index) => entry.relativePath === commitPlan.pending[index]?.relativePath) &&
      initialPlan.alreadyPresent.length === commitPlan.alreadyPresent.length &&
      initialPlan.alreadyPresent.every((entry, index) => entry === commitPlan.alreadyPresent[index]);
    if (!samePlan) throw new Error("Migration destination changed after preflight.");

    const beforeCommit = canonicalizePhysical(destinationPath, true);
    if (!samePhysicalPath(beforeCommit.physicalPath, destinationRoot)) {
      throw new Error("Migration destination physical path changed before commit.");
    }
    ensureDestinationDirectory(destinationRoot);

    const copied: string[] = [];
    for (const entry of commitPlan.pending) {
      const destinationFile = path.join(destinationRoot, entry.relativePath);
      ensureDestinationDirectory(path.dirname(destinationFile));
      const recheckedDestination = canonicalizePhysical(destinationPath, true);
      if (!samePhysicalPath(recheckedDestination.physicalPath, destinationRoot)) {
        throw new Error("Migration destination physical path changed during commit.");
      }
      writeCommittedFile(destinationFile, stagedByRelativePath.get(entry.relativePath)!);
      copied.push(entry.relativePath);
    }

    const finalDestination = canonicalizePhysical(destinationPath, true);
    if (!samePhysicalPath(finalDestination.physicalPath, destinationRoot)) {
      throw new Error("Migration destination physical path changed before marker commit.");
    }
    writeCommittedFile(markerPath, stagedByRelativePath.get(MIGRATION_MARKER)!);
    return {
      sourceRoot,
      destinationRoot,
      copied,
      alreadyPresent: commitPlan.alreadyPresent,
      markerPath,
    };
  } catch {
    const filesRestored = cleanupCreatedFiles(committedDestinationFiles);
    const directoriesRestored = cleanupCreatedDirectories(createdDestinationDirectories);
    if (!filesRestored || !directoriesRestored) {
      throw new Error("Migration commit failed and destination rollback could not be verified.");
    }
    throw new Error("Migration failed; destination was restored to its pre-migration state.");
  } finally {
    if (stageRoot) cleanupExact(stageFiles, stageDirectories);
  }
}
