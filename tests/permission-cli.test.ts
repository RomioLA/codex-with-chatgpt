import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], stateDir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: stateDir },
  });
}

describe("local permission CLI", () => {
  const dirs: string[] = [];
  let stateDir: string;

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("defaults to readonly and sets readonly, level1, and level2 with JSON results", () => {
    stateDir = makeTmpDir("permission-cli-state");
    dirs.push(stateDir);
    const root = makeTmpDir("permission-cli-ws");
    dirs.push(root);
    makeGitRepo(root);
    const workspace = new Workspace(root);

    const invoke = (mode: string) => runCli(["permission", mode, "--json", "-w", root], stateDir);
    const initial = invoke("status");
    expect(initial.status, `${initial.stdout}\n${initial.stderr}`).toBe(0);
    expect(JSON.parse(initial.stdout)).toEqual({
      ok: true,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      mode: "readonly",
    });

    for (const [arg, mode] of [["readonly", "readonly"], ["1", "level1"], ["2", "level2"]]) {
      const result = invoke(arg);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, workspaceId: workspace.id, mode });
    }
  });

  it("keeps permission independent across workspaces and rejects invalid modes", () => {
    stateDir = makeTmpDir("permission-cli-state");
    dirs.push(stateDir);
    const rootA = makeTmpDir("permission-cli-a");
    const rootB = makeTmpDir("permission-cli-b");
    dirs.push(rootA, rootB);
    makeGitRepo(rootA);
    makeGitRepo(rootB);

    const changed = runCli(["permission", "2", "--json", "-w", rootA], stateDir);
    const untouched = runCli(["permission", "status", "--json", "-w", rootB], stateDir);
    expect(changed.status).toBe(0);
    expect(JSON.parse(changed.stdout).mode).toBe("level2");
    expect(untouched.status).toBe(0);
    expect(JSON.parse(untouched.stdout).mode).toBe("readonly");

    const invalid = runCli(["permission", "admin", "--json", "-w", rootA], stateDir);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false });
    expect(JSON.parse(invalid.stdout).error).toMatch(/invalid permission mode/i);
  });

  it("exposes permissionMode in c2c status JSON", () => {
    stateDir = makeTmpDir("permission-cli-state");
    dirs.push(stateDir);
    const root = makeTmpDir("permission-cli-status");
    dirs.push(root);
    makeGitRepo(root);

    const result = runCli(["status", "--json", "-w", root], stateDir);
    expect(JSON.parse(result.stdout)).toMatchObject({
      permissionMode: "readonly",
      autostart: { enabled: false, backend: "none", backendInstalled: false },
    });
    const textResult = runCli(["status", "-w", root], stateDir);
    expect(textResult.stdout).toContain("Permission: readonly");

    const doctor = runCli(["doctor", "--json", "-w", root], stateDir);
    expect(JSON.parse(doctor.stdout).autostart).toMatchObject({
      enabled: false,
      backend: "none",
      backendInstalled: false,
    });
  });

  it("serves the persisted mode dynamically from protected admin info only", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = makeTmpDir("permission-admin-state");
    const root = makeTmpDir("permission-admin-ws");
    dirs.push(stateDir, root);
    makeGitRepo(root);
    process.env.C2C_STATE_DIR = stateDir;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const headers = { authorization: `Bearer ${bridge.adminToken}` };
    try {
      const info = async () => {
        const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, { headers });
        expect(response.status).toBe(200);
        return (await response.json()) as { permissionMode: string };
      };
      expect((await info()).permissionMode).toBe("readonly");

      setPermission(bridge.workspace.id, "level1");
      expect(readPermission(bridge.workspace.id)).toBe("level1");
      expect((await info()).permissionMode).toBe("level1");
      setPermission(bridge.workspace.id, "level2");
      expect((await info()).permissionMode).toBe("level2");

      for (const endpoint of ["/admin/permission", "/admin/set-permission"]) {
        const response = await fetch(`${bridge.localBaseUrl()}${endpoint}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ mode: "level2" }),
        });
        expect(response.status).toBe(404);
      }
    } finally {
      await bridge.close();
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });
});
