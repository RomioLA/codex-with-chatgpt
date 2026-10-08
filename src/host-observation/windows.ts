import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ObservationError, type ObservationProvider, type QueryInput, type ListenerInput } from "./types.js";

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
export function runWindowsQuery(operation: "context" | "processes" | "listeners" | "network" | "metadata", data: object = {}): Promise<any> {
  if (process.platform !== "win32") return Promise.reject(new ObservationError("NOT_SUPPORTED", "Host Observation V1 requires Windows"));
  // Fixed executable, no PATH/cwd executable resolution or caller-selectable runtime.
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    // Existing Codex Desktop bundled PS7; no download/install and no new dependency.
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe"),
  ];
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) return Promise.reject(new ObservationError("NOT_SUPPORTED", "PowerShell 7 is required for fixed Windows queries"));
  if (active >= 4) return Promise.reject(new ObservationError("QUERY_BUSY", "Host query concurrency limit reached"));
  active++;
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_QUERY_SCRIPT, "utf16le").toString("base64")],
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
