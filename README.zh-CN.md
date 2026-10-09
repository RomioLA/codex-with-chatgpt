# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

> 本仓库是 **RomioLA 维护的 C2C Local fork**，基于 [XiaoDuoYa 的 Codex with ChatGPT](https://github.com/XiaoDuoYa/codex-with-chatgpt)。在原项目基础上增加了本机权限模式、Windows production/runtime 恢复、受限只读 Host Observation，以及对嵌套 Git 仓库/worktree 的安全定位（限固定 info/status/diff 查询）。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目让网页版 ChatGPT 负责规划、审查和经本机授权的文件修改，
Codex 继续负责命令、构建和测试。不用 API Key，也不搞逆向代理。

## 这是什么

把 ChatGPT 网页版接入 Codex 编码会话。仓库不会被整体上传；ChatGPT 通过
OAuth 保护的 MCP 连接按需读取内容。文件修改由 OAuth scope 和本机权限模式共同
控制；C2C 不提供 shell 或命令执行工具。

## 一段话安装（纯小白专用）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/RomioLA/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已存在就 git pull 更新）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：先确定 Codex home：如果设置了非空的 CODEX_HOME 就使用它，
   否则使用 ~/.codex（Windows 默认为 %USERPROFILE%\.codex）。把仓库里的
   skill/SKILL.md 复制到 <codex-home>/skills/codex-with-chatgpt/SKILL.md，
   并把文件中 "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 首次配置：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```

**更新**：Skill 每天自动检查一次 GitHub，有新版本会自动更新并继续任务，
无需任何操作；也可以随时对 Codex 说"更新 Codex with ChatGPT"。

## 安装 → 配置 → 使用（手动版）

设 `<codex-home>` 为：如果 `CODEX_HOME` 已设置且非空，则使用 `CODEX_HOME`；
否则使用 `~/.codex`（Windows 上默认为 `%USERPROFILE%\.codex`）。

1. 安装 Codex Skill：把 `skill/` 复制到 `<codex-home>/skills/codex-with-chatgpt/`。
2. 对 Codex 说：**"使用 Codex with ChatGPT 完成首次配置。"**
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

> **安装范围：** 本项目不会发布或安装 Codex 网页版 GPT、启动器或模型目录条目。
> 安装内容是构建本仓库、把 `skill/SKILL.md` 安装为 Codex Skill，然后运行
> `c2c setup` 配置 ChatGPT 连接器。网页版 GPT 或模型目录的问题请先查看
> [故障排查](docs/troubleshooting.md)。

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

唯一可能需要你动手的步骤：登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库默认还是原来的一条长对话，除非你说要改成 Project。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。没有账号、不想用、登录失败：继续用临时地址，功能一样，只是修复更慢。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  权限门控 MCP 文件工具 │ OAuth 2.1 + 一次性配对码
             │  本机权限模式         │
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │ 按本机权限读取 / 修改文件
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 按需读取工作区信息、文件、图片、搜索结果、Git
  状态和执行记录。创建、编辑、替换、移动和删除文件使用独立工具，同时受 OAuth
  scope 和本机权限模式门控。C2C 不提供 shell 或命令执行工具。
- **嵌套 Git 仓库**：当已连接的 workspace 内包含多个仓库或 worktree 时，调用
  `git_info`、`git_status` 或 `git_diff` 时传入 workspace 相对目录 `repository_path`。
  不传时仍以已连接 workspace 根目录为目标。`git_diff` 的 `path` 始终相对于所选仓库。
- **Git 读取边界**：这些工具只提供固定的仓库信息、状态和 diff 查询；`repository_path`
  只用于选择仓库或 worktree，不接受任意 Git 命令。子进程会清除继承的 `GIT_*` 环境变量，
  禁用 fsmonitor、external diff、textconv，以及 status/diff 中配置的 clean/process filter，
  并尽量减少可选 index 写入。无法安全覆盖的 filter 配置会让查询 fail closed；无法安全确认
  status 时，`git_info.dirty` 返回 `null`。仓库规则与连接 workspace 的敏感规则同时生效；
  不会把仓库 Git 配置视为可信任的 helper 执行来源。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

### 本机文件权限

默认模式是 `readonly`。权限按 workspace 保存在本机；只有本机命令可以切换。ChatGPT
可通过只读的 `permission_status` 工具查看权限，不能远程提权：

```text
c2c permission status -w <workspace>
c2c permission readonly -w <workspace>
c2c permission 1 -w <workspace>
c2c permission 2 -w <workspace>
```

权限 1 允许修改 workspace 文件，并读取符合敏感文件规则的外部文件。权限 2 还允许创建、
修改外部文件，以及凭当前内容 hash 一次删除一个 workspace 普通文件。外部删除在所有模式
下都禁止；文件移动只能发生在 workspace 内；目录创建目前也仅限 workspace。OAuth scope
是独立门槛。Windows 默认状态目录为 `%LOCALAPPDATA%\OpenAI\c2c-local`；非空的
`C2C_STATE_DIR` 会明确覆盖默认路径。详见
[权限需求与实现状态](docs/local-permission-model-requirements.zh-CN.md)和
[Host Filesystem 路径边界](docs/host-filesystem-boundary.zh-CN.md)。

### Host Observation（V1）

Host Observation 通过 MCP 提供有界、只读的主机诊断。每次调用都要求可选 OAuth
scope `system.read`；它与本机文件权限模式相互独立，也不属于默认授权。生产启用需要
另行授权部署并重新授权 connector；当前无需重启或重新授权。详见
[Host Observation V1](docs/host-observation.md)。

### 生成媒体交接

`read_image` 仍是只读查看工具，用于查看工作区中的受支持图片。通过可见的 ChatGPT
页面下载图片或视频原件后，本地执行端可以运行
`c2c asset import -w <workspace> --from <download> --to <new-path>` 安全导入。
导入过程限制在工作区内，会验证签名和大小、拒绝活动 SVG，并且绝不覆盖现有文件。

## 安全模型（简版）

- **本机权限门控文件修改**：文件修改工具同时要求 OAuth scope 和用户本机权限模式。
  MCP 服务端没有 shell、命令执行或 Git 提交工具，也没有远程提权工具。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install
pnpm build          # 产出 dist/，暴露 c2c 命令
pnpm test           # 先编译 TypeScript，再运行 Vitest
pnpm test:watch     # 启动时编译一次，然后进入 Vitest watch 模式

c2c setup           # 一条命令：Bridge + 隧道 + 配对码
c2c sandbox-allow   # 把本地设置目录加入 Codex 沙箱白名单（macOS / Windows）
c2c status / doctor / pair / unpair / logs / stop
```

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。如果 QUIC 被拦截，设置
`C2C_TUNNEL_PROTOCOL=http2` 后重启 Bridge。

`test:watch` 运行期间不会自动重建 `dist/`。如果源码修改影响了 autostart 预加载 helper，
重新启动 watch 命令，或先运行 `pnpm build` 再重跑该测试。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [故障排查](docs/troubleshooting.md) ·
[本机权限](docs/local-permission-model-requirements.zh-CN.md)

## 目录结构

```
src/
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        读取和本机权限门控的文件工具、无状态 Streamable HTTP
  permission/ 按 workspace 保存的本机权限和操作策略
  write/      受边界检查保护的文件修改原语
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 状态与声明

V1。已端到端验证：Bridge、OAuth + 配对、公网隧道、ChatGPT 连接器配置、
零操作首次配置体验。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
