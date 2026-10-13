import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { setPermission } from "../src/permission/store.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { readGitJobPlan } from "../src/execution/git-job-plan.js";
import { previewGitReview, hasGitReviewHold } from "../src/execution/git-review-hold.js";
import { planGitWrite, approveGitRepository, previewGitRepositoryApproval, type GitWriteOperation } from "../src/git-write/index.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const RACE_TEST_ENABLED = process.platform === "win32" && process.env.C2C_V13_GIT_EXTERNAL_RACE_TEST === "1";
const MAX_CAPTURE_BYTES = 1200;

type RacePoint = "before-helper-request" | "native-before-resume";

interface ChildObservation {
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  spawnError: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

interface RaceMutation {
  action: string;
  process: "git child process" | "node child process";
  args: string[];
  run: (gitExecutable: string) => ChildObservation;
}

interface PreparedScenario {
  name: string;
  root: string;
  operation: GitWriteOperation;
  branches: string[];
  allowedOperations: GitWriteOperation["kind"][];
  trackedPaths: string[];
  gitObservations?: Array<{ name: string; args: string[] }>;
  mutation: RaceMutation;
}

interface RaceEvidence {
  schemaVersion: 1;
  scenario: string;
  injectionPoint: RacePoint;
  root: string;
  stateDirectory: string;
  plan: {
    digest: string;
    executable: { name: string; fileIdentity: string; hash: string };
    operation: GitWriteOperation;
    before: unknown;
    snapshotMaterials: Array<{ name: string; fileIdentity: string; plannedHash: string }>;
    stagedPathsBefore: string;
    indexTreeBefore: string | null;
    refsBefore: string;
  } | null;
  injection: {
    reached: boolean;
    count: number;
    nativeEvidenceLine: string | null;
    releaseFile: string | null;
    releaseWritten: boolean;
    mutation: { action: string; process: RaceMutation["process"]; args: string[]; result: ChildObservation } | null;
    snapshotMaterialsAfterMutation: Array<{ name: string; plannedHash: string; actualHash: string | null }>;
    trackedFilesAfterMutation: Record<string, { exists: boolean; sha256: string | null; utf8: string | null }>;
  };
  job: {
    id: string | null;
    state: string | null;
    failureCode: string | null;
    exitCode: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    gitResult: unknown;
    duplicateStart: unknown;
    storedJobCount: number;
  };
  repositoryAfter: unknown;
}

function clip(value: string | null | undefined): string {
  return (value ?? "").slice(0, MAX_CAPTURE_BYTES);
}

function childObservation(result: SpawnSyncReturns<string>): ChildObservation {
  return {
    pid: result.pid ?? null,
    exitCode: result.status,
    signal: result.signal,
    spawnError: result.error ? `${result.error.name}:${(result.error as NodeJS.ErrnoException).code ?? "unknown"}` : null,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stdout: clip(result.stdout),
    stderr: clip(result.stderr),
  };
}

function controlledEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_AUTHOR_NAME: "C2C external race fixture",
    GIT_AUTHOR_EMAIL: "race-author@c2c.local",
    GIT_COMMITTER_NAME: "C2C external race fixture",
    GIT_COMMITTER_EMAIL: "race-committer@c2c.local",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(root: string, args: string[], timeout = 10_000, executable = "git"): ChildObservation {
  return childObservation(spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env: controlledEnv(),
    timeout,
    windowsHide: true,
    shell: false,
  }));
}

function requireGit(root: string, args: string[]): string {
  const result = runGit(root, args);
  if (result.exitCode !== 0 || result.spawnError) {
    throw new Error(`FIXTURE_GIT_FAILED ${args.join(" ")}: ${result.stderr || result.spawnError || result.exitCode}`);
  }
  return result.stdout.trim();
}

