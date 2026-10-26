import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

function tempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runIsolatedStatus(workspaceRoot: string, stateDir: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", cliEntry, "status", "--json", "-w", workspaceRoot], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ status: null, stdout, stderr: "CLI status child timed out after 20 seconds" });
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: null, stdout, stderr: error.message });
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

const documents = {
  skill: fs.readFileSync(new URL("../skills/c2c-local/SKILL.md", import.meta.url), "utf8"),
  operations: fs.readFileSync(new URL("../skills/c2c-local/references/operations.md", import.meta.url), "utf8"),
  guide: fs.readFileSync(new URL("../docs/AI_GUIDE.md", import.meta.url), "utf8"),
  troubleshooting: fs.readFileSync(new URL("../docs/troubleshooting.md", import.meta.url), "utf8"),
};

describe("Stage 2 published routing contracts", () => {
  it("uses status JSON for offline preflight without creating or migrating permission/runtime state", async () => {
    const workspaceRoot = tempDirectory("c2c-stage2-skill-workspace-");
    const workspace = new Workspace(workspaceRoot);
    const emptyStateDir = path.join(os.tmpdir(), `c2c-stage2-skill-empty-${process.pid}-${Date.now()}`);
    const emptyResult = await runIsolatedStatus(workspaceRoot, emptyStateDir);
    expect(emptyResult.status, emptyResult.stderr).toBe(0);
    const emptyStatus = JSON.parse(emptyResult.stdout) as {
      diagnostics?: { workspace?: { id?: string }; bridge?: { status?: string; pid?: number | null; port?: number | null } };
    };
    expect(emptyStatus.diagnostics?.workspace?.id).toBe(workspace.id);
    expect(emptyStatus.diagnostics?.bridge).toMatchObject({ status: "stopped", pid: null, port: null });
    expect(fs.existsSync(emptyStateDir)).toBe(false);
    expect(fs.existsSync(path.join(emptyStateDir, "permissions"))).toBe(false);
    expect(fs.existsSync(path.join(emptyStateDir, "runtime"))).toBe(false);

    const legacyStateDir = tempDirectory("c2c-stage2-skill-legacy-state-");
    const permissionsDir = path.join(legacyStateDir, "permissions");
    fs.mkdirSync(permissionsDir);
    const legacyFile = path.join(permissionsDir, `${workspace.id}.json`);
    const legacyBytes = JSON.stringify({ version: 1, workspaceId: workspace.id, mode: "level2", updatedAt: "2025-01-01T00:00:00.000Z" });
    fs.writeFileSync(legacyFile, legacyBytes, "utf8");
    const legacyResult = await runIsolatedStatus(workspaceRoot, legacyStateDir);
    expect(legacyResult.status, legacyResult.stderr).toBe(0);
    const legacyStatus = JSON.parse(legacyResult.stdout) as {
      diagnostics?: { workspace?: { id?: string }; bridge?: { status?: string; pid?: number | null; port?: number | null } };
    };
    expect(legacyStatus.diagnostics?.workspace?.id).toBe(workspace.id);
    expect(legacyStatus.diagnostics?.bridge).toMatchObject({ status: "stopped", pid: null, port: null });
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(legacyBytes);
    expect(fs.existsSync(path.join(legacyStateDir, "runtime"))).toBe(false);
  });

  it("keeps permission status out of the formal read-only offline preflight", () => {
    const offlineStart = documents.skill.indexOf("若 C2C 工具全部不可用");
    const offlineEnd = documents.skill.indexOf("Named 的本机公网 self-probe", offlineStart);
    expect(offlineStart).toBeGreaterThanOrEqual(0);
    expect(offlineEnd).toBeGreaterThan(offlineStart);
    const offlineSection = documents.skill.slice(offlineStart, offlineEnd);
    const powershellBlocks = [...offlineSection.matchAll(/```powershell\s*([\s\S]*?)```/g)].map((match) => match[1]);
    const recoveryBlock = powershellBlocks.find((block) => block.includes("restore -w $targetWorkspace --json"));
    expect(recoveryBlock).toBeDefined();
    expect(recoveryBlock).toContain("status -w $targetWorkspace --json");
    expect(recoveryBlock).not.toMatch(/permission\s+status/i);
    expect(recoveryBlock).toContain("diagnostics.bridge.status");
    expect(recoveryBlock).toContain("diagnostics.bridge.pid");
    expect(recoveryBlock).toContain("diagnostics.bridge.port");
    expect(recoveryBlock).toContain("$status.workspaceId -eq $verifiedWorkspaceId");
    expect(offlineSection).toMatch(/不要在恢复预检中调用 `permission status`/);
    expect(offlineSection).toMatch(/可能获取写锁、创建 permissions 目录、迁移 legacy 权限文件并写入 Level1 baseline/);
  });

  it("separates local Codex Native routing from ChatGPT web C2C routing", () => {
    expect(documents.skill).toMatch(/Codex 本机[^\n]*Native Tools > C2C Local/);
    expect(documents.skill).toMatch(/ChatGPT 网页版访问本机[^\n]*C2C Local > Remote/);
    expect(documents.guide).toMatch(/Codex local[^\n]*Native Tools/);
    expect(documents.guide).toMatch(/ChatGPT web local[^\n]*C2C Local/);
  });

  it("does not turn a sandbox refusal into permission for a fallback tool", () => {
    expect(documents.skill).toMatch(/原生工具被沙箱[^\n]*不[^\n]*C2C[^\n]*绕过/);
    expect(documents.guide).toMatch(/refusal is not permission to retry through C2C or Remote/);
  });

  it.each(Object.entries(documents))("%s keeps offline recovery independent and requires Runtime evidence", (_name, content) => {
    expect(content).toContain("restore");
    expect(/Completely stuck[\s\S]{0,150}c2c setup/.test(content)).toBe(false);
    expect(content).toContain("PATH");
    expect(content).toMatch(/Runtime/);
    expect(/停止|stop and/i.test(content.replace(/\s+/g, " "))).toBe(true);
    expect(/Remote.{0,160}(独立|independent|not a required)|不.{0,12}(依赖|要求) Remote/i.test(content.replace(/\s+/g, " "))).toBe(true);
    expect(content).toMatch(/未部署|does not prove|Do not claim a GitHub commit deployed|不等于已部署|不代表已部署/);
  });

  it.each(["skill", "operations", "guide"] as const)("%s preserves Stage 1 Level2 and Level1 Git boundaries", (name) => {
    const content = documents[name];
    expect(content).toMatch(/不再无条件要求独立 Repository Approval|without an unconditional separate Repository Approval/);
    expect(content).toMatch(/Level1[^\n]{0,60}(仍保留|retains) Repository Approval/);
    expect(content).not.toContain("Git Write 按 repository/worktree 单独批准");
    expect(content).not.toContain("Git Write 默认没有 repository policy");
  });
});
