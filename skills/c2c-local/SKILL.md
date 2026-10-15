---
name: c2c-local
description: >
  将 RomioLA C2C Local 作为普通本机 Workspace 开发、调查、Git、受控执行和运维任务的默认工具，
  包括文件读写、Host Observation、进程与网络查询，以及权限或 Windows 登录自启诊断。
  仅在 C2C 不可用、明确需要 Windows GUI/UAC、灾难恢复，或当前能力无法完成任务时考虑 Remote Desktop Commander。
---

# C2C Local

本 Skill 描述 C2C Local V1.3 的实际能力与本机运维流程。对于本机 Workspace 文件、源码、Git、
进程、网络、Host Observation 和受控执行任务，默认优先使用 C2C Local。

只有 C2C Bridge/Tunnel/connector 本身不可用而需要恢复 C2C、任务明确需要 Windows GUI 或 UAC/elevation、
灾难恢复，或 C2C 已确认不提供所需能力时，才使用 Remote Desktop Commander。不得仅因方便、历史习惯
或旧 Skill 文案而优先使用 Remote。GUI/UAC 目前仍不是 C2C 的目标能力；C2C 自身停止时，不能依靠
已经停止的 C2C 自救，此时独立 Remote 通道可作为恢复观察/操作通道。

ChatGPT 可在 OAuth scope、本机专用策略、workspace 文件权限模式和用户任务授权共同允许时，通过 MCP
使用文件、Git Write、bounded execution 和 Level 3 request/start 能力。本机权限是能力上限，不是对
任意操作的任务授权。C2C 不提供任意无审批 shell 或远程权限提升。

## V1 baseline 与当前 authority

本 Skill 中部分运维背景记录自仓库 `C:\codex\codex-with-chatgpt` 的旧提交
`23b07065b809434699e57a06064c80b050d12d25`（分支
`integration/local-permission-v1`），它是 C2C Local V1 baseline，不代表当前
checkout、生产部署或运行状态。该版本的登录链路与验收记录只描述该 baseline。
当前任务以实际源码版本和结构化结果为准，不凭旧聊天或 baseline 推断 HEAD。

旧 Project 资料 `C2C（Codex-with-ChatGPT）.txt` 与 [legacy Codex-with-ChatGPT workflow](../../skill/SKILL.md)
描述显式调用的旧规划/编排流程，不是普通 C2C Local 工具选择或权限规则的 authority。
不要继承它的“统一 workspace=codex”或“C2C 只用于读取、分析和复核”规则，也不要把两套规则合并。
只有用户明确要求旧 Codex with ChatGPT workflow 时才使用该 legacy Skill；普通本机任务按本 Skill 选择
C2C Local。单纯查看/改文件不需要 GUI、重新配对或重启服务。

## State 与 workspace 身份

Windows 默认 state root 是 `%LOCALAPPDATA%\OpenAI\c2c-local`。
非空 `C2C_STATE_DIR` 是显式 override；旧 `%LOCALAPPDATA%\codex-with-chatgpt`
不是默认 authority。CLI 与 Bridge 必须使用相同 Windows 用户、相同有效 state root。
不能通过改 override 绕过当前权限或创建另一套运行时 authority。

每个 workspace 的 ID 来自 canonical realpath；Windows 路径大小写已归一化。
路径别名若解析到同一个根目录会得到同一 ID。项目名、聊天名、connector 显示名及
当前终端 cwd 不能代替 workspace 身份。

权限按 `state root + workspace ID` 持久化。相同身份下的聊天、connector 授权和本机
CLI 共享本机模式；权限不是每个聊天或 token 的独立副本。不同 workspace 不共享模式，
相同路径但不同 state root 也不是同一份权限状态。OAuth scopes 仍按 token 独立。
切换本机模式不要求重启 Bridge 或重新建立 Tunnel，后续 MCP 文件操作重新读取模式。

