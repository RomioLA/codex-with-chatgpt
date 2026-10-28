# C2C Local 运维与故障决策

此参考说明指定最终源码的实际命令与副作用。它不授权额外部署、重启、Host Run 修改、
权限提升、配对或浏览器操作；执行已获用户授权的步骤即可。

路由合同：**Codex 本机优先 Native Tools；ChatGPT 网页端访问本机优先 C2C Local。** Remote 是独立 fallback，不是 C2C 恢复的强制前置步骤。

## 当前 V1.5 授权与工具路由

通用命令执行使用 `execution_run`：需有效 Level2 Full Access、execution.run OAuth scope 和用户任务授权；**无需 Level3 或旧式 trusted-command recipe 预注册**。本参考文档以下 `execution_start` / `COMMAND_NOT_APPROVED` 说明只针对**历史受限 recipe 路径**，不要对通用执行套用。

Level2 不是永久 baseline，而是绑定当前 Windows 登录会话的 session grant。
真实 authority 在正在运行的 Bridge：本机切换优先使用最终 Launcher，低层 CLI 使用
`permission bridge status|1|2`。不要只信调用 CLI 进程自己的本地回显；至少回读 Bridge
`effectiveMode`。Web/MCP 不得自行签发 Level2。手动降回 Level1/revoke、注销或重启应使旧
session grant 失效；若 logout/reboot 尚未真机验收，应标 PENDING。

## 受控 Git 与 execution

`execution_start` 不接受任意 command、shell、executable、cwd、环境变量或自由参数；它只运行
本机 trusted-command registry 中已批准的固定 package script recipe。对应的 repository、recipe kind
或 target 未获本机批准时，`COMMAND_NOT_APPROVED` 表示 `execution.run` 请求已经到达 C2C，
但匹配的 trusted-command approval 不存在。不要建议通过 Level 3 或 Remote 绕过。

`execution_status`、`execution_list`、`execution_job_output` 和 `execution_cancel` 分别用于 job
状态、列表、清理后的输出及取消；它们受各自 OAuth scope、job ownership 和本机 execution 状态约束。

Stage 1 已改变结构化 Git Write 授权合同：有效 Level2 Full Access 加上正确 OAuth scope、用户任务授权和该操作支持的 identity/expected-state 校验后，不再无条件要求独立 Repository Approval。Level1 仍保留 Repository Approval。不要把 V1.5 之前的 Git approval 说明或历史 `NOT_APPROVED` 样例当成当前通用合同；按实际工具结果及当前部署版本判断。若当前 Level1 的 Git policy 返回 `NOT_APPROVED`，表示请求已到达 C2C 并被策略拒绝，不是 OAuth 或传输故障；不得通过 `execution_run`、Remote 或提权绕过。

Level 3 默认关闭。`LEVEL3_DISABLED` 表示 `execution.level3` 请求已经到达 C2C，但本机 Level 3 capability
当前关闭；它不是 OAuth scope 不足、MCP 网络错误或 ChatGPT 安全层拦截。只有本机用户明确选择开启后，
本机才执行：

```text
c2c level3 enable -w <workspace> --approve --json
```

ChatGPT/MCP 不得自行执行该 enable 来给自己提权。enable 只允许创建 Level 3 pending request，不会执行
命令。每项 request 仍须由本机操作者 inspect、核对精确 command digest、按风险分类并 approve；之后 MCP
方可调用 `level3_start`。Level 3 不等于永久或 unrestricted shell。

## 故障分类

先根据错误判断请求到达了哪一层；不要将这些信号一概处理成 OAuth reconnect。

