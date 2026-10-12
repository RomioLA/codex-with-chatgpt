import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AutostartService, taskNameForWorkspace, type AutostartInstallContext, type AutostartInstallResult, type AutostartRegistration, type AutostartTaskAdapter } from "../src/autostart/registration.js";
import {
  buildAutostartCmdAction,
  buildLogonTaskXml,
  quoteWindowsArgument,
  quoteWindowsCommandLine,
  TASK_CMD_LAUNCHER_SHA256,
  WindowsAutostartAdapter,
} from "../src/autostart/windows-task.js";
import { parseTaskLaunchPayload } from "../src/autostart/task-launcher.js";
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
  const dirsForTaskDiagnostics: string[] = [];
  afterEach(() => { for (const dir of dirsForTaskDiagnostics) cleanup(dir); dirsForTaskDiagnostics.length = 0; });
  function makeTaskRuntime(name: string) {
    const root = makeTmpDir(name);
    dirsForTaskDiagnostics.push(root);
    const cli = path.join(root, "dist", "cli", "index.js");
    const taskLauncher = path.join(root, "dist", "autostart", "task-launcher.js");
    const node = path.join(root, "node", "node.exe");
    const launcher = path.join(root, "assets", "c2c-autostart-task.cmd");
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(taskLauncher), { recursive: true });
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(cli, "// isolated CLI fixture\n", "utf8");
    fs.writeFileSync(taskLauncher, "// isolated task launcher fixture\n", "utf8");
    fs.writeFileSync(node, "isolated Node identity fixture\n", "utf8");
    fs.copyFileSync(path.resolve("assets", "c2c-autostart-task.cmd"), launcher);
    return { root, cli, node, launcher, taskLauncher };
  }

  it("builds a short fixed CMD action with a data-only restore payload", () => {
    const runtime = makeTaskRuntime("task-cmd-runtime");
    const stateDir = makeTmpDir("Task State With % NAME & 中文");
    dirsForTaskDiagnostics.push(stateDir);
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff", workspaceRoot: "C:\\Test Workspace & %WORKSPACE%\\Project",
      taskName: taskNameForWorkspace("aabbccddeeff"), updatedAt: new Date().toISOString(),
    };
    const action = buildAutostartCmdAction(runtime.cli, registration, {
      stateDir, nodePath: runtime.node, commandProcessorPath: "C:\\Windows\\System32\\cmd.exe",
      environment: { c2c_state_dir: "C:\\wrong-state", C2C_PROBE_MARKER: "C:\\test marker.json" },
    });
    expect(action.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(action.workingDirectory).toBe(runtime.root);
    expect(action.arguments).toContain("/d /v:off /s /c");
    expect(action.arguments).toContain(quoteWindowsArgument(runtime.launcher));
    expect(action.arguments).not.toMatch(/EncodedCommand|powershell/i);
    expect(action.arguments.length).toBeLessThan(2000);
    const encodedPayload = action.arguments.match(/ "([A-Za-z0-9_-]+)""$/)?.[1];
    expect(encodedPayload).toBeDefined();
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toEqual({
      version: 1,
      stateDir: path.resolve(stateDir),
      workspaceId: registration.workspaceId,
      workspaceRoot: path.win32.resolve(registration.workspaceRoot),
      environment: { C2C_PROBE_MARKER: "C:\\test marker.json", C2C_STATE_DIR: path.resolve(stateDir) },
    });
    expect(Object.keys(payload)).not.toContain("command");
    expect(Object.keys(payload)).not.toContain("arguments");
    expect(Object.keys(payload)).not.toContain("nodePath");
  });

  it("checks the packaged CMD launcher hash before constructing the Task action", () => {
    const runtime = makeTaskRuntime("task-cmd-integrity");
    const registration: AutostartRegistration = {
      workspaceId: "aabbccddeeff", workspaceRoot: "C:\\Test Workspace",
      taskName: taskNameForWorkspace("aabbccddeeff"), updatedAt: new Date().toISOString(),
    };
    expect(TASK_CMD_LAUNCHER_SHA256).toMatch(/^[a-f0-9]{64}$/);
    fs.appendFileSync(runtime.launcher, "rem modified\r\n", "ascii");
    expect(() => buildAutostartCmdAction(runtime.cli, registration, { nodePath: runtime.node }))
      .toThrow(/integrity check/);
  });

  it("parses only the fixed, data-only restore payload shape", () => {
    const payload = Buffer.from(JSON.stringify({
      version: 1,
      stateDir: "C:\\C2C State",
      workspaceId: "aabbccddeeff",
      workspaceRoot: "C:\\Test Workspace",
      environment: { c2c_state_dir: "C:\\ignored", C2C_TEST_MARKER: "C:\\probe" },
    }), "utf8").toString("base64url");
    expect(parseTaskLaunchPayload(payload)).toEqual({
      version: 1,
      stateDir: path.win32.resolve("C:\\C2C State"),
      workspaceId: "aabbccddeeff",
      workspaceRoot: path.win32.resolve("C:\\Test Workspace"),
      environment: { C2C_TEST_MARKER: "C:\\probe" },
    });
    const unsafe = Buffer.from(JSON.stringify({
      version: 1,
      stateDir: "C:\\C2C State",
      workspaceId: "aabbccddeeff",
      workspaceRoot: "C:\\Test Workspace",
      environment: {},
      command: "whoami",
    }), "utf8").toString("base64url");
    expect(() => parseTaskLaunchPayload(unsafe)).toThrow(/payload/);
    expect(() => parseTaskLaunchPayload("not+base64/url")) .toThrow(/encoding/);
  });

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
        command: "C:\\Windows\\System32\\cmd.exe",
        arguments: '/d /v:off /s /c ""C:\\Runtime\\assets\\c2c-autostart-task.cmd" "payload""',
        workingDirectory: "C:\\Users\\A & B\\c2c",
      },
    });

    expect(xml).toContain("C2C &amp; workspace");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-21-1-2-3-1001</UserId></LogonTrigger>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<Command>C:\\Windows\\System32\\cmd.exe</Command>");
    expect(xml).toContain("c2c-autostart-task.cmd");
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\A &amp; B\\c2c</WorkingDirectory>");
  });
});
