# C2C Local V1.4 — Windows installation

[中文安装指南](INSTALL.zh-CN.md)

This is the **Windows x64 V1.4 source-build path**, not a tested one-click public installer. The maintainer's protected staged Runtime directories are not distributable installation instructions.

## Prerequisites

Windows 10/11 x64, Git, PowerShell 7, **Node.js 22+ and Corepack**, VS 2022 C++ Build Tools with MSVC x64 and Windows SDK, and cloudflared. The package.json engine field says Node >=20, but the pinned **pnpm 11 requires Node >=22**. You also need a ChatGPT client/account supporting custom MCP/plugin connectors.

## Build the actual V1.4 branch

The default branch does not yet represent this V1.4 source version. Clone the explicit feature branch:

~~~powershell
git clone --branch feat/20261018-c2c-v14-native-workflow --single-branch https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
node .\bin\c2c.js --help
~~~

Native C++ Helper/Launcher compilation requires MSVC and the Windows SDK; do not skip the native build if it fails. Use the RomioLA fork, not the original upstream.

## Optional: install the current C2C Skill for Codex

A Skill in the source repository is **not automatically installed** for every new Codex chat. To make it available in other Codex projects, run this from the cloned C2C repository root:

~~~powershell
$skillRoot = Join-Path $HOME '.agents\skills'
New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath '.\skills\c2c-local' -Destination $skillRoot -Recurse -Force
~~~

Copy the whole directory, including SKILL.md and references. Codex's documented user-scope Skill location is $HOME\.agents\skills. Restart Codex if the skill is not detected. Do not substitute the legacy skill/SKILL.md. **Installing a Skill does not install or authorize the ChatGPT MCP connector.**

## Connect and pair

Replace C:\Projects with an **existing workspace directory that you deliberately authorize**:

~~~powershell
node .\bin\c2c.js setup -w 'C:\Projects'
~~~

Follow local prompts to configure Cloudflare, add the ChatGPT MCP connector and complete OAuth/one-time pairing. Never paste secrets or Cloudflare credentials into a public chat.

**Named Tunnel** is recommended for stable URLs and logon recovery if you manage a Cloudflare-hosted domain. **Quick Tunnel** suits temporary testing; its URL may change after reboot, so the connector may need an update.

## Permissions, autostart and verification

~~~powershell
node .\bin\c2c.js permission status -w 'C:\Projects' --json
node .\bin\c2c.js permission 1 -w 'C:\Projects' --json
node .\bin\c2c.js status -w 'C:\Projects' --json
node .\bin\c2c.js doctor -w 'C:\Projects' --no-fix --json
~~~

Local level2 is temporary per Windows logon session. Generic V1.4 execution_run needs **Level2 Full Access plus execution.run OAuth scope**; it does not require Level3 or the legacy recipe registry. Do not enable higher local permissions automatically.

Optional Windows **user-logon** autostart (not a background service without login):

~~~powershell
node .\bin\c2c.js autostart enable -w 'C:\Projects' --json
node .\bin\c2c.js autostart status -w 'C:\Projects' --json
~~~

Some systems require administrator rights to register the task. Test the full connection by asking ChatGPT to **actually call workspace_info**, not by relying on /health or a running process alone.

For recovery, inspect status then run:

~~~powershell
node .\bin\c2c.js restore -w 'C:\Projects' --json
~~~

Ordinary Named Tunnel recovery should not require fresh pairing. A degraded ECONNRESET public self-probe does not by itself mean the authenticated connector is broken.

More: [User guide](USER_GUIDE.md) · [AI guide](AI_GUIDE.md) · [Troubleshooting](troubleshooting.md).
