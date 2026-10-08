# C2C-LOCAL-V1_1-HOST-OBSERVATION-V1-IMPLEMENTATION-01 验收

验收日期：2026-10-08（Asia/Taipei）。所有改动保留在未提交工作区。

```text
RESULT=READY_FOR_COMMIT
BRANCH=codex/c2c-local-v1_1-host-observation-v1
BASE_HEAD=23b07065b809434699e57a06064c80b050d12d25
FINAL_WORKTREE_HEAD=23b07065b809434699e57a06064c80b050d12d25
SPIKE_RESULT=PASS
HOST_CONTEXT=PASS
PROCESS_QUERY=PASS
PROCESS_TREE=PASS
NETWORK_LISTENERS=PASS
NETWORK_STATUS=PASS
DNS_RESOLVE=PASS
PATH_INSPECT=PASS
SYSTEM_READ_SCOPE=PASS
LEGACY_DEFAULT_SCOPE_UNCHANGED=YES
ARBITRARY_SHELL_EXPOSED=NO
COMMAND_LINE_REDACTION=PASS
SENSITIVE_PATH_POLICY=PASS
EVIDENCE_QUALITY_MODEL=PASS
WINDOWS_REAL_SMOKE=PASS
TARGETED_TESTS=PASS
FULL_RELEVANT_TESTS=PASS
FULL_SUITE=PASS
TYPECHECK=PASS
BUILD=PASS
V1_REGRESSION=PASS
DOCS_ALIGNED=PASS
SKILL_ALIGNED=PASS
PRODUCTION_MODIFIED=NO
PRODUCTION_SYSTEM_READ_ACTIVATED=NO
READY_FOR_COMMIT=YES
READY_FOR_PRODUCTION_ACTIVATION=YES
RECOMMENDED_NEXT_ACTION=用户确认后提交；生产部署与Connector重新授权另行明确授权
```

READY_FOR_PRODUCTION_ACTIVATION 表示源码与本机验收已具备进入独立启用流程的条件，
不表示运行中的 Connector 已能调用工具。没有 commit、push、tag、merge、重启、re-OAuth、
pairing、权限变更或生产 state root 切换。只构建源码输出并同步已授权的本机 Skill 说明。

## 验收清单

| Gate | 证据 |
|---|---|
| 基线与分支 | 开始时 branch/HEAD/status 与任务基线完全一致，staged/unstaged/untracked 均为空；建立独立 codex 分支，HEAD 未变 |
| Primitive spike | 非管理员 Host 上 CIM、网络、DNS、SID/session/package、owner/ACL、Node dev/ino 均可用，没有触发 STOP |
| 新工具与权限 | 7 个 strict 输入 schema；每次调用独立要求 system.read；未认证本机 transport 同样拒绝 |
| Host 全部测试 | 4 个文件、63 项通过；覆盖 scope gate、过滤/上限、PID reuse、失联/截断快照、DNS、路径、句柄身份绑定、脱敏和固定内部传输 |
| OAuth | 2 个文件、75 项通过；显式授权、未知 scope 过滤、consent label、旧默认授权、refresh 不增权 |
| 全相关回归 | 全套结果包含 14 个相关文件，372 项通过、5 项既有跳过；真实 OAuth→MCP→readonly/level2 门禁与文件安全矩阵通过 |
| 全套 | pnpm test --maxWorkers=2：43 个文件通过，712 passed / 6 既有 skipped，718 total；exit 0 |
| 类型与构建 | pnpm typecheck、pnpm build 均 exit 0 |
| Windows smoke | pnpm exec tsx scripts/host-observation-smoke.ts：7 个工具全部验证通过；同一 HANDLE 元数据实现已实测 |
| 文档与技能 | README 中英文、架构/安全/协议/排障、工具合约同步；仓库与已安装 Skill validator 均通过、安装文件 hash 回读一致 |

全套运行记录保留在 `.tooling/host-smoke/`。首次高并发全套遇到两项既有 MCP/Git 测试
ECONNRESET；首次限制并发重跑遇到 OAuth 测试的随机端口被 fetch 判为 bad port，失败发生在
首次请求、授权逻辑之前；另一次 Git 测试未结束，停止了已确认的隔离 Vitest 进程。
最终实时日志运行完整通过。没有修改 timeout、增加 skip、删除或放宽安全断言。

