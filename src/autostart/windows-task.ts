import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import type {
  AutostartInstallResult,
  AutostartRegistration,
  AutostartTaskAdapter,
} from "./registration.js";

export interface WindowsTaskOptions {
  stateDir?: string;
  environment?: Record<string, string>;
  powershellPath?: string;
  schedulerPath?: string;
  nodePath?: string;
}

export interface WindowsTaskInstallOverrides {
  taskName?: string;
  cliArguments?: string[];
  environment?: Record<string, string>;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Quote one argv value using the Windows CommandLineToArgvW rules. */
export function quoteWindowsArgument(value: string): string {
  let output = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      output += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    output += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  output += "\\".repeat(backslashes * 2) + '"';
  return output;
}

export function quoteWindowsCommandLine(args: string[]): string {
  return args.map(quoteWindowsArgument).join(" ");
}

export interface ScheduledTaskAction {
  command: string;
  arguments: string;
  workingDirectory: string;
}

export function buildLogonTaskXml(input: {
  taskName: string;
  userSid: string;
  action: ScheduledTaskAction;
}): string {
  const taskName = xmlEscape(input.taskName);
  const userSid = xmlEscape(input.userSid);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>C2C workspace autostart</Description><URI>\\${taskName}</URI></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${userSid}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${userSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled><Hidden>true</Hidden>
    <ExecutionTimeLimit>PT3M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec>
    <Command>${xmlEscape(input.action.command)}</Command>
    <Arguments>${xmlEscape(input.action.arguments)}</Arguments>
    <WorkingDirectory>${xmlEscape(input.action.workingDirectory)}</WorkingDirectory>
  </Exec></Actions>
</Task>
`;
}

function windowsSystemRoot(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  if (!root) throw new Error("Cannot locate the Windows system directory.");
  return root;
}

function runCommand(command: string, args: string[]): { status: number | null; output: string; error?: Error } {
  const result = spawnSync(command, args, {
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  const decode = (value: Buffer | null): string => {
    if (!value) return "";
    try { return new TextDecoder("gbk").decode(value); }
    catch { return value.toString("utf8"); }
  };
  return {
    status: result.status,
    output: `${decode(result.stdout)}${decode(result.stderr)}`.trim(),
    ...(result.error ? { error: result.error } : {}),
  };
}

function powershellPath(options: WindowsTaskOptions): string {
  return options.powershellPath ?? path.join(windowsSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function currentUserSid(shellPath: string): string {
  const result = runCommand(shellPath, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  ]);
  const sid = result.output.trim();
  if (result.error || result.status !== 0 || !/^S-\d-\d+(?:-\d+)+$/.test(sid)) {
    throw new Error(`Could not read the current Windows user SID${result.output ? `: ${result.output.slice(0, 1000)}` : ""}`);
  }
  return sid;
}

export function buildHiddenPowerShellAction(input: {
  nodePath: string;
  nodeArguments: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  powershellPath: string;
}): ScheduledTaskAction {
  const payload = Buffer.from(JSON.stringify({
    nodePath: input.nodePath,
    arguments: quoteWindowsCommandLine(input.nodeArguments),
    workingDirectory: input.workingDirectory,
    environment: input.environment,
  }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "foreach ($property in $payload.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }",
    "Start-Process -FilePath $payload.nodePath -ArgumentList $payload.arguments -WorkingDirectory $payload.workingDirectory -WindowStyle Hidden",
    "exit 0",
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return {
    command: input.powershellPath,
    arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encodedScript}`,
    workingDirectory: input.workingDirectory,
  };
}

function restoreNodeArguments(cliModulePath: string, registration: AutostartRegistration): string[] {
  const entry = path.resolve(cliModulePath);
  return [
    ...(path.extname(entry).toLowerCase() === ".ts" ? ["--import", "tsx/esm"] : []),
    entry,
    "autostart",
    "restore",
    "--workspace-id",
    registration.workspaceId,
    "--workspace",
    registration.workspaceRoot,
  ];
}

function packageRootForCli(cliModulePath: string): string {
  return path.resolve(path.dirname(path.resolve(cliModulePath)), "..", "..");
}

export function buildAutostartPowerShellAction(
  cliModulePath: string,
  registration: AutostartRegistration,
  options: WindowsTaskOptions = {}
): ScheduledTaskAction {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const shellPath = options.powershellPath ?? (systemRoot
    ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe");
  return buildHiddenPowerShellAction({
    nodePath: options.nodePath ?? process.execPath,
    nodeArguments: restoreNodeArguments(cliModulePath, registration),
    workingDirectory: packageRootForCli(cliModulePath),
    environment: { ...(options.environment ?? {}), C2C_STATE_DIR: stateDir },
    powershellPath: shellPath,
  });
}

export class WindowsTaskScheduler implements AutostartTaskAdapter {
  private readonly stateDir: string;
  private readonly environment: Record<string, string>;
  private readonly shellPath: string;
  private readonly schedulerPath: string;
  private readonly nodePath: string;

  constructor(private readonly cliModulePath: string, options: WindowsTaskOptions = {}) {
    this.stateDir = path.resolve(options.stateDir ?? getStateDir());
    this.environment = { ...(options.environment ?? {}), C2C_STATE_DIR: this.stateDir };
    this.shellPath = powershellPath(options);
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    this.schedulerPath = options.schedulerPath ?? (systemRoot ? path.join(systemRoot, "System32", "schtasks.exe") : "schtasks.exe");
    this.nodePath = options.nodePath ?? process.execPath;
  }

  private action(registration: AutostartRegistration, overrides: WindowsTaskInstallOverrides = {}): ScheduledTaskAction {
    if (!overrides.cliArguments && !overrides.environment) {
      return buildAutostartPowerShellAction(this.cliModulePath, registration, {
        stateDir: this.stateDir,
        environment: this.environment,
        powershellPath: this.shellPath,
        schedulerPath: this.schedulerPath,
        nodePath: this.nodePath,
      });
    }
    return buildHiddenPowerShellAction({
      nodePath: this.nodePath,
      nodeArguments: overrides.cliArguments ?? restoreNodeArguments(this.cliModulePath, registration),
      workingDirectory: packageRootForCli(this.cliModulePath),
      environment: { ...this.environment, ...(overrides.environment ?? {}) },
      powershellPath: this.shellPath,
    });
  }

  install(registration: AutostartRegistration, overrides: WindowsTaskInstallOverrides = {}): AutostartInstallResult {
    const taskName = overrides.taskName ?? registration.taskName;
    const userSid = currentUserSid(this.shellPath);
    const xml = buildLogonTaskXml({
      taskName,
      userSid,
      action: this.action(registration, overrides),
    });
    const xmlPath = path.join(os.tmpdir(), `c2c-autostart-${randomUUID()}.xml`);
    fs.writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]), { flag: "wx" });
    try {
      const result = runCommand(this.schedulerPath, ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
      if (result.error || result.status !== 0) {
        throw new Error(`Could not install the Windows logon task${result.output ? `: ${result.output.slice(0, 2000)}` : ""}`);
      }
    } finally {
      try { fs.unlinkSync(xmlPath); } catch { /* ignore temporary task XML cleanup errors */ }
    }
    return { backend: "task_scheduler" };
  }

