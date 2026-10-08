import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutostartService, taskNameForWorkspace, type AutostartRegistration } from "../src/autostart/registration.js";
import { MAX_RUN_COMMAND_CHARACTERS, WindowsAutostartAdapter, WindowsRunKeyAutostart } from "../src/autostart/windows-task.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir } from "../src/config/paths.js";
import { makeTmpDir } from "./helpers.js";

// Every registry/SID/scheduler subprocess in this file is simulated. Even a
// broken test cannot read or modify the real HKCU Run key.
const commands = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawnSync: commands.spawnSync,
}));

type RunValue = { kind: string; value: string };
const userSid = "S-1-5-21-111-222-333-1001";
let hostValues: Map<string, RunValue>;
let packageValues: Map<string, RunValue>;
let onHostWrite: ((name: string, value: string) => void) | undefined;
let rejectHostDelete = false;
let rejectLegacyMutation = false;
let failLegacyDeleteAfterSideEffect = false;
let legacyDeleteLosesHostAfterRead = false;
let legacyAliasesHost = false;
const nodePath = "C:\\Program Files\\Formal Node\\node.exe";
const shellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const commandProcessorPath = "C:\\Windows\\System32\\cmd.exe";
const previousEnvironment = process.env.C2C_STATE_DIR;

beforeEach(() => {
  hostValues = new Map();
  packageValues = new Map();
  onHostWrite = undefined;
  rejectHostDelete = false;
  rejectLegacyMutation = false;
  failLegacyDeleteAfterSideEffect = false;
  legacyDeleteLosesHostAfterRead = false;
  legacyAliasesHost = false;
  commands.spawnSync.mockReset();
  commands.spawnSync.mockImplementation((file: string, args: string[], options?: { encoding?: string }) => {
    const result = (status: number, output = "") => ({
      status,
      stdout: options?.encoding === "utf8" ? output : Buffer.from(output),
      stderr: options?.encoding === "utf8" ? "" : Buffer.alloc(0),
    });
    const unsupportedHostType = () => ({
      status: 3,
      stdout: options?.encoding === "utf8" ? "" : Buffer.alloc(0),
      stderr: options?.encoding === "utf8"
        ? "C2C_HOST_RUN_UNSUPPORTED_TYPE"
        : Buffer.from("C2C_HOST_RUN_UNSUPPORTED_TYPE"),
    });
    if (args.includes("-Command")) {
      const script = args[args.length - 1];
      const encodedRequest = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      if (!encodedRequest) throw new Error("Unexpected PowerShell command in isolated registry test");
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
      const store = hostOperation || (legacyOperation && legacyAliasesHost) ? hostValues : packageValues;
      if (request.operation.endsWith("_read")) {
        const existing = store.get(request.name) ?? (legacyOperation && !legacyAliasesHost ? hostValues.get(request.name) : undefined) ?? null;
        if (hostOperation && existing && existing.kind !== "String") {
          return unsupportedHostType();
        }
        const response = { sid: userSid, value: existing };
        return result(0, Buffer.from(JSON.stringify(response), "utf16le").toString("base64"));
      }
      if (request.operation.endsWith("_write")) {
        if (!hostOperation && rejectLegacyMutation) return result(1, "legacy Run mutation denied");
        const value = request.value ?? "";
        store.set(request.name, { kind: request.kind ?? "String", value });
        if (hostOperation) onHostWrite?.(request.name, value);
        const response = { sid: userSid, value: hostOperation ? store.get(request.name) ?? null : null };
        return result(0, Buffer.from(JSON.stringify(response), "utf16le").toString("base64"));
      }
      if (request.operation.endsWith("_delete")) {
        if (hostOperation && rejectHostDelete) return result(1, "host Run delete denied");
        if (!hostOperation && rejectLegacyMutation) return result(1, "legacy Run mutation denied");
        if (!hostOperation && legacyDeleteLosesHostAfterRead && !legacyAliasesHost) {
          packageValues.delete(request.name);
          hostValues.delete(request.name);
        } else if (hostOperation || legacyAliasesHost || packageValues.has(request.name)) store.delete(request.name);
        else hostValues.delete(request.name);
        if (!hostOperation && failLegacyDeleteAfterSideEffect) return result(1, "legacy Run delete failed after side effect");
        const response = { sid: userSid, value: null };
        return result(0, Buffer.from(JSON.stringify(response), "utf16le").toString("base64"));
      }
      throw new Error(`Unexpected registry authority operation: ${request.operation}`);
    }
    throw new Error(`Unexpected subprocess: ${file}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousEnvironment === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousEnvironment;
});

function fixture(workspaceId = "aabbccddeeff") {
  const stateDir = makeTmpDir("Run State With Spaces ! & 中文");
  const cli = path.join(makeTmpDir("Formal Code With Spaces"), "dist", "cli", "index.js");
  const registration: AutostartRegistration = {
    workspaceId, workspaceRoot: path.join(stateDir, "Workspace With Spaces & 中文 ! %NAME%"),
    taskName: taskNameForWorkspace(workspaceId), updatedAt: new Date().toISOString(),
  };
  const adapter = new WindowsRunKeyAutostart(cli, { stateDir, nodePath, powershellPath: shellPath, commandProcessorPath });
  const launcher = path.join(stateDir, "autostart", "launchers", `${workspaceId}.cmd`);
  return { stateDir, cli, registration, adapter, launcher };
}

describe("HKCU Run stable launcher", () => {
  it("stores a short quoted REG_SZ while preserving formal Node/CLI/state/workspace/cwd in the launcher", () => {
    const f = fixture();
    const oldToken = process.env.C2C_ADMIN_TOKEN;
    process.env.C2C_ADMIN_TOKEN = "secret-must-not-be-embedded";
    try {
      f.adapter.install(f.registration);
      const value = hostValues.get(f.registration.taskName)!;
      expect(value.kind).toBe("String");
      expect(value.value).toBe(`"${commandProcessorPath}" /d /v:off /s /c ""${f.launcher}""`);
      expect(value.value.length).toBeLessThanOrEqual(MAX_RUN_COMMAND_CHARACTERS);
      expect(MAX_RUN_COMMAND_CHARACTERS).toBeLessThan(260);
      expect(value.value).not.toContain("EncodedCommand");
      const body = fs.readFileSync(f.launcher, "utf8");
      expect(body).toContain("setlocal DisableDelayedExpansion");
      expect(body).toContain("chcp 65001 >nul");
      expect(body).toContain("echo cmd_entered");
      expect(body).toContain("echo node_invoking");
      expect(body).toContain("echo node_returned=%C2C_NODE_EXIT%");
      expect(body).toContain("goto c2c_cwd_failed");
      expect(body).toContain("--import");
      expect(body).toContain(`"${nodePath}" "${f.cli}" "autostart" "restore" "--workspace-id" "${f.registration.workspaceId}" "--workspace" "${f.registration.workspaceRoot.replace(/%/g, "%%")}"`);
      expect(body).toContain(`set "C2C_STATE_DIR=${f.stateDir}"`);
      expect(body).toContain(`cd /d "${path.resolve(path.dirname(f.cli), "..", "..")}"`);
      expect(body).not.toMatch(/EncodedCommand|powershell|secret-must-not-be-embedded|adminToken|oauth/i);
      expect(f.adapter.isInstalled(f.registration)).toBe(true);
    } finally {
      if (oldToken === undefined) delete process.env.C2C_ADMIN_TOKEN;
      else process.env.C2C_ADMIN_TOKEN = oldToken;
    }
  });

  it("uses the canonical state-root resolver when no state override is provided", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    const adapter = new WindowsRunKeyAutostart(f.cli, {
      nodePath, powershellPath: shellPath, commandProcessorPath,
      environment: { C2C_STATE_DIR: "must-not-override-canonical-state" },
    });
    adapter.install(f.registration, { environment: { c2c_state_dir: "must-not-override-by-case" } });
    const body = fs.readFileSync(f.launcher, "utf8");
    expect(body).toContain(`set "C2C_STATE_DIR=${getStateDir()}"`);
    expect(body).not.toContain("must-not-override");
    expect(adapter.isInstalled(f.registration)).toBe(true);
  });

  it("rejects oversized or percent-expanded paths before any mutation", () => {
    const f = fixture();
    for (const stateDir of [path.join(f.stateDir, "x".repeat(190)), path.join(f.stateDir, "%UNSAFE%")]) {
      const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir, powershellPath: shellPath, commandProcessorPath });
      expect(() => adapter.install(f.registration)).toThrow(/too long|unsupported command-shell/);
      expect(fs.existsSync(path.join(stateDir, "autostart"))).toBe(false);
    }
    expect(commands.spawnSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid workspace ID without writing outside the launcher directory", () => {
    const f = fixture();
    expect(() => f.adapter.install({ ...f.registration, workspaceId: "../another" })).toThrow(/workspace ID/);
    expect(commands.spawnSync).not.toHaveBeenCalled();
  });

  it("treats a package-only Run value as unhealthy and enable installs the host authority", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot, { recursive: true });
    const workspace = new Workspace(f.registration.workspaceRoot);
    const registration: AutostartRegistration = {
      ...f.registration,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      taskName: taskNameForWorkspace(workspace.id),
      backend: "registry_run",
      previousRunValueCaptured: true,
      previousRunValue: "package-only backup must not be restored to host",
      previousRunValueKind: "String",
    };
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(registrationFile), { recursive: true });
    fs.writeFileSync(registrationFile, JSON.stringify(registration));
    packageValues.set(registration.taskName, { kind: "String", value: "package-private old launcher" });

    expect(f.adapter.isInstalled(registration)).toBe(false);
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    expect(service.status(workspace.root)).toMatchObject({ enabled: false, backendInstalled: false });
    const enabled = service.enable(workspace.root);

    expect(enabled.enabled).toBe(true);
    expect(hostValues.has(registration.taskName)).toBe(true);
    expect(hostValues.get(registration.taskName)?.value).not.toBe("package-only backup must not be restored to host");
    expect(service.getRegistrationById(workspace.id)).toMatchObject({ backend: "registry_run", runAuthority: "host_user" });
    expect(f.adapter.isInstalled(service.getRegistrationById(workspace.id)!)).toBe(true);

    service.disable(workspace.root);
    expect(hostValues.has(registration.taskName)).toBe(false);
    expect(hostValues.get(registration.taskName)?.value).not.toBe("package-only backup must not be restored to host");
  });

  it.each(["wrong-command", "oversized", "wrong-kind", "missing", "truncated", "wrong-cli", "wrong-node", "wrong-state", "wrong-workspace", "wrong-id", "wrong-cwd"])("fails health checks for %s despite an existing Run value", (damage) => {
    const f = fixture();
    f.adapter.install(f.registration);
    if (damage === "wrong-command") hostValues.get(f.registration.taskName)!.value = "old-checkout";
    else if (damage === "oversized") hostValues.get(f.registration.taskName)!.value = "x".repeat(2603);
    else if (damage === "wrong-kind") hostValues.get(f.registration.taskName)!.kind = "ExpandString";
    else if (damage === "missing") fs.unlinkSync(f.launcher);
    else if (damage === "truncated") fs.writeFileSync(f.launcher, "@echo off\r\n");
    else {
      const options = { stateDir: f.stateDir, nodePath, powershellPath: shellPath, commandProcessorPath };
      const registration = { ...f.registration };
      if (damage === "wrong-node") options.nodePath = "C:\\Old Checkout\\node.exe";
      if (damage === "wrong-state") options.stateDir = path.join(f.stateDir, "old-state");
      if (damage === "wrong-workspace") registration.workspaceRoot += " old";
      if (damage === "wrong-id") registration.workspaceId = "112233445566";
      const cli = damage === "wrong-cli" || damage === "wrong-cwd" ? path.join(f.stateDir, "Old Checkout", "dist", "cli", "index.js") : f.cli;
      const other = new WindowsRunKeyAutostart(cli, options);
      other.install(registration);
      const otherFile = path.join(options.stateDir, "autostart", "launchers", `${registration.workspaceId}.cmd`);
      fs.copyFileSync(otherFile, f.launcher);
      // Preserve the expected command, so content validation is what rejects it.
      hostValues.get(f.registration.taskName)!.value = `"${commandProcessorPath}" /d /v:off /s /c ""${f.launcher}""`;
    }
    expect(hostValues.has(f.registration.taskName)).toBe(true);
    expect(f.adapter.isInstalled(f.registration)).toBe(false);
  });

  it("reports a damaged Run launcher as disabled through service.status", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot);
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    expect(service.enable(f.registration.workspaceRoot).enabled).toBe(true);
    const id = new Workspace(f.registration.workspaceRoot).id;
    fs.writeFileSync(path.join(f.stateDir, "autostart", "launchers", `${id}.cmd`), "partial");
    expect(service.status(f.registration.workspaceRoot)).toMatchObject({ enabled: false, backendInstalled: false, registrationState: "task_missing" });
  });

  it("repairs an existing 2603-character registration via enable without capturing it as a restore value", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot);
    const workspace = new Workspace(f.registration.workspaceRoot);
    const legacy: AutostartRegistration = { ...f.registration, workspaceId: workspace.id, taskName: taskNameForWorkspace(workspace.id), backend: "registry_run", previousRunValueCaptured: true, previousRunValue: null };
    fs.mkdirSync(path.join(f.stateDir, "autostart", "workspaces"), { recursive: true });
    fs.writeFileSync(path.join(f.stateDir, "autostart", "workspaces", `${workspace.id}.json`), JSON.stringify(legacy));
    packageValues.set(legacy.taskName, { kind: "String", value: "x".repeat(2603) });
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    expect(service.status(workspace.root).enabled).toBe(false);
    expect(service.enable(workspace.root).enabled).toBe(true);
    const short = hostValues.get(legacy.taskName)!.value;
    expect(short.length).toBeLessThan(260);
    expect(service.getRegistrationById(workspace.id)?.previousRunValue).toBeNull();
    expect(packageValues.has(legacy.taskName)).toBe(false);
    expect(service.enable(workspace.root).enabled).toBe(true);
    expect(hostValues.get(legacy.taskName)!.value).toBe(short);
    service.disable(workspace.root);
    expect(hostValues.has(legacy.taskName)).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${workspace.id}.cmd`))).toBe(false);
  });

  it.each(["healthy", "corrupt", "missing", "missing-entry", "legacy"])("disable cleans the selected %s launcher and entry without touching another workspace", (damage) => {
    const f = fixture();
    const second = { ...f.registration, workspaceId: "112233445566", taskName: taskNameForWorkspace("112233445566") };
    const installed = f.adapter.install(f.registration);
    f.adapter.install(second);
    const secondFile = path.join(f.stateDir, "autostart", "launchers", `${second.workspaceId}.cmd`);
    const secondContents = fs.readFileSync(secondFile);
    const firstPackageValue = { kind: "String", value: "first workspace caller-view residue" };
    const secondPackageValue = { kind: "ExpandString", value: "%SECOND_WORKSPACE%\\residue" };
    packageValues.set(f.registration.taskName, firstPackageValue);
    packageValues.set(second.taskName, secondPackageValue);
    if (damage === "corrupt") fs.writeFileSync(f.launcher, "partial");
    if (damage === "missing") fs.unlinkSync(f.launcher);
    if (damage === "missing-entry") hostValues.delete(f.registration.taskName);
    if (damage === "legacy") hostValues.get(f.registration.taskName)!.value = "x".repeat(2603);
    f.adapter.remove({ ...f.registration, ...installed });
    expect(hostValues.has(f.registration.taskName)).toBe(false);
    expect(packageValues.has(f.registration.taskName)).toBe(false);
    expect(fs.existsSync(f.launcher)).toBe(false);
    expect(fs.readFileSync(secondFile).equals(secondContents)).toBe(true);
    expect(f.adapter.isInstalled(second)).toBe(true);
    expect(packageValues.get(second.taskName)).toEqual(secondPackageValue);
  });

  it("preserves the original host String value over repeated enable and restores it on disable", () => {
    const f = fixture();
    const original = { kind: "String", value: "C:\\original.exe" };
    hostValues.set(f.registration.taskName, original);
    const installed = f.adapter.install(f.registration);
    const updated = f.adapter.install({ ...f.registration, ...installed });
    expect(updated.previousRunValue).toBe(original.value);
    f.adapter.remove({ ...f.registration, ...updated });
    expect(hostValues.get(f.registration.taskName)).toEqual(original);
    expect(fs.existsSync(f.launcher)).toBe(false);
  });

  it("rejects a host ExpandString before mutation because its raw value cannot be preserved", () => {
    const f = fixture();
    const original = { kind: "ExpandString", value: "%LOCALAPPDATA%\\original.exe" };
    hostValues.set(f.registration.taskName, original);
    let beforeMutationCalled = false;

    expect(() => f.adapter.install(f.registration, {}, () => { beforeMutationCalled = true; }))
      .toThrow(/Unsupported host Run value type/i);

    expect(beforeMutationCalled).toBe(false);
    expect(hostValues.get(f.registration.taskName)).toEqual(original);
    expect(fs.existsSync(f.launcher)).toBe(false);
  });

  it("publishes a complete launcher by same-directory rename before writing the registry", () => {
    const f = fixture();
    const rename = vi.spyOn(fs, "renameSync");
    onHostWrite = () => {
      expect(fs.readFileSync(f.launcher, "utf8")).toContain(`"${nodePath}"`);
      expect(rename).toHaveBeenCalledOnce();
      const [temporary, target] = rename.mock.calls[0];
      expect(path.dirname(String(temporary))).toBe(path.dirname(String(target)));
      expect(target).toBe(f.launcher);
    };
    f.adapter.install(f.registration);
    expect(fs.readdirSync(path.dirname(f.launcher))).toEqual([`${f.registration.workspaceId}.cmd`]);
  });

  it("leaves the old launcher/entry intact if atomic publication fails", () => {
    const f = fixture();
    f.adapter.install(f.registration);
    const oldLauncher = fs.readFileSync(f.launcher);
    const oldValue = hostValues.get(f.registration.taskName);
    commands.spawnSync.mockClear();
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("rename denied"); });
    expect(() => f.adapter.install(f.registration)).toThrow("rename denied");
    expect(fs.readFileSync(f.launcher).equals(oldLauncher)).toBe(true);
    expect(hostValues.get(f.registration.taskName)).toEqual(oldValue);
    expect(fs.readdirSync(path.dirname(f.launcher))).toEqual([`${f.registration.workspaceId}.cmd`]);
    expect(commands.spawnSync.mock.calls.map(([, args]) => {
      const script = String(args.at(-1));
      const encoded = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      return encoded
        ? (JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { operation: string }).operation
        : "unexpected";
    })).toEqual(["host_read", "legacy_read", "host_read"]);
  });

  it.each(["write-side-effect-error", "wrong-readback", "partial-file"])("rolls back a failed update (%s) to the previous launcher and host entry", (failure) => {
    const f = fixture();
    const installed = f.adapter.install(f.registration);
    const oldLauncher = fs.readFileSync(f.launcher);
    const oldValue = { ...hostValues.get(f.registration.taskName)! };
    const updated = new WindowsRunKeyAutostart(path.join(f.stateDir, "New Formal Code", "dist", "cli", "index.js"), { stateDir: f.stateDir, nodePath, powershellPath: shellPath, commandProcessorPath });
    let firstWrite = true;
    onHostWrite = (name) => {
      if (!firstWrite) return;
      firstWrite = false;
      if (failure === "write-side-effect-error") throw new Error("host write failed after mutation");
      if (failure === "wrong-readback") hostValues.get(name)!.value = "wrong host readback";
      if (failure === "partial-file") fs.writeFileSync(f.launcher, "partial");
    };
    expect(() => updated.install({ ...f.registration, ...installed })).toThrow(/host write failed after mutation|host Run authority|installation verification/i);
    expect(hostValues.get(f.registration.taskName)).toEqual(oldValue);
    expect(fs.readFileSync(f.launcher).equals(oldLauncher)).toBe(true);
    expect(f.adapter.isInstalled(f.registration)).toBe(true);
  });

  it("removes an unpublished registration's launcher when first installation verification fails", () => {
    const f = fixture();
    onHostWrite = (name) => { hostValues.get(name)!.value = "wrong-command"; };
    expect(() => f.adapter.install(f.registration)).toThrow(/host Run authority|installation verification/i);
    expect(hostValues.has(f.registration.taskName)).toBe(false);
    expect(fs.existsSync(f.launcher)).toBe(false);
  });

  it("refuses to overwrite an unsupported registry type", () => {
    const f = fixture();
    hostValues.set(f.registration.taskName, { kind: "DWord", value: "1" });
    expect(f.adapter.isInstalled(f.registration)).toBe(false);
    expect(() => f.adapter.install(f.registration)).toThrow(/Unsupported host Run value type/i);
    expect(fs.existsSync(f.launcher)).toBe(false);
    expect(hostValues.get(f.registration.taskName)!.kind).toBe("DWord");
  });

  it("rolls back a first host Run write and launcher when registration publication fails", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot, { recursive: true });
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    const id = new Workspace(f.registration.workspaceRoot).id;
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${id}.json`);
    const launcher = path.join(f.stateDir, "autostart", "launchers", `${id}.cmd`);
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((source: unknown, target: unknown, ...args: unknown[]) => {
      if (target === registrationFile) throw new Error("first registration persistence denied");
      return (originalRename as (...values: unknown[]) => void)(source, target, ...args);
    }) as typeof fs.renameSync);

    expect(() => service.enable(f.registration.workspaceRoot)).toThrow("first registration persistence denied");

    expect(hostValues.has(taskNameForWorkspace(id))).toBe(false);
    expect(packageValues.has(taskNameForWorkspace(id))).toBe(false);
    expect(fs.existsSync(launcher)).toBe(false);
    expect(fs.existsSync(registrationFile)).toBe(false);
  });

  it("restores the previous registration and launcher if persisting an enable update fails", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot);
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    service.enable(f.registration.workspaceRoot);
    const id = new Workspace(f.registration.workspaceRoot).id;
    const file = path.join(f.stateDir, "autostart", "launchers", `${id}.cmd`);
    const previousRegistration = service.getRegistrationById(id);
    const oldContents = fs.readFileSync(file);
    const oldValue = { ...hostValues.get(taskNameForWorkspace(id))! };
    const newAdapter = new WindowsRunKeyAutostart(path.join(f.stateDir, "New Formal Code", "dist", "cli", "index.js"), { stateDir: f.stateDir, nodePath, powershellPath: shellPath, commandProcessorPath });
    const newService = new AutostartService(newAdapter, f.stateDir, "win32");
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((source: unknown, target: unknown, ...args: unknown[]) => {
      if (target === path.join(f.stateDir, "autostart", "workspaces", `${id}.json`)) {
        throw new Error("registration persistence denied");
      }
      return (rename as (...args: unknown[]) => void)(source, target, ...args);
    }) as typeof fs.renameSync);
    expect(() => newService.enable(f.registration.workspaceRoot)).toThrow("registration persistence denied");
    expect(newService.getRegistrationById(id)).toEqual(previousRegistration);
    expect(fs.readFileSync(file).equals(oldContents)).toBe(true);
    expect(hostValues.get(taskNameForWorkspace(id))).toEqual(oldValue);
    expect(service.status(f.registration.workspaceRoot).enabled).toBe(true);
  });

  it("rolls host Run back after final publication fails, retains the pending journal, then resumes", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot);
    let taskPresent = true;
    let taskInstallCalls = 0;
    const scheduler = {
      install: () => { taskInstallCalls += 1; return { backend: "task_scheduler" as const }; },
      remove: () => { taskPresent = false; },
      isInstalled: () => taskPresent,
    };
    const adapter = new WindowsAutostartAdapter(scheduler, f.adapter);
    const service = new AutostartService(adapter, f.stateDir, "win32");
    service.enable(f.registration.workspaceRoot);
    expect(taskInstallCalls).toBe(1);
    const id = new Workspace(f.registration.workspaceRoot).id;
    const previousRegistration = service.getRegistrationById(id);
    scheduler.install = () => { taskInstallCalls += 1; throw new Error("Access is denied."); };
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${id}.json`);
    const rename = fs.renameSync;
    let registrationWrites = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(((source: unknown, target: unknown, ...args: unknown[]) => {
      if (target === registrationFile) {
        registrationWrites += 1;
        if (registrationWrites === 2) throw new Error("registration persistence denied");
      }
      return (rename as (...args: unknown[]) => void)(source, target, ...args);
    }) as typeof fs.renameSync);
    expect(() => service.enable(f.registration.workspaceRoot)).toThrow("registration persistence denied");
    const pending = service.getRegistrationById(id);
    expect(previousRegistration).toMatchObject({ backend: "task_scheduler" });
    expect(pending).toMatchObject({
      backend: "task_scheduler", pendingBackend: "registry_run", runAuthority: "host_user",
      previousRunValueCaptured: true, previousRunValue: null,
      legacyRunValueCaptured: true, legacyRunValue: null,
    });
    expect(taskPresent).toBe(false);
    expect(taskInstallCalls).toBe(2);
    expect(hostValues.has(taskNameForWorkspace(id))).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${id}.cmd`))).toBe(false);
    expect(service.status(f.registration.workspaceRoot)).toMatchObject({ enabled: false, taskInstalled: false, backendInstalled: false, registrationState: "transition_pending" });

    vi.mocked(fs.renameSync).mockRestore();
    const resumed = service.enable(f.registration.workspaceRoot);
    expect(resumed).toMatchObject({ enabled: true, backend: "registry_run", taskInstalled: false, backendInstalled: true, registrationState: "enabled" });
    expect(service.getRegistrationById(id)).toMatchObject({ backend: "registry_run" });
    expect(service.getRegistrationById(id)?.pendingBackend).toBeUndefined();
    expect(taskPresent).toBe(false);
    expect(taskInstallCalls).toBe(2);
    expect(hostValues.has(taskNameForWorkspace(id))).toBe(true);
  });

  it("retains the pending journal and Task when fallback commit cannot remove the old Task", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot);
    let taskPresent = true;
    let taskInstallCalls = 0;
    let schedulerDenies = false;
    let rejectTaskRemoval = false;
    const scheduler = {
      install: () => {
        taskInstallCalls += 1;
        if (schedulerDenies) throw new Error("Access is denied.");
        return { backend: "task_scheduler" as const };
      },
      remove: () => {
        if (rejectTaskRemoval) throw new Error("task deletion denied");
        taskPresent = false;
      },
      isInstalled: () => taskPresent,
    };
    const service = new AutostartService(new WindowsAutostartAdapter(scheduler, f.adapter), f.stateDir, "win32");
    service.enable(f.registration.workspaceRoot);
    const id = new Workspace(f.registration.workspaceRoot).id;
    schedulerDenies = true;
    rejectTaskRemoval = true;

    expect(() => service.enable(f.registration.workspaceRoot)).toThrow(/task deletion denied/);
    expect(service.getRegistrationById(id)).toMatchObject({ backend: "task_scheduler", pendingBackend: "registry_run", previousRunValueCaptured: true, previousRunValue: null });
    expect(taskPresent).toBe(true);
    expect(hostValues.has(taskNameForWorkspace(id))).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${id}.cmd`))).toBe(false);
    expect(service.status(f.registration.workspaceRoot)).toMatchObject({ enabled: false, taskInstalled: true, backendInstalled: false, registrationState: "transition_pending" });

    rejectTaskRemoval = false;
    const resumed = service.enable(f.registration.workspaceRoot);
    expect(resumed).toMatchObject({ enabled: true, backend: "registry_run", backendInstalled: true, registrationState: "enabled" });
    expect(taskPresent).toBe(false);
    expect(taskInstallCalls).toBe(2);
    expect(hostValues.has(taskNameForWorkspace(id))).toBe(true);
  });

  it("disable removes both authorities from an abnormal coexistence without affecting another workspace", () => {
    const f = fixture();
    const firstRoot = f.registration.workspaceRoot;
    const secondRoot = makeTmpDir("second-autostart-workspace");
    fs.mkdirSync(firstRoot, { recursive: true });
    const firstWorkspace = new Workspace(firstRoot);
    const secondWorkspace = new Workspace(secondRoot);
    const first: AutostartRegistration = {
      ...f.registration,
      workspaceId: firstWorkspace.id,
      workspaceRoot: firstWorkspace.root,
      taskName: taskNameForWorkspace(firstWorkspace.id),
    };
    const second: AutostartRegistration = {
      ...first,
      workspaceId: secondWorkspace.id,
      workspaceRoot: secondWorkspace.root,
      taskName: taskNameForWorkspace(secondWorkspace.id),
    };
    const firstInstall = f.adapter.install(first);
    f.adapter.install(second);
    const registrationDir = path.join(f.stateDir, "autostart", "workspaces");
    fs.mkdirSync(registrationDir, { recursive: true });
    fs.writeFileSync(path.join(registrationDir, `${first.workspaceId}.json`), JSON.stringify({ ...first, ...firstInstall }));
    const scheduledTasks = new Set([first.taskName, second.taskName]);
    const scheduler = {
      install: () => ({ backend: "task_scheduler" as const }),
      remove: (registration: AutostartRegistration) => { scheduledTasks.delete(registration.taskName); },
      isInstalled: (registration: AutostartRegistration) => scheduledTasks.has(registration.taskName),
    };
    const service = new AutostartService(new WindowsAutostartAdapter(scheduler, f.adapter), f.stateDir, "win32");

    service.disable(first.workspaceRoot);

    expect(scheduledTasks.has(first.taskName)).toBe(false);
    expect(hostValues.has(first.taskName)).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${first.workspaceId}.cmd`))).toBe(false);
    expect(service.getRegistrationById(first.workspaceId)).toBeNull();
    expect(scheduledTasks.has(second.taskName)).toBe(true);
    expect(f.adapter.isInstalled(second)).toBe(true);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${second.workspaceId}.cmd`))).toBe(true);
  });

  it("reports cleanup failure and retains registration for retry while still clearing Run and launcher", () => {
    const f = fixture();
    fs.mkdirSync(f.registration.workspaceRoot, { recursive: true });
    const workspace = new Workspace(f.registration.workspaceRoot);
    const registration: AutostartRegistration = {
      ...f.registration,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      taskName: taskNameForWorkspace(workspace.id),
    };
    const installed = f.adapter.install(registration);
    const registrationDir = path.join(f.stateDir, "autostart", "workspaces");
    const file = path.join(registrationDir, `${registration.workspaceId}.json`);
    fs.mkdirSync(registrationDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...registration, ...installed }));
    let taskPresent = true;
    let rejectTaskRemoval = true;
    const scheduler = {
      install: () => ({ backend: "task_scheduler" as const }),
      remove: () => {
        if (rejectTaskRemoval) throw new Error("task cleanup denied");
        taskPresent = false;
      },
      isInstalled: () => taskPresent,
    };
    const service = new AutostartService(new WindowsAutostartAdapter(scheduler, f.adapter), f.stateDir, "win32");

    expect(() => service.disable(registration.workspaceRoot)).toThrow(/task cleanup denied/);
    expect(taskPresent).toBe(true);
    expect(hostValues.has(registration.taskName)).toBe(false);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${registration.workspaceId}.cmd`))).toBe(false);
    expect(service.getRegistrationById(registration.workspaceId)).not.toBeNull();

    rejectTaskRemoval = false;
    service.disable(registration.workspaceRoot);
    expect(taskPresent).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("restores a package caller snapshot and the prior host state after legacy delete changes state then fails", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot, { recursive: true });
    const workspace = new Workspace(f.registration.workspaceRoot);
    const callerOriginal = { kind: "ExpandString", value: "%LOCALAPPDATA%\\old package C2C launcher" };
    const registration: AutostartRegistration = {
      ...f.registration,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      taskName: taskNameForWorkspace(workspace.id),
      backend: "registry_run",
      legacyRunValueCaptured: true,
      legacyRunValue: callerOriginal.value,
      legacyRunValueKind: "ExpandString",
    };
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${registration.workspaceId}.json`);
    fs.mkdirSync(path.dirname(registrationFile), { recursive: true });
    fs.writeFileSync(registrationFile, JSON.stringify(registration));
    packageValues.set(registration.taskName, callerOriginal);
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    failLegacyDeleteAfterSideEffect = true;

    expect(() => service.enable(registration.workspaceRoot)).toThrow(/legacy Run cleanup failed/i);

    expect(hostValues.has(registration.taskName)).toBe(false);
    expect(packageValues.get(registration.taskName)).toEqual(callerOriginal);
    expect(fs.existsSync(path.join(f.stateDir, "autostart", "launchers", `${registration.workspaceId}.cmd`))).toBe(false);
    expect(service.getRegistrationById(registration.workspaceId)).toEqual(registration);
  });

  it("retains registration for retry when host Run deletion fails", () => {
    const f = fixture();
    process.env.C2C_STATE_DIR = f.stateDir;
    fs.mkdirSync(f.registration.workspaceRoot, { recursive: true });
    const workspace = new Workspace(f.registration.workspaceRoot);
    const registration: AutostartRegistration = {
      ...f.registration,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      taskName: taskNameForWorkspace(workspace.id),
    };
    const service = new AutostartService(f.adapter, f.stateDir, "win32");
    service.enable(registration.workspaceRoot);
    const launcher = path.join(f.stateDir, "autostart", "launchers", `${registration.workspaceId}.cmd`);
    const registrationFile = path.join(f.stateDir, "autostart", "workspaces", `${registration.workspaceId}.json`);
    rejectHostDelete = true;

    expect(() => service.disable(registration.workspaceRoot)).toThrow(/host Run entry cleanup failed/i);

    expect(hostValues.has(registration.taskName)).toBe(true);
    expect(fs.existsSync(launcher)).toBe(false);
    expect(fs.existsSync(registrationFile)).toBe(true);

    rejectHostDelete = false;
    service.disable(registration.workspaceRoot);
    expect(hostValues.has(registration.taskName)).toBe(false);
    expect(fs.existsSync(registrationFile)).toBe(false);
  });

  it.runIf(process.platform === "win32")("executes the quoted cmd launcher from an unrelated cwd using only isolated fixture processes", async () => {
    const f = fixture();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    fs.mkdirSync(path.dirname(f.cli), { recursive: true });
    fs.writeFileSync(f.cli, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "fs.writeFileSync(path.join(process.env.C2C_STATE_DIR, 'launch-result.json'), JSON.stringify({args:process.argv.slice(2), cwd:process.cwd(), state:process.env.C2C_STATE_DIR}));",
    ].join("\n"));
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, C2C_STATE_DIR: "incorrect-inherited-state" }, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status, `${new TextDecoder("gbk").decode(launched.stdout).slice(0, 600)} ${new TextDecoder("gbk").decode(launched.stderr).slice(0, 600)}`).toBe(0);
    const resultFile = path.join(f.stateDir, "launch-result.json");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(resultFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toEqual({
      args: ["autostart", "restore", "--workspace-id", f.registration.workspaceId, "--workspace", f.registration.workspaceRoot],
      cwd: path.resolve(path.dirname(f.cli), "..", ".."), state: f.stateDir,
    });
    const breadcrumb = fs.readFileSync(path.join(f.stateDir, "autostart", "diagnostics", `${f.registration.workspaceId}.launch.log`), "utf8");
    expect(breadcrumb).toContain("cmd_entered");
    expect(breadcrumb).toContain("node_invoking");
    expect(breadcrumb).toContain("node_returned=0");
  });

  it.runIf(process.platform === "win32")("falls back to the original CLI invocation if the preload asset disappears after install", async () => {
    const f = fixture();
    const helper = path.resolve(path.dirname(f.cli), "..", "autostart", "launch-breadcrumb.js");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "throw new Error('preload must not be selected after it disappears');\n");
    fs.mkdirSync(path.dirname(f.cli), { recursive: true });
    fs.writeFileSync(f.cli, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "fs.writeFileSync(path.join(process.env.C2C_STATE_DIR, 'launch-result.json'), JSON.stringify({args:process.argv.slice(2)}));",
    ].join("\n"));
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    expect(adapter.isInstalled(f.registration)).toBe(true);
    fs.unlinkSync(helper);
    expect(adapter.isInstalled(f.registration)).toBe(true);

    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, C2C_STATE_DIR: "incorrect-inherited-state" }, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status, `${new TextDecoder("gbk").decode(launched.stdout).slice(0, 400)} ${new TextDecoder("gbk").decode(launched.stderr).slice(0, 400)}`).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.stateDir, "launch-result.json"), "utf8"))).toEqual({
      args: ["autostart", "restore", "--workspace-id", f.registration.workspaceId, "--workspace", f.registration.workspaceRoot],
    });
  });

  it.runIf(process.platform === "win32")("uses the preload branch and records a CLI static import failure", async () => {
    const f = fixture();
    const builtHelper = path.resolve("dist", "autostart", "launch-breadcrumb.js");
    expect(fs.existsSync(builtHelper), "build the current source before this test").toBe(true);
    const helper = path.resolve(path.dirname(f.cli), "..", "autostart", "launch-breadcrumb.js");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(builtHelper, helper);
    fs.mkdirSync(path.dirname(f.cli), { recursive: true });
    fs.writeFileSync(f.cli, "import './missing-cli-import.mjs';\n");
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, C2C_STATE_DIR: "incorrect-inherited-state", C2C_ADMIN_TOKEN: "must-not-be-logged" }, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status).toBe(1);
    const breadcrumb = fs.readFileSync(path.join(f.stateDir, "autostart", "diagnostics", `${f.registration.workspaceId}.launch.log`), "utf8");
    expect(breadcrumb).toContain("cmd_entered");
    expect(breadcrumb).toContain("node_invoking");
    expect(breadcrumb).toContain("node_returned=1");
    const records = breadcrumb.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.stage)).toEqual(["node_started", "node_exited"]);
    expect(records[1].exitCode).toBe(1);
    expect(breadcrumb).not.toContain("must-not-be-logged");
    expect(breadcrumb).not.toContain("missing-cli-import");
  });

  it.runIf(process.platform === "win32")("records a failed cwd change without invoking Node", async () => {
    const f = fixture();
    const missingCli = path.join(f.stateDir, "missing-package", "dist", "cli", "index.js");
    const adapter = new WindowsRunKeyAutostart(missingCli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status).toBe(1);
    const breadcrumb = fs.readFileSync(path.join(f.stateDir, "autostart", "diagnostics", `${f.registration.workspaceId}.launch.log`), "utf8");
    expect(breadcrumb).toContain("cmd_entered");
    expect(breadcrumb).toContain("cwd_failed");
    expect(breadcrumb).not.toContain("node_invoking");
  });

  it.runIf(process.platform === "win32")("captures a missing Node exit code without changing it", async () => {
    const f = fixture();
    const missingNode = path.join(f.stateDir, "missing-node.exe");
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: missingNode, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status).not.toBe(0);
    const breadcrumb = fs.readFileSync(path.join(f.stateDir, "autostart", "diagnostics", `${f.registration.workspaceId}.launch.log`), "utf8");
    expect(breadcrumb).toContain("node_invoking");
    expect(breadcrumb).toMatch(/node_returned=\d+/);
    expect(breadcrumb).not.toContain("node_started");
  });

  it.runIf(process.platform === "win32")("keeps Node startup working when CMD cannot create the breadcrumb file", async () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.cli), { recursive: true });
    fs.writeFileSync(f.cli, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "fs.writeFileSync(path.join(process.env.C2C_STATE_DIR, 'launch-result.json'), 'ran');",
    ].join("\n"));
    const diagnosticsPath = path.join(f.stateDir, "autostart", "diagnostics");
    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
    fs.writeFileSync(diagnosticsPath, "not-a-directory");
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status).toBe(0);
    expect(fs.readFileSync(path.join(f.stateDir, "launch-result.json"), "utf8")).toBe("ran");
  });

  it.runIf(process.platform === "win32")("preserves a nonzero Node exit when CMD breadcrumb writes fail", async () => {
    const f = fixture();
    fs.mkdirSync(path.dirname(f.cli), { recursive: true });
    fs.writeFileSync(f.cli, "process.exit(17);\n");
    const diagnosticsPath = path.join(f.stateDir, "autostart", "diagnostics");
    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
    fs.writeFileSync(diagnosticsPath, "not-a-directory");
    const adapter = new WindowsRunKeyAutostart(f.cli, { stateDir: f.stateDir, nodePath: process.execPath, powershellPath: shellPath, commandProcessorPath });
    adapter.install(f.registration);
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const launched = actual.spawnSync(commandProcessorPath, ["/d", "/v:off", "/s", "/c", `""${f.launcher}""`], {
      cwd: f.stateDir, windowsHide: true, windowsVerbatimArguments: true, timeout: 10_000,
    });
    expect(launched.error).toBeUndefined();
    expect(launched.status).toBe(17);
  });
});
