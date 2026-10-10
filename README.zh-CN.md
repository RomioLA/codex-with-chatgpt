# C2C Local

> 面向本地工作区的 ChatGPT ↔ Codex 桥接方案，带明确权限边界。
> ChatGPT 负责推理和审查；通过 C2C Local，它也可以启动经本机操作者明确批准的 bounded execution recipe。

[English](README.md) | **简体中文**

本仓库是 **RomioLA 维护的 C2C Local fork**，基于 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)。在原项目桥接思路上，增加了更完整的本机权限模型、Windows runtime 恢复、受限主机诊断，以及安全的嵌套 Git/worktree 定位能力。

## C2C Local 能做什么

- 通过 OAuth 保护的 MCP Bridge，把 ChatGPT 接入用户授权的本地 Workspace。
- 读取文件、图片、源码搜索结果、Git 状态，以及已经记录的执行/测试结果。
- 在本机权限允许时创建、编辑、替换、移动文件，并提供受限制的删除能力。
- 在策略允许时读取或修改 Workspace 外的普通文件，但不开放无限制主机文件系统。
- 通过 `git_info(repository_path)`、`git_status(repository_path)`、`git_diff(repository_path)` 定位嵌套仓库和 Git worktree。
- 通过 execution 工具启动由本机操作者明确批准的 bounded test/build/lint/typecheck 或具名 package-script recipe。
- 提供受限、只读的 Windows Host Observation，可查看进程、监听端口、网络、DNS、路径和主机上下文。
- 包含 Windows Bridge/Tunnel 状态恢复和自动启动相关能力。
- **不提供**任意 Shell、调用方自带命令字符串、远程提权或任意 Git 命令通道。

执行授权由 C2C 本机 trusted-command policy 管理。package script 只是执行材料；修改 `package.json` 不会自动批准新 recipe。Windows Job Object 只约束进程生命周期，不提供文件系统、网络、权限或不可信项目代码沙箱；经批准的 package script 仍会执行项目代码。

Windows 执行会绑定 repository 与 Git/worktree identity、workspace `package.json` 哈希和已批准 recipe、所选 `node.exe` 的 identity 与 SHA-256，以及明确列出的 package manager 启动材料。npm 包括 `npm-cli.js`、`lib/cli.js`、`lib/cli/validate-engines.js`、`lib/cli/entry.js`、`lib/cli/exit-handler.js`、`lib/npm.js` 和 npm 的 `package.json`。固定版本 pnpm 的启动链包括 `bin/pnpm.cjs`、`bin/pnpm.mjs`、`dist/pnpm.mjs` bundle 和 pnpm 的 `package.json`，这些列出的 runtime 文件均核对 identity 与 SHA-256。workspace manifest 按哈希校验并保持打开以防替换。C2C build 生成同时包含 Native Helper 和固定 Launcher SHA-256 的发行元数据。Launcher 通过文件句柄验证 Helper，然后持有禁止写入和删除的文件句柄，并锁定 Helper 所在的路径目录，在这些锁仍有效时用固定绝对路径调用 `CreateProcessW`。依据 Windows 文件共享规则，这将验证过的 Helper 文件与进程创建时打开的映像绑定。Launcher 属于 C2C distribution 信任根；部署必须保护发行代码目录，防止未授权写入。若攻击者可以同时替换 Launcher 和元数据，元数据不能认证整套发行内容。Helper 会重新打开并锁定列出的 runtime 材料，核对 identity 和哈希，然后以 suspended 状态创建子进程；全部检查通过后才 Resume。固定 pnpm 启动会设置 `verify-deps-before-run=warn`，C2C 不会因此隐式启动独立 `pnpm install`；已批准 recipe 使用 workspace 中现有依赖。npm 后续加载的模块、Node built-ins 和外部模块不会递归冻结；pnpm bundle 按单个文件哈希，但其之后加载的外部模块、Node built-ins 和项目脚本材料不在此绑定内。合同不声称整个 runtime、repository 或项目经过密码学冻结。输出 sanitizer 只过滤已覆盖的格式和 secret pattern，不构成恶意代码的数据外泄防护边界。

## 本机权限模型

C2C Local 的文件能力同时受 OAuth scope 和本机 permission mode 控制：

| 模式 | 主要行为 |
| --- | --- |
| `readonly` | Workspace 只读。 |
| `level1` | 允许 Workspace 创建/编辑/替换/内部移动，并可读取策略允许的外部文本文件。 |
| `level2` | 在 level1 基础上增加受限的 Workspace 单文件删除，以及策略允许的外部创建/编辑/替换；外部删除仍禁止。 |

本机查看或切换权限：

```text
c2c permission status -w <workspace>
c2c permission readonly -w <workspace>
c2c permission 1 -w <workspace>
c2c permission 2 -w <workspace>
```

敏感文件策略、规范化路径边界、OAuth scope 和具体操作检查仍然分别生效。ChatGPT 不能通过 MCP 自行提高本机权限。

## 嵌套 Git 仓库与 worktree

一个 Workspace 中包含多个仓库或 worktree 时，可以明确指定目标：

```text
git_info(repository_path)
git_status(repository_path)
git_diff(repository_path)
```

`repository_path` 只用于选择 Workspace 内的仓库/worktree。这些工具只开放固定的 info/status/diff 查询，不是任意 Git 命令执行通道。

