import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bindLevel3ScriptEntries, type ScriptEntryBindingInput } from "../src/execution/script-entry-binding.js";
import { makeTmpDir } from "./helpers.js";

function context(overrides: Partial<ScriptEntryBindingInput> = {}): ScriptEntryBindingInput {
  const workspaceRoot = makeTmpDir("level3-script-binding");
  const repositoryRoot = path.join(workspaceRoot, "repo");
  const cwd = path.join(repositoryRoot, "tools");
  fs.mkdirSync(cwd, { recursive: true });
  return {
    engine: "powershell",
    workspaceRoot,
    cwd,
    command: "",
    ...overrides,
  };
}

function writeFixtureFile(input: ScriptEntryBindingInput, name: string): void {
  const file = path.join(input.cwd, name);
  fs.writeFileSync(file, "isolated script binding fixture\n");
}

function writeWorkspaceFixtureFile(input: ScriptEntryBindingInput, name: string): void {
  const file = path.join(input.workspaceRoot, name);
  fs.writeFileSync(file, "isolated outside-repository fixture\n");
}

describe("Level 3 script entry binding", () => {
  it("does not probe outside workspace and marks external opaque file arguments as dynamic", () => {
    const input = context({ engine: "program", executable: "custom-runner.exe", args: [path.resolve("outside-file.bin")], command: undefined });
    const probe = vi.spyOn(fs, "lstatSync");
    try {
      const result = bindLevel3ScriptEntries(input);
      expect(probe).not.toHaveBeenCalled();
      expect(result.uncertainties).toContain("computed-path");
    } finally { probe.mockRestore(); }
  });
  it("binds a literal PowerShell external script invoked with the call operator", () => {
    const input = context({ command: "& '.\\Deploy tasks.ps1' -Mode Read" });
    writeFixtureFile(input, "Deploy tasks.ps1");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/Deploy tasks.ps1"]);
    expect(result.entries[0]).toMatchObject({
      reference: ".\\Deploy tasks.ps1",
      source: "shell-command",
    });
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it("binds cmd call scripts and Python/Node file arguments in chained commands", () => {
    const input = context({
      engine: "cmd",
      command: 'call ".\\prepare.cmd" && call .\\deploy.bat && python .\\worker.py & node .\\client.mjs',
    });
    writeFixtureFile(input, "prepare.cmd");
    writeFixtureFile(input, "deploy.bat");
    writeFixtureFile(input, "worker.py");
    writeFixtureFile(input, "client.mjs");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual([
      "repo/tools/prepare.cmd",
      "repo/tools/deploy.bat",
      "repo/tools/worker.py",
      "repo/tools/client.mjs",
    ]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it("binds explicitly supplied script files in direct program argv", () => {
    const input = context({
      engine: "program",
      executable: "C:\\Tools\\custom-runner.exe",
      args: ["--script", ".\\task.py", "--module=.\\client.mjs", "--config=.\\config.json", ".\\custom-entry"],
      command: undefined,
    });
    writeFixtureFile(input, "task.py");
    writeFixtureFile(input, "client.mjs");
    writeFixtureFile(input, "config.json");
    writeFixtureFile(input, "custom-entry");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual([
      "repo/tools/task.py",
      "repo/tools/client.mjs",
      "repo/tools/config.json",
      "repo/tools/custom-entry",
    ]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    ["C:\\Python\\python.exe", [".\\build.py"], "repo/tools/build.py"],
    ["C:\\Program Files\\node.exe", [".\\client.mjs"], "repo/tools/client.mjs"],
  ] as const)("binds a script passed directly to %s", (executable, args, material) => {
    const input = context({
      engine: "program",
      executable,
      args,
      command: undefined,
    });
    writeFixtureFile(input, material.split("/").at(-1)!);
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual([material]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it("does not mistake ordinary output text for an invoked script", () => {
    const result = bindLevel3ScriptEntries(context({ command: "Write-Output '.\\example.ps1'" }));

    expect(result.entries).toEqual([]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it("reports shell-expanded script paths without guessing their resolved file", () => {
    const result = bindLevel3ScriptEntries(context({ command: "& $scriptPath; python \"$env:JOB\"" }));

    expect(result.entries).toEqual([]);
    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain("shell-expansion");
    expect(result.uncertainties).toContain("computed-command");
  });

  it("flags cmd environment expansion while preserving a separate static entry", () => {
    const input = context({
      engine: "cmd",
      command: 'call .\\fixed.cmd && python "%JOB_FILE%"',
    });
    writeFixtureFile(input, "fixed.cmd");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/fixed.cmd"]);
    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain("shell-expansion");
  });

  it("does not guess where a bare shell command resolves", () => {
    const result = bindLevel3ScriptEntries(context({ engine: "cmd", command: "deploy.cmd" }));

    expect(result.entries).toEqual([]);
    expect(result.uncertainties).toContain("ambiguous-command-search");
  });

  it("binds a bare cmd script when the fixed cwd contains that ordinary file", () => {
    const input = context({ engine: "cmd", command: "call build.cmd" });
    writeFixtureFile(input, "build.cmd");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/build.cmd"]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it("returns explicit files outside the selected repository for canonicalizeSpec to reject", () => {
    const input = context({
      engine: "program",
      executable: "C:\\Tools\\custom-runner.exe",
      args: ["..\\..\\outside.json"],
      command: undefined,
    });
    writeWorkspaceFixtureFile(input, "outside.json");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["outside.json"]);
  });

  it("marks interpreter eval modes as unresolved even when argv itself is exact", () => {
    const result = bindLevel3ScriptEntries(context({
      engine: "program",
      executable: "C:\\Program Files\\node.exe",
      args: ["--eval", "import('./runtime.mjs')"],
      command: undefined,
    }));

    expect(result.entries).toEqual([]);
    expect(result.uncertainties).toEqual(["interpreter-eval"]);
  });
});
