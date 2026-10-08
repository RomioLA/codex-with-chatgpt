import { spawnSync } from "node:child_process";

export interface HostRunValue {
  kind: string;
  value: string;
}

export interface HostRunAuthority {
  read(name: string): HostRunValue | null;
  write(name: string, value: string, kind?: "String" | "ExpandString"): void;
  delete(name: string): void;
}

const NAME_PATTERN = /^C2C-Workspace-Autostart-[0-9a-fA-F]{12}$/;
const USER_SID_PATTERN = /^S-1-(?:5-21|12-1)-(?:\d+-){3}\d+$/;
const REGISTRY_HIVE_USERS = 2147483651;
const RUN_SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const SCRIPT_ERROR = "Host Run authority operation failed.";
const UNSUPPORTED_TYPE_ERROR = "Unsupported host Run value type.";

type HostOperation = "host_read" | "host_write" | "host_delete";

interface HostRequest {
  operation: HostOperation;
  name: string;
  value?: string;
  kind?: "String" | "ExpandString";
}

interface HostResponse {
  sid: string;
  value: HostRunValue | null;
}

function validateName(name: string): void {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new Error("Invalid host Run value name.");
  }
}

function buildPowerShellScript(requestBase64: string): string {
  return String.raw`$ErrorActionPreference = 'Stop'
$request = $null
$provider = $null
$invokeOptions = $null
$sid = $null
$runPath = $null
$hDefKey = [uint32]${REGISTRY_HIVE_USERS}

function Connect-StdRegProv {
    Add-Type -AssemblyName System.Management
    $scope = [System.Management.ManagementScope]::new('\\.\root\default')
    $scope.Options.Impersonation = [System.Management.ImpersonationLevel]::Impersonate
    $scope.Options.Context.Add('__ProviderArchitecture', 64)
    $scope.Options.Context.Add('__RequiredArchitecture', $true)
    $scope.Connect()

    $nextProvider = [System.Management.ManagementClass]::new(
        $scope,
        [System.Management.ManagementPath]::new('StdRegProv'),
        $null
    )
    $nextOptions = [System.Management.InvokeMethodOptions]::new()
    $nextOptions.Context.Add('__ProviderArchitecture', 64)
    $nextOptions.Context.Add('__RequiredArchitecture', $true)
    return [pscustomobject]@{ Provider = $nextProvider; Options = $nextOptions }
}

function Set-StdRegProv {
    $connection = Connect-StdRegProv
    $script:provider = $connection.Provider
    $script:invokeOptions = $connection.Options
}

function Assert-ExplorerOwner {
    param(
        [Parameter(Mandatory)][int]$SessionId,
        [Parameter(Mandatory)][string]$ExpectedSid
    )

    Add-Type -AssemblyName System.Management
    $query = "SELECT Handle, SessionId FROM Win32_Process WHERE Name='explorer.exe' AND SessionId=$SessionId"
    $searcher = [System.Management.ManagementObjectSearcher]::new('\\.\root\cimv2', $query)
    $explorers = $null
    $ownerSidSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $explorerCount = 0
    try {
        $explorers = $searcher.Get()
        foreach ($explorer in $explorers) {
            $explorerCount += 1
            $owner = $null
            try {
                $owner = $explorer.InvokeMethod('GetOwnerSid', $null, $null)
                if ($null -eq $owner -or $null -eq $owner['ReturnValue'] -or [int64]$owner['ReturnValue'] -ne 0) { throw 'explorer-owner' }
                $explorerOwnerSid = [string]$owner['Sid']
                if ($explorerOwnerSid -notmatch '^S-1-(?:5-21|12-1)-(?:[0-9]+-){3}[0-9]+$') { throw 'explorer-owner' }
                [void]$ownerSidSet.Add($explorerOwnerSid)
            } finally {
                if ($null -ne $owner) { $owner.Dispose() }
                $explorer.Dispose()
            }
        }
    } finally {
        if ($null -ne $explorers) { $explorers.Dispose() }
        $searcher.Dispose()
    }

    if ($explorerCount -lt 1 -or $ownerSidSet.Count -ne 1) { throw 'explorer-owner' }
    $uniqueOwnerSid = $null
    foreach ($ownerSid in $ownerSidSet) {
        $uniqueOwnerSid = $ownerSid
        break
    }
    if (-not [string]::Equals([string]$uniqueOwnerSid, $ExpectedSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'explorer-owner'
    }
}

function Invoke-StdRegProv {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Arguments,
        [switch]$AllowMissingKey
    )

    $inputObject = $script:provider.GetMethodParameters($Method)
    foreach ($entry in $Arguments.GetEnumerator()) {
        $inputObject[$entry.Key] = $entry.Value
    }
    $outputObject = $script:provider.InvokeMethod($Method, $inputObject, $script:invokeOptions)
    $returnValue = $outputObject['ReturnValue']
    if ($null -eq $returnValue) { throw 'provider' }
    $returnCode = [int64]$returnValue
    if ($AllowMissingKey -and $Method -eq 'EnumValues' -and $returnCode -eq 2) {
        return [pscustomobject]@{ MissingKey = $true; Output = $null }
    }
    if ($returnCode -ne 0) { throw 'provider' }
    return [pscustomobject]@{ MissingKey = $false; Output = $outputObject }
}

function Get-RunEntry {
    param([Parameter(Mandatory)][string]$ValueName)

    $enumeration = Invoke-StdRegProv -Method 'EnumValues' -AllowMissingKey -Arguments @{
        hDefKey = $script:hDefKey
        sSubKeyName = $script:runPath
    }
    if ($enumeration.MissingKey) {
        return [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
    }

    $names = @()
    if ($null -ne $enumeration.Output['sNames']) { $names = @($enumeration.Output['sNames']) }
    $types = @()
    if ($null -ne $enumeration.Output['Types']) { $types = @($enumeration.Output['Types']) }
    if ($names.Count -ne $types.Count) { throw 'provider' }

    for ($index = 0; $index -lt $names.Count; $index += 1) {
        if ([string]::Equals([string]$names[$index], $ValueName, [System.StringComparison]::OrdinalIgnoreCase)) {
            if ([int64]$types[$index] -ne 1) { throw 'unsupported-registry-type' }
            $read = Invoke-StdRegProv -Method 'GetStringValue' -Arguments @{
                hDefKey = $script:hDefKey
                sSubKeyName = $script:runPath
                sValueName = $ValueName
            }
            if ($null -eq $read.Output['sValue']) { throw 'provider' }
            return [pscustomobject]@{ Exists = $true; Kind = 'String'; Value = [string]$read.Output['sValue'] }
        }
    }
    return [pscustomobject]@{ Exists = $false; Kind = $null; Value = $null }
}

try {
    $requestBytes = [Convert]::FromBase64String('${requestBase64}')
    $requestJson = [System.Text.Encoding]::UTF8.GetString($requestBytes)
    $request = ConvertFrom-Json -InputObject $requestJson

    if (-not [Environment]::Is64BitProcess -or -not [Environment]::Is64BitOperatingSystem) { throw 'architecture' }
    $currentProcess = [System.Diagnostics.Process]::GetCurrentProcess()
    $currentSessionId = $currentProcess.SessionId
    if ($currentSessionId -eq 0) { throw 'session' }
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        if ($null -eq $identity.User) { throw 'identity' }
        $sid = [string]$identity.User.Value
    } finally {
        $identity.Dispose()
    }
    if ($sid -notmatch '^S-1-(?:5-21|12-1)-(?:[0-9]+-){3}[0-9]+$') { throw 'identity' }
    Assert-ExplorerOwner -SessionId $currentSessionId -ExpectedSid $sid

    if ($null -eq $request -or $request.name -isnot [string] -or $request.name -cnotmatch '^C2C-Workspace-Autostart-[0-9a-fA-F]{12}$') { throw 'request' }
    $name = [string]$request.name
    $runPath = $sid + [char]92 + '${RUN_SUBKEY}'

    if ($request.operation -notin @('host_read', 'host_write', 'host_delete')) { throw 'request' }
    if ($request.operation -eq 'host_write') {
        if ($request.value -isnot [string]) { throw 'request' }
        if ($null -ne $request.kind -and $request.kind -cne 'String') { throw 'unsupported-registry-type' }
    }

    Set-StdRegProv
    $entry = Get-RunEntry -ValueName $name
    $responseValue = $null

    if ($request.operation -eq 'host_read') {
        if ($entry.Exists) {
            $responseValue = [pscustomobject]@{ kind = $entry.Kind; value = $entry.Value }
        }
    } elseif ($request.operation -eq 'host_write') {
        if (-not $entry.Exists) {
            $keyState = Invoke-StdRegProv -Method 'EnumValues' -AllowMissingKey -Arguments @{
                hDefKey = $script:hDefKey
                sSubKeyName = $script:runPath
            }
            if ($keyState.MissingKey) {
                $null = Invoke-StdRegProv -Method 'CreateKey' -Arguments @{
                    hDefKey = $script:hDefKey
                    sSubKeyName = $script:runPath
                }
            }
        }
        $null = Invoke-StdRegProv -Method 'SetStringValue' -Arguments @{
            hDefKey = $script:hDefKey
            sSubKeyName = $script:runPath
            sValueName = $name
            sValue = [string]$request.value
        }

        Set-StdRegProv
        $verified = Get-RunEntry -ValueName $name
        if (-not $verified.Exists -or $verified.Kind -cne 'String' -or -not [string]::Equals([string]$verified.Value, [string]$request.value, [System.StringComparison]::Ordinal)) { throw 'readback' }
        $responseValue = [pscustomobject]@{ kind = $verified.Kind; value = $verified.Value }
    } elseif ($request.operation -eq 'host_delete') {
        if ($entry.Exists) {
            $null = Invoke-StdRegProv -Method 'DeleteValue' -Arguments @{
                hDefKey = $script:hDefKey
                sSubKeyName = $script:runPath
                sValueName = $name
            }
        }
        Set-StdRegProv
        $verified = Get-RunEntry -ValueName $name
        if ($verified.Exists) { throw 'readback' }
    }

    $responseJson = ConvertTo-Json -InputObject ([pscustomobject]@{ sid = $sid; value = $responseValue }) -Compress -Depth 4
    $responseBase64 = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($responseJson))
    [Console]::Out.Write($responseBase64)
    exit 0
} catch {
    if ($_.Exception.Message -eq 'unsupported-registry-type') {
        [Console]::Error.WriteLine('C2C_HOST_RUN_UNSUPPORTED_TYPE')
        exit 3
    }
    [Console]::Error.WriteLine('C2C_HOST_RUN_FAILURE')
    exit 1
}
`;
}

