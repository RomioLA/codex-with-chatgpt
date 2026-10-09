# C2C Local

> Local-first ChatGPT ↔ Codex bridge with permissioned workspace access.
> ChatGPT reasons, reviews, and works with authorized local files; Codex keeps command, build, and test execution.

[简体中文](README.zh-CN.md)

This repository is **RomioLA's C2C Local fork** of [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt). It keeps the original bridge concept and adds a stronger local permission model, Windows runtime recovery, bounded host diagnostics, and secure nested Git/worktree targeting.

## What C2C Local does

- Connects ChatGPT to a local workspace through an OAuth-protected MCP bridge.
- Reads workspace files, images, search results, Git state, and recorded execution/test results.
- Supports permission-gated file creation, editing, replacement, movement, and limited deletion.
- Supports permitted reads/writes outside the workspace without exposing unrestricted host filesystem access.
- Targets nested repositories and Git worktrees with `git_info(repository_path)`, `git_status(repository_path)`, and `git_diff(repository_path)`.
- Exposes bounded, read-only Windows Host Observation for process, listener, network, DNS, path, and host context inspection.
- Includes Windows bridge/tunnel state handling, recovery, and autostart support.
- Does **not** expose an arbitrary shell, arbitrary command execution, remote permission elevation, or unrestricted Git commands.

## Permission model

C2C Local uses a machine-side permission mode in addition to OAuth scopes:

| Mode | Main behavior |
| --- | --- |
| `readonly` | Read-only workspace access. |
| `level1` | Workspace create/edit/replace/internal move plus permitted external text reads. |
| `level2` | Adds limited workspace file deletion and permitted external create/edit/replace. External deletion remains blocked. |

Check or change the local mode from the machine:

```text
c2c permission status -w <workspace>
c2c permission readonly -w <workspace>
c2c permission 1 -w <workspace>
c2c permission 2 -w <workspace>
```

Sensitive-file rules, canonical path containment, OAuth scopes, and operation-specific checks remain independent gates.

## Nested Git repositories and worktrees

When one connected workspace contains several repositories or worktrees, select the target explicitly:

```text
git_info(repository_path)
git_status(repository_path)
git_diff(repository_path)
```

`repository_path` selects a repository/worktree inside the connected workspace. These tools expose fixed info/status/diff operations only; they are not an arbitrary Git command channel.

Git subprocesses are hardened against inherited `GIT_*` overrides, fsmonitor helpers, external diff/textconv, and configured clean/process filters. Workspace and repository sensitive-path rules both apply.

## Host Observation

With the optional OAuth scope `system.read`, ChatGPT can use bounded read-only diagnostics:

- `host_context`
- `process_query`
- `process_tree`
- `network_listeners`
- `network_status`
- `dns_resolve`
- `path_inspect`

Host Observation is diagnostic-only. It is not a shell and cannot start, kill, or arbitrarily control host processes.

## Quick start

Requirements: Node.js 20+, Git, and `cloudflared` for the public connection.

Clone **this fork**:

```bash
git clone https://github.com/RomioLA/codex-with-chatgpt.git
cd codex-with-chatgpt
corepack pnpm install
corepack pnpm build
```

Then install the Codex Skill from `skill/` into your Codex home and run:

```text
c2c setup
```

For a guided setup, give your coding agent this request:

```text
Install and configure C2C Local from https://github.com/RomioLA/codex-with-chatgpt.
Check Git, Node.js >= 20, and cloudflared; clone or update the repository; run
corepack pnpm install and corepack pnpm build; install skill/SKILL.md into the
active Codex home; then run c2c setup and guide me only when login, CAPTCHA,
2FA, or a pairing code requires my action. Do not switch to the upstream
XiaoDuoYa repository.
```

## How it fits together

```text
ChatGPT Web
    |  OAuth-protected MCP
    v
C2C Local Bridge  ---- Cloudflare tunnel
    |
    | permission-gated workspace / Git / host observation
    v
Local Workspace
    ^
    | commands, builds, tests
Codex
```

ChatGPT can inspect and modify authorized files through C2C Local. Codex remains the execution side for shell commands, builds, tests, and larger implementation workflows.

## Security boundaries

- Public MCP access requires OAuth; knowing the endpoint URL is not enough.
- Tokens are workspace-bound.
- Sensitive files such as credentials, keys, SSH material, and `.env*` are denied by default, with `.env.example` allowed.
- `.c2cignore` can add project-specific exclusions.
- File mutation requires both OAuth scope and the local permission mode.
- There is no MCP shell, arbitrary command tool, Git commit tool, or remote permission-elevation tool.

See [security](docs/security.md), [architecture](docs/architecture.md), [protocol](docs/protocol.md), [troubleshooting](docs/troubleshooting.md), and [local permission requirements](docs/local-permission-model-requirements.zh-CN.md).

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm test:watch
```

Main source areas:

```text
src/bridge/      Bridge, runtime state, admin API
src/mcp/         MCP tools and registration
src/permission/  Local permission model
src/write/       Guarded mutation primitives
src/auth/        OAuth 2.1 and token handling
src/pairing/     One-time pairing codes
src/workspace/   Path policy, search, Git
src/tunnel/      Cloudflare tunnel integration
src/execution/   Recorded execution/test evidence
src/process/     Process lifecycle
src/cli/         c2c CLI
skill/           Codex Skill
```

## Upstream, status, and license

C2C Local is an independent fork maintained by RomioLA and based on [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt). Upstream attribution is intentionally preserved; installation and normal development for C2C Local should use this repository.

Current implemented scope includes the local permission model, Windows production/runtime recovery, Host Observation V1, and secure nested Git repository/worktree targeting.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

[MIT](LICENSE)