| 信号 | 含义与处理 |
|---|---|
| `INSUFFICIENT_SCOPE` | OAuth token 缺少该工具要求的 scope。检查实际 token authority；正式 ChatGPT 重新授权可展示当前完整 `SUPPORTED_SCOPES`，其他 client 仍是精确 requested-scope。旧 grant 不会靠 refresh 增加 scope。 |
| `LOCAL_PERMISSION_DENIED` | 请求已到 C2C，但本机 `readonly/level1/level2` 文件 permission mode 拒绝该文件操作。与 OAuth scope 独立。 |
| `NOT_APPROVED` | 若当前 Level1 Git policy 返回此错误，表示 Git 请求已到 C2C 但 approval 缺失；不是 OAuth 或 transport 错误。Stage 1 有效 Level2 路径不应无条件要求独立 Repository Approval。 |
| `COMMAND_NOT_APPROVED` | bounded execution 请求已到 C2C，但本机 trusted-command registry 中没有匹配 repository/kind/target recipe。不要用 Level 3 或 Remote 绕开。 |
| `LEVEL3_DISABLED` | `execution.level3` 请求已到 C2C，但本机 Level 3 未开启。只有本机用户可以显式 enable。 |
| Level 3 request pending / not approved | 精确命令仍在等待本机 inspect、digest 核对、风险分类与 approve；尚未获准运行。 |
| ChatGPT platform/tool invocation rejection | 请求未到达 C2C。检查平台侧 connector/tool invocation 状态；不要将其归类为上表中的 C2C policy 错误。 |
| MCP `-32603` / network / connector unavailable | 只说明本次调用/连接失败，不能单独证明 Bridge 已退出。区分平台调用拒绝（请求未到 C2C）、Bridge 停止、Bridge 无响应或身份不明、Tunnel 连通性与 connector 状态；只有确认 C2C 不可用才进入离线恢复。 |

正式 ChatGPT OAuth 授权的 scope 扩展只适用于已注册 `clientName === "ChatGPT"` 且 redirect hostname 为
`chatgpt.com` 的请求，并在签发 authorization code 前展示 `SUPPORTED_SCOPES`。其他 client 不自动扩权。
旧 token/refresh grant 不会自动获得新 scope；使用实际工具调用结果判定当前权限，不因一个工具失败循环
触发 reconnect。OAuth scope 与本机 workspace permission、Git policy、trusted-command registry、Level 3
审批是独立门槛。

## 本机命令

CLI 必须来自**已独立核验的正式 Runtime**，不能仅凭 PATH、源码目录的 `bin/c2c.js`、版本字符串、目录名或聊天中的历史 SHA/PID 判断 authority。公开 CLI 当前没有通用 Runtime 安装根目录 discovery 命令。已有 Launcher 的定位能力只适用于它绑定的安装/workspace；Windows Task Scheduler 的实际 Action/WorkingDirectory、workspace registration、正式安装交接记录和 Launcher 的路径校验可作为本机证据来源，但 state 路径或任务存在本身不证明 Runtime 权威身份。

示例使用下列由本机操作者**事先赋值并确认**的 PowerShell 变量：

~~~powershell
$c2cNode = 'C:\absolute\path\to\verified-runtime\node\node.exe'
$c2cCli  = 'C:\absolute\path\to\same-runtime\bin\c2c.js'
$targetWorkspace = 'C:\your\actual\workspace'
& $c2cNode $c2cCli status -w $targetWorkspace --json
& $c2cNode $c2cCli permission status -w $targetWorkspace --json
& $c2cNode $c2cCli permission bridge status -w $targetWorkspace --json
& $c2cNode $c2cCli autostart status -w $targetWorkspace --json
& $c2cNode $c2cCli restore -w $targetWorkspace --json
~~~

`status`、`permission bridge status` 与 `autostart status` 用于现状检查；其中
`permission bridge status` 读取正在运行 Bridge 的 effective authority，比单独的控制端回显
更接近最终 enforcement point。`permission status` 不属于无副作用预检：它可能获取写锁、创建
permissions 目录、迁移 legacy 权限文件并写入 Level1 baseline。`restore` 是实际恢复动作。
不要默认使用个人电脑固定路径。

### C2C 完全离线时的恢复路径

MCP 工具全部不可用时，本机 Codex 可独立恢复，不必先在线调用 C2C，也不强制依赖 Remote。只读检查已有正式 Launcher、Windows 计划任务 Action/WorkingDirectory 或可信安装交接记录；用 `Get-ScheduledTask` 查看少量匹配任务的实际 Action。核对目标 workspace path/ID、Task Action 参数、其 base64url JSON payload 中的 state root、Node、CLI、工作目录属于同一 Runtime，并符合正式安装记录/受保护路径规则。需要时只解码选定 Task 的最后一个参数以读取 workspace/state，不执行 Action/CLI。文件缺失、跨 Runtime、workspace/state 不匹配、reparse point 或身份含糊时停止，报告缺少的证据并请本机维护者提供可信安装记录或按正式安装流程修复。

仓库内 `tools/c2c-local-launcher.zh-CN.ps1 -Action Check` 会按它绑定的 workspace 检查计划任务指向的 Runtime 布局并报告 Runtime 标识；此 Launcher 的用途是 Permission/Pair/Check，不是通用 restore 入口。它依赖该 Launcher 自己的 workspace/task 配置；不要将固定 Launcher、测试专用 `C2C_LAUNCHER_RUNTIME_ROOT` seam 或任意 Task/目录推广为 authority。`C2C_STATE_DIR` 只确定 state root，不证明 Runtime 身份；`node --version`、CLI 版本字符串、PATH 命中也不够。