## 实际修改文件

正式仓库路径均相对于 `C:\codex\codex-with-chatgpt`：

- `src/host-observation/types.ts`
- `src/host-observation/windows.ts`
- `src/host-observation/process.ts`
- `src/host-observation/network.ts`
- `src/host-observation/filesystem.ts`
- `src/host-observation/redaction.ts`
- `src/host-observation/service.ts`
- `src/mcp/host-observation-tools.ts`
- `src/mcp/server.ts`
- `src/auth/store.ts`
- `src/auth/oauth.ts`
- `tests/host-observation.test.ts`
- `tests/host-mcp.test.ts`
- `tests/host-windows-runner.test.ts`
- `tests/host-redaction.test.ts`
- `tests/auth-scopes.test.ts`
- `tests/oauth.test.ts`
- `tests/mcp-integration.test.ts`
- `tests/write-security-integration.test.ts`
- `scripts/host-observation-smoke.ts`
- `README.md`
- `README.zh-CN.md`
- `docs/architecture.md`
- `docs/security.md`
- `docs/protocol.md`
- `docs/troubleshooting.md`
- `docs/host-observation.md`
- `docs/host-observation-spike.md`
- `docs/host-observation-acceptance.md`
- `skills/c2c-local/SKILL.md`
- `skills/c2c-local/references/operations.md`（保留原技能依赖）
- `skills/c2c-local/references/host-observation.md`

另外已同步安装目录的 `SKILL.md` 和新增 `references/host-observation.md`，目录为
`C:\Users\Administrator.DESKTOP-NS4I6RF\.codex\skills\c2c-local`。
原 SKILL.md 的单文件回退点位于 `.tooling/host-smoke/c2c-local-SKILL.before.md`；
已安装的 `references/operations.md` 未覆盖。构建产物、隔离 fixture 与日志在忽略目录内。

## 7 个工具的最终 schema 摘要

所有输入拒绝未知字段，所有返回都是只读 structuredContent，并带 capturedAt。

| Tool | 输入 | 输出要点 |
|---|---|---|
| host_context | `{}` | platform/version/architecture、Node Host PID、userName/SID/session/elevation/package、effectiveStateRoot、fieldStatus/unavailableFields |
| process_query | pid/name/parentPid/exePath/commandContains/sessionId 至少一个；limit 默认50，最大200 | processes：PID/parent/name/exe/脱敏命令行/session/startTime/processKey/fieldStatus；partial/truncated/processExited |
| process_tree | pid；direction 默认both，可 ancestors/children；depth 默认4、最大8；limit 默认50、最大100；可选 processKey | nodes、depth/relation、issues、partial/truncated/missingParent/processExited；stale identity 拒绝 |
| network_listeners | 可选pid/port(1–65535)/protocol(tcp或udp)/address；limit 默认50、最大200 | listener地址/端口/PID/state、尽力进程名/key、associationStatus、partial/truncated/fieldStatus |
| network_status | `{}` | adapters/status/addresses、defaultRoutePresent、dnsServers、internetReachable=null、fieldStatus/partial/truncated |
| dns_resolve | hostname：ASCII DNS名称，1–253字符；拒绝IP、URL、scheme/path/port/shell语法 | hostname、addresses、resolver、error分类、partial；专用resolver可取消，5秒总期限 |
| path_inspect | path：1–32767字符，本机盘符绝对路径或workspace-relative | lexical/canonical路径、exist/type/size、owner SID/ACL摘要、属性、file/volume ID、hardlinks、entry身份、reparse信息、时间、fieldStatus |

PID 类数字范围 0–2³²−1；过滤文本 1–1024 字符且拒绝控制字符。内部进程快照上限4096；
network_status 最多64个适配器、每个32个地址、64个DNS服务器。每个固定 Windows 查询
15秒、4MiB输出上限，同时最多4个查询；组合工具可能执行两次查询。

## system.read 的 OAuth 语义

SUPPORTED_SCOPES 新增 system.read；DEFAULT_SCOPES 仍为 workspace.read、workspace.search、
git.read、execution.read、offline_access。只有明确请求和授权才获得 system.read，refresh
只继承已存 scopes。授权页面标签为 “Read limited host system diagnostics”，不计入 mutation。
readonly + system.read 可观测；level2 无 system.read 仍拒绝；system.read 不授予任何文件写权限。

