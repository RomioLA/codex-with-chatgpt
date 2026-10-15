import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  approveLevel3Request,
  completeLevel3Request,
  consumeLevel3Request,
  createLevel3Request,
  getLevel3Request,
  getLevel3RequestPreview,
  isLevel3Enabled,
  listLevel3Requests,
  resolveConsumedLevel3Request,
  revokeLevel3Request,
  setLevel3Enabled,
  type Level3Spec,
} from "../src/execution/level3-approval.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const CLIENT_ID = "level3-test-client";

interface Fixture {
  root: string;
  repo: string;
  workspace: Workspace;
  executable: string;
  material: string;
}

function fixture(name: string): Fixture {
  const root = makeTmpDir(`level3-${name}`);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  makeGitRepo(repo);
  const executable = write(root, "tools/program.exe", "level3 test executable\n");
  const material = write(repo, "src/task.txt", "approved material\n");
  return { root, repo, workspace: new Workspace(root), executable, material };
}

function directSpec(f: Fixture, overrides: Partial<Extract<Level3Spec, { engine: "program" }>> = {}): Level3Spec {
  return {
    engine: "program",
    repositoryPath: "repo",
    executable: f.executable,
    args: ["--mode", "check"],
    cwd: "repo",
    timeoutSeconds: 60,
    materials: ["repo/src/task.txt"],
    ...overrides,
  };
}

function enabled(f: Fixture): void {
  setLevel3Enabled(f.workspace.id, true, true);
}

