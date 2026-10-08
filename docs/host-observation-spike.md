# Host Observation V1：Windows primitive spike

日期：2026-10-08
范围：Windows 只读观察原语、身份来源和 `package.json` 文件身份。没有启动 GUI、重启服务、改写生产状态或读取/设置 `C2C_STATE_DIR`；没有输出任何原始进程命令行。

## 结论

**PASS；无 STOP 条件。** 在 host 执行上下文中，CIM、网络、DNS、Node `stat`、ACL 和文件标识查询均成功。该上下文的 token 仍是非提权用户，因此本次覆盖的只读查询不要求管理员 token。受限 sandbox 中 CIM/`Get-Net*` 不可用，不能把该 sandbox 结果当成普通 Windows 用户不可用。

`pwsh` 当前进程的身份不能代表 C2C Node Host。仓库实现通过 `process.pid` 传递 Node Host PID，再对该 PID 的进程句柄读取 token 与包身份；这是正确的观察对象。包身份是观察字段，不参与 state、Registry 或 authority 选择。state 根继续遵循现有 `getStateDir()`：非空 `C2C_STATE_DIR` 覆盖，否则使用 Windows `LOCALAPPDATA\OpenAI\c2c-local`。两种 authority 没有在本 spike 中合并或改动。

## 执行结果

| 观察项 | 来源与结果 | 状态 |
| --- | --- | --- |
| 执行上下文 | PowerShell 7.6.5。sandbox 中 `Get-CimInstance Win32_Process` 和 `Get-Net*` 报 CIM 客户端不可访问；同一用户的 host 执行查询成功。sandbox 与 host 查询的 SID、SessionId、管理员角色和包状态一致；管理员角色均为 `False`。 | 可用；host 查询不需提升 token |
| 进程元数据 | host CIM 查询读取 PID、Name、ExecutablePath、CommandLine 字段存在状态、SessionId、CreationDate、ParentProcessId。`CommandLine` 原文从未打印。受控的 `node.exe` 样本上，进程身份通过目标进程 HANDLE 查询。 | 可用；非原子快照 |
| Node Host 候选 | PID 8988 持有 loopback TCP 48765 listener，与 `docs/architecture.md` 的首选端口一致；目标进程为 `node.exe`，SessionId 1、非提权、`GetPackageFullName(process HANDLE)` 返回 `APP_MODEL_ERROR_NO_PACKAGE`（15700）。这是端口关联证据，不替代 Node Host 自己传入的 `process.pid`。 | 可用；包身份为 unpackaged |
| TCP / UDP | `Get-NetTCPConnection -State Listen` 得到 73 个 TCP listener。UDP endpoint 两次读取为 140 和 135，表明它们是时点快照。输出样本有界。 | 可用；快照可能变化 |
| 活动网络 | `Get-NetAdapter` 观察到 6 个 Up adapter；`Get-NetIPConfiguration` 返回地址、网关和 DNS 配置。`Get-NetRoute` 观察到 1 条 Alive IPv4 默认路由，出口接口为 WLAN。未将本地地址或 MAC 写入本文。 | 可用 |
| DNS | `Resolve-DnsName example.com -Type A -DnsOnly` 成功返回 2 条 A 记录。sandbox 查询曾被拒绝；host 查询成功。 | 可用；只证明系统 DNS 查询成功 |
| `package.json` | `name=codex-with-chatgpt`、`version=0.1.3`、`type=module`、长度 919 bytes、`Archive` 属性。`Get-Acl` 能读取 owner 与 ACL；owner 名称不写入本文，ACL 未保护，0 条显式规则、11 条继承规则。 | 可用 |
| Node 文件身份 | 对 `package.json` 连续两次 `fs.statSync(..., { bigint: true })`，并在两个独立 Node 进程重复，`dev=4082933372`、`ino=844424936342946`、`nlink=1`、`size=919` 均稳定。`dev` 对应 C: NTFS 卷序列号 `F35C9E7C`；`ino` 的十六进制值 `30000005EC5A2` 与 `fsutil file queryfileid` 的文件 ID 低 64 位一致。 | 可用；Node `dev/ino` 可作身份字段 |
| Reparse / junction | `C:\`、`C:\codex`、workspace root、`docs` 和 `package.json` 均无 `ReparsePoint` 属性；`LinkType`/`Target` 为空。未创建 junction。 | 本路径链未发现 junction |

## 固定 API 与数据流

- 进程列表使用固定 PowerShell 7 查询 `Get-CimInstance -ClassName Win32_Process`，按输入过滤并限制结果量。命令行在子进程 JSON stdout 中仅作为本地 Node 子进程管道数据；`HostObservation` 在返回前调用 `normalizeProcess()` / `redactCommandLine()`，且先脱敏再截断。监听器关联也只返回进程名与 process key。MCP handler 只调用 `HostObservation`，错误返回通用消息，不反射 stderr 或原始查询数据。源码链为 `windows.ts` → `service.ts` / `process.ts` → `mcp/host-observation-tools.ts`。
- host 身份应继续对 Node Host PID 使用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`、`OpenProcessToken(TOKEN_QUERY)`、`GetTokenInformation(TokenElevation)`、`WindowsIdentity(token)` 和 `GetPackageFullName(process HANDLE)`，并在 `finally` 关闭句柄。SessionId 可从该 PID 的 `Get-Process`/Process API 读取。`GetCurrentPackageFullName()` 只说明调用它的 PowerShell 进程，不应替代目标 Node Host 的身份。
- 网络查询使用 `Get-NetTCPConnection`、`Get-NetUDPEndpoint`、`Get-NetAdapter`、`Get-NetIPConfiguration`、`Get-NetRoute` 和 `Resolve-DnsName`；返回有限条目、状态和是否截断。DNS 成功只表示解析成功，不代表互联网可达。
- 文件身份使用 Node `fs.statSync` / `fs.lstatSync` 的 BigInt `dev`、`ino`，ACL 使用 `Get-Acl` 的 owner 与规则计数摘要，属性使用 `Get-Item`。当前 `reparseTag` 标为 `NOT_SUPPORTED`；canonical `reparseTarget` 只能在敏感路径策略检查后返回，并需保留异步读取前后的 entry/physical identity 重检。

本 spike 只做原语实测与源码数据流审查，没有运行 GUI、服务重启或测试套件。

## 最终实现验证补充

初始 spike 的 `Get-Acl`/`Get-Item` 验证了普通用户元数据可用性；正式实现随后收紧为
`CreateFile` 同一 HANDLE 上的 `GetFileInformationByHandle` 和 `GetSecurityInfo`，避免按路径
分开打开造成 ABA 替换竞态。句柄身份与查询前的 Node `dev/ino` 比对，不匹配时丢弃全部
元数据。2026-10-08 22:17（Asia/Taipei）的隔离 Windows smoke 验证了这一最终实现：
owner SID、ACL summary、稳定文件身份和 junction 目标身份均通过；未改变生产状态。