Git 子进程会针对继承的 `GIT_*`、fsmonitor、external diff/textconv、clean/process filter 等风险做限制；Workspace 和目标仓库的敏感路径规则同时生效。

## Host Observation

获得可选 OAuth scope `system.read` 后，ChatGPT 可以调用以下受限只读诊断：

- `host_context`
- `process_query`
- `process_tree`
- `network_listeners`
- `network_status`
- `dns_resolve`
- `path_inspect`

Host Observation 只用于诊断，不是 Shell；不能启动、终止或任意控制主机进程。

## 快速安装

环境要求：Node.js 20+、Git；公网连接需要 `cloudflared`。

克隆 **C2C Local 本仓库**：

```bash
git clone https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
```

然后把 `skill/` 中的 Codex Skill 安装到当前 Codex home，并运行：

```text
c2c setup
```

如果希望让 Codex 全程代办，可以直接发送：

```text
请帮我安装并配置 C2C Local，源码使用
https://github.com/RomioLA/codex-with-chatgpt。
先检查 Git、Node.js >= 20 和 cloudflared；克隆或更新仓库；执行
corepack pnpm install 和 corepack pnpm build；把 skill/SKILL.md 安装到
当前 Codex home；然后运行 c2c setup。只有登录、验证码、2FA 或配对码必须
由我操作时再叫我，并且一次只告诉我一个动作。不要切换到 XiaoDuoYa 的上游仓库。
```

## 工作关系

```text
ChatGPT 网页版
    |  OAuth 保护的 MCP
    v
C2C Local Bridge  ---- Cloudflare Tunnel
    |
    | 权限门控的 Workspace / Git / Host Observation / bounded execution
    v
本地 Workspace  ---- C2C Native Helper ---- 本机已批准的 recipe
```

ChatGPT 可以通过 C2C Local 检查、修改已授权文件，并启动由本机操作者明确批准的 bounded recipe。C2C 不提供任意 Shell MCP 或调用方自带命令字符串。

## 安全边界

- 公网 MCP 端点强制 OAuth；知道 URL 本身不能获得访问权。
- Token 与 Workspace 绑定。
- 凭据、密钥、SSH、`.env*` 等敏感文件默认拒绝，`.env.example` 允许读取。
- `.c2cignore` 可以增加项目自己的排除规则。
- 文件修改必须同时满足 OAuth scope 和本机 permission mode。
- Execution 工具只接受 C2C 本机策略批准的具名 recipe；MCP 不提供 Shell、调用方自带命令字符串、Git commit 或远程权限提升工具。
- 已批准的 package script 仍可调用 Shell，并以本机用户账户权限执行项目代码。Windows Job Object 只约束进程生命周期，不提供文件系统、网络、权限或恶意代码沙箱。
- Runtime 完整性绑定选中的 Node 可执行文件；npm 的 `npm-cli.js`、`lib/cli.js`、`lib/cli/validate-engines.js`、`lib/cli/entry.js`、`lib/cli/exit-handler.js`、`lib/npm.js` 和 `package.json`；或固定版本 pnpm 的 `bin/pnpm.cjs`、`bin/pnpm.mjs`、`dist/pnpm.mjs` 和 `package.json`。这些列出的 runtime 文件会核对 file identity 与 SHA-256。workspace package manifest 按 SHA-256 检查并保持打开以防替换；已批准 recipe 记录保存在仓库外。这些哈希用于发现之后的变更，不认证发行者，也不能识别选中的 Node/npm/Corepack 安装在发现前就已有的恶意内容；Node 后续加载的全部模块和依赖也没有被冻结。
- Helper 和固定 Launcher 的 SHA-256 来自 C2C 构建/发行元数据。Launcher 在调用 `CreateProcessW` 期间持有已验证 Helper 文件，并锁定其路径目录，阻止写入、重命名和替换；部署仍须保护 Launcher 及 C2C 发行代码目录。若 Launcher 和期望元数据都能被一起替换，元数据不能认证整套发行内容。
- 输出 sanitizer 用于输出卫生处理，不是防止恶意代码外传数据的安全边界。

详细资料：[安全](docs/security.md) · [架构](docs/architecture.md) · [协议](docs/protocol.md) · [故障排查](docs/troubleshooting.md) · [本机权限](docs/local-permission-model-requirements.zh-CN.md)

## 开发

```bash
pnpm install
pnpm build
pnpm test
pnpm test:watch
```

主要目录：

```text
src/bridge/      Bridge、runtime state、管理 API
src/mcp/         MCP 工具及注册
src/permission/  本机权限模型
src/write/       受保护的文件修改原语
src/auth/        OAuth 2.1 与 token
src/pairing/     一次性配对码
src/workspace/   路径策略、搜索、Git
src/tunnel/      Cloudflare Tunnel
src/execution/   执行/测试证据
src/process/     进程生命周期
src/cli/         c2c CLI
skill/           Codex Skill
```

## 上游、状态与许可证

C2C Local 是 RomioLA 维护的独立 fork，来源为 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt)。保留上游 attribution；安装和 C2C Local 的正常开发默认使用当前仓库。

当前已经实现的主要扩展包括：本机权限模型、Windows production/runtime 恢复、Host Observation V1，以及安全的嵌套 Git 仓库/worktree 定位。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

[MIT](LICENSE)