## Windows primitives 实现来源

- Host：Node os/process/getStateDir；目标 Node HANDLE 的 OpenProcess、OpenProcessToken、
  GetTokenInformation(TokenElevation)、WindowsIdentity、GetPackageFullName；目标PID Get-Process session。
- Process：固定 Get-CimInstance Win32_Process；Node 归一化、脱敏、匹配与树构造。
- Network：固定 Get-NetTCPConnection Listen、Get-NetUDPEndpoint、Get-NetAdapter、
  Get-NetIPAddress、Get-NetRoute、Get-DnsClientServerAddress。
- DNS：Node 内置 c-ares Resolver 的 resolve4/resolve6；仅DNS，不是HTTP/TCP客户端。
- Metadata：Node native BigInt stat/lstat/realpath；固定 CreateFile HANDLE 上的
  GetFileInformationByHandle 与 GetSecurityInfo；RawSecurityDescriptor 只返回 owner SID/ACL计数摘要。
- Runtime：固定 PS7 executable 候选（ProgramFiles 安装版或现有 Codex bundled runtime），
  execFile、固定 EncodedCommand、JSON stdin。没有依赖下载、native addon、任意命令/脚本接口。

## partial / access-denied 限制

- 进程不是原子快照。空字段原因不确定时为 UNAVAILABLE，不猜 ACCESS_DENIED。
  processKey 依赖 startTime；没有可验证时间的父子边不猜测；缺席且快照截断时 processExited=null。
- 命令行先脱敏、再限制为8192字符，commandContains 只匹配安全返回表示；疑似凭据、
  复杂shell载荷和不确定解析可能保守遮蔽更多。
- Listener→process 是分开的快照，标 SNAPSHOT_UNVERIFIED；进程退出/无法关联不丢弃listener。
- 网络地址缺失/访问失败可造成 partial；不做公网HTTP probe，不承诺 Internet readiness。
- .git、密钥、credential/browser secrets、C2C state 与敏感别名均拒绝元数据；不能借此查.git owner。
  UNC/device/ADS 不支持。reparseTag 为 NOT_SUPPORTED；其他非symlink/junction reparse target 也不支持。
- ACL 无 READ_CONTROL 可保留已验证句柄身份/属性，owner/ACL为null + ACCESS_DENIED。
  nullDacl 只表示 RawSecurityDescriptor.DiscretionaryAcl 为null，未区分缺失和显式null DACL。
- 当前实机验证了非提权、unpackaged Host；实际 packaged Host 仍按目标 Node HANDLE 查询，
  package 字段不改变 Registry/state authority。

## 安全审查结论

PASS。无远程任意shell、启动/终止进程、registry、服务、任务调度 mutation 或环境全集接口。
所有7个工具都fail-closed；默认scope与文件模式未变。远程字段只作为固定查询的数据，
不插入script/argv/WQL。原始CIM命令行仅在本地私有管道出现，统一脱敏后返回；
stderr/通用异常不反射、不记录凭据。脱敏覆盖CLI/env/query/fragment、重复编码、
Cookie/Bearer、URI userinfo及不透明shell载荷。路径别名与目标经过敏感检查，ACL与属性
在同一句柄读取，身份不匹配或后验路径变化则整条拒绝；这覆盖持久替换及ABA对象替换。

## 实机 smoke 证据

最终 native metadata smoke：2026-10-08 22:17（Asia/Taipei），result=PASS。
当前 Node 非提权、session=1、unpackaged；当前Node processKey/startTime可用，查到一个
cloudflared 样本；真实9节点祖先链到达 Explorer；临时loopback TCP listener与Node PID一致；
11个adapter、默认路由存在、7个DNS配置地址（部分无地址接口标partial）；example.com解析到
2个A和2个AAAA；package.json 的 fileId=844424936342946、volumeId=4082933372 重读稳定，
owner SID和ACL可用，隔离junction与目标具有相同物理身份。未调用生产MCP、改Connector或重启服务。

完整合约见 [Host Observation V1](host-observation.md)，primitive 实测见
[spike记录](host-observation-spike.md)。可重复验证命令：

```powershell
pnpm typecheck
pnpm build
pnpm test --maxWorkers=2
pnpm exec tsx scripts/host-observation-smoke.ts
```
