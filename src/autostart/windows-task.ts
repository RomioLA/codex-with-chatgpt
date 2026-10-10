import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getStateDir } from "../config/paths.js";
import { StdRegProvHostRunAuthority, type HostRunAuthority } from "./host-run-authority.js";
import { PowerShellLegacyRunView, type LegacyRunValue, type LegacyRunView } from "./legacy-run-view.js";
import type {
  AutostartInstallContext,
  AutostartInstallResult,
  AutostartRegistration,
  AutostartTaskAdapter,
} from "./registration.js";

export interface WindowsTaskOptions {
  stateDir?: string;
  environment?: Record<string, string>;
  powershellPath?: string;
  schedulerPath?: string;
  commandProcessorPath?: string;
  nodePath?: string;
  hostRunAuthority?: HostRunAuthority;
  legacyRunView?: LegacyRunView;
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

interface RawCommandResult {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
}

function runCommandRaw(command: string, args: string[], maxBuffer = 64 * 1024): RawCommandResult {
  const result = spawnSync(command, args, {
    windowsHide: true,
    maxBuffer,
  });
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0),
    ...(result.error ? { error: result.error } : {}),
  };
}

function decodeWindowsOutput(value: Buffer): string {
  if (!value.length) return "";
  try { return new TextDecoder("gbk").decode(value); }
  catch { return value.toString("utf8"); }
}

function runCommand(command: string, args: string[]): { status: number | null; output: string; error?: Error } {
  const result = runCommandRaw(command, args);
  return {
    status: result.status,
    output: `${decodeWindowsOutput(result.stdout)}${decodeWindowsOutput(result.stderr)}`.trim(),
    ...(result.error ? { error: result.error } : {}),
  };
}

class WindowsTaskInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsTaskInspectionError";
  }
}

class WindowsTaskRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsTaskRollbackError";
  }
}

type TaskEnabledState = "true" | "false" | "unspecified";

