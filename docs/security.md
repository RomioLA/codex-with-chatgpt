# Security Model

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output exposure | ChatGPT can start only a bounded recipe approved in C2C's local trusted-command policy. Per-stream sanitizers handle chunk boundaries, UTF-8 splits, token patterns, long values, and private-key blocks; stdout and stderr stay independent, so a secret split across both streams is not guaranteed to be detected. Output size is capped and restricted streams are listed without a body. This sanitizer is not a malicious-code data-exfiltration boundary. |
| Generated media handoff | `read_image` is a read-only inspection tool. The local executor imports the original browser download into a new workspace-relative path; signatures, size, containment and SVG active-content checks are enforced, and existing files are never overwritten. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

The default grant remains read-only: `workspace.read`, `workspace.search`,
`git.read`, `execution.read`, and `offline_access`. Optional mutation scopes
are `workspace.write`, `workspace.delete`, `filesystem.external.read`, and
`filesystem.external.write`. Tools enforce scopes individually
(`INSUFFICIENT_SCOPE`); explicitly requested scopes never gain unrequested
capabilities. A mutation also needs the local permission mode to allow it.
`system.read` is an additional, explicitly requested read-only scope for Host
Observation; it is not in the default grant or the mutation set. Refresh rotation
preserves the refresh token's stored scopes and never adds this scope. Scope
filtering continues to drop unknown names; a request with no supported scopes
is rejected.
Access tokens live for 1 hour. Refresh tokens live for 30 days and rotate on
use. All tokens are bound to `workspace_id` and `client_id`.

## Bounded execution

The execution tools can start a named test, build, lint, typecheck, or package
script recipe only when C2C's managed local trusted-command policy has approved
that repository, target, package manager, and script material. MCP requests and
model output cannot create or change that authority. Editing `package.json`
does not approve a new recipe. The approved recipe authority is held in C2C's
managed trusted-command store, outside the repository.

`EXECUTED_MATERIAL_IDENTITY` for V1.2 means these specific checks: repository
root and Git/worktree directory identities are locked; the Git entry is
identity/hash checked; the workspace `package.json` is hash checked and held
open against replacement; the approved recipe is
matched to the trusted-command record; the selected `node.exe` and selected
npm or pinned pnpm CLI entry each have a discovered file identity and SHA-256,
then are opened by handle, identity/hash checked by the native helper before
process creation, and kept locked against write/delete/rename through Resume.
The helper checks that these locks remain effective before Resume; it does not
re-hash the files at that point. For npm this includes
`npm-cli.js`, `npm/lib/cli.js`, `npm/lib/cli/validate-engines.js`, and
`npm/lib/cli/entry.js`, `npm/lib/cli/exit-handler.js`, `npm/lib/npm.js`, and
the npm `package.json`. The pinned pnpm launch chain includes
`bin/pnpm.cjs`, `bin/pnpm.mjs`, and `dist/pnpm.mjs`; the final bundled file is
hashed as one material, with its `package.json`. The native helper and its fixed
launcher must match SHA-256 values generated by the C2C build and packaged with
the distribution. The launcher opens the helper with a handle that denies write
and delete sharing, verifies its final path, SHA-256, PE format, and file
identity, and keeps that handle open while it calls `CreateProcessW` with the
fixed absolute helper path. It also holds handles on the helper path's directory
chain without delete sharing, so the path cannot be renamed, replaced, or
redirected through a reparse point during process image creation. A Windows race
test observes these locks and verifies that the authorized helper identity and
hash remain present through process creation. This binds the helper object
checked by the launcher to the image opened by `CreateProcessW` under Windows
file-sharing rules; the launcher itself is part of the C2C distribution trust
root and must be protected from untrusted writes. The build output supplies
expected hashes and the protected C2C distribution is the authority. Missing or
mismatched metadata or artifacts fail closed. The metadata does not independently
authenticate an installation if an attacker can replace the launcher and
metadata together.

