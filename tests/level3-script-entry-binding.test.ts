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
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

  it("binds an existing PowerShell CMD entry while flagging missing or unsupported targets", () => {
    const cmdInput = context({ command: "& ./assets/c2c-autostart-task.cmd" });
    writeFixtureFile(cmdInput, "assets/c2c-autostart-task.cmd");
    const cmdResult = bindLevel3ScriptEntries(cmdInput);
    expect(cmdResult.materials).toEqual(["repo/tools/assets/c2c-autostart-task.cmd"]);
    expect(cmdResult.hasUnresolvedSemantics).toBe(false);

    const missingExe = bindLevel3ScriptEntries(context({ command: "& ./build/native/example.exe" }));
    expect(missingExe.materials).toEqual([]);
    expect(missingExe.hasUnresolvedSemantics).toBe(true);
    expect(missingExe.uncertainties).toContain("unverified-execution-target");

    const tsInput = context({ command: "& ./src/execution/git-commit-entry.ts" });
    writeFixtureFile(tsInput, "src/execution/git-commit-entry.ts");
    const tsResult = bindLevel3ScriptEntries(tsInput);
    expect(tsResult.materials).toEqual(["repo/tools/src/execution/git-commit-entry.ts"]);
    expect(tsResult.hasUnresolvedSemantics).toBe(true);
    expect(tsResult.uncertainties).toContain("unsupported-execution-target");
  });

  it.each([".ps1", ".cmd", ".bat", ".exe", ".com"])(
    "binds an existing explicit PowerShell & target with %s",
    (extension) => {
      const input = context({ command: `& ./tools/entry${extension}` });
      writeFixtureFile(input, `tools/entry${extension}`);
      const result = bindLevel3ScriptEntries(input);

      expect(result.materials).toEqual([`repo/tools/tools/entry${extension}`]);
      expect(result.hasUnresolvedSemantics).toBe(false);
    },
  );

  it("binds explicit PowerShell paths in direct command position", () => {
    const input = context({ command: "./tools/entry.exe" });
    writeFixtureFile(input, "tools/entry.exe");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/tools/entry.exe"]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    "Start-Process -FilePath ./tools/entry.exe -Wait",
    "Start-Process -FilePath=./tools/entry.exe -Wait",
    "Start-Process ./tools/entry.exe -Wait",
    "Start-Process -WorkingDirectory ./tools -FilePath ./tools/entry.com -Wait",
  ])("binds the Start-Process target from %s", (command) => {
    const extension = command.includes("entry.com") ? ".com" : ".exe";
    const input = context({ command });
    writeFixtureFile(input, `tools/entry${extension}`);
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual([`repo/tools/tools/entry${extension}`]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    { engine: "cmd", command: "./tools/direct.exe", file: "tools/direct.exe" },
    { engine: "cmd", command: "call ./tools/call.com", file: "tools/call.com" },
    { engine: "cmd", command: 'start ./tools/start.exe', file: "tools/start.exe" },
    { engine: "cmd", command: 'start "Window title" /wait "./tools/start-title.exe"', file: "tools/start-title.exe" },
    { engine: "powershell", command: "& ./tools/call-operator.exe", file: "tools/call-operator.exe" },
    { engine: "powershell", command: "./tools/direct.exe", file: "tools/direct.exe" },
    { engine: "powershell", command: ". ./tools/dot.ps1", file: "tools/dot.ps1" },
    { engine: "powershell", command: "Start-Process -FilePath ./tools/start-process.exe", file: "tools/start-process.exe" },
    { engine: "powershell", command: "Start-Process ./tools/start-position.com", file: "tools/start-position.com" },
    { engine: "program", command: undefined, executable: "C:\\Tools\\node.exe", args: ["./tools/program-entry.js"], file: "tools/program-entry.js" },
  ] as const)("binds the explicit entry in the $engine matrix: $command", ({ engine, command, executable, args, file }) => {
    const input = context({ engine, command, executable, args });
    writeFixtureFile(input, file);
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual([`repo/tools/${file}`]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    "C:/Windows/System32/whoami.exe",
    "call C:/Windows/System32/whoami.exe",
    "start C:/Windows/System32/whoami.exe",
  ])("fails closed for an explicit CMD target outside the repository: %s", (command) => {
    const result = bindLevel3ScriptEntries(context({ engine: "cmd", command }));

    expect(result.materials).toEqual([]);
    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain("unverified-execution-target");
  });

  it("does not treat a non-interpreter CMD argument as another execution material", () => {
    const input = context({ engine: "cmd", command: "call ./tools/entry.exe ./data/ordinary.ps1" });
    writeFixtureFile(input, "tools/entry.exe");
    writeFixtureFile(input, "data/ordinary.ps1");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/tools/entry.exe"]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    "Start-Process -FilePath ./build/native/example.exe",
    "Start-Process ./build/native/example.exe",
  ])("marks a missing Start-Process target unresolved in %s", (command) => {
    const result = bindLevel3ScriptEntries(context({ command }));

    expect(result.materials).toEqual([]);
    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain("unverified-execution-target");
  });

  it.each([
    ["Start-Process notepad.exe", "ambiguous-command-search"],
    ["Start-Process -FilePath $env:TOOL", "computed-path"],
    ["Start-Process -FilePath ./tools/*.exe", "computed-path"],
    ["Start-Process -FilePath", "unverified-execution-target"],
  ] as const)("fails closed for unresolved Start-Process target %s", (command, uncertainty) => {
    const result = bindLevel3ScriptEntries(context({ command }));

    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain(uncertainty);
  });

  it("keeps non-interpreter Start-Process arguments out of the execution material set", () => {
    const input = context({ command: "Start-Process -FilePath ./tools/entry.exe -ArgumentList ./data/ordinary.ps1" });
    writeFixtureFile(input, "tools/entry.exe");
    writeFixtureFile(input, "data/ordinary.ps1");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/tools/entry.exe"]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each([
    "& ./python.exe ./src/main.py",
    "Start-Process -FilePath ./python.exe -ArgumentList ./src/main.py",
    "Start-Process ./python.exe ./src/main.py",
  ])("binds an interpreter script argument for %s", (command) => {
    const input = context({ command });
    writeFixtureFile(input, "python.exe");
    writeFixtureFile(input, "src/main.py");
    const result = bindLevel3ScriptEntries(input);

    expect(result.materials).toEqual(["repo/tools/python.exe", "repo/tools/src/main.py"]);
    expect(result.hasUnresolvedSemantics).toBe(false);
  });

  it.each(["entry.ts", "& entry.ts"])("does not assume bare PowerShell command %s is statically resolved", (command) => {
    const result = bindLevel3ScriptEntries(context({ command }));

    expect(result.entries).toEqual([]);
    expect(result.hasUnresolvedSemantics).toBe(true);
    expect(result.uncertainties).toContain("ambiguous-command-search");
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
