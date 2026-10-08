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
| Execution output leak | Codex may nominate test/build/lint logs; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. ChatGPT still cannot run commands. |
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

Run shell commands, commit, or install packages: C2C exposes no such tool.
ChatGPT also cannot change the local permission mode through MCP. File
mutations exist, but each is gated by both an OAuth scope and the local mode;
external deletion remains unavailable even in `level2`. Workspace deletion is
limited to one regular file with an expected content hash. These rules do not
turn the Bridge into an OS sandbox: local processes with access to the files
remain outside this MCP policy boundary.
