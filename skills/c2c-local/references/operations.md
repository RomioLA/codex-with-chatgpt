# C2C Local 运维与故障决策

此参考说明指定最终源码的实际命令与副作用。它不授权额外部署、重启、Host Run 修改、
权限提升、配对或浏览器操作；执行已获用户授权的步骤即可。

## 本机命令

CLI 来自当前真实 checkout 的 `bin/c2c.js`。在该部署中是
`C:\codex\codex-with-chatgpt\bin\c2c.js`；迁移 checkout 后先核对源码位置，不沿用旧路径。
PowerShell 7 示例中的 `完整目标 workspace 路径` 必须换成用户的实际根目录。
workspace 命令一律显式传 `-w`；不要让当前 shell cwd 把目标变成 CLI 仓库。

```powershell
node "C:\codex\codex-with-chatgpt\bin\c2c.js" status -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" permission status -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" autostart status -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" restore -w "完整目标 workspace 路径" --json
```

前三项用于现状检查；restore 属于运行时恢复动作。`status` 的 `ok` 是 recovery 是否
healthy，不是“进程存在”；CLI exit 0 本身不证明 ready。`permission status` 不改权限。
`autostart status` 返回 `enabled`、`backend`、`backendInstalled`、`registrationState`、
`workspaceExists` 和可选最近结果；不要把可选 lastRunStatus 当作此刻健康。

明确需要安装/更新或禁用该 workspace 的登录启动时：

```powershell
node "C:\codex\codex-with-chatgpt\bin\c2c.js" autostart enable -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" autostart disable -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" autostart list --json
```

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
| 本机 CLI 与 MCP 的 workspaceId/mode 不一致 | 先核对 Windows 用户、有效 state root、显式 `-w`、connector identity；不要提升权限、删除权限文件或重启来掩盖错误 |
| `LOCAL_PERMISSION_DENIED` | 回读 permission_status，解释本机模式限制；仅在用户明确选择后由本机改变模式；不能远程提权 |
| `INSUFFICIENT_SCOPE` | 检查实际 token 的授权范围；本机 level1/2 不补 scope；确需新增 scope 时走用户明确同意的授权流程，不自行反复 pair |
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