  remove(registration: AutostartRegistration): void {
    if (!this.isInstalled(registration)) return;
    const result = runCommand(this.schedulerPath, ["/Delete", "/TN", registration.taskName, "/F"]);
    if (result.error || result.status !== 0) {
      throw new Error(`Could not remove the Windows logon task${result.output ? `: ${result.output.slice(0, 2000)}` : ""}`);
    }
  }

  isInstalled(registration: AutostartRegistration): boolean {
    const result = runCommand(this.schedulerPath, ["/Query", "/TN", registration.taskName]);
    return !result.error && result.status === 0;
  }
}

interface ExistingRunValue {
  value: string;
  kind: "String" | "ExpandString";
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_KEY_PS = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

export class WindowsRunKeyAutostart {
  private readonly shellPath: string;
  private readonly registryPath: string;
  private readonly stateDir: string;
  private readonly nodePath: string;
  private readonly environment: Record<string, string>;

  constructor(private readonly cliModulePath: string, options: WindowsTaskOptions = {}) {
    this.shellPath = powershellPath(options);
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    this.registryPath = options.schedulerPath ?? (systemRoot ? path.join(systemRoot, "System32", "reg.exe") : "reg.exe");
    this.stateDir = path.resolve(options.stateDir ?? getStateDir());
    this.nodePath = options.nodePath ?? process.execPath;
    this.environment = options.environment ?? {};
  }

  private readValue(valueName: string): ExistingRunValue | null {
    const encodedName = Buffer.from(valueName, "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))`,
      `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${RUN_KEY_PS}', $false)`,
      "if ($null -eq $key) { exit 2 }",
      "try {",
      "  try { $kind = $key.GetValueKind($name).ToString() } catch [System.ArgumentException] { exit 2 } catch [System.IO.IOException] { exit 2 }",
      "  if ($kind -notin @('String', 'ExpandString')) { throw 'The existing Run value has an unsupported registry type.' }",
      "  $value = [string]$key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "  $json = ConvertTo-Json -Compress -InputObject @{ kind = $kind; value = $value }",
      "  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json)))",
      "} finally { $key.Close() }",
    ].join("; ");
    const result = runCommand(this.shellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]);
    if (result.status === 2) return null;
    if (result.error || result.status !== 0) {
      throw new Error(`Could not inspect the current-user Run entry${result.output ? `: ${result.output.slice(0, 1000)}` : ""}`);
    }
    try {
      const json = Buffer.from(result.output.trim(), "base64").toString("utf16le");
      const parsed = JSON.parse(json) as { kind: string; value: string };
      if ((parsed.kind !== "String" && parsed.kind !== "ExpandString") || typeof parsed.value !== "string") {
        throw new Error("invalid registry value");
      }
      return { kind: parsed.kind, value: parsed.value };
    } catch {
      throw new Error("Could not decode the existing current-user Run entry.");
    }
  }

