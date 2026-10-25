# C2C Local 运维与故障决策

此参考说明指定最终源码的实际命令与副作用。它不授权额外部署、重启、Host Run 修改、
权限提升、配对或浏览器操作；执行已获用户授权的步骤即可。

## V1.4 优先级说明

通用命令执行使用 `execution_run`：需有效 Level2 Full Access、execution.run OAuth scope 和用户任务授权；**无需 Level3 或旧式 trusted-command recipe 预注册**。本参考文档以下 `execution_start` / `COMMAND_NOT_APPROVED` 说明只针对**历史受限 recipe 路径**，不要对通用执行套用。

V1.4 Final 的 Level2 不是永久 baseline，而是绑定当前 Windows 登录会话的 session grant。
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

Git Write 默认没有 repository policy。MCP/ChatGPT 不能创建或批准 Git policy。由本机用户/操作员准备
JSON policy 后，先运行不带 `--approve` 的 preview 并检查返回的 digest：

```powershell
c2c git-write approve -w <workspace> --repository <workspace-relative-path> --policy <local-json-policy>
```

核对真实 repository/worktree、Git bundle、允许的 operations、branches、remotes、author 等预览内容后，
使用同一 policy 显式批准：

```powershell
c2c git-write approve -w <workspace> --repository <workspace-relative-path> --policy <local-json-policy> --approve --digest <preview-digest>
```

后续 `git_write` 仍受 repository policy、`expectedHead`、`expectedBranch`、status 和允许操作范围约束。
`NOT_APPROVED` 表示 OAuth/tool routing 已到达 C2C，但本机 repository Git policy 未批准；它不是 OAuth
失败，也不是 MCP 网络故障。

Level 3 默认关闭。`LEVEL3_DISABLED` 表示 `execution.level3` 请求已经到达 C2C，但本机 Level 3 capability
当前关闭；它不是 OAuth scope 不足、MCP 网络错误或 ChatGPT 安全层拦截。只有本机用户明确选择开启后，
本机才执行：

```powershell
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
| `NOT_APPROVED` | Git Write 请求已到 C2C，但该 repository/worktree 没有匹配的本机 Git policy approval。不是 OAuth 或 transport 错误。 |
| `COMMAND_NOT_APPROVED` | bounded execution 请求已到 C2C，但本机 trusted-command registry 中没有匹配 repository/kind/target recipe。不要用 Level 3 或 Remote 绕开。 |
| `LEVEL3_DISABLED` | `execution.level3` 请求已到 C2C，但本机 Level 3 未开启。只有本机用户可以显式 enable。 |
| Level 3 request pending / not approved | 精确命令仍在等待本机 inspect、digest 核对、风险分类与 approve；尚未获准运行。 |
| ChatGPT platform/tool invocation rejection | 请求未到达 C2C。检查平台侧 connector/tool invocation 状态；不要将其归类为上表中的 C2C policy 错误。 |
| MCP `-32603` / network / connector unavailable | transport/runtime 类故障。先判断 Bridge、Tunnel、connector 可用性和请求是否到达；只有 C2C 本身不可用时才考虑独立恢复通道。 |

正式 ChatGPT OAuth 授权的 scope 扩展只适用于已注册 `clientName === "ChatGPT"` 且 redirect hostname 为
`chatgpt.com` 的请求，并在签发 authorization code 前展示 `SUPPORTED_SCOPES`。其他 client 不自动扩权。
旧 token/refresh grant 不会自动获得新 scope；使用实际工具调用结果判定当前权限，不因一个工具失败循环
触发 reconnect。OAuth scope 与本机 workspace permission、Git policy、trusted-command registry、Level 3
审批是独立门槛。

## 本机命令

CLI 必须来自**已核验版本的本机运行时**，不能仅凭旧源码目录的 bin/c2c.js 判断版本。
例如维护者本机 C:\codex\codex-with-chatgpt 可能仍停在旧分支，而正式 V1.4 由独立的
受保护 Runtime 运行。先在本机定位正在运行的 Node 路径与同一 Runtime 的 CLI，
确认版本、完整性和 workspace，之后才运行以下示例；绝不能使用聊天中的历史 SHA/PID
去拼凑 CLI 或清理 OAuth/state。

示例使用下列由本机操作者**事先赋值并确认**的 PowerShell 变量：

~~~powershell
$c2cNode = 'C:\absolute\path\to\verified-runtime\node\node.exe'
$c2cCli  = 'C:\absolute\path\to\verified-runtime\bin\c2c.js'
$targetWorkspace = 'C:\your\actual\workspace'
& $c2cNode $c2cCli status -w $targetWorkspace --json
& $c2cNode $c2cCli permission status -w $targetWorkspace --json
& $c2cNode $c2cCli permission bridge status -w $targetWorkspace --json
& $c2cNode $c2cCli autostart status -w $targetWorkspace --json
& $c2cNode $c2cCli restore -w $targetWorkspace --json
~~~

前四项用于现状检查；其中 `permission bridge status` 读取正在运行 Bridge 的 effective authority，
比单独的控制端回显更接近最终 enforcement point；restore 是实际恢复动作。不要默认使用个人电脑固定路径。

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

前三项用于现状检查；restore 属于运行时恢复动作。`status` 的 `ok` 是 recovery 是否
healthy，不是“进程存在”；CLI exit 0 本身不证明 ready。`permission status` 不改权限。
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
| `NOT_APPROVED` | Git 请求已到达 C2C，但本机 repository policy 未批准；按上方 preview/digest 流程由本机操作员处理 |
| `COMMAND_NOT_APPROVED` | execution 请求已到达 C2C，但 trusted-command recipe 未批准；不得通过 Level 3 或 Remote 绕过 |
| `LEVEL3_DISABLED` | Level 3 请求已到达 C2C，但本机 capability 关闭；仅本机用户可显式开启 |
| Level 3 pending / not approved | 等待本机逐条 inspect、核对精确 digest、风险分类与 approve；此时命令尚未获准启动 |
| ChatGPT platform/tool invocation rejection | 请求尚未到达 C2C；按平台/connector 调用状态排查，不归因于 C2C policy |
| MCP `-32603` / network / connector unavailable | transport/runtime 故障；与 OAuth scope、本机文件模式或专用 policy 错误分开定位 |
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
