# C2C Local — V1.4

> Connect ChatGPT to a user-authorized local workspace to inspect code, Git, files and host diagnostics, and to perform permission-gated edits and generic local execution.  
> Maintained by [RomioLA](https://github.com/RomioLA), based on [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt). **Unofficial community project, not affiliated with OpenAI.**

[简体中文](README.zh-CN.md) · [Windows installation](docs/INSTALL.md) · [User guide](docs/USER_GUIDE.md) · [AI tool guide](docs/AI_GUIDE.md) · [Troubleshooting](docs/troubleshooting.md)

## Version status

This README describes the **V1.4 feature branch feat/20261018-c2c-v14-native-workflow**, **not** the repository's default main branch. The maintainer's Windows Runtime has been exercised locally, but that is **not** a claim of a publicly released, validated one-click installer. New users should follow the [source-build installation guide](docs/INSTALL.md).

## What V1.4 does

| Area | Capability |
| --- | --- |
| Workspace | Read/search files and images; authorized editing, replacing, moving and limited deletion |
| Git | Explicit nested repository/worktree selection, fixed queries and policy-gated Git writes |
| Host Observation | Bounded read-only process, network, listener, DNS and path inspection |
| Batch reading | **batch_read** — up to 16 explicit files, with shared bounds and pagination |
| Batch search | **batch_search** — up to 8 queries with shared scan budget |
| Evidence | **collect_evidence** — selected file, search, Git and existing execution evidence |
| Generic execution | **execution_run** — Level2 Full Access program, PowerShell or CMD commands |
| Persistent workflow | **task_create/status/list/result/output/cancel** — fixed, deterministic tasks with checkpoints and recovery |
| Recovery | OAuth-protected MCP, Cloudflare Tunnel, Windows user-logon autostart |

**Use execution_run for generic V1.4 command execution** when a valid Level2 Full Access session grant, execution.run OAuth scope and user authorization are present. It does **not** require the previous execution_start trusted-command recipe registry or Level3 per-command approval. Other security policies still apply.

**Tasks are not autonomous agents.** Plans are finite and immutable; C2C does not invoke an LLM to extend them. WAITING_FOR_MODEL and uncertain side effects must not trigger automatic replay of commands.

## Quick Windows source-build overview

Requirements: Windows x64, Git, **Node.js 22+**, Corepack with pinned pnpm 11, PowerShell 7, Visual Studio 2022 C++ Build Tools (MSVC x64 + Windows SDK) and cloudflared. Although package.json declares Node >=20, **pnpm 11 requires Node >=22**.

~~~powershell
git clone --branch feat/20261018-c2c-v14-native-workflow --single-branch https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
node .\bin\c2c.js setup -w 'C:\Projects'
~~~

**Replace C:\Projects with a directory on your own PC that already exists and that you intend to authorize.** Follow the CLI's Tunnel, ChatGPT connector and OAuth pairing prompts. A Named Tunnel on a domain you control is recommended for stable restarts. Full setup, autostart, permissions and recovery steps are in [INSTALL.md](docs/INSTALL.md).

After connecting, ask ChatGPT:

> Use C2C to call workspace_info and permission_status, verify the connected workspace, then inspect my project read-only. Do not edit without my authorization.

## Permission and safety boundaries

| Mode | High-level behavior |
| --- | --- |
| readonly | Read-only |
| level1 | Restricted workspace editing and permitted external text reads |
| level2 | Higher permissions for the current Windows login session, including eligible Full Access execution |

OAuth scopes, local permission mode, operation-specific policy and explicit user authorization are **independent gates**. Level2 resets to the persistent baseline after logoff/reboot. A working directory is **not** an OS sandbox. Windows Job Objects contain process lifetime but do not isolate files, network or malicious project code. Credential and sensitive-file boundaries remain enforced. Public MCP access requires OAuth; knowing the URL is insufficient.

A healthy /health is **not** proof of authenticated ChatGPT tool access. If disconnected, inspect local status, then use restore when appropriate; routine Named Tunnel recovery should not require re-pairing.

## Documentation

- [Windows install (English)](docs/INSTALL.md) / [中文](docs/INSTALL.zh-CN.md)
- [User guide (English)](docs/USER_GUIDE.md) / [中文](docs/USER_GUIDE.zh-CN.md)
- [AI tool-selection guide](docs/AI_GUIDE.md) and [Current C2C Skill](skills/c2c-local/SKILL.md)
- [Troubleshooting](docs/troubleshooting.md), [Security](docs/security.md), [Architecture](docs/architecture.md), [Protocol](docs/protocol.md)
- [Legacy Codex-with-ChatGPT planning Skill](skill/SKILL.md) — only when explicitly requested, not the default V1.4 routing authority

Committing a guide to GitHub does **not** automatically teach every ChatGPT chat to use the connector. Install the skill in supported coding-agent environments and connect the real C2C plugin in ChatGPT. Live tool descriptions and current permissions remain authoritative.

**Next-version proposal (not yet implemented):** [V1.5 Capability Delivery & Operational Observability Plan](docs/v1.5-plan.md). Do not confuse this plan with deployed V1.4 functionality.

## Development

~~~powershell
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
~~~

A documentation commit is not a substitute for Windows install verification, production deployment, or CI.

**License:** [MIT](LICENSE). Upstream attribution is preserved.
