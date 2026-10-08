import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: childProcess.spawnSync,
}));

import { StdRegProvHostRunAuthority } from "../src/autostart/host-run-authority.js";

const shellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const validName = "C2C-Workspace-Autostart-abcdef123456";
const userSid = "S-1-5-21-111-222-333-1001";
const genericError = "Host Run authority operation failed.";

type WireResponse = { sid: string; value: null | { kind: string; value: string } };

function encodedResponse(value: WireResponse): string {
  return Buffer.from(JSON.stringify(value), "utf16le").toString("base64");
}

function successfulResponse(value: WireResponse): void {
  childProcess.spawnSync.mockReturnValue({
    status: 0,
    stdout: encodedResponse(value),
    stderr: "",
  });
}

function callDetails(): { file: string; args: string[]; options: Record<string, unknown> } {
  const [file, args, options] = childProcess.spawnSync.mock.calls.at(-1) as [
    string,
    string[],
    Record<string, unknown>,
  ];
  return { file, args, options };
}

function requestFromLastCall(): { operation: string; name: string; value?: string; kind?: string } {
  const { args } = callDetails();
  const script = args[4];
  const match = script.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  if (!match) throw new Error("PowerShell script omitted the Base64 request literal.");
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as {
    operation: string;
    name: string;
    value?: string;
    kind?: string;
  };
}

