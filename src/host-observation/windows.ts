import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ObservationError, type ObservationProvider, type QueryInput, type ListenerInput } from "./types.js";

// Small fixed script for the local permission gate. Identity values stay inside
// the local process and this script has no caller-controlled input.
//
// Boot identity must be EXACT and STABLE: two independent processes in the same
// Windows logon session have to produce byte-identical identity fields, otherwise
// the sha256 fingerprint drifts and a grant written by one process can never be
// verified by another.
//
// Fixed defects in the previous revision:
//  1. bootTime came from NtQuerySystemInformation(SystemTimeOfDayInformation)
//     formatted with DateTime.ToString("o"), which normalises the fractional text
//     per process (.500 / .498 / .502 / .0000000 observed).
//  2. That same query was called with a 48-byte buffer. The kernel requires
//     exactly sizeof(SYSTEM_TIMEOFDAY_INFORMATION) (48), so any other size fails
//     with STATUS_INFO_LENGTH_MISMATCH and the "fallback" could never work either.
//
// This revision therefore emits the raw 64-bit boot FILETIME as canonical
// fixed-width invariant text (no locale, DateTime formatting, wall-clock or
// tick-count arithmetic), verifies that the kernel answered with a complete
// structure, and cross-checks the result. Any inconsistent measurement fails
// closed instead of yielding a plausible but drift-prone value.
export const WINDOWS_SESSION_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class C2CSessionIdentity {
 const int SystemTimeOfDayInformation = 3;
 const int SystemEnvironmentInformation = 90;
 const int SystemEnvironmentInformationEx = 107;
 // sizeof(SYSTEM_TIMEOFDAY_INFORMATION). The kernel rejects any other length with
 // STATUS_INFO_LENGTH_MISMATCH, so this buffer size is mandatory, not cosmetic.
 const int TimeOfDayInformationSize = 48;
 // Offset of the 64-bit BootTime FILETIME inside SYSTEM_ENVIRONMENT_INFORMATION
 // (BootIdentifier GUID 0..15, BootFlags 16..17, padding 18..23, BootTime 24..31).
 const int EnvironmentBootTimeOffset = 24;
 const int EnvironmentMinimumSize = 32;
 const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
 const int StatusBufferTooSmall = unchecked((int)0xC0000023);
 const long MaxPlausibleFileTime = 2650467743999999999L; // 9999-12-31T23:59:59.9999999Z
 [StructLayout(LayoutKind.Sequential)] struct Luid { public uint LowPart; public int HighPart; }
 [StructLayout(LayoutKind.Sequential)] struct TokenStatistics {
  public Luid TokenId; public Luid AuthenticationId; public long ExpirationTime;
  public int TokenType; public int ImpersonationLevel; public int DynamicCharged;
  public int DynamicAvailable; public int GroupCount; public int PrivilegeCount; public Luid ModifiedId;
 }
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, out TokenStatistics value, int length, out int needed);
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind, IntPtr buffer, uint length, out uint returned);
 [DllImport("kernel32.dll")] static extern bool GetSystemTimeAdjustment(out uint adjustment, out uint increment, out bool disabled);
 // Exact-size query into a fresh buffer. A successful call must report a complete
 // structure; zeroed or truncated buffers are never accepted as evidence.
 static byte[] QueryExact(int kind, int size) {
  IntPtr raw = Marshal.AllocHGlobal(size);
  try {
   for (int i = 0; i < size; i++) Marshal.WriteByte(raw, i, 0xAA);
   uint returned;
   int status = NtQuerySystemInformation(kind, raw, (uint)size, out returned);
   if (status != 0 || returned != (uint)size) return null;
   byte[] copy = new byte[size];
   Marshal.Copy(raw, copy, 0, size);
   return copy;
  } finally { Marshal.FreeHGlobal(raw); }
 }
 static bool IsPlausibleFileTime(long value) {
  return value > 0 && value < MaxPlausibleFileTime;
 }
 // Windows 11 SYSTEM_ENVIRONMENT_INFORMATION carries BootIdentifier plus a 64-bit
 // boot FILETIME. Returns null when this build does not expose it.
 static object[] TryExtendedEnvironment() {
  foreach (int kind in new int[] { SystemEnvironmentInformationEx, SystemEnvironmentInformation }) {
   byte[] buffer = QueryExact(kind, EnvironmentMinimumSize);
   if (buffer == null) continue;
   var identifierBytes = new byte[16];
   Array.Copy(buffer, 0, identifierBytes, 0, 16);
   var identifier = new Guid(identifierBytes);
   if (identifier == Guid.Empty) continue;
   long bootTime = BitConverter.ToInt64(buffer, EnvironmentBootTimeOffset);
   if (!IsPlausibleFileTime(bootTime)) continue;
   ulong flags = BitConverter.ToUInt64(buffer, 16);
   return new object[] { identifier, bootTime, (int)(flags & 0xFFFFUL), (int)(flags >> 16), "environment-information" };
  }
  return null;
 }
 // Fallback: the exact-size SystemTimeOfDayInformation buffer (word 0 = boot
 // FILETIME). The raw value is used as-is; nothing is derived from ticks.
 static long? TryTimeOfDayBootTime() {
  byte[] buffer = QueryExact(SystemTimeOfDayInformation, TimeOfDayInformationSize);
  if (buffer == null) return null;
  long bootTime = BitConverter.ToInt64(buffer, 0);
  return IsPlausibleFileTime(bootTime) ? bootTime : (long?)null;
 }
 static Guid ReadBootIdentifier() {
  byte[] buffer = QueryExact(SystemEnvironmentInformation, EnvironmentMinimumSize);
  if (buffer == null) throw new InvalidOperationException("Boot identifier unavailable");
  var identifierBytes = new byte[16];
  Array.Copy(buffer, 0, identifierBytes, 0, 16);
  var identifier = new Guid(identifierBytes);
  if (identifier == Guid.Empty) throw new InvalidOperationException("Boot identifier unavailable");
  return identifier;
 }
 // Canonical fixed-width UTC text for a Windows FILETIME (100ns ticks since
 // 1601-01-01T00:00:00Z): always yyyy-MM-ddTHH:mm:ss.fffffffZ, invariant culture.
 static string FormatFileTime(long fileTime) {
  return DateTime.FromFileTimeUtc(fileTime).ToString("yyyy-MM-dd'T'HH:mm:ss'.'fffffff'Z'", CultureInfo.InvariantCulture);
 }
 public static Dictionary<string,object> Read() {
  var result = new Dictionary<string,object>();
  using (var identity = WindowsIdentity.GetCurrent()) {
   if (identity.User == null) throw new InvalidOperationException("User SID unavailable");
   TokenStatistics stats; int needed;
   if (!GetTokenInformation(identity.Token, 10, out stats, Marshal.SizeOf(typeof(TokenStatistics)), out needed)) throw new InvalidOperationException("Token statistics unavailable");
   if (stats.AuthenticationId.LowPart == 0 && stats.AuthenticationId.HighPart == 0) throw new InvalidOperationException("Logon LUID unavailable");
   result["userSid"] = identity.User.Value;
   result["logonId"] = unchecked((uint)stats.AuthenticationId.HighPart).ToString("x8") + stats.AuthenticationId.LowPart.ToString("x8");
  }
  result["sessionId"] = Process.GetCurrentProcess().SessionId;
  result["ticksPerSecond"] = TimeSpan.TicksPerSecond;
  object[] extended = TryExtendedEnvironment();
  long? timeOfDayBoot = TryTimeOfDayBootTime();
  Guid bootIdentifier;
  long bootTime;
  if (extended != null) {
   bootIdentifier = (Guid)extended[0];
   bootTime = (long)extended[1];
   result["bootSource"] = (string)extended[4];
   result["firmwareType"] = extended[2];
   // Independent corroboration: when both sources answer they must agree exactly.
   if (timeOfDayBoot.HasValue && timeOfDayBoot.Value != bootTime) throw new InvalidOperationException("Boot time sources disagree");
   if (timeOfDayBoot.HasValue) result["bootTimeCorroborated"] = true;
  } else if (timeOfDayBoot.HasValue) {
   bootIdentifier = ReadBootIdentifier();
   bootTime = timeOfDayBoot.Value;
   result["bootSource"] = "time-of-day-information";
   result["bootTimeCorroborated"] = false;
  } else {
   throw new InvalidOperationException("Boot time unavailable");
  }
  uint adjustment; uint increment; bool adjustmentDisabled;
  if (GetSystemTimeAdjustment(out adjustment, out increment, out adjustmentDisabled)) {
   result["interruptTimeAdjustment"] = (long)adjustment;
   result["interruptTimeIncrement"] = (long)increment;
  }
  result["bootTimeFileTime"] = bootTime;
  result["bootId"] = bootIdentifier.ToString("D");
  result["bootTime"] = FormatFileTime(bootTime);
  return result;
 }
}
'@
[C2CSessionIdentity]::Read() | ConvertTo-Json -Depth 4 -Compress
`;

// The entire interpreter body is source-controlled. JSON stdin is DATA only.
// No remote value enters command arguments, a script fragment, WQL, or Invoke-Expression.
export const WINDOWS_QUERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$q = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Status($error) {
  if ($error.Exception -is [UnauthorizedAccessException] -or $error.Exception.HResult -eq -2147024891) { 'ACCESS_DENIED' }
  else { 'UNAVAILABLE' }
}
function ProcessRow($p) {
  @{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=$p.Name;exePath=$p.ExecutablePath;
    commandLine=$p.CommandLine;sessionId=$p.SessionId;startTime=$(if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null})}
}
switch ($q.operation) {
  'processes' {
    $all = @(Get-CimInstance -ClassName Win32_Process)
    $selected = @($all | Where-Object {
      ($null -eq $q.pid -or $_.ProcessId -eq $q.pid) -and
      ($null -eq $q.parentPid -or $_.ParentProcessId -eq $q.parentPid) -and
      ($null -eq $q.name -or $_.Name -ieq $q.name)
    })
    $out = @{processes=@($selected | Select-Object -First 4096 | ForEach-Object { ProcessRow $_ });truncated=($selected.Count -gt 4096)}
  }
  'listeners' {
    $rows = [Collections.Generic.List[object]]::new(); $statuses = @{}
    foreach ($protocol in @('tcp','udp')) {
      if ($q.protocol -and $q.protocol -ne $protocol) { continue }
      try {
        $connections = if($protocol -eq 'tcp'){ @(Get-NetTCPConnection -State Listen) }else{ @(Get-NetUDPEndpoint) }
        $statuses[$protocol] = 'AVAILABLE'
        foreach($c in $connections) {
          if(($null -ne $q.pid -and $c.OwningProcess -ne $q.pid) -or
             ($null -ne $q.port -and $c.LocalPort -ne $q.port) -or
             ($q.address -and $c.LocalAddress -ne $q.address)) {continue}
          $rows.Add(@{protocol=$protocol;localAddress=$c.LocalAddress;localPort=[int]$c.LocalPort;
            pid=[int]$c.OwningProcess;state=$(if($protocol -eq 'tcp'){'LISTENING'}else{$null})})
        }
      } catch { $statuses[$protocol] = Status $_ }
    }
    $out = @{listeners=@($rows | Select-Object -First ($q.limit + 1));truncated=($rows.Count -gt $q.limit);fieldStatus=$statuses}
  }
  'network' {
    $statuses=@{internetReachable='NOT_SUPPORTED'}; $adapters=@(); $route=$null; $servers=@(); $truncated=$false
    try {
      $adapterAll=@(Get-NetAdapter); $truncated=$adapterAll.Count -gt 64
      $adapters=@($adapterAll | Select-Object -First 64 | ForEach-Object {
        $adapter=$_; $addresses=@(); $addressStatus='AVAILABLE'
        $addressesTruncated=$false
        try {$addressAll=@(Get-NetIPAddress -InterfaceIndex $adapter.ifIndex);$addressesTruncated=$addressAll.Count -gt 32;$addresses=@($addressAll | Select-Object -First 32 | ForEach-Object {$_.IPAddress})}
        catch {$addressStatus=Status $_}
        @{interfaceIndex=[int]$adapter.ifIndex;operationalStatus=[string]$adapter.Status;
          addresses=$addresses;truncated=$addressesTruncated;fieldStatus=@{addresses=$addressStatus}}
      }); $statuses.adapters='AVAILABLE'
    } catch {$statuses.adapters=Status $_}
    try {$route=@(Get-NetRoute | Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','::/0') -and $_.State -ne 'Dead'}).Count -gt 0;$statuses.defaultRoutePresent='AVAILABLE'}
    catch {$statuses.defaultRoutePresent=Status $_}
    try {$serverAll=@(Get-DnsClientServerAddress | ForEach-Object {$_.ServerAddresses} | Select-Object -Unique);$truncated=$truncated -or $serverAll.Count -gt 64;$servers=@($serverAll | Select-Object -First 64);$statuses.dnsServers='AVAILABLE'}
    catch {$statuses.dnsServers=Status $_}
    $out=@{adapters=$adapters;defaultRoutePresent=$route;dnsServers=$servers;internetReachable=$null;
      fieldStatus=$statuses;readinessEvidenceOnly=$true;truncated=$truncated}
  }
  'context' {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class C2CHostIdentity {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int kind,out int value,int length,out int needed);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr p,ref uint length,StringBuilder name);
 public static Dictionary<string,object> Read(int pid) {
  var data=new Dictionary<string,object>();var h=OpenProcess(0x1000,false,pid);
  if(h==IntPtr.Zero) return data;
  try {
   IntPtr token;
   if(OpenProcessToken(h,8,out token)) {try {
    using(var identity=new WindowsIdentity(token)){data["userSid"]=identity.User.Value;data["userName"]=identity.Name;}
    int elevation,needed;if(GetTokenInformation(token,20,out elevation,4,out needed))data["isElevated"]=elevation!=0;
   }finally{CloseHandle(token);}}
   uint length=0;int code=GetPackageFullName(h,ref length,null);
   if(code==15700){data["isPackaged"]=false;data["packageIdentity"]=null;}
   else if(code==122 && length<4096){var name=new StringBuilder((int)length);if(GetPackageFullName(h,ref length,name)==0){data["isPackaged"]=true;data["packageIdentity"]=name.ToString();}}
  }finally{CloseHandle(h);}return data;
 }
}
'@
    $out=[C2CHostIdentity]::Read([int]$q.hostPid)
    try {$out['sessionId']=(Get-Process -Id $q.hostPid).SessionId}catch{}
  }
  'metadata' {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
public static class C2CFileMetadata {
 [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low,High; }
 [StructLayout(LayoutKind.Sequential)] struct FileInfo {
  public uint Attributes;public FileTime Creation,Access,Write;public uint VolumeSerial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out FileInfo info);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
 [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr h,int type,uint requested,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
 [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
 public static Dictionary<string,object> Read(string path) {
  var result=new Dictionary<string,object>();var status=new Dictionary<string,string>();
  result["owner"]=null;result["aclSummary"]=null;result["attributes"]=null;result["handleIdentity"]=null;result["fieldStatus"]=status;
  // OPEN_REPARSE_POINT: inspect the named entry, never follow a newly swapped final link.
  const uint flags=0x02000000|0x00200000;
  var h=CreateFile(path,0x00020000,7,IntPtr.Zero,3,flags,IntPtr.Zero);
  bool aclReadable=h!=new IntPtr(-1);
  if(!aclReadable)h=CreateFile(path,0,7,IntPtr.Zero,3,flags,IntPtr.Zero);
  if(h==new IntPtr(-1))return result;
  try {
   FileInfo info;
   if(!GetFileInformationByHandle(h,out info))return result;
   result["handleIdentity"]=new Dictionary<string,string>{{"fileId",(((ulong)info.IndexHigh<<32)|info.IndexLow).ToString()},{"volumeId",info.VolumeSerial.ToString()}};
   result["attributes"]=((FileAttributes)info.Attributes).ToString();status["attributes"]="AVAILABLE";
   if(!aclReadable){status["owner"]="ACCESS_DENIED";status["aclSummary"]="ACCESS_DENIED";return result;}
   IntPtr owner,group,dacl,sacl,descriptor;
   uint code=GetSecurityInfo(h,1,1|4,out owner,out group,out dacl,out sacl,out descriptor);
   if(code!=0){status["owner"]=code==5?"ACCESS_DENIED":"UNAVAILABLE";status["aclSummary"]=status["owner"];return result;}
   try {
    int length=checked((int)GetSecurityDescriptorLength(descriptor));
    if(length<1 || length>65536){status["owner"]="UNAVAILABLE";status["aclSummary"]="UNAVAILABLE";return result;}
    var bytes=new byte[length];Marshal.Copy(descriptor,bytes,0,length);
    var security=new RawSecurityDescriptor(bytes,0);result["owner"]=security.Owner==null?null:security.Owner.Value;
    int inherited=0,explicitCount=0;
    if(security.DiscretionaryAcl!=null)foreach(GenericAce ace in security.DiscretionaryAcl){if((ace.AceFlags&AceFlags.Inherited)!=0)inherited++;else explicitCount++;}
    result["aclSummary"]=new Dictionary<string,object>{{"protected",(security.ControlFlags&ControlFlags.DiscretionaryAclProtected)!=0},{"explicitRuleCount",explicitCount},{"inheritedRuleCount",inherited},{"nullDacl",security.DiscretionaryAcl==null}};
    status["owner"]=security.Owner==null?"UNAVAILABLE":"AVAILABLE";status["aclSummary"]="AVAILABLE";
   }finally{LocalFree(descriptor);}
  }finally{CloseHandle(h);}
  return result;
 }
}
'@
    $out=[C2CFileMetadata]::Read([string]$q.path)
    foreach($field in @('owner','aclSummary','attributes')){if(-not $out['fieldStatus'].ContainsKey($field)){$out['fieldStatus'][$field]='UNAVAILABLE'}}
  }
  default { throw 'Unsupported internal observation operation' }
}
$out | ConvertTo-Json -Depth 12 -Compress
`;

