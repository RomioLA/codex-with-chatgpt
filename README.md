# Codex with ChatGPT

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

> [!IMPORTANT]
> **遇到问题？** 请先向 Codex 发送 **「更新 Codex with ChatGPT」** 并重试。更新到最新版本可以解决大多数已知问题。  
> **Having trouble?** First ask Codex to **“Update Codex with ChatGPT”** and try again. Updating to the latest version resolves most known issues.

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目让网页版 ChatGPT 负责规划、审查和经本机授权的
文件修改，Codex 继续负责命令、构建和测试。不用 API Key、不搞逆向代理。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project uses that web
subscription for planning, review, and locally authorized file changes; Codex
retains command, build, and test execution.
No API keys, no reverse proxy — official web UI plus an OAuth-protected MCP
bridge with local permission controls.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版接入 Codex 编码会话。仓库不会被整体上传；
ChatGPT 通过 OAuth 保护的 MCP 连接按需读取内容。文件修改由 OAuth scope 和
本机权限模式共同控制；C2C 不提供 shell 或命令执行工具。

**EN** — Connect the ChatGPT web app to Codex coding sessions. The repository
is not uploaded as a bundle: ChatGPT requests the content it needs through an
OAuth-protected MCP connection. OAuth scopes and a local permission mode govern
file changes; C2C provides no shell or command-execution tool.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/XiaoDuoYa/codex-with-chatgpt 克隆到
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


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/XiaoDuoYa/codex-with-chatgpt into
   ~/codex-with-chatgpt (if it already exists, git pull to update).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: determine the Codex home first: use a non-empty CODEX_HOME
   when set, otherwise use ~/.codex (%USERPROFILE%\.codex on Windows). Copy
   skill/SKILL.md to <codex-home>/skills/codex-with-chatgpt/SKILL.md, and update
   the line "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. First-time setup: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — The Skill checks GitHub once a day and updates itself when a
new version is released; no action needed. You can also say "更新 Codex with ChatGPT"
anytime. / Skill 每天自动检查一次 GitHub，有新版本会自动更新，无需任何操作；
也可以随时对 Codex 说"更新 Codex with ChatGPT"。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

Let `<codex-home>` be a non-empty `CODEX_HOME` when set; otherwise use `~/.codex`
(`%USERPROFILE%\.codex` on Windows).

1. Install the Codex Skill: copy `skill/` to `<codex-home>/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

> **Installation scope:** This repository does not publish or install a Codex
> Web GPT, launcher, or model-catalog entry. Installation consists of building
> this checkout, installing `skill/SKILL.md` as a Codex Skill, and running
> `c2c setup` to configure the ChatGPT connector. For Web GPT or model-catalog
> problems, see [troubleshooting](docs/troubleshooting.md).

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  permission-gated   │   OAuth 2.1 + one-time pairing code
             │  MCP file tools     │   Local permission mode
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │ read / write according to local permission
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT reads workspace information, files, images,
  search results, Git state, and execution records. File creation, editing,
  replacement, movement, and deletion use separate tools gated by OAuth scopes
  and the local permission mode. C2C has no shell or command-execution tool.
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

### Local file permissions

The local default is `readonly`. The machine-side command changes the mode for
one workspace; ChatGPT can read it through `permission_status` but cannot change
it remotely:

```text
c2c permission status -w <workspace>
c2c permission readonly -w <workspace>
c2c permission 1 -w <workspace>
c2c permission 2 -w <workspace>
```

Mode `1` allows workspace file changes and reads of permitted external files.
Mode `2` also allows external file creation or modification and deletion of one
workspace file at a time with its current content hash. External deletion is
always denied. Moves stay within the workspace; directory creation is currently
workspace-only. OAuth scopes remain an independent gate. See the
[permission requirements and implementation status](docs/local-permission-model-requirements.zh-CN.md)
and [host filesystem boundary](docs/host-filesystem-boundary.zh-CN.md).

On Windows, the default state directory is
`%LOCALAPPDATA%\OpenAI\c2c-local`; `C2C_STATE_DIR` explicitly overrides it.

### Generated media handoff

`read_image` remains an inspection tool for supported workspace images. After
a requested image or video is downloaded through the visible ChatGPT UI, the
local executor can validate and import the
original with `c2c asset import -w <workspace> --from <download> --to <new-path>`.
Imports are workspace-contained, signature-checked, size-limited, reject active
SVG content, and never overwrite an existing file.

### Host Observation (V1)

Host Observation exposes bounded, read-only host diagnostics through MCP. Every
call requires the optional OAuth scope `system.read`, which is separate from the
local file permission mode and is not part of the default grant. Production
activation requires separate authorization to deploy and reauthorize the
connector; no restart or reauthorization is needed now. See
[Host Observation V1](docs/host-observation.md).

## Security model (short version)

- **Local file permission gate**: file mutation tools require both an OAuth
  scope and the user's local mode. The MCP server has no shell, command, or Git
  commit tool, and it exposes no remote permission-elevation tool.
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # compiles TypeScript, then runs Vitest
pnpm test:watch     # compiles once, then starts Vitest watch mode

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you). If QUIC is blocked, set
`C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.

`test:watch` does not rebuild `dist/` after its initial compile. If a source edit
changes the preloaded autostart helper while watch mode is running, restart the
watch command or run `pnpm build` before rerunning that test.

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [troubleshooting](docs/troubleshooting.md) ·
[local permissions](docs/local-permission-model-requirements.zh-CN.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        read and permission-gated file tools, stateless Streamable HTTP
  permission/ persisted local mode and operation policy
  write/      guarded file mutation primitives
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Status & disclaimer

V1. Verified end-to-end: bridge, OAuth + pairing, public tunnel, ChatGPT
connector setup, zero-touch first-run experience.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=xiaoduoya%2Fcodex-with-chatgpt&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
 </picture>
</a>
