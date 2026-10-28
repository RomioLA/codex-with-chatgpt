# C2C Local V1.5 — Windows 安装指南

> 面向 Windows x64 从源码使用 V1.5 的新用户。V1.5 已发布到默认 `main`，源码标签为 `v1.5.0`；目前仍是源码构建路径，不应把维护者本机 Runtime 目录当成公开一键安装包。

## 环境要求

- Windows 10/11 x64、Git、PowerShell 7（pwsh）。
- **Node.js 22+、Corepack**。项目虽然声明 Node >=20，但它指定的 pnpm 11 需要 Node >=22。
- **Visual Studio 2022 C++ Build Tools（MSVC x64 + Windows SDK）**：构建 Native Helper/Launcher 必需；不是只编译 TypeScript。
- **cloudflared**：ChatGPT 远程连接到本机需要；长期使用推荐 Cloudflare 自有域名的 Named Tunnel。
- 可以添加自定义 MCP/插件连接的 ChatGPT 账号；可用入口以当前客户端界面为准。

PowerShell 检查：

~~~powershell
git --version
node --version
corepack --version
pwsh --version
cloudflared --version
~~~

不要下载来源不明的原生可执行文件。

## 获取 V1.5 并构建

默认 `main` 已包含 V1.5，实现与后续文档修订都从这里获取：

~~~powershell
git clone https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
node .\bin\c2c.js --help
~~~

如果构建提示找不到 cl.exe、vswhere 或 Windows SDK，先安装/修复 Visual Studio C++ Build Tools。此处采用 **RomioLA** fork，不要误用 XiaoDuoYa 上游。

## 可选：让 Codex 新对话识别当前 V1.5 Skill

**源码仓库内有 Skill 文件，不代表 Codex 已自动安装。** 需要让本机 Codex 在其他项目中也能找到它，可在当前 C2C 仓库源码根目录执行：

~~~powershell
$skillRoot = Join-Path $HOME '.agents\skills'
New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath '.\skills\c2c-local' -Destination $skillRoot -Recurse -Force
~~~

应包含完整的 SKILL.md 及 references 目录。Codex 的用户级 Skill 位置为 $HOME\.agents\skills；如未显示，可重新打开 Codex。不要安装旧的 skill/SKILL.md 代替当前 V1.5 Skill。**此步骤只帮助 Codex 选择工具，不会自动配置 ChatGPT 连接器或授予权限。**

## 第一次连接

选定一个**已经存在、明确授权**的本地目录。以下 C:\Projects 是示例，请替换成自己的真实目录：

~~~powershell
node .\bin\c2c.js setup -w 'C:\Projects'
~~~

按 CLI 提示完成 Cloudflare、ChatGPT MCP 连接、OAuth 和一次性配对。配对码只在官方授权步骤输入，不要分享 OAuth Token、云端凭据或用户密钥。

- **Named Tunnel**：需要 Cloudflare 域名与有效凭据，公网地址一般在重启后保持不变，推荐长期使用。
- **Quick Tunnel**：用于临时体验，重启后地址可能变化，需要检查 ChatGPT 连接是否仍指向当前 URL。
- ChatGPT 连接器配置不会被修改版 README 自动创建；必须实际完成连接器授权。

## 权限与可选自启

~~~powershell
node .\bin\c2c.js permission status -w 'C:\Projects' --json
node .\bin\c2c.js permission 1 -w 'C:\Projects' --json
~~~

readonly 只读，level1 允许受限文件修改；Level2 是当前 Windows 登录会话的临时提升，注销或重启后回落到持久基线。V1.5 通用命令 `execution_run` 需要 **Level2 Full Access + execution.run OAuth scope + 用户任务授权**；它不要求 Level3 或逐命令 trusted-command 审批。V1.5 的结构化 Git Write 在有效 Level2 下也不再无条件要求独立 Repository Approval，而 Level1 仍保留该策略门。不要安装时默认启用高权限。

对长期使用的 Named Tunnel，可选择在本机启用登录自启：

~~~powershell
node .\bin\c2c.js autostart enable -w 'C:\Projects' --json
node .\bin\c2c.js autostart status -w 'C:\Projects' --json
~~~

部分 Windows 环境需要管理员 PowerShell 注册任务。它是 **用户登录触发**，不是无人登录也运行的 Windows 服务。

## 验收与恢复

~~~powershell
node .\bin\c2c.js status -w 'C:\Projects' --json
node .\bin\c2c.js doctor -w 'C:\Projects' --no-fix --json
~~~

还必须让 ChatGPT **真实调用 workspace_info、permission_status** 验证 OAuth/MCP 端到端连接。Bridge PID 或 /health 健康不等于工具真正可用。

断线先检查 status，必要时：

~~~powershell
node .\bin\c2c.js restore -w 'C:\Projects' --json
~~~

正常 Named Tunnel 恢复通常不需要重新配对或删除连接。公网健康自检 ECONNRESET 不能单独证明连接器不可用。

继续阅读：[用户指南](USER_GUIDE.zh-CN.md) · [AI 指南](AI_GUIDE.md) · [排障说明](troubleshooting.md)。
