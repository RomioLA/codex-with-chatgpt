import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AutostartService, taskNameForWorkspace, type AutostartInstallContext, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
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
  removeError: Error | null = null;

  install(registration: AutostartRegistration, _context?: AutostartInstallContext): { backend: "task_scheduler" } {
    this.installCalls.push(registration.taskName);
    this.installed.add(registration.taskName);
    return { backend: "task_scheduler" };
  }

  remove(registration: AutostartRegistration): void {
    this.removeCalls.push(registration.taskName);
    if (this.removeError) throw this.removeError;
    this.installed.delete(registration.taskName);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.installed.has(registration.taskName);
  }
}

class FakeRunKey {
  readonly installed = new Set<string>();
  readonly removed: string[] = [];
  readonly events: string[] = [];

  removeError: Error | null = null;

  install(registration: AutostartRegistration, _overrides?: unknown, beforeMutation?: (metadata: AutostartInstallResult) => void): AutostartInstallResult {
    const metadata: AutostartInstallResult = {
      backend: "registry_run",
      previousRunValueCaptured: registration.previousRunValueCaptured ?? true,
      previousRunValue: registration.previousRunValue ?? null,
      previousRunValueKind: registration.previousRunValueKind ?? null,
    };
    if (!beforeMutation) throw new Error("Run fallback requires a durable transition journal.");
    beforeMutation(metadata);
    this.events.push("run_install");
    this.installed.add(registration.taskName);
    return {
      ...metadata,
      rollback: () => { this.installed.delete(registration.taskName); },
    };
  }

  remove(registration: AutostartRegistration): void {
    this.removed.push(registration.taskName);
    if (this.removeError) throw this.removeError;
    this.installed.delete(registration.taskName);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.installed.has(registration.taskName);
  }
}