The pinned pnpm invocation sets `verify-deps-before-run=warn`. If workspace
dependencies are missing or stale, pnpm warns and continues to the named
recipe instead of spawning an implicit `pnpm install` through ambient command
search. Dependency installation is outside this bounded recipe launch.

Execution temp cleanup is an internal owned-resource operation, not a general
file-delete capability. Its request is derived from a fixed state-root
`execution-temp/tmp-<jobId>` path and must match the workspace/job record,
random ownership nonce, root identity, directory identity, creation time, and
marker contents plus a separate ownership record in the Job Store directory.
A narrow native helper validates the fixed C2C state-root layout, holds Windows
directory handles without delete sharing, verifies identities, checks each
enumerated child identity before deletion, and deletes entries by handle without
following reparse points. MCP parameters and repository content cannot supply
an absolute cleanup target. Unowned, stale-unverified, or replaced directories
are preserved and reported. Platforms without this identity-bound Windows
cleanup primitive fail closed rather than falling back to path-based recursive
deletion. Existing V1 root markers remain readable during upgrade, but they do
not authorize cleanup of legacy job directories; cleanup still requires the
persisted per-job nonce, sidecar, creation metadata, and current file identities.

This contract binds the named CLI entries and npm's direct bootstrap chain, not
every file Node or npm may load later. Modules loaded after
`npm/lib/cli/entry.js`, Node built-ins, and runtime dependencies are not
recursively hashed or cryptographically frozen in V1.2. The listed pnpm bundle
is hashed as a whole file; later external modules, Node built-ins, and files
loaded by project scripts are outside that binding. Do not read this contract
as immutability of the whole Node runtime, package-manager installation,
repository, or project dependency graph. Runtime hashes are measured from the
selected installation during discovery; they are not vendor signatures or
known-good publisher hashes. A malicious Node/npm/Corepack installation already
present at discovery is accepted as the selected baseline, so the selected
runtime installation itself remains a trust input and must be managed by the
local operator.

C2C does not expose an arbitrary Shell MCP or caller-supplied command string.
An approved package script can still invoke Shell and execute project code with
the local account's available access. Windows Job Objects contain process
lifecycle only; they are not a filesystem sandbox, network sandbox, privilege
sandbox, or malicious-code sandbox.

Streaming sanitization treats stdout and stderr as separate streams to preserve
stream identity and byte-offset pagination. It detects covered patterns across
chunks within each stream, but it cannot promise detection when secret fragments
are divided between stdout and stderr. Minimal environment-variable exposure
reduces accidental disclosure; the sanitizer does not stop malicious project
code from exfiltrating data through other channels or from shaping output to
evade its patterns.

## Host Observation

The seven Host Observation tools fail closed unless the current MCP call has
`system.read`, including local transports. This OAuth gate is independent of the
local file permission mode: `system.read` does not grant file mutation, change
the Windows account's OS permissions, or bypass the existing sensitive-path
policy. Each tool is annotated read-only. Results are untrusted diagnostic data.

Windows queries use a fixed, source-controlled PowerShell 7 script through
`execFile` without a shell. Only a fixed executable candidate is selected: the
Program Files PowerShell 7 path or the existing Codex bundled runtime path.
Caller values are serialized as JSON on stdin; they are not inserted into the
script or executable arguments. The implementation does not search PATH or the
current directory and does not download/install PowerShell. Generic failures
return a sanitized error rather than raw stderr or exception text.

Process results are non-atomic CIM snapshots. Missing or access-denied fields
are not proof that a process is absent; listener-to-process association comes
from a separate snapshot and is marked unverified. Command-line credentials are
redacted before output and before `commandContains` filtering, so that filter
cannot be used as an oracle for hidden secret values.