function runNodeWrite(target: string, content: string): ChildObservation {
  return childObservation(spawnSync(process.execPath, [
    "-e",
    "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], process.argv[2], 'utf8');",
    target,
    content,
  ], {
    cwd: path.dirname(target),
    encoding: "utf8",
    env: controlledEnv(),
    timeout: 10_000,
    windowsHide: true,
    shell: false,
  }));
}

function fileHash(file: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function snapshotMaterials(plan: ReturnType<typeof planGitWrite>, stage: "planned"): Array<{ name: string; fileIdentity: string; plannedHash: string }>;
function snapshotMaterials(plan: ReturnType<typeof planGitWrite>, stage: "actual"): Array<{ name: string; plannedHash: string; actualHash: string | null }>;
function snapshotMaterials(plan: ReturnType<typeof planGitWrite>, stage: "planned" | "actual") {
  return stage === "planned"
    ? plan.snapshotMaterials.map((material) => ({ name: path.basename(material.path), fileIdentity: material.fileIdentity, plannedHash: material.hash }))
    : plan.snapshotMaterials.map((material) => ({ name: path.basename(material.path), plannedHash: material.hash, actualHash: fileHash(material.path) }));
}

function commandCapture(root: string, args: string[]): { exitCode: number | null; output: string } {
  const result = runGit(root, args);
  return { exitCode: result.exitCode, output: clip(result.exitCode === 0 ? result.stdout : result.stderr) };
}

function trackedFileSnapshot(root: string, trackedPaths: string[]) {
  const files: Record<string, { exists: boolean; sha256: string | null; utf8: string | null }> = {};
  for (const relative of trackedPaths) {
    const absolute = path.join(root, relative);
    try {
      const bytes = fs.readFileSync(absolute);
      files[relative] = {
        exists: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        utf8: clip(bytes.toString("utf8")),
      };
    } catch {
      files[relative] = { exists: false, sha256: null, utf8: null };
    }
  }
  return files;
}

function repositorySnapshot(root: string, trackedPaths: string[], gitObservations: PreparedScenario["gitObservations"] = []): unknown {
  return {
    head: commandCapture(root, ["rev-parse", "HEAD"]),
    branch: commandCapture(root, ["branch", "--show-current"]),
    headCommit: commandCapture(root, ["show", "-s", "--format=%H%n%P%n%T%n%s", "HEAD"]),
    headTreePaths: commandCapture(root, ["ls-tree", "-r", "--name-only", "HEAD"]),
    refs: commandCapture(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/heads"]),
    status: commandCapture(root, ["status", "--porcelain=v2", "-z", "--branch"]),
    stagedPaths: commandCapture(root, ["diff", "--cached", "--name-status"]),
    gitObservations: gitObservations.map(({ name, args }) => ({ name, ...commandCapture(root, args) })),
    files: trackedFileSnapshot(root, trackedPaths),
  };
}

function prepareScenario(name: string): PreparedScenario {
  const root = makeTmpDir(`v13-f03-${name}`);
  makeGitRepo(root);
  requireGit(root, ["config", "user.name", "C2C external race fixture"]);
  requireGit(root, ["config", "user.email", "race-author@c2c.local"]);

  if (name === "add-before-helper" || name === "add-after-lock") {
    write(root, "approved-add.txt", "C2C selected file\n");
    write(root, "external-index.txt", "external staged file\n");
    const operation: GitWriteOperation = { kind: "add", paths: ["approved-add.txt"], expectedHead: requireGit(root, ["rev-parse", "HEAD"]), expectedBranch: "main" };
    return {
      name, root, operation, branches: ["main"], allowedOperations: ["add"], trackedPaths: ["approved-add.txt", "external-index.txt"],
      mutation: { action: "stage an additional file in the live index", process: "git child process", args: ["add", "--", "external-index.txt"], run: (gitExecutable) => runGit(root, ["add", "--", "external-index.txt"], name === "add-after-lock" ? 2_500 : 10_000, gitExecutable) },
    };
  }

  if (name === "commit-ref-before-helper") {
    const baseHead = requireGit(root, ["rev-parse", "HEAD"]);
    requireGit(root, ["switch", "-c", "race-external"]);
    write(root, "external-ref-data.txt", "data introduced by concurrent ref advance\n");
    requireGit(root, ["add", "external-ref-data.txt"]);
    requireGit(root, ["commit", "-m", "External ref fixture"]);
    const concurrentHead = requireGit(root, ["rev-parse", "HEAD"]);
    requireGit(root, ["switch", "main"]);
    write(root, "approved-commit.txt", "planned staged content\n");
    requireGit(root, ["add", "approved-commit.txt"]);
    const operation: GitWriteOperation = { kind: "commit", message: "C2C planned commit", expectedHead: baseHead, expectedBranch: "main" };
    return {
      name, root, operation, branches: ["main", "race-external"], allowedOperations: ["commit"],
      trackedPaths: ["approved-commit.txt", "external-ref-data.txt"],
      gitObservations: [{ name: "external ref commit remains reachable", args: ["show", "race-external:external-ref-data.txt"] }],
      mutation: {
        action: "advance refs/heads/main to a prebuilt sibling-branch commit without touching the worktree or index",
        process: "git child process",
        args: ["update-ref", "refs/heads/main", concurrentHead, baseHead],
        run: (gitExecutable) => runGit(root, ["update-ref", "refs/heads/main", concurrentHead, baseHead], 10_000, gitExecutable),
      },
    };
  }

  if (name === "commit-index-after-lock") {
    write(root, "approved-commit.txt", "planned staged content\n");
    write(root, "external-index.txt", "external staged file\n");
    requireGit(root, ["add", "--", "approved-commit.txt"]);
    const operation: GitWriteOperation = { kind: "commit", message: "C2C planned commit", expectedHead: requireGit(root, ["rev-parse", "HEAD"]), expectedBranch: "main" };
    return {
      name, root, operation, branches: ["main"], allowedOperations: ["commit"], trackedPaths: ["approved-commit.txt", "external-index.txt"],
      mutation: { action: "stage an additional file while Native holds its execution materials", process: "git child process", args: ["add", "--", "external-index.txt"], run: (gitExecutable) => runGit(root, ["add", "--", "external-index.txt"], 2_500, gitExecutable) },
    };
  }

  if (name === "switch-dirty-worktree-before-helper" || name === "switch-head-after-lock") {
    const baseHead = requireGit(root, ["rev-parse", "HEAD"]);
    requireGit(root, ["switch", "-c", "race-target"]);
    write(root, "hello.txt", "approved target branch content\n");
    requireGit(root, ["add", "hello.txt"]);
    requireGit(root, ["commit", "-m", "Target branch content"]);
    requireGit(root, ["switch", "main"]);
    requireGit(root, ["switch", "-c", "race-external", "main"]);
    write(root, "hello.txt", "external branch content\n");
    requireGit(root, ["add", "hello.txt"]);
    requireGit(root, ["commit", "-m", "External branch content"]);
    requireGit(root, ["switch", "main"]);
    const operation: GitWriteOperation = { kind: "switch", name: "race-target", expectedHead: baseHead, expectedBranch: "main" };
    if (name === "switch-dirty-worktree-before-helper") {
      const content = "external uncommitted worktree marker\n";
      return {
        name, root, operation, branches: ["main", "race-target", "race-external"], allowedOperations: ["switch"], trackedPaths: ["hello.txt"],
        mutation: {
          action: "write a conflicting uncommitted tracked-file change from a second process",
          process: "node child process",
          args: ["-e", "writeFileSync(hello.txt, external marker)"],
          run: () => runNodeWrite(path.join(root, "hello.txt"), content),
        },
      };
    }
    return {
      name, root, operation, branches: ["main", "race-target", "race-external"], allowedOperations: ["switch"], trackedPaths: ["hello.txt"],
      mutation: { action: "switch HEAD and the tracked worktree to a different clean branch", process: "git child process", args: ["switch", "--no-guess", "--", "race-external"], run: (gitExecutable) => runGit(root, ["switch", "--no-guess", "--", "race-external"], 2_500, gitExecutable) },
    };
  }

  throw new Error(`Unknown F-03 scenario: ${name}`);
}

function approveScenario(scenario: PreparedScenario): Workspace {
  const workspace = new Workspace(scenario.root);
  setPermission(workspace.id, "level1");
  const policy = {
    allowedRemotes: [],
    allowedBranches: scenario.branches,
    allowedOperations: scenario.allowedOperations,
  };
  const preview = previewGitRepositoryApproval(workspace, ".", policy);
  approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest);
  return workspace;
}

async function waitForFinishedGitJob(supervisor: ExecutionSupervisor, jobId: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = supervisor.store.get(jobId);
    if (job?.finishedAt && job.gitResult) return job;
    // This waits for job completion only; the race itself is controlled by the explicit Native gate.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("V13_GIT_EXTERNAL_RACE_COMPLETION_TIMEOUT");
}

async function runRace(scenarioName: string, injectionPoint: RacePoint): Promise<{ evidence: RaceEvidence; evidenceFile: string }> {
  const stateDirectory = isolateStateDir();
  const scenario = prepareScenario(scenarioName);
  const workspace = approveScenario(scenario);
  const evidenceDirectory = makeTmpDir(`v13-f03-evidence-${scenarioName}`);
  const evidenceFile = path.join(evidenceDirectory, "result.json");
  const releaseDirectory = makeTmpDir(`v13-f03-release-${scenarioName}`);
  const releaseFile = path.join(releaseDirectory, "resume.release");
  // write-tree populates the index cache-tree extension. Do this observation
  // before the approved plan captures index bytes, not after that snapshot.
  const indexTreeBefore = scenario.operation.kind === "commit" ? requireGit(scenario.root, ["write-tree"]) : null;
  const planned = planGitWrite(workspace, ".", scenario.operation);
  const stagedPathsBefore = commandCapture(scenario.root, ["diff", "--cached", "--name-status"]).output;
  const refsBefore = commandCapture(scenario.root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/heads"]).output;
  const evidence: RaceEvidence = {
    schemaVersion: 1,
    scenario: scenarioName,
    injectionPoint,
    root: scenario.root,
    stateDirectory,
    plan: {
      digest: planned.digest,
      executable: { name: path.basename(planned.executable), fileIdentity: planned.executableFileIdentity, hash: planned.executableHash },
      operation: planned.operation,
      before: planned.before,
      snapshotMaterials: snapshotMaterials(planned, "planned"),
      stagedPathsBefore,
      indexTreeBefore,
      refsBefore,
    },
    injection: {
      reached: false,
      count: 0,
      nativeEvidenceLine: null,
      releaseFile: injectionPoint === "native-before-resume" ? releaseFile : null,
      releaseWritten: false,
      mutation: null,
      snapshotMaterialsAfterMutation: [],
      trackedFilesAfterMutation: {},
    },
    job: { id: null, state: null, failureCode: null, exitCode: null, startedAt: null, finishedAt: null, gitResult: null, duplicateStart: null, storedJobCount: 0 },
    repositoryAfter: null,
  };

  const inject = (line: string | null) => {
    evidence.injection.reached = true;
    evidence.injection.count += 1;
    evidence.injection.nativeEvidenceLine = line;
    evidence.injection.mutation = {
      action: scenario.mutation.action,
      process: scenario.mutation.process,
      args: scenario.mutation.args,
      result: scenario.mutation.run(planned.executable),
    };
    evidence.injection.snapshotMaterialsAfterMutation = snapshotMaterials(planned, "actual");
    evidence.injection.trackedFilesAfterMutation = trackedFileSnapshot(scenario.root, scenario.trackedPaths);
  };
  const nativeOptions = {
    beforeHelperRequestWrite: () => {
      if (injectionPoint === "before-helper-request") inject(null);
    },
    ...(injectionPoint === "native-before-resume" ? {
      helperBeforeResumeTest: {
        releaseFile,
        phase: "suspended" as const,
        onSuspended: (line: string) => {
          try {
            inject(line);
          } finally {
            fs.writeFileSync(releaseFile, "resume\n", { flag: "wx" });
            evidence.injection.releaseWritten = true;
          }
        },
      },
    } : {}),
  };
  const native = new WindowsNativeExecutionRunner(nativeOptions);
  const runner: ExecutionRunner = { start: (request, callbacks) => native.start(request, callbacks) };
  const supervisor = new ExecutionSupervisor(workspace, { runner });
  try {
    const idempotencyKey = `v13-f03-${scenarioName}-0123456789`;
    const request = {
      repositoryPath: ".",
      operation: scenario.operation,
      timeoutSeconds: 45,
      oauthClientId: "v13-external-race-fixture",
      scopes: ["git.write"],
      idempotencyKey,
    };
    const started = supervisor.startGitWrite(request);
    if (!started.ok) throw new Error(`V13_GIT_EXTERNAL_RACE_START_FAILED:${started.error}`);
    if (started.job.authorization?.type !== "git") throw new Error("V13_GIT_EXTERNAL_RACE_AUTHORIZATION_MISSING");
    const persisted = readGitJobPlan(workspace, started.job.authorization.requestId, started.job.authorization.digest);
    evidence.plan = {
      digest: persisted.digest,
      executable: { name: path.basename(persisted.executable), fileIdentity: persisted.executableFileIdentity, hash: persisted.executableHash },
      operation: persisted.operation,
      before: persisted.before,
      snapshotMaterials: snapshotMaterials(persisted, "planned"),
      stagedPathsBefore,
    indexTreeBefore,
    refsBefore,
    };
    // The persisted plan is the actual execution authority. Observer commands
    // can refresh index cache metadata; they are not a second approval digest.
    expect(persisted.before.head).toBe(scenario.operation.expectedHead);
    expect(persisted.before.branch).toBe(scenario.operation.expectedBranch);
    if (!started.job.finishedAt) {
      const finished = await waitForFinishedGitJob(supervisor, started.job.jobId);
      evidence.job = {
        id: finished.jobId,
        state: finished.state,
        failureCode: finished.failureCode,
        exitCode: finished.exitCode,
        startedAt: finished.startedAt,
        finishedAt: finished.finishedAt,
        gitResult: finished.gitResult ?? null,
        duplicateStart: null,
        storedJobCount: supervisor.store.listAll().length,
      };
    } else {
      const finished = supervisor.store.get(started.job.jobId)!;
      evidence.job = {
        id: finished.jobId,
        state: finished.state,
        failureCode: finished.failureCode,
        exitCode: finished.exitCode,
        startedAt: finished.startedAt,
        finishedAt: finished.finishedAt,
        gitResult: finished.gitResult ?? null,
        duplicateStart: null,
        storedJobCount: supervisor.store.listAll().length,
      };
    }
    const duplicate = supervisor.startGitWrite(request);
    evidence.job.duplicateStart = duplicate.ok ? { ok: true, duplicate: duplicate.duplicate, jobId: duplicate.job.jobId } : { ok: false, error: duplicate.error };
    evidence.job.storedJobCount = supervisor.store.listAll().length;
    evidence.repositoryAfter = repositorySnapshot(scenario.root, scenario.trackedPaths);
    expect(evidence.job.state).toBe("failed");
    expect(evidence.injection.mutation?.result.exitCode).toBe(0);
    expect(evidence.job.failureCode).toBe(scenarioName === "commit-ref-before-helper" || scenarioName === "switch-dirty-worktree-before-helper" ? "NONZERO_EXIT" : "GIT_STATE_CHANGED");
    const actualHead = requireGit(scenario.root, ["rev-parse", "HEAD"]);
    if (scenarioName === "commit-ref-before-helper") {
      expect(actualHead).toBe(requireGit(scenario.root, ["rev-parse", "race-external"]));
      expect(requireGit(scenario.root, ["show", "HEAD:external-ref-data.txt"])).toBe("data introduced by concurrent ref advance");
    } else if (scenarioName === "switch-head-after-lock") {
      expect(requireGit(scenario.root, ["branch", "--show-current"])).toBe("race-external");
      expect(fs.readFileSync(path.join(scenario.root, "hello.txt"), "utf8")).toBe("external branch content\n");
    } else {
      expect(actualHead).toBe(scenario.operation.expectedHead);
      if (scenarioName === "switch-dirty-worktree-before-helper")
        expect(fs.readFileSync(path.join(scenario.root, "hello.txt"), "utf8")).toBe("external uncommitted worktree marker\n");
    }
    expect(supervisor.startGitWrite({ ...request, idempotencyKey: `${idempotencyKey}-fresh` })).toMatchObject({ ok: false, error: "GIT_REVIEW_REQUIRED" });
    const review = previewGitReview(workspace, ".");
    expect(review?.hold.jobId).toBe(evidence.job.id);
    const acknowledged = spawnSync(process.execPath, [path.resolve("bin/c2c.js"), "git-write", "review", "-w", scenario.root,
      "-r", ".", "--job", evidence.job.id!, "--digest", review!.digest, "--approve", "--json"],
      { env: { ...process.env, C2C_STATE_DIR: stateDirectory }, windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 4096 });
    expect(acknowledged.status, acknowledged.stderr || acknowledged.stdout).toBe(0);
    expect(JSON.parse(acknowledged.stdout)).toMatchObject({ ok: true, acknowledged: evidence.job.id });
    expect(hasGitReviewHold(workspace, ".")).toBe(false);
    return { evidence, evidenceFile };
  } finally {
    try {
      await supervisor.shutdown();
    } finally {
      fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    }
  }
}

describe.skipIf(!RACE_TEST_ENABLED)("V1.3 external Git race evidence (isolated Windows Native opt-in)", () => {
  it("records add index races before helper receipt and while Native holds material handles", async () => {
    const before = await runRace("add-before-helper", "before-helper-request");
    const afterLock = await runRace("add-after-lock", "native-before-resume");
    expect(before.evidence.injection.reached).toBe(true);
    expect(before.evidence.injection.count).toBe(1);
    expect(before.evidence.injection.mutation?.result.exitCode).toBe(0);
    expect(afterLock.evidence.injection.nativeEvidenceLine).toMatch(/^C2C_EXECUTION_HELPER_SUSPENDED:\d+:suspended$/);
    expect(afterLock.evidence.injection.releaseWritten).toBe(true);
    expect(afterLock.evidence.injection.count).toBe(1);
    expect(afterLock.evidence.injection.mutation?.result.spawnError === null || afterLock.evidence.injection.mutation?.result.timedOut).toBe(true);
    for (const result of [before, afterLock]) {
      expect(result.evidence.job.finishedAt).not.toBeNull();
      expect(result.evidence.job.gitResult).not.toBeNull();
      expect(result.evidence.job.duplicateStart).toMatchObject({ ok: true, duplicate: true, jobId: result.evidence.job.id });
      expect(result.evidence.job.storedJobCount).toBe(1);
      expect(fs.existsSync(result.evidenceFile)).toBe(true);
    }
  }, 180_000);

  it("records commit behavior when refs or the index change outside the confirmed plan", async () => {
    const refAdvance = await runRace("commit-ref-before-helper", "before-helper-request");
    const indexWrite = await runRace("commit-index-after-lock", "native-before-resume");
    expect(refAdvance.evidence.injection.count).toBe(1);
    expect(refAdvance.evidence.injection.mutation?.result.exitCode).toBe(0);
    expect(indexWrite.evidence.injection.nativeEvidenceLine).toMatch(/^C2C_EXECUTION_HELPER_SUSPENDED:\d+:suspended$/);
    expect(indexWrite.evidence.injection.releaseWritten).toBe(true);
    expect(indexWrite.evidence.injection.count).toBe(1);
    expect(indexWrite.evidence.injection.mutation?.result.spawnError === null || indexWrite.evidence.injection.mutation?.result.timedOut).toBe(true);
    for (const result of [refAdvance, indexWrite]) {
      expect(result.evidence.job.finishedAt).not.toBeNull();
      expect(result.evidence.job.gitResult).not.toBeNull();
      expect(result.evidence.job.duplicateStart).toMatchObject({ ok: true, duplicate: true, jobId: result.evidence.job.id });
      expect(result.evidence.job.storedJobCount).toBe(1);
      expect(fs.existsSync(result.evidenceFile)).toBe(true);
    }
  }, 180_000);

  it("records switch refusal and HEAD/worktree races without assuming the Git outcome", async () => {
    const dirtyWorktree = await runRace("switch-dirty-worktree-before-helper", "before-helper-request");
    const headSwitch = await runRace("switch-head-after-lock", "native-before-resume");
    expect(dirtyWorktree.evidence.injection.count).toBe(1);
    expect(dirtyWorktree.evidence.injection.mutation?.result.exitCode).toBe(0);
    expect(headSwitch.evidence.injection.nativeEvidenceLine).toMatch(/^C2C_EXECUTION_HELPER_SUSPENDED:\d+:suspended$/);
    expect(headSwitch.evidence.injection.releaseWritten).toBe(true);
    expect(headSwitch.evidence.injection.count).toBe(1);
    expect(headSwitch.evidence.injection.mutation?.result.spawnError === null || headSwitch.evidence.injection.mutation?.result.timedOut).toBe(true);
    for (const result of [dirtyWorktree, headSwitch]) {
      expect(result.evidence.job.finishedAt).not.toBeNull();
      expect(result.evidence.job.gitResult).not.toBeNull();
      expect(result.evidence.job.duplicateStart).toMatchObject({ ok: true, duplicate: true, jobId: result.evidence.job.id });
      expect(result.evidence.job.storedJobCount).toBe(1);
      expect(fs.existsSync(result.evidenceFile)).toBe(true);
    }
  }, 180_000);

  it("checks pull_ff_only planning against a fixed approved HTTPS remote without performing network I/O", () => {
    isolateStateDir();
    const root = makeTmpDir("v13-f03-pull-plan");
    makeGitRepo(root);
    requireGit(root, ["config", "user.name", "C2C external race fixture"]);
    requireGit(root, ["config", "user.email", "race-author@c2c.local"]);
    const remoteUrl = "https://example.invalid/c2c-f03.git";
    requireGit(root, ["remote", "add", "origin", remoteUrl]);
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
    const policy = {
      allowedRemotes: [{ name: "origin", url: remoteUrl }],
      allowedBranches: ["main"],
      allowedOperations: ["pull_ff_only"] as GitWriteOperation["kind"][],
    };
    const preview = previewGitRepositoryApproval(workspace, ".", policy);
    approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest);
    const plan = planGitWrite(workspace, ".", {
      kind: "pull_ff_only",
      remote: "origin",
      branch: "main",
      expectedHead: requireGit(root, ["rev-parse", "HEAD"]),
      expectedBranch: "main",
    });
    expect(plan.remoteBinding).toEqual({ name: "origin", url: remoteUrl });
    expect(plan.args).toContain("--ff-only");
    expect(plan.args).toContain("--no-rebase");
    expect(plan.args).toContain("--no-autostash");
    expect(plan.args).toContain("origin");
    expect(plan.args).toContain("refs/heads/main");
    expect(plan.args.some((argument) => argument.startsWith("file://"))).toBe(false);
  });
});
