import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  approveLevel3Request,
  createLevel3Request,
  getLevel3Request,
  setLevel3Enabled,
} from "../src/execution/level3-approval.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import type { ExecutionJob } from "../src/execution/job-types.js";
import { setPermission } from "../src/permission/store.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const CLIENT_ID = "f01-script-replacement-client";
const POWERSHELL = process.env.C2C_TEST_PWSH ?? path.join(process.env.USERPROFILE ?? "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
const CMD = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe");
const PYTHON = process.env.C2C_TEST_PYTHON ?? path.join(process.env.LOCALAPPDATA ?? "", "hermes/hermes-agent/venv/Scripts/python.exe");
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  isolateStateDir();
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

interface EntrypointCase {
  name: string;
  executable: string;
  entryFile: string;
  engine: "powershell" | "cmd" | "program";
  command?: string;
  args?: string[];
  sourceFor(marker: "markerA.txt" | "markerB.txt", value: "A" | "B"): string;
}

const ENTRYPOINTS: EntrypointCase[] = [
  {
    name: "PowerShell call operator",
    engine: "powershell",
    executable: POWERSHELL,
    entryFile: "entry.ps1",
    command: "& './entry.ps1'",
    sourceFor: (marker, value) => `[System.IO.File]::WriteAllText('${marker}', '${value}')\n`,
  },
  {
    name: "PowerShell CMD external file",
    engine: "powershell",
    executable: POWERSHELL,
    entryFile: "entry.cmd",
    command: "& './entry.cmd'",
    sourceFor: (marker, value) => `@echo off\r\n> \"${marker}\" echo ${value}\r\n`,
  },
  {
    name: "PowerShell Start-Process FilePath",
    engine: "powershell",
    executable: POWERSHELL,
    entryFile: "start-process-entry.cmd",
    command: "Start-Process -FilePath './start-process-entry.cmd' -Wait",
    sourceFor: (marker, value) => `@echo off\r\n> \"${marker}\" echo ${value}\r\n`,
  },
  {
    name: "CMD call command",
    engine: "cmd",
    executable: CMD,
    entryFile: "entry.cmd",
    command: "call entry.cmd",
    sourceFor: (marker, value) => `@echo off\r\n> "${marker}" echo ${value}\r\n`,
  },
  {
    name: "Python script argv",
    engine: "program",
    executable: PYTHON,
    entryFile: "entry.py",
    args: ["entry.py"],
    sourceFor: (marker, value) => `from pathlib import Path\nPath("${marker}").write_text("${value}", encoding="utf-8")\n`,
  },
  {
    name: "Node script argv",
    engine: "program",
    executable: process.execPath,
    entryFile: "entry.js",
    args: ["entry.js"],
    sourceFor: (marker, value) => `require("node:fs").writeFileSync("${marker}", "${value}")\n`,
  },
  {
    name: "Node ordinary-file argv with CommonJS",
    engine: "program",
    executable: process.execPath,
    entryFile: "entry.custom",
    args: ["entry.custom"],
    sourceFor: (marker, value) => `require("node:fs").writeFileSync("${marker}", "${value}")\n`,
  },
];

class CountingNativeRunner implements ExecutionRunner {
  starts = 0;
  readonly diagnostics: string[] = [];
  private readonly native: WindowsNativeExecutionRunner;

  constructor(options: ConstructorParameters<typeof WindowsNativeExecutionRunner>[0] = {}) {
    this.native = new WindowsNativeExecutionRunner(options);
  }

  start(
    request: Parameters<ExecutionRunner["start"]>[0],
    callbacks: Parameters<ExecutionRunner["start"]>[1],
  ) {
    this.starts += 1;
    return this.native.start(request, {
      ...callbacks,
      onDiagnostic: (message) => {
        this.diagnostics.push(message);
        callbacks.onDiagnostic?.(message);
      },
    });
  }
}

function specFor(entrypoint: EntrypointCase) {
  const common = {
    repositoryPath: ".",
    executable: entrypoint.executable,
    cwd: ".",
    timeoutSeconds: 20,
    materials: [] as string[],
  };
  if (entrypoint.engine === "program") {
    return { ...common, engine: "program" as const, args: [...entrypoint.args!] };
  }
  return { ...common, engine: entrypoint.engine, command: entrypoint.command! };
}

function approveRequest(workspace: Workspace, request: ReturnType<typeof createLevel3Request>) {
  const record = getLevel3Request(workspace.id, request.requestId);
  expect(record).not.toBeNull();
  if (record?.status === "approved") return record;
  const options: { risk: "development"; allowDynamic?: true } = { risk: "development" };
  if (record?.spec.entryBinding?.kind === "dynamic_code") options.allowDynamic = true;
  return approveLevel3Request(workspace, request.requestId, request.digest, true, options);
}

async function waitForFinishedJob(supervisor: ExecutionSupervisor, jobId: string): Promise<ExecutionJob> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = supervisor.store.get(jobId);
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`NATIVE_JOB_TIMEOUT: ${jobId}`);
}

