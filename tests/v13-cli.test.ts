import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { listGitRepositoryApprovals } from "../src/git-write/index.js";
import { createLevel3Request, getLevel3Request, isLevel3Enabled, setLevel3Enabled, type Level3Spec } from "../src/execution/level3-approval.js";
import { Workspace } from "../src/workspace/manager.js";
import { isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceCliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const distCliEntry = path.join(projectRoot, "dist", "cli", "index.js");

function runCli(args: string[], stateDir: string) {
  const nodeArgs = fs.existsSync(distCliEntry)
    ? [distCliEntry, ...args]
    : ["--import", "tsx", sourceCliEntry, ...args];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

function parseOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("V1.3 local CLI approval gates", () => {
  let originalStateDir: string | undefined;

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDir;
  });

  it("shows Level 3 disabled by default, rejects implicit enable/approval, and inspects a pending request", () => {
    originalStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const root = makeTmpDir("v13-cli-level3-workspace");
    makeGitRepo(root);
    const workspace = new Workspace(root);

    const status = runCli(["level3", "status", "--json", "-w", root], stateDir);
    expect(status.status, `${status.stdout}\n${status.stderr}`).toBe(0);
    expect(parseOutput(status.stdout)).toMatchObject({ ok: true, enabled: false });
    expect(isLevel3Enabled(workspace.id)).toBe(false);

    const implicitEnable = runCli(["level3", "enable", "-w", root], stateDir);
    expect(implicitEnable.status).not.toBe(0);
    expect(implicitEnable.stderr).toMatch(/required option '--approve' not specified/i);
    expect(isLevel3Enabled(workspace.id)).toBe(false);

    setLevel3Enabled(workspace.id, true, true);
    const executable = write(root, "approved-program.exe", "mock executable for CLI approval preview\n");
    write(root, "approval-material.txt", "review this exact file\n");
    const spec: Level3Spec = {
      engine: "program",
      repositoryPath: ".",
      executable,
      args: ["--inspect-only"],
      cwd: ".",
      timeoutSeconds: 45,
      materials: ["approval-material.txt"],
    };
    const request = createLevel3Request(workspace, "cli-test-client", spec);
    const inspect = runCli(["level3", "inspect", "--request", request.requestId, "--json", "-w", root], stateDir);
    expect(inspect.status, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
    const inspected = parseOutput(inspect.stdout);
    expect(inspected).toMatchObject({
      ok: true,
      request: { requestId: request.requestId, status: "pending", spec: { args: ["--inspect-only"] } },
    });
    expect(inspected.warning).toContain("can access resources beyond cwd");
    expect(JSON.stringify(inspected)).not.toContain("manifestPath");
    expect(JSON.stringify(inspected)).not.toContain("fileIdentity");

    const implicitApproval = runCli([
      "level3", "approve", "--request", request.requestId, "--approve", "--json", "-w", root,
    ], stateDir);
    expect(implicitApproval.status).not.toBe(0);
    expect(implicitApproval.stderr).toMatch(/required option '--digest <sha256>' not specified/i);
    expect(isLevel3Enabled(workspace.id)).toBe(true);
    expect(getLevel3Request(workspace.id, request.requestId)?.status).toBe("pending");
  });

  it("previews a Git policy without writing it and rejects an incorrect approval digest", () => {
    originalStateDir = process.env.C2C_STATE_DIR;
    const stateDir = isolateStateDir();
    const root = makeTmpDir("v13-cli-git-write-workspace");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const policyPath = write(root, "git-write-policy.json", JSON.stringify({
      allowedOperations: ["branch_list"],
      allowedBranches: ["main"],
      allowedRemotes: [],
    }));

    const preview = runCli(["git-write", "approve", "--repository", ".", "--policy", policyPath, "--json", "-w", root], stateDir);
    expect(preview.status, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    const payload = parseOutput(preview.stdout);
    expect(payload).toMatchObject({ ok: true, approvalRequired: true });
    expect(typeof payload.digest).toBe("string");
    expect(listGitRepositoryApprovals(workspace.id)).toEqual([]);

    const rejected = runCli([
      "git-write", "approve", "--repository", ".", "--policy", policyPath,
      "--approve", "--digest", "0".repeat(64), "--json", "-w", root,
    ], stateDir);
    expect(rejected.status).toBe(1);
    expect(parseOutput(rejected.stdout)).toMatchObject({ ok: false, error: "POLICY_DIGEST_MISMATCH" });
    expect(listGitRepositoryApprovals(workspace.id)).toEqual([]);
  });
});