beforeEach(() => {
  childProcess.spawnSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StdRegProvHostRunAuthority protocol", () => {
  it("uses the explicit HKU SID path and forced 64-bit StdRegProv protocol", () => {
    successfulResponse({ sid: userSid, value: { kind: "String", value: "node.exe --workspace" } });

    const authority = new StdRegProvHostRunAuthority(shellPath);
    expect(authority.read(validName)).toEqual({ kind: "String", value: "node.exe --workspace" });

    const { file, args, options } = callDetails();
    expect(file).toBe(shellPath);
    expect(args).toHaveLength(5);
    expect(args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    expect(options).toMatchObject({
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8",
    });

    const script = args[4];
    const request = requestFromLastCall();
    expect(request).toEqual({ operation: "host_read", name: validName });
    expect((script.match(/FromBase64String\(/g) ?? [])).toHaveLength(1);
    expect(script).toContain("[System.Management.ManagementScope]::new('\\\\.\\root\\default')");
    expect(script).toContain("[System.Management.ImpersonationLevel]::Impersonate");
    expect(script).toContain("$scope.Options.Context.Add('__ProviderArchitecture', 64)");
    expect(script).toContain("$scope.Options.Context.Add('__RequiredArchitecture', $true)");
    expect(script).toContain("$nextOptions.Context.Add('__ProviderArchitecture', 64)");
    expect(script).toContain("$nextOptions.Context.Add('__RequiredArchitecture', $true)");
    expect(script).toContain("$AllowMissingKey -and $Method -eq 'EnumValues' -and $returnCode -eq 2");
    expect(script).toContain("$hDefKey = [uint32]2147483651");
    expect(script).toContain("$runPath = $sid + [char]92 + 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'");
    expect(script).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent()");
    expect(script).toContain("$currentSessionId -eq 0");
    expect(script).toContain("[System.Management.ManagementObjectSearcher]::new('\\\\.\\root\\cimv2', $query)");
    expect(script).toContain("SELECT Handle, SessionId FROM Win32_Process WHERE Name='explorer.exe' AND SessionId=$SessionId");
    expect(script).toContain("$explorer.InvokeMethod('GetOwnerSid', $null, $null)");
    expect(script).toContain("$explorerCount -lt 1 -or $ownerSidSet.Count -ne 1");
    expect(script).toContain("[string]::Equals([string]$uniqueOwnerSid, $ExpectedSid, [System.StringComparison]::OrdinalIgnoreCase)");
    expect(script).toContain("Assert-ExplorerOwner -SessionId $currentSessionId -ExpectedSid $sid");
    expect(script.indexOf("    Assert-ExplorerOwner -SessionId $currentSessionId -ExpectedSid $sid"))
      .toBeLessThan(script.indexOf("    Set-StdRegProv\n    $entry = Get-RunEntry"));
    expect(script).not.toMatch(/\breg\.exe\b|GetExpandedStringValue|SetExpandedStringValue|HKEY_CURRENT_USER/i);
    expect(file).not.toMatch(/reg\.exe/i);
  });

  it("returns null for an absent value", () => {
    successfulResponse({ sid: userSid, value: null });

    expect(new StdRegProvHostRunAuthority(shellPath).read(validName)).toBeNull();
    expect(requestFromLastCall()).toEqual({ operation: "host_read", name: validName });
  });

  it("encodes writes and validates the independent readback before succeeding", () => {
    successfulResponse({ sid: userSid, value: { kind: "String", value: "C:\\Program Files\\node.exe" } });

    expect(() => new StdRegProvHostRunAuthority(shellPath).write(
      validName,
      "C:\\Program Files\\node.exe",
    )).not.toThrow();
    expect(requestFromLastCall()).toEqual({
      operation: "host_write",
      name: validName,
      value: "C:\\Program Files\\node.exe",
      kind: "String",
    });

    successfulResponse({ sid: userSid, value: { kind: "String", value: "different" } });
    expect(() => new StdRegProvHostRunAuthority(shellPath).write(validName, "expected"))
      .toThrow(genericError);
  });

  it("rejects ExpandString writes and invalid names before starting PowerShell", () => {
    const authority = new StdRegProvHostRunAuthority(shellPath);

    expect(() => authority.write(validName, "%APPDATA%\\app.exe", "ExpandString"))
      .toThrow("Unsupported host Run value type.");
    expect(() => authority.read("C2C-Workspace-Autostart-short"))
      .toThrow("Invalid host Run value name.");
    expect(() => authority.delete("unrelated-run-entry"))
      .toThrow("Invalid host Run value name.");
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it("requires delete readback to be absent", () => {
    successfulResponse({ sid: userSid, value: null });
    expect(() => new StdRegProvHostRunAuthority(shellPath).delete(validName)).not.toThrow();
    expect(requestFromLastCall()).toEqual({ operation: "host_delete", name: validName });

    successfulResponse({ sid: userSid, value: { kind: "String", value: "still present" } });
    expect(() => new StdRegProvHostRunAuthority(shellPath).delete(validName)).toThrow(genericError);
  });

  it("reports unsupported existing registry types without exposing values", () => {
    childProcess.spawnSync.mockReturnValue({
      status: 3,
      stdout: "",
      stderr: "C2C_HOST_RUN_UNSUPPORTED_TYPE",
    });

    expect(() => new StdRegProvHostRunAuthority(shellPath).read(validName))
      .toThrow("Unsupported host Run value type.");
  });

  it("hides WMI failure details and rejects malformed responses", () => {
    childProcess.spawnSync.mockReturnValue({
      status: 1,
      stdout: "private registry value sentinel",
      stderr: "WMI failure containing private registry value sentinel",
    });
    let caught: unknown;
    try {
      new StdRegProvHostRunAuthority(shellPath).read(validName);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(genericError);
    expect((caught as Error).message).not.toContain("private registry value sentinel");

    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: "not-base64!", stderr: "" });
    expect(() => new StdRegProvHostRunAuthority(shellPath).read(validName)).toThrow(genericError);

    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: Buffer.from(JSON.stringify({ sid: userSid }), "utf16le").toString("base64"),
      stderr: "",
    });
    expect(() => new StdRegProvHostRunAuthority(shellPath).read(validName)).toThrow(genericError);

    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: encodedResponse({ sid: "S-1-5-18", value: null }),
      stderr: "",
    });
    expect(() => new StdRegProvHostRunAuthority(shellPath).read(validName)).toThrow(genericError);
  });
});