function decodeResponse(stdout: string): HostResponse {
  const encoded = stdout.trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(SCRIPT_ERROR);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf16le")) as unknown;
  } catch {
    throw new Error(SCRIPT_ERROR);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(SCRIPT_ERROR);
  }
  const response = parsed as Record<string, unknown>;
  if (Object.keys(response).length !== 2 || typeof response.sid !== "string" || !USER_SID_PATTERN.test(response.sid)) {
    throw new Error(SCRIPT_ERROR);
  }

  if (response.value === null) return { sid: response.sid, value: null };
  if (typeof response.value !== "object" || Array.isArray(response.value)) throw new Error(SCRIPT_ERROR);
  const value = response.value as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.kind !== "String" || typeof value.value !== "string") {
    throw new Error(SCRIPT_ERROR);
  }
  return { sid: response.sid, value: { kind: "String", value: value.value } };
}

export class StdRegProvHostRunAuthority implements HostRunAuthority {
  constructor(private readonly shellPath: string) {
    if (!shellPath) throw new Error("A PowerShell executable path is required.");
  }

  read(name: string): HostRunValue | null {
    return this.invoke({ operation: "host_read", name }).value;
  }

  write(name: string, value: string, kind: "String" | "ExpandString" = "String"): void {
    validateName(name);
    if (kind !== "String") throw new Error(UNSUPPORTED_TYPE_ERROR);
    if (typeof value !== "string") throw new Error("Invalid host Run value.");
    const response = this.invoke({ operation: "host_write", name, value, kind });
    if (!response.value || response.value.kind !== "String" || response.value.value !== value) {
      throw new Error(SCRIPT_ERROR);
    }
  }

  delete(name: string): void {
    const response = this.invoke({ operation: "host_delete", name });
    if (response.value !== null) throw new Error(SCRIPT_ERROR);
  }

  private invoke(request: HostRequest): HostResponse {
    validateName(request.name);
    const requestBase64 = Buffer.from(JSON.stringify(request), "utf8").toString("base64");

    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        this.shellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", buildPowerShellScript(requestBase64)],
        {
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 256 * 1024,
          encoding: "utf8",
        },
      );
    } catch {
      throw new Error(SCRIPT_ERROR);
    }

    if (result.status === 3 && typeof result.stderr === "string" && result.stderr.trim() === "C2C_HOST_RUN_UNSUPPORTED_TYPE") {
      throw new Error(UNSUPPORTED_TYPE_ERROR);
    }
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error(SCRIPT_ERROR);
    }
    return decodeResponse(result.stdout);
  }
}
