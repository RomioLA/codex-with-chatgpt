import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";
const windowsIt = isWindows ? it : it.skip;
let fixtureRoot: string | undefined;

function fixturePath(...parts: string[]): string {
  if (!fixtureRoot) throw new Error("Windows CMD fixture was not initialized");
  return path.join(fixtureRoot, ...parts);
}

function runWrapper(args: string[], childExitCode: number): { exitCode: number | null; childRan: boolean } {
  const markerPath = fixturePath("child-ran.txt");
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
  const wrapperPath = fixturePath("assets", "c2c-autostart-task.cmd");
  const argumentText = args.length > 0 ? ` ${args.join(" ")}` : "";
  const command = `""${wrapperPath}"${argumentText}"`;
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
    encoding: "utf8",
    env: {
      ...process.env,
      C2C_TEST_CHILD_EXIT_CODE: String(childExitCode),
      C2C_TEST_CHILD_MARKER: markerPath,
    },
    timeout: 15_000,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
  return { exitCode: result.status, childRan: fs.existsSync(markerPath) };
}

describe("Windows autostart CMD wrapper", () => {
  beforeAll(() => {
    if (!isWindows) return;
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-autostart-wrapper-"));
    const nodeDir = fixturePath("node");
    const assetsDir = fixturePath("assets");
    const autostartDir = fixturePath("dist", "autostart");
    for (const dir of [nodeDir, assetsDir, autostartDir]) fs.mkdirSync(dir, { recursive: true });

    fs.copyFileSync(process.execPath, fixturePath("node", "node.exe"));
    fs.copyFileSync(
      fileURLToPath(new URL("../assets/c2c-autostart-task.cmd", import.meta.url)),
      fixturePath("assets", "c2c-autostart-task.cmd"),
    );
    fs.writeFileSync(
      fixturePath("dist", "autostart", "task-launcher.js"),
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.C2C_TEST_CHILD_MARKER, 'ran');",
        "process.exit(Number(process.env.C2C_TEST_CHILD_EXIT_CODE ?? '0'));",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    if (!fixtureRoot) return;
    for (const file of [
      fixturePath("child-ran.txt"),
      fixturePath("dist", "autostart", "task-launcher.js"),
      fixturePath("assets", "c2c-autostart-task.cmd"),
      fixturePath("node", "node.exe"),
    ]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    for (const dir of [
      fixturePath("node"),
      fixturePath("dist", "autostart"),
      fixturePath("dist"),
      fixturePath("assets"),
      fixtureRoot,
    ]) {
      if (fs.existsSync(dir)) fs.rmdirSync(dir);
    }
  });

  windowsIt("returns the task-launcher exit code when the child succeeds", () => {
    const result = runWrapper(["workspace-id"], 0);
    expect(result.childRan).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  windowsIt("returns the task-launcher exit code when the child fails", () => {
    const result = runWrapper(["workspace-id"], 1);
    expect(result.childRan).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  windowsIt("returns 2 without arguments", () => {
    const result = runWrapper([], 0);
    expect(result.childRan).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  windowsIt("returns 2 when extra arguments are supplied", () => {
    const result = runWrapper(["workspace-id", "extra"], 0);
    expect(result.childRan).toBe(false);
    expect(result.exitCode).toBe(2);
  });
});