  private writeValue(valueName: string, value: string, kind: "String" | "ExpandString" = "String"): void {
    const registryKind = kind === "ExpandString" ? "REG_EXPAND_SZ" : "REG_SZ";
    const result = runCommand(this.registryPath, ["add", RUN_KEY, "/v", valueName, "/t", registryKind, "/d", value, "/f"]);
    if (result.error || result.status !== 0) {
      throw new Error(`Could not write the current-user Run entry${result.output ? `: ${result.output.slice(0, 1000)}` : ""}`);
    }
  }

  private deleteValue(valueName: string): void {
    const result = runCommand(this.registryPath, ["delete", RUN_KEY, "/v", valueName, "/f"]);
    if (result.error || result.status !== 0) {
      throw new Error(`Could not remove the current-user Run entry${result.output ? `: ${result.output.slice(0, 1000)}` : ""}`);
    }
  }

  install(registration: AutostartRegistration, overrides: WindowsTaskInstallOverrides = {}): AutostartInstallResult {
    const valueName = overrides.taskName ?? registration.taskName;
    const previous = registration.backend === "registry_run" && registration.previousRunValueCaptured
      ? registration.previousRunValue === null || registration.previousRunValue === undefined
        ? null
        : {
            value: registration.previousRunValue,
            kind: registration.previousRunValueKind === "ExpandString" ? "ExpandString" as const : "String" as const,
          }
      : this.readValue(valueName);
    const environment = { ...this.environment, ...(overrides.environment ?? {}), C2C_STATE_DIR: this.stateDir };
    const action = overrides.cliArguments
      ? buildHiddenPowerShellAction({
          nodePath: this.nodePath,
          nodeArguments: overrides.cliArguments,
          workingDirectory: packageRootForCli(this.cliModulePath),
          environment,
          powershellPath: this.shellPath,
        })
      : buildAutostartPowerShellAction(this.cliModulePath, registration, {
          stateDir: this.stateDir,
          environment,
          powershellPath: this.shellPath,
          nodePath: this.nodePath,
        });
    const commandLine = `${quoteWindowsArgument(action.command)} ${action.arguments}`;
    this.writeValue(valueName, commandLine);
    return {
      backend: "registry_run",
      previousRunValueCaptured: true,
      previousRunValue: previous?.value ?? null,
      previousRunValueKind: previous?.kind ?? null,
    };
  }

  remove(registration: AutostartRegistration): void {
    if (!this.isInstalled(registration)) return;
    if (registration.previousRunValueCaptured && registration.previousRunValue !== null && registration.previousRunValue !== undefined) {
      this.writeValue(
        registration.taskName,
        registration.previousRunValue,
        registration.previousRunValueKind === "ExpandString" ? "ExpandString" : "String"
      );
    } else {
      this.deleteValue(registration.taskName);
    }
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.readValue(registration.taskName) !== null;
  }
}

export interface RunKeyAutostartAdapter {
  install(registration: AutostartRegistration): AutostartInstallResult;
  remove(registration: AutostartRegistration): void;
  isInstalled(registration: AutostartRegistration): boolean;
}

/** Prefer a current-user Scheduled Task; use HKCU Run only when Windows denies task creation. */
export class WindowsAutostartAdapter implements AutostartTaskAdapter {
  constructor(
    private readonly taskScheduler: AutostartTaskAdapter,
    private readonly runKey: RunKeyAutostartAdapter
  ) {}

  install(registration: AutostartRegistration): AutostartInstallResult {
    if (registration.backend === "registry_run") return this.runKey.install(registration);
    try {
      return this.taskScheduler.install(registration);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(access is denied|access denied|拒绝访问|访问被拒绝|0x80070005)/i.test(message)) throw error;
      const result = this.runKey.install(registration);
      try { this.taskScheduler.remove(registration); } catch { /* the denied task may not be removable either */ }
      return result;
    }
  }

  remove(registration: AutostartRegistration): void {
    if (registration.backend === "registry_run") {
      this.runKey.remove(registration);
      return;
    }
    if (registration.backend === "task_scheduler") {
      this.taskScheduler.remove(registration);
      return;
    }
    this.taskScheduler.remove(registration);
    this.runKey.remove(registration);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    if (registration.backend === "registry_run") return this.runKey.isInstalled(registration);
    if (registration.backend === "task_scheduler") return this.taskScheduler.isInstalled(registration);
    return this.taskScheduler.isInstalled(registration) || this.runKey.isInstalled(registration);
  }
}
