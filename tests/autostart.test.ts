import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AutostartService, taskNameForWorkspace, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import {
  buildHiddenPowerShellAction,
  buildLogonTaskXml,
  quoteWindowsArgument,
  quoteWindowsCommandLine,
  WindowsAutostartAdapter,
} from "../src/autostart/windows-task.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

class FakeTaskScheduler implements AutostartTaskAdapter {
  readonly installed = new Set<string>();
  readonly installCalls: string[] = [];
  readonly removeCalls: string[] = [];

  install(registration: AutostartRegistration): { backend: "task_scheduler" } {
    this.installCalls.push(registration.taskName);
    this.installed.add(registration.taskName);
    return { backend: "task_scheduler" };
  }

  remove(registration: AutostartRegistration): void {
    this.removeCalls.push(registration.taskName);
    this.installed.delete(registration.taskName);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.installed.has(registration.taskName);
  }
}

class FakeRunKey {
  readonly installed = new Set<string>();
  readonly removed: string[] = [];

  install(registration: AutostartRegistration): { backend: "registry_run"; previousRunValueCaptured: true; previousRunValue: null } {
    this.installed.add(registration.taskName);
    return { backend: "registry_run", previousRunValueCaptured: true, previousRunValue: null };
  }

  remove(registration: AutostartRegistration): void {
    this.removed.push(registration.taskName);
    this.installed.delete(registration.taskName);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.installed.has(registration.taskName);
  }
}

describe("Windows workspace autostart registration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function fixture(): { stateDir: string; tasks: FakeTaskScheduler; service: AutostartService } {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const tasks = new FakeTaskScheduler();
    return { stateDir, tasks, service: new AutostartService(tasks, stateDir, "win32") };
  }

  it("persists enable registration and reports task status", () => {
    const { service } = fixture();
    const workspaceRoot = makeTmpDir("autostart-enable");
    dirs.push(workspaceRoot);

    const status = service.enable(workspaceRoot);

    expect(status.enabled).toBe(true);
    expect(status.registrationState).toBe("enabled");
    expect(status.taskInstalled).toBe(true);
    expect(service.getRegistrationById(new Workspace(workspaceRoot).id)?.workspaceRoot).toBe(workspaceRoot);
  });

  it("supports multiple independent workspaces and removes only the selected task", () => {
    const { service, tasks } = fixture();
    const first = makeTmpDir("autostart-first");
    const second = makeTmpDir("autostart-second");
    dirs.push(first, second);

    service.enable(first);
    service.enable(second);
    const firstName = taskNameForWorkspace(new Workspace(first).id);
    const secondName = taskNameForWorkspace(new Workspace(second).id);
    expect(service.list()).toHaveLength(2);

    const disabled = service.disable(first);

    expect(disabled.registrationState).toBe("not_registered");
    expect(tasks.installed.has(firstName)).toBe(false);
    expect(tasks.installed.has(secondName)).toBe(true);
    expect(service.list()).toHaveLength(1);
  });

  it("removes the final task and registration", () => {
    const { service, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-last");
    dirs.push(workspaceRoot);
    service.enable(workspaceRoot);

    service.disable(workspaceRoot);

    expect(service.list()).toEqual([]);
    expect(tasks.installed.size).toBe(0);
  });

  it("keeps duplicate enable idempotent", () => {
    const { service, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-idempotent");
    dirs.push(workspaceRoot);

    const first = service.enable(workspaceRoot);
    const second = service.enable(workspaceRoot);

    expect(second.taskName).toBe(first.taskName);
    expect(service.list()).toHaveLength(1);
    expect(tasks.installed.size).toBe(1);
  });

  it("rejects a missing workspace without registering a task", () => {
    const { service, tasks } = fixture();
    const missing = path.join(makeTmpDir("autostart-missing-parent"), "does-not-exist");

    expect(() => service.enable(missing)).toThrow(/does not exist/i);
    expect(service.list()).toEqual([]);
    expect(tasks.installed.size).toBe(0);
  });

  it("reports a registration whose Task Scheduler entry is missing", () => {
    const { service, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-task-missing");
    dirs.push(workspaceRoot);
    service.enable(workspaceRoot);
    tasks.installed.clear();

    const status = service.status(workspaceRoot);

    expect(status.enabled).toBe(false);
    expect(status.registrationState).toBe("task_missing");
    expect(status.taskInstalled).toBe(false);
  });

  it("does not change the workspace permission mode", () => {
    const { service } = fixture();
    const workspaceRoot = makeTmpDir("autostart-permission");
    dirs.push(workspaceRoot);
    const workspace = new Workspace(workspaceRoot);
    setPermission(workspace.id, "level2");

    service.enable(workspaceRoot);
    service.disable(workspaceRoot);

    expect(readPermission(workspace.id)).toBe("level2");
  });

  it("returns unsupported on non-Windows platforms", () => {
    const { tasks, stateDir } = fixture();
    const service = new AutostartService(tasks, stateDir, "linux");
    const workspaceRoot = makeTmpDir("autostart-unsupported");
    dirs.push(workspaceRoot);

    expect(() => service.enable(workspaceRoot)).toThrow(/unsupported/i);
    expect(fs.existsSync(path.join(stateDir, "autostart"))).toBe(false);
    expect(tasks.installCalls).toEqual([]);
  });

  it.each([
    "Could not install the Windows logon task: Access is denied.",
    "The Task Scheduler service is not available.",
    "Could not install the Windows logon task: 0x80041315",
  ])("uses HKCU Run when Task Scheduler denies creation or is unavailable (%s)", (message) => {
    const taskScheduler = new FakeTaskScheduler();
    taskScheduler.install = () => { throw new Error(message); };
    const runKey = new FakeRunKey();
    const adapter = new WindowsAutostartAdapter(taskScheduler, runKey);
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff",
      workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"),
      updatedAt: new Date().toISOString(),
    };

    const installed = adapter.install(registration);

    expect(installed.backend).toBe("registry_run");
    expect(runKey.installed.has(registration.taskName)).toBe(true);
    expect(adapter.isInstalled({ ...registration, backend: "registry_run" })).toBe(true);
    adapter.remove({ ...registration, ...installed });
    expect(runKey.installed.size).toBe(0);
  });

  it("does not use HKCU Run for unrelated Task Scheduler failures", () => {
    const taskScheduler = new FakeTaskScheduler();
    taskScheduler.install = () => { throw new Error("The supplied task XML is invalid."); };
    const runKey = new FakeRunKey();
    const adapter = new WindowsAutostartAdapter(taskScheduler, runKey);
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff",
      workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"),
      updatedAt: new Date().toISOString(),
    };

    expect(() => adapter.install(registration)).toThrow(/XML is invalid/i);
    expect(runKey.installed.size).toBe(0);
  });
});