describe("Windows workspace autostart registration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("rolls back an installed authority when the first registration file cannot be created", () => {
    const { service, stateDir, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-first-write-failure");
    dirs.push(workspaceRoot);
    const id = new Workspace(workspaceRoot).id;
    const registrations = path.join(stateDir, "autostart", "workspaces");
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation(((file: unknown, ...args: unknown[]) => {
      if (typeof file === "string" && file.startsWith(registrations)) throw new Error("registration create denied");
      return (open as (...args: unknown[]) => number)(file, ...args);
    }) as typeof fs.openSync);

    expect(() => service.enable(workspaceRoot)).toThrow("registration create denied");
    expect(tasks.installed.size).toBe(0);
    expect(service.getRegistrationById(id)).toBeNull();
    expect(fs.existsSync(path.join(registrations, `${id}.json`))).toBe(false);
  });

  it("never publishes a partial or interrupted registration temp file", () => {
    const { service, stateDir, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-partial-registration");
    dirs.push(workspaceRoot);
    const id = new Workspace(workspaceRoot).id;
    const registrations = path.join(stateDir, "autostart", "workspaces");
    const write = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (typeof target === "number") {
        (write as (...args: unknown[]) => void)(target, "{\"workspaceId\":", "utf8");
        throw new Error("registration write interrupted");
      }
      return (write as (...args: unknown[]) => void)(target, ...args);
    }) as typeof fs.writeFileSync);

    expect(() => service.enable(workspaceRoot)).toThrow("registration write interrupted");
    expect(tasks.installed.size).toBe(0);
    expect(service.getRegistrationById(id)).toBeNull();
    expect(fs.existsSync(path.join(registrations, `${id}.json`))).toBe(false);
    expect(fs.readdirSync(registrations)).toEqual([]);
  });

  it("unlinks the known registration path when disable encounters malformed JSON", () => {
    const { service, stateDir, tasks } = fixture();
    const workspaceRoot = makeTmpDir("autostart-disable-corrupt-json");
    dirs.push(workspaceRoot);
    const id = new Workspace(workspaceRoot).id;
    const file = path.join(stateDir, "autostart", "workspaces", `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken json", "utf8");
    const exists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (target === file) return false;
      return (exists as (...args: unknown[]) => boolean)(target, ...args);
    }) as typeof fs.existsSync);

    const disabled = service.disable(workspaceRoot);

    expect(disabled.registrationState).toBe("not_registered");
    expect(tasks.removeCalls).toEqual([taskNameForWorkspace(id)]);
    expect((exists as (target: string) => boolean)(file)).toBe(false);
  });

  it("reports failure to unlink the known registration path", () => {
    const { service, stateDir } = fixture();
    const workspaceRoot = makeTmpDir("autostart-disable-unlink-failure");
    dirs.push(workspaceRoot);
    const id = new Workspace(workspaceRoot).id;
    const file = path.join(stateDir, "autostart", "workspaces", `${id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken json", "utf8");
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (target === file) throw new Error("registration unlink denied");
      return (unlink as (...args: unknown[]) => void)(target, ...args);
    }) as typeof fs.unlinkSync);

    expect(() => service.disable(workspaceRoot)).toThrow("registration unlink denied");
    expect(fs.existsSync(file)).toBe(true);
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
    const context: AutostartInstallContext = {
      persistTransition: (transition) => {
        expect(transition).toMatchObject({ pendingBackend: "registry_run", previousRunValueCaptured: true, previousRunValue: null });
        expect(runKey.installed.has(registration.taskName)).toBe(false);
        runKey.events.push("journal");
      },
    };
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff",
      workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"),
      updatedAt: new Date().toISOString(),
    };

    const installed = adapter.install(registration, context);

    expect(installed.backend).toBe("registry_run");
    expect(installed.pendingBackend).toBe("registry_run");
    expect(runKey.events).toEqual(["journal", "run_install"]);
    expect(runKey.installed.has(registration.taskName)).toBe(true);
    expect(adapter.isInstalled({ ...registration, backend: "registry_run" })).toBe(true);
    adapter.remove({ ...registration, ...installed });
    expect(runKey.installed.size).toBe(0);
  });

  it("keeps successful Scheduled Task registration primary without installing a Run fallback", () => {
    const scheduler = new FakeTaskScheduler();
    const runKey = new FakeRunKey();
    const adapter = new WindowsAutostartAdapter(scheduler, runKey);
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff", workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"), updatedAt: new Date().toISOString(),
    };
    const installed = adapter.install(registration);
    expect(installed.backend).toBe("task_scheduler");
    expect(scheduler.installCalls).toEqual([registration.taskName]);
    expect(runKey.installed.size).toBe(0);
    expect(adapter.isInstalled({ ...registration, ...installed })).toBe(true);
  });

  it("defers removing the old task until fallback registration is committed", () => {
    const scheduler = new FakeTaskScheduler();
    scheduler.install = () => { throw new Error("Access is denied."); };
    const runKey = new FakeRunKey();
    const adapter = new WindowsAutostartAdapter(scheduler, runKey);
    const journal: AutostartRegistration[] = [];
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff", workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"), updatedAt: new Date().toISOString(),
    };
    scheduler.installed.add(registration.taskName);
    const installed = adapter.install(registration, { persistTransition: (transition) => { journal.push(transition); } });
    expect(journal).toHaveLength(1);
    expect(scheduler.installed.has(registration.taskName)).toBe(true);
    expect(scheduler.removeCalls).toEqual([]);
    installed.commit?.();
    expect(scheduler.installed.has(registration.taskName)).toBe(false);
    expect(runKey.installed.has(registration.taskName)).toBe(true);
  });

  it("rolls back the Run fallback and fails closed when the old Scheduled Task cannot be removed", () => {
    const scheduler = new FakeTaskScheduler();
    scheduler.install = () => { throw new Error("Access is denied."); };
    scheduler.removeError = new Error("task deletion denied");
    const runKey = new FakeRunKey();
    const adapter = new WindowsAutostartAdapter(scheduler, runKey);
    const journal: AutostartRegistration[] = [];
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff", workspaceRoot: "C:\\workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"), updatedAt: new Date().toISOString(),
    };
    scheduler.installed.add(registration.taskName);
    const installed = adapter.install(registration, { persistTransition: (transition) => { journal.push(transition); } });
    expect(journal).toHaveLength(1);

    expect(() => installed.commit?.()).toThrow(/task deletion denied/);
    expect(scheduler.installed.has(registration.taskName)).toBe(true);
    expect(runKey.installed.has(registration.taskName)).toBe(false);
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