操作前确认 `workspace_info` 的真实根路径/ID，再读 `permission_status`。
只使用与用户目标相匹配的 connector。若不匹配，停止该 connector 的文件操作，定位正确
workspace；不要自动把所有项目接到 `C:\codex`，也不要跨 connector 拼接权限判断。

## 权限与文件操作

| 本机模式 | workspace | workspace 外 |
|---|---|---|
| `readonly` | 读取、搜索、查看 Git/结果；不写、不删 | 不允许 |
| `level1` | 读、创建、编辑、替换、内部移动；不删 | 非敏感文本文件只读 |
| `level2` | 继承 level1，另可删除单个普通文件 | 可读、创建、编辑、替换文件；不移动、不删除 |

实际 V1 限制：`create_directory` 只创建一个 workspace 目录，父目录须已存在；
没有目录删除、递归删除、外部目录创建或外部移动工具。外部删除在所有模式都是 HARD NO。
路径越界、敏感文件、state 文件保护仍生效；level2 不能绕过它们。

workspace 工具使用 workspace 相对路径（可用 `workspace:/`）；外部文件工具必须使用
明确的 host 绝对路径，并且 canonical 目标仍在 workspace 外，不能用别名跨越工具边界。

### Nested Git repositories and worktrees

When a connected workspace contains multiple repositories or worktrees, select a nested
repository with the workspace-relative `repository_path` argument on `git_info`,
`git_status`, or `git_diff`. For example, when the workspace is `C:\codex`, use
`repository_path="cinderella-companion/worktrees/WORK2"` to inspect WORK2. Do not
report the container workspace's Git state as the nested repository's state.

`repository_path` must resolve to an existing directory inside the connected workspace
and to that repository/worktree's Git top-level. Canonical path validation blocks
`..`, outside absolute paths, and symlink/junction escapes; a normal subdirectory of a
parent repository does not fall back to that parent. Git commands remain fixed and use
the selected directory as `cwd`. `git_diff.path` is a separate pathspec relative to the
selected repository. Responses include `repositoryPath` and `topLevel`; `git_info`
returns branch, full `head`, and `dirty` without requiring a full status query. Omitting
`repository_path` preserves the existing workspace-root behavior.

These APIs expose fixed repository-info, status, and diff queries; `repository_path`
selects a repository/worktree and does not provide arbitrary Git command execution.
The shared runner removes inherited `GIT_*` variables, sets noninteractive and
`GIT_OPTIONAL_LOCKS=0` behavior, fixes `core.fsmonitor=false`, and uses `--no-pager`.
Diff inventory and patch queries use `--no-ext-diff` and `--no-textconv`; configured
clean/process filters are overridden for status and diff execution. Normal Git configuration
continues to supply metadata such as branch/upstream information, but repository
configuration is not trusted to launch helpers. Git queries may read repository
metadata, configuration, and attributes as part of their normal operation.
Filter keys that cannot be safely represented as command-line overrides make the
query fail closed; if status cannot be safely established, `git_info.dirty` is `null`.
Status paths are parsed from NUL-delimited records and mapped to the selected root
before sensitive checks; diff inventory and patch paths use that same root-relative base.
Repositories that rely on external clean/process filters may show additional dirty
paths or a raw-worktree diff representation because those programs are intentionally
not executed.

Sensitive rules from the connected workspace and selected repository are both
checked. Repository paths are matched relative to the repository root, then mapped
to workspace-relative paths for the connected workspace rules. Either layer denying
a path hides it; repository negation cannot reopen a workspace-level deny.

### 四类独立权限门槛

1. **OAuth scopes** 决定远程 token 是否有资格调用某类 MCP capability。正式 ChatGPT OAuth 请求同时满足
   已注册 `clientName === "ChatGPT"` 且 redirect hostname 为 `chatgpt.com` 时，授权流程使用当前
   `SUPPORTED_SCOPES` 完整集合，并在签发 authorization code 前由授权页展示。其他 OAuth client 仍按
   exact-requested-scope 处理，不会自动扩权。旧 access/refresh grant 不会因为这项规则自动获得新 scope；
   实际权限以当前工具调用结果和该 token 的 authority 为准。不要因一次工具失败反复触发 reconnect。
   `INSUFFICIENT_SCOPE` 是 OAuth scope 问题，必须与本机 policy 拒绝区分。