Network status reports adapters, configured DNS servers, and default-route
presence as readiness evidence only. It sets `internetReachable` to null with
`NOT_SUPPORTED` status; it does not establish Internet access or probe public
HTTP. Adapter, address, and DNS lists are bounded and expose truncation.
`dns_resolve` performs only a system-configured DNS lookup for a validated ASCII
hostname; it does not make HTTP or TCP requests.

`path_inspect` returns path metadata only and never reads file contents. It
accepts local-drive absolute and workspace-relative paths; UNC/device paths and
alternate data streams are rejected. The existing sensitive-path policy still
applies to both aliases and canonical targets. In particular, `.git` is
explicitly sensitive, so this tool cannot inspect its owner. The reparse tag
field is null with `NOT_SUPPORTED` status. Supported metadata is read from one
native Windows handle and bound to its file/volume identity before returning;
an identity mismatch suppresses the metadata. Owner/ACL errors remain explicit
in fieldStatus rather than being presented as missing paths. See
[Host Observation V1](host-observation.md) for the exact handle and status contract.

The source implementation is registered in this checkout, but production
activation is not part of this change. No production restart or OAuth
reauthorization is needed now. Enabling it later requires separate user
authorization for deployment and connector reauthorization; existing refresh
tokens will not gain `system.read`. See [Host Observation V1](host-observation.md)
for the full schema and status contract.

## Local file permissions

Permission mode is stored per workspace under the active C2C state directory.
Missing, malformed, mismatched, or unsupported permission state falls back to
`readonly`. The local CLI accepts `c2c permission readonly|1|2|status`; the MCP
`permission_status` tool only reads the mode and cannot change it.

`readonly` permits workspace reads only. `level1` permits workspace file
creation and modification, workspace moves, and non-sensitive external reads.
`level2` adds workspace deletion and external file creation or modification.
Current deletion is one regular workspace file per call, guarded by its
expected content hash. Moves are workspace-to-workspace only. Directory
creation is workspace-only. External deletion is a hard deny in every mode.
OAuth scope checks remain independent, so a local mode alone does not grant a
token a new scope.

## Storage

State lives under the OS-convention app directory: Windows
`%LOCALAPPDATA%\OpenAI\c2c-local`, macOS
`~/Library/Application Support/codex-with-chatgpt`, and Linux
`$XDG_STATE_HOME/codex-with-chatgpt` (or `~/.local/state/codex-with-chatgpt`).
A non-empty `C2C_STATE_DIR` explicitly overrides the platform default. Directory
and file modes request 0700 and 0600 where the filesystem supports those bits.
Permission state, the per-workspace Bridge lock, named-hostname preference, and
tunnel metadata live there, never in the project. Only SHA-256 token hashes
are persisted; a stolen state file does not yield usable bearer tokens.

`c2c state migrate --from <path>` explicitly imports recognized durable JSON
from `auth/`, `permissions/`, `tunnels/`, `endpoints/`, and `autostart/`, plus
`prefs.json`. It excludes runtime files, logs, sessions, executions, and
execution output. The source must be a separate existing state directory with
recognized entries; source and destination must be separate, non-nested paths,
and the destination cannot traverse a symlink or junction. Destination files
are never overwritten: matching files are reported as already present, while
conflicts stop the migration. A completion marker prevents a second migration
into the same destination. On failure, the migrator attempts identity-checked
rollback of objects it created. If another process changes the filesystem or
object identity cannot be verified, full rollback is not guaranteed; the
migrator reports the failure and avoids deleting unverified paths.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## What ChatGPT cannot do through C2C (V1)

Run arbitrary shell commands, commit, or install packages through an MCP tool:
C2C exposes no such tool. An approved package script can invoke shell commands
as project code under the local user's account.
ChatGPT also cannot change the local permission mode through MCP. File
mutations exist, but each is gated by both an OAuth scope and the local mode;
external deletion remains unavailable even in `level2`. Workspace deletion is
limited to one regular file with an expected content hash. These rules do not
turn the Bridge into an OS sandbox: local processes with access to the files
remain outside this MCP policy boundary.
