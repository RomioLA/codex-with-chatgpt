import { spawnSync } from "node:child_process";

export type LegacyRunValueKind = "String" | "ExpandString";

export interface LegacyRunValue {
  kind: string;
  value: string;
}

/** A caller-identity view of the one C2C Run value. */
export interface LegacyRunView {
  read(name: string): LegacyRunValue | null;
  write(name: string, value: string, kind?: LegacyRunValueKind): void;
  /** Verify null, or the supplied host value when deleting reveals a merged host view. */
  delete(name: string, expectedAfter?: LegacyRunValue | null): void;
}

interface LegacyRequest {
  operation: "legacy_read" | "legacy_write" | "legacy_delete";
  name: string;
  value?: string;
  kind?: LegacyRunValueKind;
}

interface LegacyResponse {
  sid: string;
  value: LegacyRunValue | null;
}

const LEGACY_RUN_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const C2C_RUN_NAME = /^C2C-Workspace-Autostart-[a-f0-9]{12}$/i;

function assertC2CRunName(name: string): void {
  if (!C2C_RUN_NAME.test(name)) {
    throw new Error("Legacy Run cleanup is restricted to the exact C2C workspace value name.");
  }
}

/**
 * Uses .NET Registry.CurrentUser for the process identity. The host Run value
 * is handled separately by HostRunAuthority; this view exists only for the
 * narrowly-scoped legacy migration cleanup.
 */
export class PowerShellLegacyRunView implements LegacyRunView {
  constructor(private readonly shellPath: string) {}

  private invoke(request: LegacyRequest): LegacyResponse {
    assertC2CRunName(request.name);
    if (request.operation === "legacy_write"
      && (typeof request.value !== "string" || (request.kind !== "String" && request.kind !== "ExpandString"))) {
      throw new Error("The caller Run write request is invalid.");
    }
    const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$requestJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRequest}'))`,
      "$request = ConvertFrom-Json -InputObject $requestJson",
      "if ([string]$request.name -notmatch '^C2C-Workspace-Autostart-[a-fA-F0-9]{12}$') { throw 'Invalid legacy Run value name.' }",
      "if ([string]$request.operation -eq 'legacy_write' -and [string]$request.kind -notin @('String', 'ExpandString')) { throw 'Unsupported legacy Run registry kind.' }",
      `$keyPath = '${LEGACY_RUN_KEY}'`,
      "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$value = $null",
      "switch ([string]$request.operation) {",
      "  'legacy_read' {",
      "    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $false)",
      "    if ($null -ne $key) {",
      "      try {",
      "        if ($key.GetValueNames() -contains [string]$request.name) {",
      "          $kind = $key.GetValueKind([string]$request.name).ToString()",
      "          $raw = $key.GetValue([string]$request.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
      "          $value = @{ kind = $kind; value = [string]$raw }",
      "        }",
      "      } finally { $key.Close() }",
      "    }",
      "  }",
      "  'legacy_write' {",
      "    if ([string]$request.kind -notin @('String', 'ExpandString')) { throw 'Unsupported legacy Run registry kind.' }",
      "    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath, $true)",
      "    if ($null -eq $key) { throw 'Could not open the current-user Run key for writing.' }",
      "    try {",
      "      $kind = [Microsoft.Win32.RegistryValueKind]([string]$request.kind)",
      "      $key.SetValue([string]$request.name, [string]$request.value, $kind)",
      "    } finally { $key.Close() }",
      "  }",
      "  'legacy_delete' {",
      "    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $true)",
      "    if ($null -ne $key) {",
      "      try { $key.DeleteValue([string]$request.name, $false) } finally { $key.Close() }",
      "    }",
      "  }",
      "  default { throw 'Unsupported legacy Run operation.' }",
      "}",
      "$response = @{ sid = $sid; value = $value }",
      "$json = ConvertTo-Json -Compress -Depth 4 -InputObject $response",
      "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json)))",
    ].join("\n");
    const result = spawnSync(this.shellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    });
    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
    if (result.error || result.status !== 0) {
      const status = result.status === null ? "unknown" : String(result.status);
      throw new Error(`Caller Run operation '${request.operation}' failed (exit ${status}).`);
    }
    try {
      const json = Buffer.from(stdout.toString("ascii").trim(), "base64").toString("utf16le");
      const response = JSON.parse(json) as Partial<LegacyResponse>;
      if (typeof response.sid !== "string" || !/^S-1-\d+(?:-\d+)+$/i.test(response.sid)) throw new Error("missing or invalid caller SID");
      if (!Object.prototype.hasOwnProperty.call(response, "value")) throw new Error("missing value envelope field");
      if (response.value !== null && response.value !== undefined) {
        if (!response.value || typeof response.value !== "object"
          || typeof response.value.kind !== "string" || typeof response.value.value !== "string") {
          throw new Error("invalid Run value");
        }
        return { sid: response.sid, value: response.value };
      }
      return { sid: response.sid, value: null };
    } catch {
      throw new Error("Could not decode the caller current-user Run response.");
    }
  }

  read(name: string): LegacyRunValue | null {
    return this.invoke({ operation: "legacy_read", name }).value;
  }

  write(name: string, value: string, kind: LegacyRunValueKind = "String"): void {
    this.invoke({ operation: "legacy_write", name, value, kind });
    const actual = this.read(name);
    if (!actual || actual.kind !== kind || actual.value !== value) {
      throw new Error("Caller Run write failed verification.");
    }
  }

  delete(name: string, expectedAfter: LegacyRunValue | null = null): void {
    this.invoke({ operation: "legacy_delete", name });
    const actual = this.read(name);
    if (actual !== null && !sameLegacyRunValue(actual, expectedAfter)) {
      throw new Error("Caller Run deletion failed verification.");
    }
  }
}

function sameLegacyRunValue(left: LegacyRunValue | null, right: LegacyRunValue | null): boolean {
  return left === null
    ? right === null
    : right !== null && left.kind === right.kind && left.value === right.value;
}