2. **workspace local permission mode** 为 `readonly`、`level1`、`level2`。`level2` 是文件 permission
   mode 的最高档，只控制对应文件能力；它不等于 Git Write 授权、execution trusted-command approval
   或 Level 3 approval。workspace 修改/移动需 `workspace.write`，删除需 `workspace.delete`；外部读/写
   分别需 `filesystem.external.read` / `filesystem.external.write`，并同时通过本机模式门槛。
3. **专用本机 policy** 独立控制额外 capability：Git Write 按 repository/worktree 单独批准；bounded
   execution 按 repository 和固定 package script recipe 进入本机 trusted-command registry。
4. **Level 3** 默认关闭。只有本机用户先明确执行 `c2c level3 enable -w <workspace> --approve` 才能创建
   Level 3 pending request。之后每个精确 request 仍需本机 inspect、digest 核对、按 risk 分类和 approve；
   MCP 才能调用 `level3_start`。开启本身不运行命令，也不授予永久 unrestricted shell。

OAuth scopes 和本机策略是两层独立门槛：scope 获准不代表本机 policy 已批准，本机模式也不能补足 OAuth
scope。不得通过提高 Level 3 或切换 Remote 绕过 Git/recipe policy 拒绝。

权限变更只能由本机用户明确决定，通过本机 CLI 执行：

```powershell
node "C:\codex\codex-with-chatgpt\bin\c2c.js" permission status -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" permission readonly -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" permission 1 -w "完整目标 workspace 路径" --json
node "C:\codex\codex-with-chatgpt\bin\c2c.js" permission 2 -w "完整目标 workspace 路径" --json
```

不要自动执行提升权限、直接改 permissions JSON，或把本机提权命令交给远程 runner。
用户已明确授权本机权限变更时，本机执行者可执行对应命令并回读；远程 ChatGPT 只提示
用户本机操作。CLI 的 `mode`、MCP `permission_status.mode` 和 `workspaceId` 应一致。
变更后无需为了“生效”重启服务。缺失、损坏、workspace 不匹配或版本不支持的权限状态
回退 readonly；查明原因，不用删除状态或自动提升来补救。

读文件后使用返回的完整字节 `contentHash` 作为 `expected_hash`，不要计算分页片段的 hash。
`replace_file`、`edit_file` 和 `delete_file` 必须传入该 hash；external 对应工具同样如此。
创建拒绝已存在目标，移动仅 workspace 内普通文件到不存在的目标；`edit_file` 的
`old_text` 必须恰好匹配一次。`STALE_FILE` 时重读并重新评估用户改动，不能盲覆盖。
每次删除只针对一个用户授权的明确普通文件；不用批量或递归删除。

## Host Observation V1

当用户任务需要主机诊断且授权范围包含该读取时，可使用 Host Observation；用户不必说出
“Host Observation”这个名称。若结构化 Host tools 已暴露且 `system.read` 已授权，优先使用它们。
只有工具未暴露、scope 缺失或工具能力不足以回答问题时，才说明需要本机协助。本机 Codex
可在当前用户任务已授权本机诊断时使用合适的本机查询方式；这不代表 Host Observation scope
已授权。远程 ChatGPT 不得借其他 MCP 工具绕过 Host Observation 的 scope 或能力范围。

七个工具逐次要求 OAuth scope `system.read`；它与本机文件权限模式独立，不增加文件修改或
删除能力。正式 ChatGPT 重新授权链能够包含 `system.read`，不应把它描述为必然需要逐项增量 reOAuth。
旧 token/refresh grant 不自动获得新 scope；按实际工具调用与当前 token authority 判断。`system.read`
和 `readonly/level1/level2` 独立，获准读取主机诊断不会增加文件写权限。

