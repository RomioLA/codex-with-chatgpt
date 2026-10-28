# C2C Local — V1.5

> 让 ChatGPT 在用户明确授权下，直接读取本地工作区、调查项目、查看 Git、进行受控文件修改与通用命令执行。  
> 本仓库是 [RomioLA](https://github.com/RomioLA) 维护的 fork，基于 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)。**非 OpenAI 官方产品。**

[English](README.md) · [Windows 安装](docs/INSTALL.zh-CN.md) · [用户指南](docs/USER_GUIDE.zh-CN.md) · [AI 工具指南](docs/AI_GUIDE.md) · [故障排查](docs/troubleshooting.md)

## 版本状态：请先看这里

**V1.5 已正式发布。** GitHub 默认 `main` 已包含 V1.5 实现，源码发布标签为 **v1.5.0**。维护者的 Windows Production Runtime 与真实 ChatGPT 在线链路已完成本次版本验收，但这**不等于已经提供面向所有新机器验证的一键安装器**。新用户仍应按 [源码安装指南](docs/INSTALL.zh-CN.md) 操作。

## C2C 能做什么

| 类别 | V1.5 能力 |
| --- | --- |
| 工作区/文件 | 读取、搜索、图片查看；按本机权限创建、编辑、替换及部分移动/删除 |
| Git | 支持工作区内的嵌套仓库及 worktree，固定查询与专用受控 Git Write |
| 主机观测 | 只读的进程、进程树、端口、网络、DNS、路径检查 |
| 批量读取 | **batch_read**：最多 16 个已知文件，结果有界并可分页 |
| 批量搜索 | **batch_search**：最多 8 个查询，共享资源预算 |
| 收集证据 | **collect_evidence**：指定文件、搜索、Git、既有执行输出 |
| 通用命令 | **execution_run**：Level2 Full Access 下的 program、PowerShell、CMD |
| 持久任务 | **task_create/status/list/result/output/cancel**：确定性有限步骤、checkpoint、故障恢复与取消 |
| 运行维护 | OAuth、Cloudflare Tunnel、Windows 登录自启与故障恢复 |

### 两个重要区别

1. **V1.5 通用执行首选 execution_run。** 它要求本机有效 Level2 Full Access、相应 OAuth scope（execution.run）和用户授权；**不需要**为了通用命令先使用旧的 execution_start、预注册 trusted-command recipe 或 Level3 逐命令批准。V1.5 的结构化 Git Write 在有效 Level2 下也不再无条件要求独立 Repository Approval；Level1 仍保留该策略门。repository identity、expected-state、OAuth scope 与用户任务授权仍然有效。
2. **Task 不是自主 Agent。** 创建后的计划固定，不调用 LLM 自行增加步骤。出现 WAITING_FOR_MODEL 或未知副作用时停止，不能自动重放可能已执行的命令。

## 五分钟了解安装路径

目前面向新用户的是 **Windows x64 源码构建**，不是一键安装器。准备 Git、**Node.js 22+ / Corepack / pnpm 11**、PowerShell 7、Visual Studio 2022 C++ Build Tools（MSVC x64 + Windows SDK）及 cloudflared。pnpm 11 实际要求 Node >=22；package.json 的 Node >=20 声明不足以满足当前 pnpm 版本。

~~~powershell
git clone https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
node .\bin\c2c.js setup -w 'C:\Projects'
~~~

**把 C:\Projects 替换为自己电脑上真实存在并愿意授权的目录。** 在本机按 CLI 指引完成 Tunnel、ChatGPT 连接器和 OAuth 配对。长期使用推荐 Cloudflare Named Tunnel 以保持连接地址稳定。详情和首次验证、登录自启步骤均在 [完整安装指南](docs/INSTALL.zh-CN.md)。

在新 ChatGPT 对话中可说：

> 使用 C2C，先调用 workspace_info 和 permission_status 确认真实连接，再只读调查我授权工作区下的项目。未经我批准不要修改。

## 本机权限与安全边界

| 本机模式 | 行为 |
| --- | --- |
| readonly | 只读 |
| level1 | 受限工作区文件修改与允许的外部文本读取 |
| level2 | 当前 Windows 登录会话的更高授权，可能支持通用命令和有限额外文件能力 |

OAuth scope、权限模式、操作级别的本机策略与用户任务授权**同时生效**。Level2 注销或重启后回到持久基线；权限等级不是对任何命令的永久授权。Host Observation 不等于任意 Shell；执行命令的 cwd **不是操作系统沙箱**。Windows Job Object 只约束进程生命周期，不隔离磁盘、网络或恶意项目脚本。凭据、密钥、.env 等敏感路径受保护。公网 MCP 需要 OAuth，知道网址不等于获授权。

连接丢失时先检查状态，必要时执行本机 restore；正常 Named Tunnel 恢复不应第一时间删除连接或重新配对。健康端点 /health 成功不等于完整 OAuth/MCP 工具调用成功。

## 文档入口

- **第一次安装：** [Windows 安装指南（中文）](docs/INSTALL.zh-CN.md) / [English](docs/INSTALL.md)
- **怎么使用：** [用户指南（中文）](docs/USER_GUIDE.zh-CN.md) / [English](docs/USER_GUIDE.md)
- **让新的 AI 正确选工具：** [AI Guide](docs/AI_GUIDE.md) 与 [当前 C2C Skill](skills/c2c-local/SKILL.md)
- **问题排查与技术边界：** [Troubleshooting](docs/troubleshooting.md)、[Security](docs/security.md)、[Architecture](docs/architecture.md)、[Protocol](docs/protocol.md)
- **旧规划/编排模式：** [Legacy Skill](skill/SKILL.md)（仅在明确要求时使用，不作为 V1.5 默认工具规则）
- **V1.5 规划记录：** [V1.5 Plan](docs/v1.5-plan.md)（保留作为已发布 V1.5 的规划/历史记录）

**注意：** 把说明写到 GitHub 不会自动让 ChatGPT 读取或安装。对于支持 Skill 的编码 Agent，应按其产品说明安装 skills/c2c-local；对于 ChatGPT，必须真实连接 C2C 插件，工具 schema 和当前权限始终优先。

## 开发

~~~powershell
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
~~~

当前生产部署、源码版本、CI 和可用安装方式必须分别核验；文档变更本身不构成全平台/新用户安装验收。

**License:** [MIT](LICENSE)。上游归属保留；非 OpenAI 官方、无官方背书。
