import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutostartService, taskNameForWorkspace, type AutostartRegistration } from "../src/autostart/registration.js";
import { buildLogonTaskXml, WindowsAutostartAdapter, WindowsRunKeyAutostart, WindowsTaskScheduler } from "../src/autostart/windows-task.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir } from "./helpers.js";

// Native commands are deterministic in this file. In particular, no test can
// read or modify the host's actual Scheduled Tasks or HKCU Run key.
const native = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: native.spawnSync,
}));

type RunValue = { kind: "String" | "ExpandString"; value: string };
type TaskEvent = { operation: "query" | "create" | "delete"; taskName: string; xml?: Buffer; xmlQuery?: boolean };

const shellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const nodePath = "C:\\Program Files\\Formal Node\\node.exe";
const commandProcessorPath = "C:\\Windows\\System32\\cmd.exe";
const userSid = "S-1-5-21-111-222-333-1001";
const previousStateOverride = process.env.C2C_STATE_DIR;

let taskDefinitions: Map<string, Buffer>;
let hostRunValues: Map<string, RunValue>;
let packageRunValues: Map<string, RunValue>;
let legacyAliasesHost: boolean;
let failLegacyDeleteAfterSideEffect: boolean;
let rejectLegacyMutation: boolean;
let rejectHostDelete: boolean;
let legacyDeleteLosesHostAfterRead: boolean;
let taskEvents: TaskEvent[];
let denyNextTaskCreate: string | null;
let beforeTaskDelete: ((name: string) => void) | undefined;
let realXmlValidation: ((command: string, args: string[]) => unknown) | undefined;
let xmlValidationStderrNoise: string | undefined;