使用流程、7 个工具的参数边界和数据处理规则见
[Host Observation 操作指引](references/host-observation.md)。

## 登录自启与网络 readiness

Windows 自启是当前用户**登录触发**，不是无人登录也运行的 Windows service。
已注册且 enabled 的 workspace 会在该用户下次登录自然恢复；不要求每次聊天执行
setup/enable/restore。未注册的 workspace 不会因此自动启动。

已验收的部署链为 Windows 登录 → Explorer-visible Host HKU Run → 短 Run command
→ state root 下 workspace 专属 CMD launcher → Node → autostart restore → Bridge
→ Named Tunnel → 已配置 ChatGPT connector。其他注册可以使用 Scheduled Task；以实际
`autostart status.backend` 为准，不能仅因名称里有 Task 就判注册缺失。

Run authority 必须是 `StdRegProv + explicit HKU\当前交互用户 SID + 64-bit provider`。
enable/status/update/rollback/disable/verify 都使用这一 authority。Codex package 的
process HKCU 可能是 Explorer 看不到的 private registry；不要用 `reg.exe add HKCU`
手工“修复”。caller legacy view 仅供受保护的旧项清理，不是另一份正式安装 authority。
CMD launcher 和 registration 均原子发布；不手改 launcher、回滚记录或 pendingBackend，
不把 EncodedCommand 塞回 Run。

开机登录时 WLAN/DNS 尚未 ready 属于已识别风险。Named 内部只对明确 transient DNS/
network 启动失败最多尝试 6 次，退避 2/4/8/16/16 秒，共享总 deadline 75 秒。
下一次 retry 前旧 cloudflared 必须已退出。不要在 retrying 时另起 Tunnel、重新 enable，
或加无限重试。binary/credentials/config/unknown/permanent/timeout/exhaustion 是 hard fail。
75 秒是 Named provider 的预算，不是整台机器登录流程的保证；Quick 的启动门槛独立。

## 健康判断与故障处理

本机首先使用 `status -w ... --json`。从 `diagnostics` 确认 workspace、Bridge 身份、
Tunnel preference/provider/连接状态、endpoint 匹配和 `recovery.status/reason`；
不能只看命令 exit code、PID 存在、tokenCount 或 `restartSafeConnector`。
恢复需求再使用 `restore -w ... --json`；它会恢复/reuse 运行时，不重新配对、不撤销 token，
不修改 ChatGPT connector 设置。只做读取或已有服务健康时无需调用 restore。

Named 的本机公网 self-probe 只访问 `/health`。Bridge/runtime/single-instance、Named
连接与 endpoint authority 都重新确认正常时，单独 degraded/ECONNRESET 是 diagnostic-only：
不重启健康 Tunnel，不让正式 restore exit 1。真实 ChatGPT 工具调用成功与否独立判断。
Quick 仍以公网 health 为启动/恢复门槛，不能套用 Named 的诊断豁免。

**最终源码的 doctor 并未统一为上述 restore 语义。** 它默认会尝试自动修复，
`report.tunnel` / `namedRepair` / exit code 仍可能把 Named self-probe 失败当作故障。
不要复制旧 Skill 的“doctor 失败就静默修复”或“所有 report 都 green 才能工作”。
如确需其附加诊断，使用 `doctor --no-fix -w ... --json`，同时仍检查后续保存 endpoint
的副作用；它不是严格纯只读命令。Named 判定回到 status/restore 的结构化 diagnostics。
仅凭 doctor 的 self-probe 失败，不登录 Cloudflare、不重建 connector、不触发重启。

本机命令、registration 状态、故障决策树和诊断取证步骤见
[运维与故障决策](references/operations.md)；只在相关故障或明确运维请求时读取。
不把此刻的 PID、端口、URL、权限当前值、token、日志时间或调查目录写回 Skill。