let active = 0;

/**
 * A directory listing that can fail without aborting resolution.
 * `C:\Program Files\WindowsApps` is frequently ACL-restricted (SYSTEM/TrustedInstaller
 * only), so a missing or denied store simply yields no MSIX candidates.
 */
export interface DirectoryListing {
  entries: string[];
  readable: boolean;
}

export interface PowerShellDiscoveryFileSystem {
  listDirectory(directory: string): DirectoryListing;
  isRegularFile(candidate: string): boolean;
}

export interface PowerShellDiscoveryInputs {
  /** Absolute Program Files root; never a caller-supplied search path. */
  programFiles: string;
  /** Absolute 32-bit Program Files root. */
  programFilesX86: string;
  /** Absolute MSIX package store root. */
  packageStore: string;
  /** Bundled fallback runtime directory (Codex desktop runtime). */
  bundledDirectory: string;
  fileSystem?: PowerShellDiscoveryFileSystem;
  platform?: NodeJS.Platform;
}

/** Fixed per-machine MSIX store. Typically ACL-restricted even for the user. */
const POWERSHELL_PACKAGE_STORE = "C:\\Program Files\\WindowsApps";

/**
 * Numeric-aware comparison of two dotted versions. A non-numeric segment sorts
 * below any numeric segment, so numeric segments never collide with labels.
 */