function output(status: number, stdout: Buffer | string = ""): { status: number; stdout: Buffer; stderr: Buffer } {
  return {
    status,
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

function taskName(args: string[]): string {
  const index = args.findIndex((value) => value.toLowerCase() === "/tn");
  if (index < 0 || !args[index + 1]) throw new Error(`Unexpected schtasks arguments: ${args.join(" ")}`);
  return args[index + 1];
}

function runNativeSimulator(): void {
  native.spawnSync.mockReset();
  native.spawnSync.mockImplementation((command: string, args: string[], options?: { encoding?: string }) => {
    const executable = path.basename(command).toLowerCase();
    const operation = args[0]?.toLowerCase();

    if (executable === "schtasks.exe" || executable === "schtasks") {
      const name = taskName(args);
      if (operation === "/query") {
        const definition = taskDefinitions.get(name);
        taskEvents.push({ operation: "query", taskName: name, xmlQuery: args.some((arg) => arg.toLowerCase() === "/xml") });
        if (!definition) return output(1, "ERROR: The system cannot find the file specified.");
        return output(0, args.some((arg) => arg.toLowerCase() === "/xml")
          ? Buffer.from(definition)
          : "Task exists.");
      }
      if (operation === "/create") {
        const xmlIndex = args.findIndex((value) => value.toLowerCase() === "/xml");
        if (xmlIndex < 0 || !args[xmlIndex + 1]) throw new Error("schtasks /Create omitted its XML path.");
        const xml = fs.readFileSync(args[xmlIndex + 1]);
        taskEvents.push({ operation: "create", taskName: name, xml: Buffer.from(xml) });
        if (denyNextTaskCreate) {
          const message = denyNextTaskCreate;
          denyNextTaskCreate = null;
          return output(1, message);
        }
        taskDefinitions.set(name, Buffer.from(xml));
        return output(0, "SUCCESS: The scheduled task was created.");
      }
      if (operation === "/delete") {
        taskEvents.push({ operation: "delete", taskName: name });
        beforeTaskDelete?.(name);
        if (!taskDefinitions.delete(name)) return output(1, "ERROR: The system cannot find the file specified.");
        return output(0, "SUCCESS: The scheduled task was deleted.");
      }
      throw new Error(`Unexpected schtasks operation: ${args.join(" ")}`);
    }

    if (executable === "powershell.exe" || executable === "powershell") {
      const script = args[args.length - 1] ?? "";
      if (args.some((arg) => arg.toLowerCase() === "-encodedcommand")) {
        if (realXmlValidation) return realXmlValidation(command, args);
        const encodedScript = args[args.findIndex((arg) => arg.toLowerCase() === "-encodedcommand") + 1];
        const decodedScript = Buffer.from(encodedScript, "base64").toString("utf16le");
        const encodedPath = decodedScript.match(/FromBase64String\('([^']+)'\)/)?.[1];
        if (!encodedPath) throw new Error("Unexpected encoded PowerShell XML validation command.");
        const xmlPath = Buffer.from(encodedPath, "base64").toString("utf8");
        const xmlBytes = fs.readFileSync(xmlPath);
        const xml = xmlBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
          ? xmlBytes.subarray(2).toString("utf16le")
          : xmlBytes.toString("utf8");
        if (!/<Task\b/.test(xml) || !xml.includes("http://schemas.microsoft.com/windows/2004/02/mit/task")) {
          return output(1, "The XML is not a Task Scheduler task definition.");
        }
        const settings = xml.match(/<Settings>([\s\S]*?)<\/Settings>/i)?.[1] ?? "";
        const parsed = output(0, settings.match(/<Enabled>\s*(true|false)\s*<\/Enabled>/i)?.[1].toLowerCase() ?? "unspecified");
        if (xmlValidationStderrNoise) parsed.stderr = Buffer.from(xmlValidationStderrNoise);
        return parsed;
      }
      const encodedRequest = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      if (!encodedRequest && script.includes("WindowsIdentity]::GetCurrent")) return output(0, userSid);
      if (!encodedRequest) throw new Error("Unexpected PowerShell command in isolated autostart transaction test.");
      const request = JSON.parse(Buffer.from(encodedRequest, "base64").toString("utf8")) as {
        operation: "host_read" | "host_write" | "host_delete" | "legacy_read" | "legacy_write" | "legacy_delete";
        name: string;
        value?: string;
        kind?: string;
      };
      if (!/^(?:host|legacy)_(?:read|write|delete)$/.test(request.operation)) {
        throw new Error(`Unexpected registry authority operation: ${request.operation}`);
      }
      const hostOperation = request.operation.startsWith("host_");
      const legacyOperation = request.operation.startsWith("legacy_");
      const store = hostOperation || (legacyOperation && legacyAliasesHost) ? hostRunValues : packageRunValues;
      const authorityOutput = (status: number, response: unknown) => {
        const encodedResponse = Buffer.from(JSON.stringify(response), "utf16le").toString("base64");
        if (options?.encoding === "utf8") {
          return { status, stdout: encodedResponse, stderr: "" };
        }
        return output(status, Buffer.from(encodedResponse));
      };
      const unsupportedHostType = () => ({
        status: 3,
        stdout: options?.encoding === "utf8" ? "" : Buffer.alloc(0),
        stderr: options?.encoding === "utf8"
          ? "C2C_HOST_RUN_UNSUPPORTED_TYPE"
          : Buffer.from("C2C_HOST_RUN_UNSUPPORTED_TYPE"),
      });
      if (request.operation.endsWith("_read")) {
        const value = store.get(request.name) ?? (legacyOperation && !legacyAliasesHost ? hostRunValues.get(request.name) : undefined) ?? null;
        if (hostOperation && value && value.kind !== "String") return unsupportedHostType();
        return authorityOutput(0, { sid: userSid, value });
      }
      if (request.operation.endsWith("_write")) {
        if (!hostOperation && rejectLegacyMutation) return output(1, "legacy Run mutation denied");
        if (hostOperation && request.kind !== "String") return unsupportedHostType();
        const value = { kind: request.kind ?? "String", value: request.value ?? "" } as RunValue;
        store.set(request.name, value);
        return authorityOutput(0, { sid: userSid, value: hostOperation ? value : null });
      }
      if (request.operation.endsWith("_delete")) {
        if (hostOperation && rejectHostDelete) return output(1, "host Run delete denied");
        if (!hostOperation && rejectLegacyMutation) return output(1, "legacy Run mutation denied");
        if (!hostOperation && legacyDeleteLosesHostAfterRead && !legacyAliasesHost) {
          packageRunValues.delete(request.name);
          hostRunValues.delete(request.name);
        } else if (hostOperation || legacyAliasesHost || packageRunValues.has(request.name)) store.delete(request.name);
        else hostRunValues.delete(request.name);
        if (!hostOperation && failLegacyDeleteAfterSideEffect) return output(1, "legacy Run delete failed after side effect");
        return authorityOutput(0, { sid: userSid, value: null });
      }
      throw new Error(`Unexpected registry authority operation: ${request.operation}`);
    }

    throw new Error(`Unexpected native command in isolated autostart test: ${command} ${args.join(" ")}`);
  });
}

function fixture() {
  const stateDir = makeTmpDir("autostart-transaction-state");
  const workspaceRoot = makeTmpDir("autostart-transaction-workspace");
  const workspace = new Workspace(workspaceRoot);
  const cliPath = path.join(makeTmpDir("autostart-transaction-cli"), "dist", "cli", "index.js");
  const registration: AutostartRegistration = {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    taskName: taskNameForWorkspace(workspace.id),
    updatedAt: new Date(0).toISOString(),
  };
  const runtime = (cli = cliPath, runCommandProcessorPath = commandProcessorPath) => {
    const scheduler = new WindowsTaskScheduler(cli, {
      stateDir,
      powershellPath: shellPath,
      schedulerPath: "schtasks.exe",
      nodePath,
    });
    const runKey = new WindowsRunKeyAutostart(cli, {
      stateDir,
      powershellPath: shellPath,
      nodePath,
      commandProcessorPath: runCommandProcessorPath,
    });
    const adapter = new WindowsAutostartAdapter(scheduler, runKey);
    return { scheduler, runKey, adapter, service: new AutostartService(adapter, stateDir, "win32") };
  };
  const registrationFile = path.join(stateDir, "autostart", "workspaces", `${workspace.id}.json`);
  return { stateDir, workspaceRoot: workspace.root, workspaceId: workspace.id, registration, cliPath, runtime, registrationFile };
}

function rejectRegistrationRename(stateDir: string, workspaceId: string, failOn: number, message: string): () => number {
  const registrationFile = path.join(stateDir, "autostart", "workspaces", `${workspaceId}.json`);
  const originalRename = fs.renameSync;
  let matchingRenames = 0;
  vi.spyOn(fs, "renameSync").mockImplementation(((source: unknown, target: unknown, ...args: unknown[]) => {
    if (typeof target === "string" && path.resolve(target) === path.resolve(registrationFile)) {
      matchingRenames += 1;
      if (matchingRenames === failOn) throw new Error(message);
    }
    return (originalRename as (...values: unknown[]) => void)(source, target, ...args);
  }) as typeof fs.renameSync);
  return () => matchingRenames;
}

beforeEach(() => {
  taskDefinitions = new Map();
  hostRunValues = new Map();
  packageRunValues = new Map();
  legacyAliasesHost = false;
  failLegacyDeleteAfterSideEffect = false;
  rejectLegacyMutation = false;
  rejectHostDelete = false;
  legacyDeleteLosesHostAfterRead = false;
  taskEvents = [];
  denyNextTaskCreate = null;
  beforeTaskDelete = undefined;
  realXmlValidation = undefined;
  xmlValidationStderrNoise = undefined;
  runNativeSimulator();
});

afterEach(() => {
  vi.restoreAllMocks();
  realXmlValidation = undefined;
  xmlValidationStderrNoise = undefined;
  if (previousStateOverride === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateOverride;
});

describe("autostart transactional registration", () => {
  it("restores the complete old Scheduled Task XML when an update cannot publish its registration", () => {
    const f = fixture();
    const initial = f.runtime();
    initial.service.enable(f.workspaceRoot);
    const previousJson = fs.readFileSync(f.registrationFile);
    const oldXmlText = buildLogonTaskXml({
      taskName: f.registration.taskName,
      userSid: "S-1-5-21-111111111-222222222-333333333-1001",
      action: {
        command: "C:\\Program Files\\旧版 工具\\node.exe",
        arguments: '"C:\\正式 CLI\\dist\\cli\\index.js" "autostart" "restore"',
        workingDirectory: "C:\\旧工作区\\项目 数据",
      },
    }).replace("<Enabled>true</Enabled><Hidden>true</Hidden>", "<Enabled>false</Enabled><Hidden>true</Hidden>");
    const previousXml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(oldXmlText, "utf16le")]);
    taskDefinitions.set(f.registration.taskName, Buffer.from(previousXml));
    const updatedCli = path.join(makeTmpDir("autostart-transaction-updated-cli"), "dist", "cli", "index.js");
    const updated = f.runtime(updatedCli);
    rejectRegistrationRename(f.stateDir, f.workspaceId, 1, "registration publication denied");

    expect(() => updated.service.enable(f.workspaceRoot)).toThrow("registration publication denied");

    expect(fs.readFileSync(f.registrationFile).equals(previousJson)).toBe(true);
    expect(taskDefinitions.get(f.registration.taskName)?.equals(previousXml)).toBe(true);
    expect(oldXmlText).toContain("C:\\Program Files\\旧版 工具\\node.exe");
    expect(oldXmlText).toContain("C:\\旧工作区\\项目 数据");
    expect(oldXmlText).toContain("<Enabled>false</Enabled><Hidden>true</Hidden>");
    const creates = taskEvents.filter((event) => event.operation === "create" && event.taskName === f.registration.taskName);
    expect(creates.length).toBeGreaterThanOrEqual(3); // initial install, attempted update, exact rollback import
    expect(creates[creates.length - 1].xml?.equals(previousXml)).toBe(true);
  });

  it.runIf(process.platform === "win32")("validates and restores Unicode disabled task XML through real PowerShell without invoking native task commands", async () => {
    const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    realXmlValidation = (command, args) => actualChildProcess.spawnSync(command, args, {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    const f = fixture();
    const { scheduler, service } = f.runtime();
    service.enable(f.workspaceRoot);
    const oldXmlText = buildLogonTaskXml({
      taskName: f.registration.taskName,
      userSid: "S-1-5-21-111111111-222222222-333333333-1001",
      action: {
        command: "C:\\Program Files\\旧版 工具\\node.exe",
        arguments: '"C:\\正式 CLI\\dist\\cli\\index.js" "autostart" "restore"',
        workingDirectory: "C:\\旧工作区\\项目 数据",
      },
    }).replace("<Enabled>true</Enabled><Hidden>true</Hidden>", "<Enabled>false</Enabled><Hidden>true</Hidden>");
    const previousXml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(oldXmlText, "utf16le")]);
    taskDefinitions.set(f.registration.taskName, Buffer.from(previousXml));

    const installed = scheduler.install(f.registration);
    installed.rollback?.();

    expect(taskDefinitions.get(f.registration.taskName)?.equals(previousXml)).toBe(true);
    expect(taskEvents.filter((event) => event.operation === "create").at(-1)?.xml?.equals(previousXml)).toBe(true);
  });

  it("ignores successful PowerShell CLIXML progress on stderr while reading the task XML result", () => {
    const f = fixture();
    const { scheduler, service } = f.runtime();
    service.enable(f.workspaceRoot);
    const oldXmlText = buildLogonTaskXml({
      taskName: f.registration.taskName,
      userSid: "S-1-5-21-111111111-222222222-333333333-1001",
      action: {
        command: "C:\\Program Files\\旧版 工具\\node.exe",
        arguments: '"C:\\正式 CLI\\dist\\cli\\index.js" "autostart" "restore"',
        workingDirectory: "C:\\旧工作区\\项目 数据",
      },
    }).replace("<Enabled>true</Enabled><Hidden>true</Hidden>", "<Enabled>false</Enabled><Hidden>true</Hidden>");
    const previousXml = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(oldXmlText, "utf16le")]);
    taskDefinitions.set(f.registration.taskName, Buffer.from(previousXml));
    xmlValidationStderrNoise = "#< CLIXML\r\n<Objs><Obj><AV>Preparing modules</AV></Obj></Objs>";

    const installed = scheduler.install(f.registration);
    installed.rollback?.();

    expect(taskDefinitions.get(f.registration.taskName)?.equals(previousXml)).toBe(true);
  });

  it("deletes a newly created Scheduled Task when first registration publication fails", () => {
    const f = fixture();
    const { service } = f.runtime();
    rejectRegistrationRename(f.stateDir, f.workspaceId, 1, "first registration publication denied");

    expect(() => service.enable(f.workspaceRoot)).toThrow("first registration publication denied");

    expect(taskDefinitions.has(f.registration.taskName)).toBe(false);
    expect(taskEvents.some((event) => event.operation === "delete" && event.taskName === f.registration.taskName)).toBe(true);
    expect(fs.existsSync(f.registrationFile)).toBe(false);
  });

  it("does not mutate Run or Task authority when publishing the durable transition journal fails", () => {
    const f = fixture();
    const initial = f.runtime();
    initial.service.enable(f.workspaceRoot);
    const oldXml = Buffer.from(taskDefinitions.get(f.registration.taskName)!);
    denyNextTaskCreate = "ERROR: Access is denied.";
    rejectRegistrationRename(f.stateDir, f.workspaceId, 1, "transition journal publication denied");

    expect(() => initial.service.enable(f.workspaceRoot)).toThrow("transition journal publication denied");

    expect(taskDefinitions.get(f.registration.taskName)?.equals(oldXml)).toBe(true);
    expect(hostRunValues.has(f.registration.taskName)).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`))).toBe(false);
    expect(JSON.parse(fs.readFileSync(f.registrationFile, "utf8"))).not.toHaveProperty("pendingBackend");
  });

  it("rolls back the failed final Run publication, keeps its journal, and recovers on enable", () => {
    const f = fixture();
    const firstProcess = f.runtime();
    firstProcess.service.enable(f.workspaceRoot);
    denyNextTaskCreate = "ERROR: Access is denied.";
    rejectRegistrationRename(f.stateDir, f.workspaceId, 2, "stable registration publication denied");

    expect(() => firstProcess.service.enable(f.workspaceRoot)).toThrow("stable registration publication denied");

    const interrupted = JSON.parse(fs.readFileSync(f.registrationFile, "utf8")) as AutostartRegistration;
    expect(interrupted.pendingBackend).toBe("registry_run");
    expect(taskDefinitions.has(f.registration.taskName)).toBe(false);
    expect(hostRunValues.has(f.registration.taskName)).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`))).toBe(false);

    // A fresh adapter/service pair represents a process restart. The journal is
    // the only durable transition record it receives.
    const restarted = f.runtime();
    const recovered = restarted.service.enable(f.workspaceRoot);
    const authorities = restarted.adapter.getAuthorityState!(f.registration);

    expect(authorities).toEqual({ taskPresent: false, runPresent: true });
    expect(recovered).toMatchObject({ enabled: true, backendInstalled: true, registrationState: "enabled", backend: "registry_run" });
    expect(restarted.service.getRegistrationById(f.workspaceId)).not.toHaveProperty("pendingBackend");
    expect(restarted.service.getRegistrationById(f.workspaceId)?.backend).toBe("registry_run");
  });

  it("restores the exact prior host Run command and launcher when an existing Run update cannot publish stable registration", () => {
    const f = fixture();
    denyNextTaskCreate = "ERROR: Access is denied.";
    const initial = f.runtime();
    const installed = initial.service.enable(f.workspaceRoot);
    expect(installed).toMatchObject({ enabled: true, backend: "registry_run" });

    const launcherPath = path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`);
    const previousHostRun = hostRunValues.get(f.registration.taskName);
    const previousLauncher = fs.readFileSync(launcherPath);
    expect(previousHostRun).toBeDefined();
    expect(initial.service.getRegistrationById(f.workspaceId)).toMatchObject({
      backend: "registry_run",
      runAuthority: "host_user",
      previousRunValueCaptured: true,
      previousRunValue: null,
    });

    denyNextTaskCreate = "ERROR: Access is denied.";
    const updated = f.runtime(f.cliPath, "C:\\New Formal Cmd\\cmd.exe");
    const registrationRenames = rejectRegistrationRename(
      f.stateDir,
      f.workspaceId,
      2,
      "stable registration publication denied",
    );

    expect(() => updated.service.enable(f.workspaceRoot)).toThrow("stable registration publication denied");
    expect(registrationRenames()).toBe(2);
    expect(hostRunValues.get(f.registration.taskName)).toEqual(previousHostRun);
    expect(fs.readFileSync(launcherPath).equals(previousLauncher)).toBe(true);

    const pending = JSON.parse(fs.readFileSync(f.registrationFile, "utf8")) as AutostartRegistration;
    expect(pending).toMatchObject({
      backend: "registry_run",
      pendingBackend: "registry_run",
      runAuthority: "host_user",
      previousRunValueCaptured: true,
      previousRunValue: null,
    });
    expect(updated.adapter.getAuthorityState!(f.registration)).toEqual({ taskPresent: false, runPresent: true });
    expect(updated.service.status(f.workspaceRoot)).toMatchObject({
      enabled: false,
      backendInstalled: false,
      taskInstalled: false,
      registrationState: "transition_pending",
    });

    vi.mocked(fs.renameSync).mockRestore();
    const resumed = updated.service.enable(f.workspaceRoot);
    const resumedRun = hostRunValues.get(f.registration.taskName);
    expect(resumed).toMatchObject({ enabled: true, backendInstalled: true, backend: "registry_run", registrationState: "enabled" });
    expect(updated.adapter.getAuthorityState!(f.registration)).toEqual({ taskPresent: false, runPresent: true });
    expect(resumedRun?.kind).toBe("String");
    expect(resumedRun?.value).toContain("C:\\New Formal Cmd\\cmd.exe");
    expect(resumedRun?.value).not.toBe(previousHostRun?.value);
    expect(updated.service.getRegistrationById(f.workspaceId)).not.toHaveProperty("pendingBackend");
  });

  it("keeps host Run installed when native CLI caller and host registry views alias", () => {
    const f = fixture();
    legacyAliasesHost = true;
    const initial = f.runtime();
    denyNextTaskCreate = "ERROR: Access is denied.";

    const first = initial.service.enable(f.workspaceRoot);

    expect(first).toMatchObject({ enabled: true, backend: "registry_run" });
    const firstRegistration = initial.service.getRegistrationById(f.workspaceId)!;
    expect(firstRegistration).toMatchObject({ runAuthority: "host_user" });
    expect(firstRegistration).not.toHaveProperty("legacyRunValueCaptured");
    const runBeforeUpdate = hostRunValues.get(f.registration.taskName);
    expect(runBeforeUpdate).toBeDefined();
    expect(packageRunValues.has(f.registration.taskName)).toBe(false);

    const updatedCli = path.join(makeTmpDir("native-alias-updated-cli"), "dist", "cli", "index.js");
    const updated = f.runtime(updatedCli);
    const second = updated.service.enable(f.workspaceRoot);

    expect(second).toMatchObject({ enabled: true, backend: "registry_run", registrationState: "enabled" });
    const updatedRegistration = updated.service.getRegistrationById(f.workspaceId)!;
    expect(updatedRegistration).toMatchObject({ runAuthority: "host_user", backend: "registry_run" });
    expect(hostRunValues.get(f.registration.taskName)).toEqual(runBeforeUpdate);
    expect(packageRunValues.has(f.registration.taskName)).toBe(false);
    expect(fs.readFileSync(path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`), "utf8")).toContain(updatedCli);
    expect(updated.runKey.isInstalled(updatedRegistration)).toBe(true);
  });

  it("restores host Run after a package-overlay delete race during pending recovery and stays disabled", () => {
    const f = fixture();
    const initial = f.runtime();
    const oldCaller = { kind: "String" as const, value: "old private package Run value" };
    packageRunValues.set(f.registration.taskName, oldCaller);
    const installed = initial.runKey.install(f.registration);
    const launcherPath = path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`);
    const launcherBeforeRecovery = Buffer.from(fs.readFileSync(launcherPath));
    const expectedHost = { ...hostRunValues.get(f.registration.taskName)! };
    const pending: AutostartRegistration = {
      ...f.registration,
      ...installed,
      backend: "registry_run",
      pendingBackend: "registry_run",
    };
    fs.mkdirSync(path.dirname(f.registrationFile), { recursive: true });
    fs.writeFileSync(f.registrationFile, JSON.stringify(pending));
    legacyDeleteLosesHostAfterRead = true;

    expect(() => initial.service.enable(f.workspaceRoot)).toThrow(/legacy Run cleanup failed because the caller entry aliases or changed the host entry/i);

    expect(hostRunValues.get(f.registration.taskName)).toEqual(expectedHost);
    expect(fs.readFileSync(launcherPath).equals(launcherBeforeRecovery)).toBe(true);
    expect(packageRunValues.has(f.registration.taskName)).toBe(false);
    expect(initial.service.getRegistrationById(f.workspaceId)).toMatchObject({ pendingBackend: "registry_run" });
    expect(initial.service.status(f.workspaceRoot)).toMatchObject({ enabled: false, backendInstalled: false, registrationState: "transition_pending" });

    legacyDeleteLosesHostAfterRead = false;
    expect(() => initial.service.enable(f.workspaceRoot)).toThrow(/caller Run value changed before migration cleanup/i);
    expect(hostRunValues.get(f.registration.taskName)).toEqual(expectedHost);
    expect(initial.service.status(f.workspaceRoot)).toMatchObject({ enabled: false, backendInstalled: false, registrationState: "transition_pending" });
  });

  it("replays the durable pre-delete crash snapshot into a fresh service and completes Run authority recovery", () => {
    const f = fixture();
    const firstProcess = f.runtime();
    firstProcess.service.enable(f.workspaceRoot);
    const launcherPath = path.join(f.stateDir, "autostart", "launchers", `${f.workspaceId}.cmd`);
    let crashSnapshot: {
      registration: Buffer;
      launcher: Buffer;
      taskXml: Buffer;
      runValue: RunValue;
    } | undefined;
    beforeTaskDelete = (name) => {
      if (name !== f.registration.taskName) throw new Error(`Unexpected task deletion for ${name}`);
      const runValue = hostRunValues.get(name);
      const taskXml = taskDefinitions.get(name);
      if (!runValue || !taskXml || !fs.existsSync(launcherPath)) {
        throw new Error("Delete boundary arrived before the pending Run authority was complete.");
      }
      crashSnapshot = {
        registration: Buffer.from(fs.readFileSync(f.registrationFile)),
        launcher: Buffer.from(fs.readFileSync(launcherPath)),
        taskXml: Buffer.from(taskXml),
        runValue: { ...runValue },
      };
      throw new Error("simulated process interruption at Task delete boundary");
    };
    denyNextTaskCreate = "ERROR: Access is denied.";

    expect(() => firstProcess.service.enable(f.workspaceRoot)).toThrow("simulated process interruption at Task delete boundary");

    expect(crashSnapshot).toBeDefined();
    const snapshot = crashSnapshot!;
    expect((JSON.parse(snapshot.registration.toString("utf8")) as AutostartRegistration).pendingBackend).toBe("registry_run");
    expect(snapshot.runValue.kind).toBe("String");

    // The failing call may run its in-process rollback. Replaying the captured
    // bytes reconstructs the exact durable state observed immediately before
    // schtasks /Delete, as if the process had been terminated at that boundary.
    beforeTaskDelete = undefined;
    fs.writeFileSync(f.registrationFile, snapshot.registration);
    fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
    fs.writeFileSync(launcherPath, snapshot.launcher);
    taskDefinitions.set(f.registration.taskName, Buffer.from(snapshot.taskXml));
    hostRunValues.set(f.registration.taskName, { ...snapshot.runValue });

    const restarted = f.runtime();
    const pendingRegistration = restarted.service.getRegistrationById(f.workspaceId)!;
    expect(restarted.adapter.getAuthorityState!(pendingRegistration)).toEqual({ taskPresent: true, runPresent: true });
    expect(restarted.adapter.isInstalled(pendingRegistration)).toBe(false);
    expect(restarted.service.status(f.workspaceRoot)).toMatchObject({
      enabled: false,
      backendInstalled: false,
      taskInstalled: true,
      registrationState: "transition_pending",
    });
    const recovered = restarted.service.enable(f.workspaceRoot);

    expect(restarted.adapter.getAuthorityState!(f.registration)).toEqual({ taskPresent: false, runPresent: true });
    expect(recovered).toMatchObject({ enabled: true, backendInstalled: true, registrationState: "enabled", backend: "registry_run" });
    expect(restarted.service.getRegistrationById(f.workspaceId)).not.toHaveProperty("pendingBackend");
  });

  it("keeps a pending journal disabled after final-publication rollback", () => {
    const f = fixture();
    const firstProcess = f.runtime();
    firstProcess.service.enable(f.workspaceRoot);
    denyNextTaskCreate = "ERROR: Access is denied.";
    rejectRegistrationRename(f.stateDir, f.workspaceId, 2, "stable registration publication denied");
    expect(() => firstProcess.service.enable(f.workspaceRoot)).toThrow("stable registration publication denied");

    expect(firstProcess.service.status(f.workspaceRoot)).toMatchObject({
      enabled: false,
      backendInstalled: false,
      registrationState: "transition_pending",
    });
    expect(firstProcess.adapter.getAuthorityState!(f.registration)).toEqual({ taskPresent: false, runPresent: false });
  });

  it("reports Task and Run coexistence as disabled, then enable reconciles to one authority", () => {
    const f = fixture();
    const { adapter, runKey, service } = f.runtime();
    service.enable(f.workspaceRoot);
    const registration = service.getRegistrationById(f.workspaceId)!;
    runKey.install(registration);

    expect(adapter.getAuthorityState!(registration)).toEqual({ taskPresent: true, runPresent: true });
    expect(adapter.isInstalled(registration)).toBe(false);
    expect(service.status(f.workspaceRoot)).toMatchObject({
      enabled: false,
      backendInstalled: false,
      registrationState: "authority_conflict",
    });

    const repaired = service.enable(f.workspaceRoot);

    expect(adapter.getAuthorityState!(registration)).toEqual({ taskPresent: false, runPresent: true });
    expect(repaired).toMatchObject({ enabled: true, backendInstalled: true, registrationState: "enabled", backend: "registry_run" });
  });

  it("does not restore its own Run launcher when disabling a migrated Run registration without prior-value metadata", () => {
    const f = fixture();
    const { runKey, service } = f.runtime();
    service.enable(f.workspaceRoot);
    const taskRegistration = service.getRegistrationById(f.workspaceId)!;
    expect(taskRegistration.backend).toBe("task_scheduler");
    expect(taskRegistration.previousRunValueCaptured).toBeUndefined();

    const residue = runKey.install(taskRegistration);
    const command = hostRunValues.get(f.registration.taskName)?.value;
    expect(command).toBeDefined();
    expect(command!.length).toBeLessThan(260);

    service.enable(f.workspaceRoot);
    const migrated = service.getRegistrationById(f.workspaceId)!;
    expect(migrated).toMatchObject({
      backend: "registry_run",
      runAuthority: "host_user",
      previousRunValueCaptured: true,
      previousRunValue: null,
      previousRunValueKind: null,
    });
    expect(migrated.previousRunValue).not.toBe(command);
    expect(residue.previousRunValue).toBeNull();

    service.disable(f.workspaceRoot);

    expect(hostRunValues.has(f.registration.taskName)).toBe(false);
    expect(taskDefinitions.has(f.registration.taskName)).toBe(false);
    expect(service.getRegistrationById(f.workspaceId)).toBeNull();
  });

  it("disables a corrupt registration by deleting its known workspace-derived path", () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.registrationFile), { recursive: true });
    fs.writeFileSync(f.registrationFile, "{ truncated json");
    const { service } = f.runtime();

    const status = service.disable(f.workspaceRoot);

    expect(fs.existsSync(f.registrationFile)).toBe(false);
    expect(status).toMatchObject({ enabled: false, registrationState: "not_registered" });
  });

  it("surfaces a failed unlink of a corrupt registration rather than reporting disable success", () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.registrationFile), { recursive: true });
    fs.writeFileSync(f.registrationFile, "{ truncated json");
    const originalUnlink = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((target: unknown, ...args: unknown[]) => {
      if (typeof target === "string" && path.resolve(target) === path.resolve(f.registrationFile)) {
        throw new Error("registration unlink denied");
      }
      return (originalUnlink as (...values: unknown[]) => void)(target, ...args);
    }) as typeof fs.unlinkSync);
    const { service } = f.runtime();

    expect(() => service.disable(f.workspaceRoot)).toThrow("registration unlink denied");
    expect(fs.existsSync(f.registrationFile)).toBe(true);
  });

  it("throws when disable cannot identify a missing workspace and has no valid registration", () => {
    const f = fixture();
    const missingRoot = path.join(makeTmpDir("autostart-unidentified-workspace-parent"), "missing-workspace");
    const { service } = f.runtime();

    expect(() => service.disable(missingRoot)).toThrow("Cannot determine the workspace identity");
    expect(taskEvents).toEqual([]);
  });

  it("finds and removes a missing workspace registration by its known root path", () => {
    const f = fixture();
    const missingRoot = path.join(makeTmpDir("autostart-registered-missing-parent"), "missing-workspace");
    const workspaceId = "aabbccddeeff";
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${workspaceId}.json`);
    const missingRegistration: AutostartRegistration = {
      workspaceId,
      workspaceRoot: missingRoot,
      taskName: taskNameForWorkspace(workspaceId),
      updatedAt: new Date(0).toISOString(),
      backend: "task_scheduler",
    };
    fs.mkdirSync(path.dirname(registrationFile), { recursive: true });
    fs.writeFileSync(registrationFile, JSON.stringify(missingRegistration));
    const { service } = f.runtime();

    const status = service.disable(missingRoot);

    expect(fs.existsSync(registrationFile)).toBe(false);
    expect(status).toMatchObject({ enabled: false, registrationState: "not_registered", workspaceExists: false });
    expect(taskEvents.some((event) => event.operation === "query" && event.taskName === missingRegistration.taskName)).toBe(true);
  });
});
