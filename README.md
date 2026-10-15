# C2C Local

> Local-first ChatGPT ↔ Codex bridge with permissioned workspace access.
> ChatGPT reasons and reviews. Through C2C Local it can also start bounded execution recipes that a local operator explicitly approved.

[简体中文](README.zh-CN.md)

This repository is **RomioLA's C2C Local fork** of [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt). It keeps the original bridge concept and adds a stronger local permission model, Windows runtime recovery, bounded host diagnostics, and secure nested Git/worktree targeting.

## What C2C Local does

- Connects ChatGPT to a local workspace through an OAuth-protected MCP bridge.
- Reads workspace files, images, search results, Git state, and recorded execution/test results.
- Supports permission-gated file creation, editing, replacement, movement, and limited deletion.
- Supports permitted reads/writes outside the workspace without exposing unrestricted host filesystem access.
- Targets nested repositories and Git worktrees with `git_info(repository_path)`, `git_status(repository_path)`, and `git_diff(repository_path)`.
- Exposes bounded, read-only Windows Host Observation for process, listener, network, DNS, path, and host context inspection.
- Starts locally approved, bounded test/build/lint/typecheck or named package-script recipes through the execution tools.
- Includes Windows bridge/tunnel state handling, recovery, and autostart support.
- V1.3 development adds structured Git writes and separately enabled Level 3 PowerShell 7 / CMD / local program execution, with local approval of each exact command.
- Does not expose remote elevation, an unrestricted shell, or arbitrary Git arguments. V1.3 is not deployed to Production; see the [V1.3 stage report](docs/v1.3-stage-report.md).
- The adversarial-review fixes bind literal scripts, enforce revocable native launch permits, use fixed-tree commit/ref CAS and retain audit history through safe rotation. See the [security repair report](docs/v1.3-security-fix-report.md) for remaining Beta gates. Current single-command CLI approval does not define the future session/terminal authorization model.

Execution approval is held in C2C's local trusted-command policy. A package script is execution material; changing `package.json` never approves a new recipe. Windows Job Objects contain process lifetime only. They do not sandbox filesystem, network, privileges, or untrusted project code; an approved package script still executes project code.

For Windows execution, C2C binds repository and Git/worktree identities, the workspace `package.json` hash and approved recipe, the selected `node.exe` identity and SHA-256, and named package-manager startup material. The npm set includes `npm-cli.js`, `lib/cli.js`, `lib/cli/validate-engines.js`, `lib/cli/entry.js`, `lib/cli/exit-handler.js`, `lib/npm.js`, and npm's `package.json`. The pinned pnpm set includes `bin/pnpm.cjs`, `bin/pnpm.mjs`, `dist/pnpm.mjs`, and pnpm's `package.json`; duplicate path fields resolve to the same locked object. Each named runtime file is checked by identity and SHA-256. The workspace manifest is checked by hash and held open against replacement. The C2C build generates distribution metadata with SHA-256 values for both the native helper and its fixed launcher. Before starting the helper, the launcher opens and verifies the helper by handle, then keeps a no-write/no-delete file handle and locks its path directories while it calls `CreateProcessW` with that fixed absolute path. Under Windows file-sharing rules, this binds the verified helper file to the image opened during process creation. The launcher is part of the C2C distribution trust root: deployment must protect the distribution code directory from untrusted writes. The packaged metadata detects mismatched build artifacts but does not authenticate a distribution if an attacker can replace the launcher and metadata together. The helper reopens and locks the named runtime materials, checks their identities and hashes, then creates the child suspended and resumes it only after validation. The pinned pnpm invocation uses `verify-deps-before-run=warn`, so C2C does not trigger a separate implicit `pnpm install`; the named recipe runs against dependencies already available in the workspace. npm modules loaded after the listed bootstrap files, Node built-ins, and later external modules are not recursively frozen. The contract does not claim whole-runtime or whole-project cryptographic immutability. The output sanitizer is a formatting and secret-pattern filter, not a malicious-code data-exfiltration boundary.

## Permission model

C2C Local uses a machine-side permission mode in addition to OAuth scopes:

| Mode | Main behavior |
| --- | --- |
| `readonly` | Persistent baseline; read-only workspace access. |
| `level1` | Persistent baseline; workspace create/edit/replace/internal move plus permitted external text reads. |
| `level2` | Temporary elevation for the current Windows logon session; adds limited workspace deletion and permitted external create/edit/replace. Logout or reboot returns to the persistent baseline. External deletion remains blocked. |

Check or change the local mode from the machine:

```text
c2c permission status -w <workspace>
c2c permission readonly -w <workspace>
c2c permission 1 -w <workspace>
c2c permission 2 -w <workspace>
```

`permission 2` sets the persistent baseline to `level1` and adds a current Windows session grant. CLI and MCP status expose `baselineMode`, `effectiveMode`, and `sessionElevation.active`, never the underlying identity. If Windows boot, user SID, session ID, or token logon ID cannot be confirmed, access falls back to the baseline. Missing or malformed state remains `readonly`; a new workspace must be initialized locally with `permission 1`. Sensitive-file rules, canonical path containment, OAuth scopes, and operation-specific checks remain independent gates.

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
    | permission-gated workspace / Git / host observation / bounded execution
    v
Local Workspace  ---- C2C native helper ---- locally approved recipe
```

ChatGPT can inspect and modify authorized files through C2C Local and start locally approved bounded recipes. V1.3 development also adds repository-policy-controlled Git writes and single-use Level 3 approvals bound to the exact command digest.

## Security boundaries

- Public MCP access requires OAuth; knowing the endpoint URL is not enough.
- Tokens are workspace-bound.
- Sensitive files such as credentials, keys, SSH material, and `.env*` are denied by default, with `.env.example` allowed.
- `.c2cignore` can add project-specific exclusions.
- File mutation requires both OAuth scope and the local permission mode.
- V1.2 execution tools still accept only named, locally approved recipes. V1.3 adds separate opt-in `git.write` and `execution.level3` scopes; repository grants and exact-command approvals are managed only by the local CLI. Existing tokens gain no new scopes on refresh.
- An approved package script can still invoke shell commands and project code with the local account's available access. Windows Job Objects contain process lifecycle only; they do not sandbox files, network access, privileges, or malicious code.
- Runtime integrity binds the selected Node executable; npm's `npm-cli.js`, `lib/cli.js`, `lib/cli/validate-engines.js`, `lib/cli/entry.js`, `lib/cli/exit-handler.js`, `lib/npm.js`, and `package.json`; or pinned pnpm's `bin/pnpm.cjs`, `bin/pnpm.mjs`, `dist/pnpm.mjs`, and `package.json`. It also binds the workspace package manifest and approved recipe record held outside the repository. These hashes detect changes after runtime discovery; they do not authenticate the publisher or detect already-malicious bytes in the selected Node/npm/Corepack installation, and they do not freeze every later module or dependency.
- The helper and fixed launcher SHA-256 values come from C2C build/distribution metadata. The launcher holds the verified helper file and its path directories against write, rename, and replacement through `CreateProcessW`; deployment must protect the launcher and the rest of the C2C distribution code directory. The metadata does not authenticate a distribution whose launcher and expected metadata can both be replaced.
- Output sanitization is an output hygiene measure, not a malicious-code data-exfiltration boundary.

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