describe.skipIf(process.platform !== "win32")("F-01 approved script replacement through Supervisor and Native", () => {
  for (const entrypoint of ENTRYPOINTS) {
    it(`${entrypoint.name}: runs approved A and rejects replacement B before Native launch`, async () => {
      if (!fs.existsSync(entrypoint.executable)) throw new Error("BLOCKED_SCRIPT_INTERPRETER_MISSING: set C2C_TEST_PWSH/C2C_TEST_PYTHON to installed interpreters");
      const root = makeTmpDir(`v13-script-replacement-${entrypoint.entryFile.replace(/\W/g, "-")}`);
      makeGitRepo(root);
      // The enclosing source checkout is ESM. This fixture explicitly tests
      // ordinary CommonJS entry files, including an unknown extension.
      write(root, "package.json", JSON.stringify({ type: "commonjs" }));
      const workspace = new Workspace(root);
      setPermission(workspace.id, "level1");
      setLevel3Enabled(workspace.id, true, true);

      const scriptPath = write(root, entrypoint.entryFile, entrypoint.sourceFor("markerA.txt", "A"));
      const markerA = path.join(root, "markerA.txt");
      const markerB = path.join(root, "markerB.txt");
      const runner = new CountingNativeRunner();
      const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });

      try {
        const requestA = createLevel3Request(workspace, CLIENT_ID, specFor(entrypoint));
        const approvedA = approveRequest(workspace, requestA);
        expect(approvedA.snapshot.materials.map((material) => material.relativePath)).toContain(entrypoint.entryFile);

        const startedA = supervisor.startLevel3({
          requestId: requestA.requestId,
          digest: requestA.digest,
          oauthClientId: CLIENT_ID,
          scopes: ["execution.level3"],
          idempotencyKey: `f01-script-replacement-${entrypoint.entryFile}-a`,
        });
        expect(startedA.ok, JSON.stringify(startedA)).toBe(true);
        if (!startedA.ok) throw new Error(startedA.error);

        const completedA = await waitForFinishedJob(supervisor, startedA.job.jobId);
        expect(completedA.state, JSON.stringify({ failureCode: completedA.failureCode })).toBe("succeeded");
        expect(completedA.exitCode).toBe(0);
        expect(fs.readFileSync(markerA, "utf8").trimEnd()).toBe("A");
        expect(runner.starts).toBe(1);

        const requestBeforeReplacement = createLevel3Request(workspace, CLIENT_ID, specFor(entrypoint));
        approveRequest(workspace, requestBeforeReplacement);
        fs.writeFileSync(scriptPath, entrypoint.sourceFor("markerB.txt", "B"));
        expect(fs.existsSync(markerB)).toBe(false);

        const rejectedB = supervisor.startLevel3({
          requestId: requestBeforeReplacement.requestId,
          digest: requestBeforeReplacement.digest,
          oauthClientId: CLIENT_ID,
          scopes: ["execution.level3"],
          idempotencyKey: `f01-script-replacement-${entrypoint.entryFile}-b`,
        });

        expect(rejectedB).toEqual({ ok: false, error: "LEVEL3_MATERIAL_CHANGED" });
        expect(fs.existsSync(markerB)).toBe(false);
        expect(runner.starts).toBe(1);
      } finally {
        await supervisor.shutdown();
      }
    }, 40_000);
  }

  it.each([
    ["PowerShell CMD external file", "f01-native-cmd-replacement-0001", "cmd"],
    ["PowerShell Start-Process FilePath", "f01-native-start-process-replacement-0001", "start-process"],
  ])("%s target: Native rejects replacement after the Supervisor snapshot", async (entrypointName, idempotencyKey, name) => {
    if (!fs.existsSync(POWERSHELL)) throw new Error("BLOCKED_SCRIPT_INTERPRETER_MISSING: set C2C_TEST_PWSH to an installed PowerShell 7 executable");
    const entrypoint = ENTRYPOINTS.find((item) => item.name === entrypointName)!;
    const root = makeTmpDir(`v13-script-replacement-native-${name}`);
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ type: "commonjs" }));
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
    setLevel3Enabled(workspace.id, true, true);

    const scriptPath = write(root, entrypoint.entryFile, entrypoint.sourceFor("markerA.txt", "A"));
    const markerA = path.join(root, "markerA.txt");
    const markerB = path.join(root, "markerB.txt");
    const request = createLevel3Request(workspace, CLIENT_ID, specFor(entrypoint));
    const approved = approveRequest(workspace, request);
    expect(approved.snapshot.materials.map((material) => material.relativePath)).toContain(entrypoint.entryFile);

    let nativeRequestWriteReached = false;
    const runner = new CountingNativeRunner({ beforeHelperRequestWrite: () => {
      nativeRequestWriteReached = true;
      fs.writeFileSync(scriptPath, entrypoint.sourceFor("markerB.txt", "B"));
    } });
    const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
    try {
      const started = supervisor.startLevel3({
        requestId: request.requestId,
        digest: request.digest,
        oauthClientId: CLIENT_ID,
        scopes: ["execution.level3"],
        idempotencyKey,
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) throw new Error(started.error);

      const completed = await waitForFinishedJob(supervisor, started.job.jobId);
      expect(nativeRequestWriteReached).toBe(true);
      expect(completed.state, JSON.stringify({ failureCode: completed.failureCode, exitCode: completed.exitCode })).toBe("interrupted");
      expect(completed.failureCode).toBe("HELPER_CLEANUP_UNCONFIRMED");
      expect(runner.diagnostics.some((message) => message.includes("lock-execution-materials"))).toBe(true);
      expect(fs.existsSync(markerA)).toBe(false);
      expect(fs.existsSync(markerB)).toBe(false);
    } finally {
      await supervisor.shutdown();
    }
  }, 40_000);

  it.each([
    ["PowerShell Start-Process", "powershell", POWERSHELL, "Start-Process -FilePath './target.exe' -Wait"],
    ["CMD direct", "cmd", CMD, "./target.exe"],
    ["CMD call", "cmd", CMD, "call ./target.exe"],
    ["CMD start", "cmd", CMD, 'start "" "./target.exe"'],
  ] as const)("%s .exe target: Native rejects the changed material before launch", async (name, engine, executable, command) => {
    if (!fs.existsSync(executable)) throw new Error(`BLOCKED_SCRIPT_INTERPRETER_MISSING: set the test interpreter for ${name}`);
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const root = makeTmpDir(`v13-script-replacement-native-${key}-exe`);
    makeGitRepo(root);
    write(root, "package.json", JSON.stringify({ type: "commonjs" }));
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level1");
    setLevel3Enabled(workspace.id, true, true);

    const targetPath = write(root, "target.exe", "inert invalid executable fixture A\n");
    const request = createLevel3Request(workspace, CLIENT_ID, {
      engine,
      repositoryPath: ".",
      executable,
      command,
      cwd: ".",
      timeoutSeconds: 20,
      materials: [],
    });
    const approved = approveRequest(workspace, request);
    expect(approved.snapshot.materials.map((material) => material.relativePath)).toContain("target.exe");

    let nativeRequestWriteReached = false;
    const runner = new CountingNativeRunner({ beforeHelperRequestWrite: () => {
      nativeRequestWriteReached = true;
      fs.writeFileSync(targetPath, "inert invalid executable fixture B\n");
    } });
    const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
    try {
      const started = supervisor.startLevel3({
        requestId: request.requestId,
        digest: request.digest,
        oauthClientId: CLIENT_ID,
        scopes: ["execution.level3"],
        idempotencyKey: `f01-native-${key}-exe-replacement-0001`,
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) throw new Error(started.error);

      const completed = await waitForFinishedJob(supervisor, started.job.jobId);
      expect(nativeRequestWriteReached).toBe(true);
      expect(completed.state, JSON.stringify({ failureCode: completed.failureCode, exitCode: completed.exitCode })).toBe("interrupted");
      expect(completed.failureCode).toBe("HELPER_CLEANUP_UNCONFIRMED");
      expect(runner.diagnostics.some((message) => message.includes("lock-execution-materials"))).toBe(true);
    } finally {
      await supervisor.shutdown();
    }
  }, 40_000);
});