只有本机可信安装/Launcher 记录确认 Runtime、workspace 与 state root 对应后，才用同一 Runtime 执行 `status -w <workspace> --json` 进行只读预检。核对 `diagnostics.workspace.id`、Bridge observation `diagnostics.bridge.status`，以及 Bridge 运行时顶层 `workspaceId`、`pid`、`port` 与 `diagnostics.bridge.pid/port` 的一致性；状态为 `uncertain`、顶层 `state` 为 `unknown` 或身份不一致时停止。只有状态表明确需恢复时，才单独显式执行 `restore -w <workspace> --json`。标准 PowerShell 预检示例仅保留在 `SKILL.md`，避免同一恢复脚本在多处漂移。

`status --json` 是当前只读诊断，不触发权限迁移。离线恢复预检不要调用 `permission status`：虽然名字是 status，它可能获取写锁、创建 permissions 目录、迁移 legacy 权限文件并写入 Level1 baseline。

示意变量必须由上述本机只读证据赋值，不可直接复制猜测路径或试跑候选 CLI。如果未找到匹配 Task/Launcher/安装记录，或现有证据不足以证明 Runtime、workspace、state root、Node 与 CLI 的关联，下一步是向本机维护者核实/恢复正式安装；不得盲跑 PATH/source CLI、改任务或权限、删除 state、重新 OAuth/Pairing 或修改 Tunnel。Remote 是可独立选择的 fallback，不得绕过当前执行环境的拒绝。

Stage 2 当前源码变更不等于已部署。要使用新能力，必须能从本机 Runtime/安装证据确认部署版本；不以 GitHub commit、仓库 Skill 或版本字符串单独宣称已可用。

### 状态检查与自动修复边界

`status -w <workspace> --json` 是只读状态入口；`restore` 是明确恢复动作。`doctor` 默认是 auto-repair，JSON `repairMode` / `repairEffects` 与文本说明会标出副作用：它可更新 Codex sandbox allowlist、启动或重启 Bridge、启动明确停止的 Named Tunnel（Quick Tunnel 按既有健康门槛处理）、写 endpoint metadata。`doctor --no-fix` 是只读诊断，不启动/重启 Bridge 或 Tunnel，也不写 endpoint metadata 或 allowlist。Named Tunnel 的状态、provider、hostname、processRunning/connected 均确认且 public `/health` 单独 degraded 时，doctor 保持连接且不重启；unknown/disconnected 不启动。恢复不得更改权限、OAuth、Pairing、connector 或自动重放未知副作用 Job/Task。

需要由本机用户切换 Level2 时，优先使用最终 Launcher；维护/自动化场景在用户已明确授权后才运行：

~~~powershell
& $c2cNode $c2cCli permission bridge 2 -w $targetWorkspace --json
# 完成需要 Full Access 的工作后，如需恢复默认：
& $c2cNode $c2cCli permission bridge 1 -w $targetWorkspace --json
~~~

切换后回读 `permission bridge status`，并在远程侧用 `permission_status` / 实际工具调用验证。
不要使用旧式仅绑定调用 CLI 进程身份的结果冒充 Bridge 已生效，也不要让 Web/MCP 自行提权。
明确需要启用、禁用自启或列出所有注册工作区时：

~~~powershell
& $c2cNode $c2cCli autostart enable -w $targetWorkspace --json
& $c2cNode $c2cCli autostart disable -w $targetWorkspace --json
& $c2cNode $c2cCli autostart list --json
~~~

状态查询与 restore 的边界见上文；`status` 的 `ok` 是 recovery 是否
healthy，不是“进程存在”；CLI exit 0 本身不证明 ready。`permission status` 可能为
legacy 权限执行迁移并写入 Level1 baseline，不应作为离线恢复只读预检。
`autostart status` 返回 `enabled`、`backend`、`backendInstalled`、`registrationState`、
`workspaceExists` 和可选最近结果；不要把可选 lastRunStatus 当作此刻健康。