describe("Windows Task Scheduler command construction", () => {
  it("quotes spaces, embedded quotes, trailing slashes, and empty arguments", () => {
    expect(quoteWindowsArgument("C:\\Program Files\\node.exe")).toBe('"C:\\Program Files\\node.exe"');
    expect(quoteWindowsArgument('say "hello"')).toBe('"say \\"hello\\""');
    expect(quoteWindowsArgument("tail\\")).toBe('"tail\\\\"');
    expect(quoteWindowsArgument("")).toBe('""');
    expect(quoteWindowsCommandLine(["node", "a b", ""])).toBe('"node" "a b" ""');
  });

  it("escapes XML fields and creates a least-privilege current-user logon task", () => {
    const xml = buildLogonTaskXml({
      taskName: "C2C & workspace",
      userSid: "S-1-5-21-1-2-3-1001",
      action: {
        command: "C:\\Program Files\\Windows PowerShell\\powershell.exe",
        arguments: "-WindowStyle Hidden -EncodedCommand abc123",
        workingDirectory: "C:\\Users\\A & B\\c2c",
      },
    });

    expect(xml).toContain("C2C &amp; workspace");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\A &amp; B\\c2c</WorkingDirectory>");
  });

  it("keeps Node executable, CLI entry, and workspace paths in the encoded hidden action", () => {
    const nodeArguments = [
      "C:\\C2C Install\\dist\\cli\\index.js",
      "autostart",
      "restore",
      "--workspace",
      "C:\\Users\\A B\\Project\\",
      "--workspace-id",
      "aabbccddeeff; Remove-Item test-marker",
    ];
    const action = buildHiddenPowerShellAction({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      nodeArguments,
      workingDirectory: "C:\\C2C Install",
      environment: { C2C_STATE_DIR: "C:\\Users\\A B\\State" },
      powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    expect(action.command).toContain("powershell.exe");
    expect(action.arguments).toContain("-WindowStyle Hidden");
    expect(action.arguments).toContain("-EncodedCommand");
    expect(action.workingDirectory).toBe("C:\\C2C Install");

    const encodedScript = action.arguments.split("-EncodedCommand ")[1];
    const script = Buffer.from(encodedScript, "base64").toString("utf16le");
    expect(script).toContain("Start-Process -FilePath $payload.nodePath");
    expect(script).not.toContain("C:\\Users\\A B\\Project");
    const payloadBase64 = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
    expect(payloadBase64).toBeDefined();
    const payload = JSON.parse(Buffer.from(payloadBase64!, "base64").toString("utf8")) as {
      nodePath: string;
      arguments: string;
      workingDirectory: string;
      environment: Record<string, string>;
    };
    expect(payload.nodePath).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(payload.arguments).toBe(quoteWindowsCommandLine(nodeArguments));
    expect(payload.workingDirectory).toBe("C:\\C2C Install");
    expect(payload.environment).toEqual({ C2C_STATE_DIR: "C:\\Users\\A B\\State" });
    expect(script).not.toContain(" -Wait");
    expect(script).toContain("exit 0");
  });
});