describe("Level 3 one-time local approval", () => {
  let originalStateDirectory: string | undefined;

  beforeEach(() => {
    originalStateDirectory = process.env.C2C_STATE_DIR;
    isolateStateDir();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalStateDirectory === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDirectory;
  });

  it("stays disabled by default and returns a safe pending preview", () => {
    const f = fixture("default-disabled");
    expect(isLevel3Enabled(f.workspace.id)).toBe(false);
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f))).toThrowError(
      expect.objectContaining({ code: "LEVEL3_DISABLED" }),
    );

    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(pending.status).toBe("pending");
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(1);
    const preview = getLevel3RequestPreview(f.workspace.id, pending.requestId, CLIENT_ID)!;
    expect(preview.spec.engine).toBe("program");
    expect("snapshot" in preview).toBe(false);
    expect("manifestPath" in preview).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("fileIdentity");
    cleanup(f.root);
  });

  it("keeps the Level 3 feature switch enabled across a fresh runtime process", () => {
    const f = fixture("persistent-feature-switch");
    enabled(f);
    expect(isLevel3Enabled(f.workspace.id)).toBe(true);

    const sourceUrl = pathToFileURL(path.resolve("src/execution/level3-approval.ts")).href;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import { isLevel3Enabled } from ${JSON.stringify(sourceUrl)}; console.log(JSON.stringify(isLevel3Enabled(${JSON.stringify(f.workspace.id)})));`,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: process.env.C2C_STATE_DIR },
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(child.stdout.trim()).toBe("true");
    cleanup(f.root);
  });

  it("binds direct argv to one client and allows one launch resolution", () => {
    const f = fixture("single-use");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    const approved = approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    expect(approved.status).toBe("approved");
    expect(approved.manifestPath).toBeTruthy();

    const consumed = consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(consumed.request.requestId).toBe(pending.requestId);
    expect(consumed.request.spec.timeoutSeconds).toBe(60);
    expect(consumed.repository.identity).toBe(approved.repositoryIdentity);
    expect(consumed.genericCommand.mode).toBe("direct");
    expect(consumed.genericCommand.args).toEqual(["--mode", "check"]);
    expect(consumed.genericCommand.materials).toHaveLength(1);

    const launch = resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(launch.request.status).toBe("launching");
    expect(launch.genericCommand.approvalManifest).toBe(approved.manifestPath);
    expect(() => resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_ALREADY_USED" }),
    );
    expect(() => consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_ALREADY_USED" }),
    );
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "completed")).toBe(true);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("completed");
    cleanup(f.root);
  });

  it("marks a consumed request failed when canceled before launch, without allowing success", () => {
    const f = fixture("consumed-cancelled-before-launch");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);

    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "completed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("consumed");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(true);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("failed");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(false);
    cleanup(f.root);
  });

  it.each([
    ["cmd", "echo hello & echo world", "cmd"],
    ["powershell", "Write-Output 'exact command text'", "powershell"],
  ] as const)("preserves %s command text for the native runner", (engine, command, expectedMode) => {
    const f = fixture(`${engine}-text`);
    const executable = write(f.root, engine === "powershell" ? "pwsh.exe" : "cmd.exe", "shell fixture\n");
    enabled(f);
    const spec: Level3Spec = {
      engine,
      repositoryPath: "repo",
      executable,
      args: [],
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: ["repo/src/task.txt"],
    };
    const pending = createLevel3Request(f.workspace, CLIENT_ID, spec);
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    const authorization = consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    expect(authorization.genericCommand.mode).toBe(expectedMode);
    expect(authorization.genericCommand.args).toEqual([]);
    expect(authorization.genericCommand.commandText).toBe(command);
    cleanup(f.root);
  });

  it("requires the local system-risk acknowledgement and rejects embedded credentials", () => {
    const f = fixture("risk-and-secrets");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "destructive-system",
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }));
    const approved = approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "destructive-system",
      allowSystem: true,
    });
    expect(approved.allowSystem).toBe(true);

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f, { args: ["--api-key=ghp_abcdefghijklmnopqrstuvwxyz012345"] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    );
    cleanup(f.root);
  });

  it("rechecks the approved material after a job consumes its request", () => {
    const f = fixture("queued-material-change");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" });
    consumeLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest);
    fs.writeFileSync(f.material, "changed while queued\n");
    expect(() => resolveConsumedLevel3Request(f.workspace, pending.requestId, CLIENT_ID, pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("consumed");
    cleanup(f.root);
  });

  it("rejects a pre-binding approval record when the current binder finds unresolved execution semantics", () => {
    const f = fixture("stale-entry-binding");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    write(f.repo, "entry.ts", "isolated unsupported execution target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "& .\\entry.ts",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{ requestId: string; spec: { entryBinding?: unknown } }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    // Simulate a pending record written before this binder learned to report
    // the existing unsupported PowerShell target as unresolved.
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it("rejects a pre-binding Start-Process approval record when the current binder discovers its executable material", () => {
    const f = fixture("stale-start-process-binding");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    write(f.repo, "entry.exe", "isolated Start-Process target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "Start-Process -FilePath .\\entry.exe",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{
        requestId: string;
        spec: { materials: string[]; entryBinding?: unknown };
        snapshot: { materials: unknown[] };
      }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    // Simulate a pre-binding record: it had neither a material nor its hash in
    // the approved snapshot, even though the current binder now finds the exe.
    stored.spec.materials = [];
    stored.snapshot.materials = [];
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it.each([
    "./entry.exe",
    "call ./entry.exe",
    'start "" "./entry.exe"',
  ])("rejects a pre-binding CMD approval record after discovering its executable material: %s", (command) => {
    const f = fixture("stale-cmd-entry-binding");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");
    write(f.repo, "entry.exe", "isolated CMD target fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });

    const stateFile = path.join(process.env.C2C_STATE_DIR!, "execution", "level3", f.workspace.id, "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      requests: Array<{
        requestId: string;
        spec: { materials: string[]; entryBinding?: unknown };
        snapshot: { materials: unknown[] };
      }>;
    };
    const stored = state.requests.find((record) => record.requestId === pending.requestId)!;
    stored.spec.materials = [];
    stored.snapshot.materials = [];
    stored.spec.entryBinding = { kind: "literal_entries", uncertainties: [] };
    fs.writeFileSync(stateFile, JSON.stringify(state));

    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );
    cleanup(f.root);
  });

  it.each([
    "C:/Windows/System32/whoami.exe",
    "call C:/Windows/System32/whoami.exe",
    "start C:/Windows/System32/whoami.exe",
  ])("rejects an explicit CMD target outside the repository before approval: %s", (command) => {
    const f = fixture("external-cmd-target");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it.each([
    "./missing.exe",
    "call ./missing.exe",
    'start "" "./missing.exe"',
  ])("rejects a missing explicit CMD target before approval: %s", (command) => {
    const f = fixture("missing-cmd-target");
    enabled(f);
    const shell = write(f.root, "tools/cmd.exe", "isolated CMD executable fixture\n");

    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "cmd",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it("keeps unresolved Start-Process targets behind the existing dynamic-code approval", () => {
    const f = fixture("start-process-dynamic-approval");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    const pending = createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: "Start-Process notepad.exe",
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    });
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.spec.entryBinding?.kind).toBe("dynamic_code");
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_RISK_APPROVAL_REQUIRED" }),
    );
    expect(approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, {
      risk: "development",
      allowDynamic: true,
    }).status).toBe("approved");
    cleanup(f.root);
  });

  it.each([".cmd", ".exe"])("rejects a missing explicit PowerShell %s target before creating an approval request", (extension) => {
    const f = fixture(`missing-powershell-target-${extension.slice(1)}`);
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command: `& .\\missing${extension}`,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it.each([
    "Start-Process -FilePath .\\missing.exe",
    "Start-Process .\\missing.exe",
  ])("rejects a missing Start-Process target before creating an approval request: %s", (command) => {
    const f = fixture("missing-start-process");
    enabled(f);
    const shell = write(f.root, "tools/pwsh.exe", "isolated PowerShell executable fixture\n");
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, {
      engine: "powershell",
      repositoryPath: "repo",
      executable: shell,
      command,
      cwd: "repo",
      timeoutSeconds: 30,
      materials: [],
    })).toThrowError(expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }));
    expect(listLevel3Requests(f.workspace.id)).toHaveLength(0);
    cleanup(f.root);
  });

  it("rejects changed material and only revokes when called through local approval", () => {
    const f = fixture("material-revoke");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    fs.writeFileSync(f.material, "changed after request\n");
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_MATERIAL_CHANGED" }),
    );

    const second = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(revokeLevel3Request(f.workspace.id, second.requestId, true)).toBe(true);
    expect(getLevel3Request(f.workspace.id, second.requestId)?.status).toBe("revoked");
    expect(completeLevel3Request(f.workspace.id, second.requestId, CLIENT_ID, "failed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, second.requestId)?.status).toBe("revoked");
    expect(() => consumeLevel3Request(f.workspace, second.requestId, CLIENT_ID, second.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_NOT_APPROVED" }),
    );
    setLevel3Enabled(f.workspace.id, false, true);
    expect(isLevel3Enabled(f.workspace.id)).toBe(false);
    cleanup(f.root);
  });

  it("expires pending requests and binds them to the requesting client", () => {
    const f = fixture("expiry-owner");
    enabled(f);
    const pending = createLevel3Request(f.workspace, CLIENT_ID, directSpec(f));
    expect(() => consumeLevel3Request(f.workspace, pending.requestId, "other-client", pending.digest)).toThrowError(
      expect.objectContaining({ code: "LEVEL3_CLIENT_MISMATCH" }),
    );
    expect(() => approveLevel3Request(f.workspace, pending.requestId, "0".repeat(64), true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_DIGEST_MISMATCH" }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    expect(() => approveLevel3Request(f.workspace, pending.requestId, pending.digest, true, { risk: "development" })).toThrowError(
      expect.objectContaining({ code: "LEVEL3_REQUEST_EXPIRED" }),
    );
    expect(getLevel3RequestPreview(f.workspace.id, pending.requestId, CLIENT_ID)?.status).toBe("expired");
    expect(completeLevel3Request(f.workspace.id, pending.requestId, CLIENT_ID, "failed")).toBe(false);
    expect(getLevel3Request(f.workspace.id, pending.requestId)?.status).toBe("expired");
    cleanup(f.root);
  });

  it("refuses workspace-sensitive material paths", () => {
    const f = fixture("sensitive-material");
    write(f.repo, ".env", "not-a-real-secret\n");
    enabled(f);
    expect(() => createLevel3Request(f.workspace, CLIENT_ID, directSpec(f, { materials: ["repo/.env"] }))).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    );
    cleanup(f.root);
  });
});