enable/disable 会修改本机 authority，不是日常诊断。`autostart list` 是该 state root 的
全局列表，不加 `-w`。disable 尝试 Task、Host Run、legacy 和 launcher；清理失败报错并
保留 registration 供重试，不宣称已完成。未知/不支持的 Run 值类型会 fail closed。
禁用登录启动不等同于停止此刻 Bridge，不自动附加 stop/unpair。
隐藏 `autostart restore --workspace-id ... --workspace ...` 是 launcher 的验证入口，
不拿聊天里的旧 ID 手工调用；一般恢复使用公开的 `restore -w`。

`state migrate --from` 是显式一次性迁移，不按 workspace 执行，不添加 `-w`。
只迁移认可的 durable JSON，排除 runtime/logs/sessions/executions，冲突不覆盖；失败时
身份核验回滚可能因外部竞态而无法完全恢复。迁移 CLI 在提交后还会尝试修改 Codex config
的 writable_roots；该更新失败时仍报告 MIGRATION_COMMITTED 和 sandbox warning，不回滚
已经提交的迁移。它不是仅复制文件的命令。不要自动迁移、直接复制全部旧 state，或把
当前运行的 Bridge 切到另一 state root。`sandbox-allow` 会修改本机 Codex config；
权限模式、OAuth scope、Codex sandbox permission profile 是三件不同的事，不互相替代。
不要求 danger-full-access 或 approval_policy=never；既有 restricted workspace、
on-request 与 auto_review 部署约束保持独立。

## 故障决策树

先分清“远程不能访问”“本机运行时不健康”和“某个文件操作被拒绝”，不要一律 restart。

| 真实信号 | 判断与下一步 |
|---|---|
| `workspace_info` 根路径/ID 与目标不符 | 停止该 connector 的操作；选择对应 workspace 的 connector，并重新读取 identity/permission；不统一 workspace=codex |
| 本机 CLI 与 MCP 的 workspaceId/mode 不一致 | 先核对 Windows 用户、有效 state root、显式 `-w`、connector identity，并用 `permission bridge status` 读取运行中 Bridge authority；不要提升权限、删除权限文件或重启来掩盖错误 |
| `LOCAL_PERMISSION_DENIED` | 回读 permission_status，解释本机文件模式限制；仅在用户明确选择后由本机改变模式；不能远程提权 |
| `INSUFFICIENT_SCOPE` | OAuth scope 门槛拒绝；检查当前 token authority。不要将其与本机 policy 拒绝混淆，也不要因单次失败循环 reconnect |
| `NOT_APPROVED` | 当前 Level1 Git policy 返回此拒绝时，表示请求已到 C2C 但尚无匹配 approval；不是 OAuth/transport 错误。Stage 1 有效 Level2 路径不应无条件要求独立 Repository Approval。 |
| `COMMAND_NOT_APPROVED` | execution 请求已到达 C2C，但 trusted-command recipe 未批准；不得通过 Level 3 或 Remote 绕过 |
| `LEVEL3_DISABLED` | Level 3 请求已到达 C2C，但本机 capability 关闭；仅本机用户可显式开启 |
| Level 3 pending / not approved | 等待本机逐条 inspect、核对精确 digest、风险分类与 approve；此时命令尚未获准启动 |
| ChatGPT platform/tool invocation rejection | 请求尚未到达 C2C；按平台/connector 调用状态排查，不归因于 C2C policy |
| MCP `-32603` / network / connector unavailable | 单次调用失败不能证明 Bridge 已退出。区分平台拒绝（请求未到 C2C）、Bridge 停止/无响应或身份不明、Tunnel 连通性及 connector 状态；与 OAuth、本机权限和 Git policy 拒绝分开定位 |
| `STALE_FILE` / `AMBIGUOUS_EDIT` / 目标已存在 | 重读内容和完整 hash，重新评估修改或明确匹配范围；不取消 hash 校验、不覆盖用户新内容 |
| `AUDIT_FAILED` 且 `details.operationApplied=true` | 文件操作已执行，但审计写入失败；先回读目标/源的实际状态并报告，不因错误响应自动重做修改、移动或删除 |
| 越界、敏感文件、external delete/move | 尊重源码拒绝；不改 override、借 shell 或另一个 connector 绕过限制 |
| `diagnostics.bridge.status=uncertain` 或 `bridgeUncertain` | 状态未知不是进程已死；收集窄范围身份/启动证据；不另起 Bridge/Tunnel、不按 PID 杀进程、不删锁 |
| Bridge 已确认 stopped，用户要求恢复 | 显式 `restore -w ... --json` 一次；它会 reuse 或启动同 workspace 实例。恢复后看 result.ok、diagnostics 和实际 connector 工具调用 |
| Named startup `retrying` 且属于 DNS/network transient | 让既有恢复调用完成有限预算；不叠加手工 retry/重启。没有待进行调用时才按用户授权尝试一次 restore |
| Named child 存在但未 connected、`namedStateUnverified`、`termination_unconfirmed` | 不能证明停止；停止自动 spawn，定位进程退出/启动参数与连接证据，不运行多个 Tunnel |
| `cloudflaredMissing` | 定位真实 binary/实际启动环境；安装或修复依赖须在任务授权范围内，不回退 Quick 来掩盖 Named 配置 |
| `needsCloudflareLogin` / `credentialsMissing` / `namedCredentialsInvalid` / `namedConfigurationMissing` | 先检查真实凭据/配置错误；只有 source reason 指向登录且用户授权时才登录。invalid/config/unknown 是 hard fail，不因 timeout 或 self-probe 随意做 OAuth/Cloudflare login |
| `namedRuntimeMismatch` / `quickRuntimeMismatch` | 记录 workspace/runtime/provider/URL 的不一致位置；不自动切换 Tunnel preference、删除 connector 或复制状态文件 |
| Named runtime/connected/endpoint 一致且 recovery=healthy，仅 publicProbe=degraded | 诊断退化，保持健康运行时；实际测试 ChatGPT 的 workspace_info/permission_status/授权读工具。不能仅因 ECONNRESET 重启或将正式 restore 判失败 |
| Named status/restore healthy，但 doctor exit 1、namedRepair.needed | 检查是否只是 doctor 旧 self-probe 分支；按正式 diagnostics 和实际业务调用判断，不套用旧全绿 gate |
| `connectorEndpointMissing` / `connectorEndpointChanged` | 本地保存的 endpoint 不能证明网页设置；核对对应 workspace 的实际 connector，仅在明确设置/修复授权下更新。Named 不随意重建，Quick 地址变化需要独立处理 |
| Quick public health 失败 | Quick 是独立 hard health 门槛；已授权的 restore 可 start/restart。URL 变化可能需要用户更新对应 connector；不得借 Named diagnostic-only 放行 |
| 真实 connector 401/授权失败 | 这是独立业务证据；区分 token/scopes/audience、网页绑定与本机权限。经授权修复实际授权，不以本机 public probe 或 tokenCount>0 代替验证 |
| `registrationState=transition_pending/authority_conflict/task_missing` | 先读取该 workspace 的真实 authority/registration/launcher；明确需要修复时调用正式 enable 进行事务协调并回读，不手改 HKCU 或 pendingBackend |
| `workspace_missing/not_registered` | 不创建空目录或伪造 registration；核对用户预期根路径，明确注册/迁移需求后再操作 |