function compareVersions(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const leftPart = a[index];
    const rightPart = b[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? 1 : -1;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

/**
 * Versioned Program Files layout: %ProgramFiles%\PowerShell\<version>\pwsh.exe.
 * Only names that are purely numeric versions are accepted, so "7-preview" and
 * any non-version directory is never mistaken for a versioned install.
 */
function versionedProgramFilesCandidates(root: string, listed: DirectoryListing): string[] {
  if (!listed.readable) return [];
  return listed.entries
    .filter((entry) => /^\d+(?:\.\d+)*$/.test(entry))
    .sort((left, right) => compareVersions(right, left))
    .map((entry) => path.join(root, entry, "pwsh.exe"));
}

/**
 * MSIX layout: <store>\<PackageFullName>\pwsh.exe, where PackageFullName is
 * Microsoft.PowerShell_<version>_<arch>_<resourceid>_<publisherId>.
 * Only the Microsoft-published publisher ID is accepted; highest version first.
 */
const MSIX_PACKAGE_PATTERN = /^Microsoft\.PowerShell_(\d+(?:\.\d+)*)_(x64|x86|arm64)_[^_]*_(8wekyb3d8bbwe)$/i;

function msixPowerShellCandidates(store: string, listed: DirectoryListing): string[] {
  if (!listed.readable) return [];
  return listed.entries
    .map((entry) => ({ entry, match: MSIX_PACKAGE_PATTERN.exec(entry) }))
    .filter((item): item is { entry: string; match: RegExpExecArray } => item.match !== null)
    .sort((left, right) => compareVersions(right.match[1], left.match[1]))
    .map((item) => path.join(store, item.entry, "pwsh.exe"));
}

/** True only for a regular file: directories, symlinks, and devices are rejected. */
function defaultIsRegularFile(candidate: string): boolean {
  try {
    const link = fs.lstatSync(candidate);
    if (link.isSymbolicLink() || link.isDirectory() || !link.isFile()) return false;
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function defaultListDirectory(directory: string): DirectoryListing {
  try { return { entries: fs.readdirSync(directory), readable: true }; }
  catch { return { entries: [], readable: false }; }
}

export const defaultPowerShellDiscoveryFileSystem: PowerShellDiscoveryFileSystem = {
  listDirectory: defaultListDirectory,
  isRegularFile: defaultIsRegularFile,
};

/**
 * Build the ordered, deterministic candidate list for the fixed interpreter.
 * Purely a function of the supplied well-known absolute roots, this machine's own
 * directory listings, and (optionally) an injected file system for tests.
 *
 * No PATH, PATHEXT, COMSPEC, current-directory, or caller-supplied search path is
 * ever consulted, so a caller cannot redirect the identity script.
 */
export function resolvePowerShellCandidates(inputs: PowerShellDiscoveryInputs): string[] {
  const fileSystem = inputs.fileSystem ?? defaultPowerShellDiscoveryFileSystem;
  const programFilesRoot = path.join(inputs.programFiles, "PowerShell");
  const candidates = [
    // Primary documented per-machine install.
    path.join(inputs.programFiles, "PowerShell", "7", "pwsh.exe"),
    // Preview channel install.
    path.join(inputs.programFiles, "PowerShell", "7-preview", "pwsh.exe"),
    // Side-by-side 6.x installs.
    path.join(inputs.programFiles, "PowerShell", "6", "pwsh.exe"),
    path.join(inputs.programFiles, "PowerShell", "6-preview", "pwsh.exe"),
    // Versioned Program Files layout, highest version first.
    ...versionedProgramFilesCandidates(programFilesRoot, fileSystem.listDirectory(programFilesRoot)),
    // 32-bit install location.
    path.join(inputs.programFilesX86, "PowerShell", "7", "pwsh.exe"),
    path.join(inputs.programFilesX86, "PowerShell", "7-preview", "pwsh.exe"),
    // MSIX install (Microsoft Store / winget MSIX), highest version first.
    ...msixPowerShellCandidates(inputs.packageStore, fileSystem.listDirectory(inputs.packageStore)),
    // Existing Codex Desktop bundled PS7; no download/install and no new dependency.
    path.join(inputs.bundledDirectory, "pwsh.exe"),
  ];
  const windowsCaseInsensitive = (inputs.platform ?? process.platform) === "win32";
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const key = windowsCaseInsensitive ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fileSystem.isRegularFile(candidate)) continue;
    resolved.push(candidate);
  }
  return resolved;
}

/** Well-known absolute roots for this machine (no environment-provided search path). */
export function localPowerShellDiscoveryInputs(): PowerShellDiscoveryInputs {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  return {
    programFiles: path.resolve(programFiles),
    programFilesX86: path.resolve(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"),
    // Fixed per-machine MSIX store. Typically ACL-restricted even for the user.
    packageStore: POWERSHELL_PACKAGE_STORE,
    bundledDirectory: path.join(
      os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell"
    ),
    platform: process.platform,
  };
}

/** Ordered candidates that exist as regular files on this machine. */
export function fixedPowerShellCandidates(): string[] {
  return resolvePowerShellCandidates(localPowerShellDiscoveryInputs());
}

/**
 * Why the session identity could not be read. Callers always fail closed on any
 * non-"ok" reason; the reason exists so a human/acceptance run can tell
 * "no PowerShell installed" apart from "PowerShell refused to start here"
 * instead of seeing an indistinguishable null.
 *
 *  - NOT_WINDOWS            : host is not Windows.
 *  - NO_INTERPRETER         : no well-known PowerShell 7 executable exists on disk.
 *  - SPAWN_DENIED_BY_ENVIRONMENT : at least one candidate exists but the OS refused
 *                            to create the process for EVERY candidate (e.g. EPERM
 *                            from a restricted sandbox / job object). This is an
 *                            environment property; it says nothing about whether
 *                            the binaries themselves are valid.
 *  - INTERPRETER_FAILED     : the interpreter started but exited non-zero.
 *  - INVALID_OUTPUT         : it exited 0 but did not emit a parseable identity.
 *  - IDENTITY_REJECTED      : parseable, but the identity fields failed validation.
 */
export type SessionIdentityFailureReason =
  | "NOT_WINDOWS"
  | "NO_INTERPRETER"
  | "SPAWN_DENIED_BY_ENVIRONMENT"
  | "INTERPRETER_FAILED"
  | "INVALID_OUTPUT"
  | "IDENTITY_REJECTED";

/** Per-candidate outcome. "missing" is decided before any spawn is attempted. */
export type PowerShellCandidateOutcome =
  | "identity-ok"
  /** Process creation was refused by the OS (EPERM/EACCES/ENOENT-at-exec, job object). */
  | "spawn-denied"
  /** Started but failed: non-zero exit, crash, timeout, or unusable output. */
  | "interpreter-failed";

export interface SessionIdentityReadResult {
  ok: boolean;
  /** Present only when ok. */
  identity: Record<string, unknown> | null;
  /** Null when ok. */
  reason: SessionIdentityFailureReason | null;
  /** The interpreter that produced (or attempted) the identity. */
  executable: string | null;
  /** Ordered candidate outcomes for diagnostics; never contains file contents. */
  attempts: Array<{ executable: string; outcome: PowerShellCandidateOutcome | "missing" }>;
}

export function fileExistsForPowerShell(candidate: string): boolean {
  return defaultIsRegularFile(candidate);
}

/** Parse the identity JSON emitted by the fixed script (never throws). */
function parseIdentityPayload(stdout: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function fixedPowerShellArgs(script = WINDOWS_QUERY_SCRIPT): string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Classify a failed execFileSync call. Only genuine process-creation refusals are
 * treated as "spawn denied"; everything else is an interpreter failure so that a
 * later candidate is still tried and the reason stays honest.
 */
function classifySpawnError(error: unknown): PowerShellCandidateOutcome {
  const err = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null; killed?: boolean };
  const code = err?.code;
  if (code === "EPERM" || code === "EACCES" || code === "ENOEXEC" || code === "EFTYPE") return "spawn-denied";
  // A killed child (timeout) produced no identity but the binary did run.
  if (err?.killed || err?.signal) return "interpreter-failed";
  // Non-zero exit is an interpreter failure, not a transport refusal.
  if (typeof err?.status === "number") return "interpreter-failed";
  return "interpreter-failed";
}

function runPowerShell(
  executable: string,
  script: string
): { outcome: "ok"; stdout: string } | { outcome: PowerShellCandidateOutcome } {
  try {
    const stdout = execFileSync(executable, fixedPowerShellArgs(script), {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
      encoding: "utf8",
    });
    return { outcome: "ok", stdout };
  } catch (error) {
    return { outcome: classifySpawnError(error) };
  }
}


/** Ordered, cached per-interpreter identity outcome. */
const candidateOutcomes = new Map<string, PowerShellCandidateOutcome>();

/**
 * Read the Windows logon identity together with an explicit failure reason.
 *
 * A candidate is only rejected permanently for the two reasons that justify it:
 * it does not exist on disk, or it started and failed. A spawn refusal is
 * environment-wide, so it is recorded and the next candidate is tried; if every
 * existing candidate was refused, the reason is SPAWN_DENIED_BY_ENVIRONMENT
 * rather than "no PowerShell", and nothing is cached as a property of the binary.
 */
export function readWindowsSessionIdentitySyncDetailed(): SessionIdentityReadResult {
  const empty = (reason: SessionIdentityFailureReason, attempts: SessionIdentityReadResult["attempts"] = []) =>
    ({ ok: false, identity: null, reason, executable: null, attempts }) as SessionIdentityReadResult;

  if (process.platform !== "win32") return empty("NOT_WINDOWS");

  const candidates = fixedPowerShellCandidates();
  const attempts: SessionIdentityReadResult["attempts"] = [];
  if (candidates.length === 0) return empty("NO_INTERPRETER", attempts);

  let spawnDenied = 0;
  let lastReason: SessionIdentityFailureReason = "INTERPRETER_FAILED";
  let lastExecutable: string | null = null;

  for (const executable of candidates) {
    const key = process.platform === "win32" ? executable.toLowerCase() : executable;
    const cached = candidateOutcomes.get(key);
    if (cached === "interpreter-failed") {
      attempts.push({ executable, outcome: "interpreter-failed" });
      lastExecutable = executable;
      continue;
    }
    lastExecutable = executable;
    const run = runPowerShell(executable, WINDOWS_SESSION_IDENTITY_SCRIPT);
    if (run.outcome !== "ok") {
      attempts.push({ executable, outcome: run.outcome });
      // Do not cache a transport refusal as a property of this binary.
      if (run.outcome === "interpreter-failed") candidateOutcomes.set(key, "interpreter-failed");
      if (run.outcome === "spawn-denied") spawnDenied += 1;
      lastReason = run.outcome === "spawn-denied" ? "SPAWN_DENIED_BY_ENVIRONMENT" : "INTERPRETER_FAILED";
      continue;
    }
    const parsed = parseIdentityPayload(run.stdout);
    if (parsed === null) {
      attempts.push({ executable, outcome: "interpreter-failed" });
      candidateOutcomes.set(key, "interpreter-failed");
      lastReason = "INVALID_OUTPUT";
      continue;
    }
    attempts.push({ executable, outcome: "identity-ok" });
    return { ok: true, identity: parsed, reason: null, executable, attempts };
  }

  if (spawnDenied > 0 && spawnDenied === attempts.length) return empty("SPAWN_DENIED_BY_ENVIRONMENT", attempts);
  if (spawnDenied > 0) return empty(lastReason, attempts);
  if (lastReason === "INVALID_OUTPUT") return empty("INVALID_OUTPUT", attempts);
  // Preserve the interpreter for diagnostics even on failure.
  const failed = empty(lastReason, attempts);
  return { ...failed, executable: lastExecutable };
}

/**
 * Read the current process's Windows logon identity for local permission checks.
 * This operation is internal and is never registered as an MCP Host Observation tool.
 *
 * Returns null when no legitimate interpreter can produce a verified identity, so
 * every caller fails closed instead of guessing. Use the Detailed variant when a
 * caller needs to distinguish "no PowerShell" from "PowerShell refused".
 */
export function readWindowsSessionIdentitySync(): unknown | null {
  return readWindowsSessionIdentitySyncDetailed().identity;
}

/**
 * Resolve an interpreter for the generic observation query. A plain regular-file
 * check is sufficient here: the query itself reports a fixed SYSTEM_QUERY_FAILED
 * error when the interpreter cannot start, and observation must not pay for an
 * identity probe round-trip on every call.
 */
function observationPowerShellExecutable(): string | undefined {
  return fixedPowerShellCandidates()[0];
}

export function runWindowsQuery(operation: "context" | "processes" | "listeners" | "network" | "metadata", data: object = {}): Promise<any> {
  if (process.platform !== "win32") return Promise.reject(new ObservationError("NOT_SUPPORTED", "Host Observation V1 requires Windows"));
  const executable = observationPowerShellExecutable();
  if (!executable) return Promise.reject(new ObservationError("NOT_SUPPORTED", "PowerShell 7 is required for fixed Windows queries"));
  if (active >= 4) return Promise.reject(new ObservationError("QUERY_BUSY", "Host query concurrency limit reached"));
  active++;
  return new Promise((resolve, reject) => {
    const child = execFile(executable, fixedPowerShellArgs(),
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      active--;
      // Never return stderr/errors containing raw process data or paths to callers/logs.
      if (error) { reject(new ObservationError(error.killed ? "TIMEOUT" : "SYSTEM_QUERY_FAILED", "Fixed Windows observation query failed")); return; }
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ""))); }
      catch { reject(new ObservationError("SYSTEM_QUERY_FAILED", "Invalid Windows observation response")); }
    });
    child.stdin?.on("error", () => { /* execFile callback maps startup/exit errors */ });
    child.stdin?.end(JSON.stringify({ ...data, operation }));
  });
}
export const windowsProvider: ObservationProvider = {
  context: () => runWindowsQuery("context", { hostPid: process.pid }),
  processes: (filter?: Pick<QueryInput, "pid" | "parentPid" | "name">) => runWindowsQuery("processes", filter),
  listeners: (filter: ListenerInput) => runWindowsQuery("listeners", filter),
  network: () => runWindowsQuery("network"),
  metadata: (absolutePath: string) => runWindowsQuery("metadata", { path: absolutePath }),
};