interface TaskDefinitionSnapshot {
  xml: Buffer;
  enabled: TaskEnabledState;
}

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function validateTaskXml(shellPath: string, file: string): TaskEnabledState {
  const encodedPath = Buffer.from(file, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$settings = New-Object System.Xml.XmlReaderSettings",
    "$settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit",
    "$settings.XmlResolver = $null",
    "$reader = [System.Xml.XmlReader]::Create($path, $settings)",
    "try {",
    "  $doc = New-Object System.Xml.XmlDocument",
    "  $doc.XmlResolver = $null",
    "  $doc.PreserveWhitespace = $true",
    "  $doc.Load($reader)",
    "} finally { $reader.Dispose() }",
    "$root = $doc.DocumentElement",
    "if ($null -eq $root -or $root.LocalName -ne 'Task' -or $root.NamespaceURI -ne 'http://schemas.microsoft.com/windows/2004/02/mit/task') { throw 'The XML is not a Task Scheduler task definition.' }",
    "$ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)",
    "$ns.AddNamespace('t', 'http://schemas.microsoft.com/windows/2004/02/mit/task')",
    "$enabled = $doc.SelectSingleNode('/t:Task/t:Settings/t:Enabled', $ns)",
    "if ($null -eq $enabled) { [Console]::Out.Write('unspecified') } else {",
    "  $value = $enabled.InnerText.Trim().ToLowerInvariant()",
    "  if ($value -notin @('true', 'false')) { throw 'The task Enabled value is invalid.' }",
    "  [Console]::Out.Write($value)",
    "}",
  ].join("\n");
  const result = runCommandRaw(shellPath, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncodedCommand(script),
  ]);
  // PowerShell can write informational CLIXML/progress to stderr on success.
  // Only stdout carries the parser result; exit status still governs failure.
  const enabled = decodeWindowsOutput(result.stdout).trim();
  if (result.error || result.status !== 0 || (enabled !== "true" && enabled !== "false" && enabled !== "unspecified")) {
    const output = `${enabled}${decodeWindowsOutput(result.stderr)}`.trim();
    throw new WindowsTaskInspectionError(`Could not validate the exported Windows task XML${output ? `: ${output.slice(0, 1000)}` : ""}`);
  }
  return enabled;
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
  diagnostics?: { stateDir: string; workspaceId: string; cliPath: string };
}): ScheduledTaskAction {
  if (input.diagnostics && !/^[a-f0-9]{12}$/i.test(input.diagnostics.workspaceId)) {
    throw new Error("Invalid autostart workspace ID for Task diagnostics.");
  }
  const payload = Buffer.from(JSON.stringify({
    nodePath: input.nodePath,
    arguments: quoteWindowsCommandLine(input.nodeArguments),
    workingDirectory: input.workingDirectory,
    environment: input.environment,
    diagnostics: input.diagnostics ?? null,
  }), "utf8").toString("base64");
  // The Task wrapper must not wait: Task Scheduler limits execution to three minutes.
  // Only fixed diagnostic fields are persisted, never the environment or raw exceptions.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$diagnostics = $payload.diagnostics",
    "$logFile = $null",
    "if ($null -ne $diagnostics -and $diagnostics.workspaceId -match '^[a-fA-F0-9]{12}$') { try { $diagDir = Join-Path $diagnostics.stateDir 'autostart\\diagnostics'; [void][IO.Directory]::CreateDirectory($diagDir); $logFile = Join-Path $diagDir ($diagnostics.workspaceId + '.launch.log') } catch { $logFile = $null } }",
    "function Write-C2CEvent { param([string]$Stage, [object]$NodePid = $null, [object]$Code = $null); if ($null -eq $logFile) { return }; try { $entry = [ordered]@{ stage = $Stage; workspaceId = [string]$diagnostics.workspaceId; checkedAt = [DateTime]::UtcNow.ToString('o'); wrapperPid = $PID; nodePid = $NodePid; exitCode = $Code; stateDir = [string]$diagnostics.stateDir; cwd = [string]$payload.workingDirectory; nodePath = [string]$payload.nodePath; cliPath = [string]$diagnostics.cliPath }; $json = ConvertTo-Json -InputObject $entry -Compress; [IO.File]::AppendAllText($logFile, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)) } catch { } }",
    "Write-C2CEvent 'wrapper_entered'",
    "try {",
    "  foreach ($property in $payload.environment.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, 'Process') }",
    "  Write-C2CEvent 'node_launch_attempted'",
    "  $node = Start-Process -FilePath $payload.nodePath -ArgumentList $payload.arguments -WorkingDirectory $payload.workingDirectory -WindowStyle Hidden -PassThru",
    "  Write-C2CEvent 'node_launched' $node.Id",
    "  Write-C2CEvent 'wrapper_exited' $node.Id 0",
    "  exit 0",
    "} catch {",
    "  Write-C2CEvent 'node_launch_failed'",
    "  Write-C2CEvent 'wrapper_exited' $null 1",
    "  exit 1",
    "}",
  ].join("\n");
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
  const helperPath = path.resolve(path.dirname(path.resolve(cliModulePath)), "..", "autostart", "launch-breadcrumb.js");
  const nodeArguments = restoreNodeArguments(cliModulePath, registration);
  if (path.extname(path.resolve(cliModulePath)).toLowerCase() !== ".ts" && fs.existsSync(helperPath)) {
    nodeArguments.unshift("--import", pathToFileURL(helperPath).href);
  }
  return buildHiddenPowerShellAction({
    nodePath: options.nodePath ?? process.execPath,
    nodeArguments,
    workingDirectory: packageRootForCli(cliModulePath),
    environment: { ...(options.environment ?? {}), C2C_STATE_DIR: stateDir },
    powershellPath: shellPath,
    diagnostics: { stateDir, workspaceId: registration.workspaceId, cliPath: path.resolve(cliModulePath) },
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

  private temporaryXmlPath(xml: Buffer): string {
    const file = path.join(os.tmpdir(), `c2c-autostart-${randomUUID()}.xml`);
    try {
      fs.writeFileSync(file, xml, { flag: "wx" });
      return file;
    } catch (error) {
      try { fs.unlinkSync(file); } catch { /* the temporary file may not have been created */ }
      throw error;
    }
  }

  private queryTaskExists(taskName: string): boolean {
    const result = runCommandRaw(this.schedulerPath, ["/Query", "/TN", taskName]);
    const output = `${decodeWindowsOutput(result.stdout)}${decodeWindowsOutput(result.stderr)}`.trim();
    if (result.error || result.status === null) {
      throw new WindowsTaskInspectionError(`Could not inspect the Windows logon task${output ? `: ${output.slice(0, 2000)}` : `: ${result.error?.message ?? "command failed"}`}`);
    }
    if (result.status === 0) return true;
    if (isMissingScheduledTask(output)) return false;
    throw new WindowsTaskInspectionError(`Could not inspect the Windows logon task${output ? `: ${output.slice(0, 2000)}` : ` (exit code ${result.status})`}`);
  }

  private queryTaskDefinition(taskName: string): TaskDefinitionSnapshot | null {
    const result = runCommandRaw(this.schedulerPath, ["/Query", "/TN", taskName, "/XML"], 4 * 1024 * 1024);
    const output = `${decodeWindowsOutput(result.stdout)}${decodeWindowsOutput(result.stderr)}`.trim();
    if (result.error || result.status === null) {
      throw new WindowsTaskInspectionError(`Could not export the existing Windows logon task${output ? `: ${output.slice(0, 2000)}` : `: ${result.error?.message ?? "command failed"}`}`);
    }
    if (result.status !== 0) {
      if (isMissingScheduledTask(output)) return null;
      throw new WindowsTaskInspectionError(`Could not export the existing Windows logon task${output ? `: ${output.slice(0, 2000)}` : ` (exit code ${result.status})`}`);
    }
    if (!result.stdout.length) {
      throw new WindowsTaskInspectionError("Task Scheduler returned an empty XML definition for the existing task.");
    }

    const xml = Buffer.from(result.stdout);
    let tempPath: string;
    try { tempPath = this.temporaryXmlPath(xml); }
    catch (error) {
      throw new WindowsTaskInspectionError(`Could not save the existing Windows task XML${error instanceof Error ? `: ${error.message}` : `: ${String(error)}`}`);
    }
    try {
      return { xml, enabled: validateTaskXml(this.shellPath, tempPath) };
    } catch (error) {
      if (error instanceof WindowsTaskInspectionError) throw error;
      throw new WindowsTaskInspectionError(`Could not validate the existing Windows task XML${error instanceof Error ? `: ${error.message}` : `: ${String(error)}`}`);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* retain the inspection result */ }
    }
  }

  private createFromXml(taskName: string, xmlPath: string, description: string): void {
    const result = runCommand(this.schedulerPath, ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    if (result.error || result.status !== 0) {
      throw new Error(`${description}${result.output ? `: ${result.output.slice(0, 2000)}` : result.error ? `: ${result.error.message}` : ` (exit code ${result.status})`}`);
    }
  }

  private restoreTask(taskName: string, previous: TaskDefinitionSnapshot | null): void {
    if (!previous) {
      if (!this.queryTaskExists(taskName)) return;
      const result = runCommand(this.schedulerPath, ["/Delete", "/TN", taskName, "/F"]);
      if (result.error || result.status !== 0) {
        // A failed delete is acceptable only if a follow-up query proves that
        // the partial task is already gone.
        if (this.queryTaskExists(taskName)) {
          throw new Error(`Could not remove the partially-created Windows logon task${result.output ? `: ${result.output.slice(0, 2000)}` : ""}`);
        }
        return;
      }
      if (this.queryTaskExists(taskName)) {
        throw new Error("The partially-created Windows logon task remained after rollback.");
      }
      return;
    }

    const xmlPath = this.temporaryXmlPath(previous.xml);
    try {
      const enabled = validateTaskXml(this.shellPath, xmlPath);
      if (enabled !== previous.enabled) throw new Error("The saved Windows task XML changed before rollback.");
      this.createFromXml(taskName, xmlPath, "Could not restore the previous Windows logon task");
    } finally {
      try { fs.unlinkSync(xmlPath); } catch { /* rollback result is reported independently */ }
    }

    const restored = this.queryTaskDefinition(taskName);
    if (!restored) throw new Error("The previous Windows logon task was missing after rollback.");
    const effectiveEnabled = (state: TaskEnabledState): boolean => state !== "false";
    if (effectiveEnabled(restored.enabled) !== effectiveEnabled(previous.enabled)) {
      throw new Error("The previous Windows logon task Enabled state was not restored.");
    }
  }

  install(
    registration: AutostartRegistration,
    contextOrOverrides?: AutostartInstallContext | WindowsTaskInstallOverrides
  ): AutostartInstallResult {
    const overrides = contextOrOverrides && "persistTransition" in contextOrOverrides
      ? {}
      : contextOrOverrides as WindowsTaskInstallOverrides | undefined ?? {};
    const taskName = overrides.taskName ?? registration.taskName;
    // Export and validate the existing definition before /Create /F can replace it.
    // stdout is retained as raw bytes so Unicode XML and its original encoding survive.
    const previous = this.queryTaskDefinition(taskName);
    const userSid = currentUserSid(this.shellPath);
    const xml = buildLogonTaskXml({
      taskName,
      userSid,
      action: this.action(registration, overrides),
    });
    const xmlPath = this.temporaryXmlPath(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
    let rolledBack = false;
    const rollback = (): void => {
      if (rolledBack) return;
      try {
        this.restoreTask(taskName, previous);
        rolledBack = true;
      } catch (error) {
        throw new WindowsTaskRollbackError(`Could not roll back the Windows logon task: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      try {
        this.createFromXml(taskName, xmlPath, "Could not install the Windows logon task");
      } catch (error) {
        try { rollback(); }
        catch (rollbackError) {
          throw new WindowsTaskRollbackError(`${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        throw error;
      }
    } finally {
      try { fs.unlinkSync(xmlPath); } catch { /* ignore temporary task XML cleanup errors */ }
    }
    return { backend: "task_scheduler", rollback };
  }

  remove(registration: AutostartRegistration): void {
    if (!this.queryTaskExists(registration.taskName)) return;
    const result = runCommand(this.schedulerPath, ["/Delete", "/TN", registration.taskName, "/F"]);
    if (result.error || result.status !== 0) {
      throw new Error(`Could not remove the Windows logon task${result.output ? `: ${result.output.slice(0, 2000)}` : ""}`);
    }
  }

  isInstalled(registration: AutostartRegistration): boolean {
    return this.queryTaskExists(registration.taskName);
  }
}

interface ExistingRunValue {
  value: string;
  kind: string;
}

function sameRunValue(left: ExistingRunValue | null, right: ExistingRunValue | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.kind === right.kind && left.value === right.value;
}

function requireHostString(value: ExistingRunValue | null): void {
  if (value && value.kind !== "String") {
    throw new Error(`The host Run value uses unsupported registry type '${value.kind}'; it was preserved.`);
  }
}

function requireLegacyKind(value: LegacyRunValue | null): void {
  if (value && value.kind !== "String" && value.kind !== "ExpandString") {
    throw new Error(`The caller Run value uses unsupported registry type '${value.kind}'; it was preserved.`);
  }
}

// Windows documents a 260-character Run/RunOnce limit. Leave explicit headroom.
export const MAX_RUN_COMMAND_CHARACTERS = 240;

function writeAtomicLauncher(file: string, contents: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // Same-directory rename publishes a complete file, including on replacement.
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function isMissingScheduledTask(output: string): boolean {
  return /(?:the system cannot find the (?:file|path) specified|the specified task name .* does not exist(?: in the system)?|the task name .* does not exist|task not found|找不到指定的文件|系统找不到指定的文件|找不到指定的任务)/i.test(output);
}

function removeLauncher(file: string): void {
  try { fs.unlinkSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Batch-file literals need percent escaping in addition to argv quoting. */
function quoteBatchArgument(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error("The Run launcher argument contains unsupported command-shell characters.");
  return quoteWindowsArgument(value.replace(/%/g, "%%"));
}

export class WindowsRunKeyAutostart {
  private readonly shellPath: string;
  private readonly stateDir: string;
  private readonly nodePath: string;
  private readonly environment: Record<string, string>;
  private readonly commandProcessorPath: string;
  private readonly hostRunAuthority: HostRunAuthority;
  private readonly legacyRunView: LegacyRunView;

  constructor(private readonly cliModulePath: string, options: WindowsTaskOptions = {}) {
    this.shellPath = powershellPath(options);
    this.stateDir = path.resolve(options.stateDir ?? getStateDir());
    this.nodePath = options.nodePath ?? process.execPath;
    this.environment = options.environment ?? {};
    this.commandProcessorPath = options.commandProcessorPath ?? path.join(windowsSystemRoot(), "System32", "cmd.exe");
    this.hostRunAuthority = options.hostRunAuthority ?? new StdRegProvHostRunAuthority(this.shellPath);
    this.legacyRunView = options.legacyRunView ?? new PowerShellLegacyRunView(this.shellPath);
  }

  private launcherPath(registration: AutostartRegistration): string {
    if (!/^[a-f0-9]{12}$/i.test(registration.workspaceId)) {
      throw new Error("Invalid autostart workspace ID for the Run launcher.");
    }
    return path.join(this.stateDir, "autostart", "launchers", `${registration.workspaceId}.cmd`);
  }

  private launcher(registration: AutostartRegistration, overrides: WindowsTaskInstallOverrides = {}): {
    file: string; contents: Buffer; commandLine: string;
  } {
    const file = this.launcherPath(registration);
    // cmd.exe expands percent variables even in quotes. Refuse ambiguous paths
    // before changing either authority; delayed expansion is explicitly disabled.
    for (const value of [file, this.commandProcessorPath]) {
      if (/[\r\n"%]/.test(value)) throw new Error("The Run launcher path contains unsupported command-shell characters.");
    }
    const commandLine = `${quoteWindowsArgument(this.commandProcessorPath)} /d /v:off /s /c "${quoteWindowsArgument(file)}"`;
    if (commandLine.length > MAX_RUN_COMMAND_CHARACTERS) {
      throw new Error(`The Run launcher command is too long (${commandLine.length} characters; maximum ${MAX_RUN_COMMAND_CHARACTERS}). Use a shorter C2C state path or Task Scheduler.`);
    }
    // Windows environment names are case-insensitive. Strip every spelling of
    // the state override before appending the one canonical value last.
    const environment = Object.fromEntries([
      ...Object.entries({ ...this.environment, ...(overrides.environment ?? {}) })
        .filter(([name]) => name.toUpperCase() !== "C2C_STATE_DIR"),
      ["C2C_STATE_DIR", this.stateDir],
    ]);
    const diagnosticsDirectory = path.join(this.stateDir, "autostart", "diagnostics");
    const diagnosticLog = path.join(diagnosticsDirectory, `${registration.workspaceId}.launch.log`);
    const helperPath = path.resolve(path.dirname(path.resolve(this.cliModulePath)), "..", "autostart", "launch-breadcrumb.js");
    const cliArguments = overrides.cliArguments ?? restoreNodeArguments(this.cliModulePath, registration);

    const lines = ["@echo off", "setlocal DisableDelayedExpansion", "chcp 65001 >nul"];
    lines.push(`if not exist ${quoteBatchArgument(diagnosticsDirectory)} mkdir ${quoteBatchArgument(diagnosticsDirectory)} >nul 2>&1`);
    lines.push(`2>nul > ${quoteBatchArgument(diagnosticLog)} echo cmd_entered`);
    for (const [name, value] of Object.entries(environment)) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(name) || /[\r\n"]/.test(value)) {
        throw new Error("The Run launcher environment contains unsupported command-shell characters.");
      }
      lines.push(`set "${name}=${value.replace(/%/g, "%%")}"`);
    }
    lines.push(`cd /d ${quoteBatchArgument(packageRootForCli(this.cliModulePath))}`);
    lines.push("if errorlevel 1 goto c2c_cwd_failed");
    lines.push(`2>nul >> ${quoteBatchArgument(diagnosticLog)} echo node_invoking`);
    lines.push(`if exist ${quoteBatchArgument(helperPath)} goto c2c_with_preload`);
    lines.push([this.nodePath, ...cliArguments].map(quoteBatchArgument).join(" "));
    lines.push('set "C2C_NODE_EXIT=%errorlevel%"');
    lines.push("goto c2c_node_returned");
    lines.push(":c2c_with_preload");
    lines.push([this.nodePath, "--import", pathToFileURL(helperPath).href, ...cliArguments].map(quoteBatchArgument).join(" "));
    lines.push('set "C2C_NODE_EXIT=%errorlevel%"');
    lines.push(":c2c_node_returned");
    lines.push(`2>nul >> ${quoteBatchArgument(diagnosticLog)} echo node_returned=%C2C_NODE_EXIT%`);
    lines.push("exit /b %C2C_NODE_EXIT%");
    lines.push(":c2c_cwd_failed");
    lines.push(`2>nul >> ${quoteBatchArgument(diagnosticLog)} echo cwd_failed`);
    lines.push("exit /b 1");
    if (lines.some((line) => line.length > 8000)) {
      throw new Error("The Run launcher invocation exceeds safe batch-file limits.");
    }
    return {
      file,
      commandLine,
      // UTF-8 after an ASCII code-page preamble preserves Unicode paths. No
      // encoded scripts, PowerShell execution-policy changes, or inherited secrets.
      contents: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8"),
    };
  }

  private matchesLauncher(registration: AutostartRegistration, expected: ReturnType<WindowsRunKeyAutostart["launcher"]>, valueName = registration.taskName): boolean {
    const value = this.readValue(valueName);
    return value?.kind === "String"
      && value.value.length <= MAX_RUN_COMMAND_CHARACTERS
      && value.value === expected.commandLine
      && fs.lstatSync(expected.file).isFile()
      && fs.readFileSync(expected.file).equals(expected.contents);
  }

  private readValue(valueName: string): ExistingRunValue | null {
    return this.hostRunAuthority.read(valueName);
  }

  private writeValue(valueName: string, value: string): void {
    this.hostRunAuthority.write(valueName, value, "String");
  }

  private deleteValue(valueName: string): void {
    this.hostRunAuthority.delete(valueName);
  }

  install(
    registration: AutostartRegistration,
    overrides: WindowsTaskInstallOverrides = {},
    beforeMutation?: (metadata: AutostartInstallResult) => void
  ): AutostartInstallResult {
    const valueName = overrides.taskName ?? registration.taskName;
    const expected = this.launcher(registration, overrides);
    const existing = this.readValue(valueName);
    requireHostString(existing);
    const callerExisting = this.legacyRunView.read(valueName);
    requireLegacyKind(callerExisting);

    const hasTrustedHostBackup = registration.runAuthority === "host_user"
      && registration.previousRunValueCaptured === true;
    const hasUnmarkedLegacyRunRegistration = registration.runAuthority !== "host_user"
      && registration.backend === "registry_run"
      && registration.previousRunValueCaptured === true;
    let previous: ExistingRunValue | null;
    if (hasTrustedHostBackup) {
      if (registration.previousRunValue === null || registration.previousRunValue === undefined) {
        previous = null;
      } else if (registration.previousRunValueKind === "String") {
        previous = { value: registration.previousRunValue, kind: "String" };
      } else {
        throw new Error("The trusted host Run backup has an unsupported registry type; it was preserved.");
      }
    } else if (hasUnmarkedLegacyRunRegistration) {
      // Older package releases stored their own Run command in this field.
      // It is not a host backup and must not be restored on a later disable.
      previous = null;
    } else {
      previous = existing?.kind === "String" && existing.value === expected.commandLine ? null : existing;
    }

    let legacy: LegacyRunValue | null;
    if (registration.legacyRunValueCaptured === true) {
      if (registration.legacyRunValue === null) {
        if (registration.legacyRunValueKind !== null && registration.legacyRunValueKind !== undefined) {
          throw new Error("The saved legacy Run snapshot is inconsistent; it was preserved.");
        }
        legacy = null;
      } else if (typeof registration.legacyRunValue === "string"
        && (registration.legacyRunValueKind === "String" || registration.legacyRunValueKind === "ExpandString")) {
        legacy = { value: registration.legacyRunValue, kind: registration.legacyRunValueKind };
      } else {
        throw new Error("The saved legacy Run snapshot is invalid; it was preserved.");
      }
    } else if (callerExisting && !sameRunValue(existing, callerExisting)) {
      legacy = callerExisting;
    } else {
      legacy = null;
    }
    const oldLauncher = fs.existsSync(expected.file) ? fs.readFileSync(expected.file) : null;
    const metadata: AutostartInstallResult = {
      backend: "registry_run",
      runAuthority: "host_user",
      legacyRunValueCaptured: true,
      legacyRunValue: legacy?.value ?? null,
      legacyRunValueKind: legacy?.kind === "String" || legacy?.kind === "ExpandString" ? legacy.kind : null,
      previousRunValueCaptured: true,
      previousRunValue: previous?.value ?? null,
      previousRunValueKind: previous ? "String" : null,
    };
    const expectedHostValue: ExistingRunValue = { kind: "String", value: expected.commandLine };
    let legacyWasPrivatelyDeleted = false;
    let legacySnapshotRestored = false;
    let commitCompleted = false;
    let rollbackCompleted = false;

    const restoreHostValue = (target: ExistingRunValue | null): void => {
      const current = this.readValue(valueName);
      if (sameRunValue(current, target)) return;
      if (target) this.writeValue(valueName, target.value);
      else if (current) this.deleteValue(valueName);
      const verified = this.readValue(valueName);
      if (!sameRunValue(verified, target)) {
        throw new Error("Host Run value rollback verification failed.");
      }
    };

    const rollback = (): void => {
      if (rollbackCompleted) return;
      const failures: string[] = [];

      if (legacyWasPrivatelyDeleted && legacy && !legacySnapshotRestored) {
        try {
          const currentHost = this.readValue(valueName);
          if (!sameRunValue(currentHost, expectedHostValue)) {
            throw new Error("host Run value changed after legacy cleanup");
          }
          const currentCaller = this.legacyRunView.read(valueName);
          if (currentCaller === null || sameRunValue(currentCaller, expectedHostValue)) {
            this.legacyRunView.write(valueName, legacy.value, legacy.kind as "String" | "ExpandString");
          } else if (!sameRunValue(currentCaller, legacy)) {
            throw new Error("caller Run value changed after legacy cleanup");
          }
          const restoredCaller = this.legacyRunView.read(valueName);
          if (!sameRunValue(restoredCaller, legacy)) {
            throw new Error("caller Run value rollback verification failed");
          }
          if (!sameRunValue(this.readValue(valueName), expectedHostValue)) {
            restoreHostValue(expectedHostValue);
            throw new Error("host Run value changed while restoring legacy cleanup");
          }
          legacySnapshotRestored = true;
        } catch (error) {
          failures.push(`legacy Run rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      try {
        const currentHost = this.readValue(valueName);
        // This exact-name transaction owns the host write; restore the
        // pre-call value even if its verification readback was incorrect.
        if (!sameRunValue(currentHost, existing)) {
          restoreHostValue(existing);
        }
      } catch (error) {
        failures.push(`host Run rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (oldLauncher) writeAtomicLauncher(expected.file, oldLauncher);
        else removeLauncher(expected.file);
      } catch (error) { failures.push(`launcher rollback failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (failures.length) throw new Error(failures.join("; "));
      rollbackCompleted = true;
    };

    const commit = (): void => {
      if (commitCompleted) return;
      if (!this.matchesLauncher(registration, expected, valueName)) {
        throw new Error("The host Run entry or launcher changed before migration cleanup.");
      }
      const callerValue = this.legacyRunView.read(valueName);
      if (legacy === null) {
        if (callerValue !== null && !sameRunValue(callerValue, expectedHostValue)) {
          throw new Error("The caller Run value changed before migration cleanup; it was preserved.");
        }
        commitCompleted = true;
        return;
      }
      if (callerValue === null) {
        commitCompleted = true;
        return;
      }
      if (!sameRunValue(callerValue, legacy)) {
        throw new Error("The caller Run value changed before migration cleanup; it was preserved.");
      }

      let deleteError: unknown;
      try { this.legacyRunView.delete(valueName, expectedHostValue); }
      catch (error) { deleteError = error; }

      let hostAfterDelete: ExistingRunValue | null = null;
      let hostReadError: unknown;
      try { hostAfterDelete = this.readValue(valueName); }
      catch (error) { hostReadError = error; }
      if (hostReadError || !sameRunValue(hostAfterDelete, expectedHostValue)) {
        let restoreError: unknown;
        try { restoreHostValue(expectedHostValue); }
        catch (error) { restoreError = error; }
        throw new Error(`Legacy Run cleanup failed because the caller entry aliases or changed the host entry${deleteError ? `; delete failed: ${String(deleteError)}` : ""}${hostReadError ? `; host verification failed: ${String(hostReadError)}` : ""}${restoreError ? `; host restore failed: ${String(restoreError)}` : "; host entry restored"}.`);
      }

      const callerAfterDelete = this.legacyRunView.read(valueName);
      if (callerAfterDelete === null || sameRunValue(callerAfterDelete, expectedHostValue)) {
        legacyWasPrivatelyDeleted = true;
      }
      if (deleteError) {
        throw new Error(`Legacy Run cleanup failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
      }
      if (callerAfterDelete !== null && !sameRunValue(callerAfterDelete, expectedHostValue)) {
        throw new Error("Legacy Run cleanup failed verification; the caller value remains.");
      }
      commitCompleted = true;
    };

    // Journal the transition after all reads and metadata capture, but before
    // publishing either the launcher file or its host Run value.
    beforeMutation?.(metadata);
    try {
      writeAtomicLauncher(expected.file, expected.contents);
      this.writeValue(valueName, expected.commandLine);
      if (!this.matchesLauncher(registration, expected, valueName)) {
        throw new Error("The Run entry or launcher failed installation verification.");
      }
    } catch (error) {
      try { rollback(); }
      catch (rollbackError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw error;
    }
    return {
      ...metadata,
      rollback,
      commit,
    };
  }

  hasEntry(registration: AutostartRegistration): boolean {
    return this.readValue(registration.taskName) !== null;
  }

  remove(registration: AutostartRegistration): void {
    const failures: string[] = [];
    let hostCleanupVerified = false;
    let hostAfterCleanup: ExistingRunValue | null = null;
    const trustedHostBackup = registration.runAuthority === "host_user"
      && registration.previousRunValueCaptured === true
      && registration.previousRunValue !== null
      && registration.previousRunValue !== undefined
      ? { kind: registration.previousRunValueKind ?? "String", value: registration.previousRunValue }
      : null;

    try {
      const existing = this.readValue(registration.taskName);
      requireHostString(existing);
      if (trustedHostBackup) {
        if (trustedHostBackup.kind !== "String") {
          throw new Error("The trusted host Run backup has an unsupported registry type; it was preserved.");
        }
        if (!sameRunValue(existing, trustedHostBackup)) {
          this.writeValue(registration.taskName, trustedHostBackup.value);
        }
        hostAfterCleanup = this.readValue(registration.taskName);
        if (!sameRunValue(hostAfterCleanup, trustedHostBackup)) {
          throw new Error("Host Run backup restoration failed verification.");
        }
      } else {
        if (existing) this.deleteValue(registration.taskName);
        hostAfterCleanup = this.readValue(registration.taskName);
        if (hostAfterCleanup !== null) {
          throw new Error("Host Run entry removal failed verification.");
        }
      }
      hostCleanupVerified = true;
    } catch (error) {
      failures.push(`Host Run entry cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (hostCleanupVerified) {
      try {
        const callerValue = this.legacyRunView.read(registration.taskName);
        requireLegacyKind(callerValue);
        // Matching values may be the host and caller views of the same native
        // Run entry. Keep the restored host backup in that case.
        if (callerValue && !sameRunValue(callerValue, hostAfterCleanup)) {
          let deleteError: unknown;
          try { this.legacyRunView.delete(registration.taskName, hostAfterCleanup); }
          catch (error) { deleteError = error; }

          let hostAfterDelete: ExistingRunValue | null = null;
          let hostReadError: unknown;
          try { hostAfterDelete = this.readValue(registration.taskName); }
          catch (error) { hostReadError = error; }
          if (hostReadError || !sameRunValue(hostAfterDelete, hostAfterCleanup)) {
            let restoreError: unknown;
            try {
              if (hostAfterCleanup) this.writeValue(registration.taskName, hostAfterCleanup.value);
              else if (hostAfterDelete) this.deleteValue(registration.taskName);
              const restored = this.readValue(registration.taskName);
              if (!sameRunValue(restored, hostAfterCleanup)) {
                throw new Error("host Run restoration failed verification");
              }
            } catch (error) { restoreError = error; }
            throw new Error(`Caller Run cleanup changed the host entry${hostReadError ? `; host verification failed: ${String(hostReadError)}` : ""}${restoreError ? `; host restore failed: ${String(restoreError)}` : "; host entry restored"}.`);
          }

          const callerAfterDelete = this.legacyRunView.read(registration.taskName);
          if (deleteError) {
            throw new Error(`Caller Run deletion failed: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
          }
          if (callerAfterDelete !== null && !sameRunValue(callerAfterDelete, hostAfterCleanup)) {
            throw new Error("Caller Run deletion failed verification.");
          }
        }
      } catch (error) {
        failures.push(`Caller legacy Run cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Removal must also work for missing/corrupt launchers and legacy long values.
    try {
      removeLauncher(this.launcherPath(registration));
    } catch (error) {
      failures.push(`launcher cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (failures.length) throw new Error(failures.join("; "));
  }

  isInstalled(registration: AutostartRegistration): boolean {
    try { return this.matchesLauncher(registration, this.launcher(registration)); }
    catch { return false; }
  }
}

export interface RunKeyAutostartAdapter {
  install(
    registration: AutostartRegistration,
    overrides?: WindowsTaskInstallOverrides,
    beforeMutation?: (metadata: AutostartInstallResult) => void
  ): AutostartInstallResult;
  remove(registration: AutostartRegistration): void;
  isInstalled(registration: AutostartRegistration): boolean;
  hasEntry?(registration: AutostartRegistration): boolean;
}

function isTaskSchedulerFallbackError(error: unknown): boolean {
  if (error instanceof WindowsTaskInspectionError || error instanceof WindowsTaskRollbackError) return false;
  const message = error instanceof Error ? error.message : String(error);
  const denied = /(access is denied|access denied|拒绝访问|访问被拒绝|0x80070005)/i.test(message);
  const unavailable = /(?:task scheduler|scheduled task|windows logon task).{0,100}(?:unavailable|not available|service (?:is )?not running|service has not been started|could not connect|cannot connect)|(?:unavailable|not available|service (?:is )?not running|service has not been started).{0,100}(?:task scheduler|scheduled task|windows logon task)|0x80041315|0x80070426|ERROR_SERVICE_NOT_ACTIVE/i.test(message);
  return denied || unavailable;
}

/** Prefer a current-user Scheduled Task; use the host Run authority when the scheduler denies or cannot accept registration. */
export class WindowsAutostartAdapter implements AutostartTaskAdapter {
  constructor(
    private readonly taskScheduler: AutostartTaskAdapter,
    private readonly runKey: RunKeyAutostartAdapter
  ) {}

  getAuthorityState(registration: AutostartRegistration): { taskPresent: boolean; runPresent: boolean } {
    return {
      taskPresent: this.taskScheduler.isInstalled(registration),
      runPresent: this.runKey.hasEntry?.(registration) ?? this.runKey.isInstalled(registration),
    };
  }

  private installRunTransition(registration: AutostartRegistration, context?: AutostartInstallContext): AutostartInstallResult {
    if (!context) {
      throw new Error("A durable transition context is required before installing the Run autostart backend.");
    }
    let transitionPersisted = false;
    const result = this.runKey.install(registration, {}, (metadata) => {
      context.persistTransition({
        ...registration,
        pendingBackend: "registry_run",
        runAuthority: metadata.runAuthority ?? "host_user",
        legacyRunValueCaptured: metadata.legacyRunValueCaptured ?? true,
        legacyRunValue: metadata.legacyRunValue ?? null,
        legacyRunValueKind: metadata.legacyRunValueKind ?? null,
        previousRunValueCaptured: metadata.previousRunValueCaptured ?? true,
        previousRunValue: metadata.previousRunValue ?? null,
        previousRunValueKind: metadata.previousRunValueKind ?? null,
      });
      transitionPersisted = true;
    });
    if (!transitionPersisted) {
      try {
        if (result.rollback) result.rollback();
        else this.runKey.remove({ ...registration, ...result });
      } catch (rollbackError) {
        throw new Error(`Run adapter did not persist the transition before mutation; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      throw new Error("Run adapter did not persist the transition before mutation.");
    }
    let commitCompleted = false;
    let rollbackCompleted = false;
    const rollback = (): void => {
      if (rollbackCompleted) return;
      result.rollback?.();
      rollbackCompleted = true;
    };
    return {
      ...result,
      backend: "registry_run",
      pendingBackend: "registry_run",
      rollback,
      commit: () => {
        if (commitCompleted) return;
        try {
          result.commit?.();
          // The durable pending journal already exists. Remove the former Task
          // only after Run is installed; a cleanup failure rolls Run back.
          this.taskScheduler.remove(registration);
          if (this.taskScheduler.isInstalled(registration)) {
            throw new Error("The previous Windows logon task remained after transition cleanup.");
          }
          commitCompleted = true;
        } catch (error) {
          try { rollback(); }
          catch (rollbackError) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}; Run transition rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
          }
          throw error;
        }
      },
    };
  }

  install(registration: AutostartRegistration, context?: AutostartInstallContext): AutostartInstallResult {
    const authority = this.getAuthorityState(registration);
    if (registration.pendingBackend === "registry_run"
      || registration.backend === "registry_run"
      || authority.runPresent) {
      return this.installRunTransition(registration, context);
    }
    try {
      return this.taskScheduler.install(registration, context);
    } catch (error) {
      if (!isTaskSchedulerFallbackError(error)) throw error;
      return this.installRunTransition(registration, context);
    }
  }

  remove(registration: AutostartRegistration): void {
    const failures: string[] = [];
    try { this.taskScheduler.remove(registration); }
    catch (error) { failures.push(`Scheduled Task cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { this.runKey.remove(registration); }
    catch (error) { failures.push(`Host Run cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (failures.length) throw new Error(`Could not remove all autostart authorities: ${failures.join("; ")}`);
  }

  isInstalled(registration: AutostartRegistration): boolean {
    if (registration.pendingBackend === "registry_run") return false;
    const authority = this.getAuthorityState(registration);
    if (registration.backend === "task_scheduler") return authority.taskPresent && !authority.runPresent;
    if (registration.backend === "registry_run") {
      return authority.runPresent && !authority.taskPresent && this.runKey.isInstalled(registration);
    }
    if (authority.taskPresent === authority.runPresent) return false;
    return authority.taskPresent || this.runKey.isInstalled(registration);
  }
}