`restartSafeConnector=true` 只表示已配置 Named endpoint 的稳定性，不证明连接、OAuth、
scope、权限或网页工具调用成功。`connectorEndpointHealthy` 是本机 self-probe 派生结果，
degraded 不独自构成 Named hard failure；`connectorEndpointMatchesCurrent=false` 则是
独立配置问题。不同 reason 不混为自探针退化。

## 启动取证和验证边界

排查自然登录启动时，先确认三件事：加载了哪个 state/registration/launcher/源码版本，
目标启动动作是否执行，失败位于 Run、CMD、Node、restore、Bridge、Tunnel 还是业务调用。
通过当前 autostart status、正式 launch breadcrumb 和窄范围日志获取证据；所需 ID、
PID、时间、路径由本次运行读取，不把具体值写进 Skill。
breadcrumb 是 best-effort 阶段证据，写失败不改变 restore；缺日志不独自证明没启动。
Runtime PID 存在仅能阻止重复实例，不能证明 PID 归属；使用正式身份核验和受保护的
admin 通道，不能按旧记录向进程发 signal。

修改外部配置前保留单文件回退点，修改后回读并说明是否需要刷新/重启。Skill 文档变化
不需要重启 production。只有改运行时或明确验证登录启动的授权才重新注册/重启/重启机器。
不要主动执行 GUI、录制、截图点击或长时间交互验证；确需 UI 验证先说明必要性和额度，
等待用户同意。浏览器自动化按当前用户约束 attach 现有 127.0.0.1:9222，连接失败停止；
不沿用旧 Skill 的内置浏览器强制规则，不擅自启动新 Chrome/profile。
读取日志先窄过滤并限制输出；验证资产留在调查区，不能成为正式 Skill 的路径 authority。
