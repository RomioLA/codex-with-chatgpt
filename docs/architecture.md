# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP + local policy │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  permission-gated file access
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Local permission gate**: file mutation tools require OAuth scopes and the
  persisted local mode. The bridge has no shell or command-execution tool.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | Read tools plus local-permission-gated file tools; stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, bounded image reads, ripgrep search with Node fallback, git status/diff with pagination, host path boundary |
| `permission/`, `write/` | Per-workspace local permission state and operation matrix; revalidated file mutation primitives |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `autostart/` | Windows logon registration, restore invocation, and diagnostic breadcrumbs |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, explicit durable-state migration, secret-redacting logger |

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler. File operations
then check OAuth scope, canonical path and sensitive-file rules, and the local
permission mode immediately before calling the synchronous file primitive.
Workspace moves recheck both workspace paths. External deletion is denied
before permission evaluation. `permission_status` only reports the local mode;
permission changes use the local CLI (`c2c permission readonly|1|2|status`).

**Local permissions**: new connections receive the read-only OAuth grant by
default. Mutation tools require explicitly granted scopes as well as the local
per-workspace mode. `readonly` blocks mutations; `level1` permits workspace file
changes and permitted external reads; `level2` adds workspace file deletion and
external file creation or modification. Deletion is limited to one regular
workspace file with its current hash. The current MCP set does not create
external directories or move files across the workspace boundary; external
deletion is always denied.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
whether the occupant is a c2c bridge for the same workspace (reuse) or not
(fall back to an ephemeral port). Configuration follows automatically via the
runtime state file; users never see ports.

**State and instance identity**: state defaults to the OS app directory;
Windows uses `%LOCALAPPDATA%\OpenAI\c2c-local`. A non-empty
`C2C_STATE_DIR` explicitly overrides that location. Each Bridge acquires a
per-workspace lock file below the active state root; a live PID alone is not
treated as proof that it owns a Bridge, and unverifiable locks fail closed.
The owner record is `bridge-instances/<workspaceId>.lock`; port scanning is
not the single-instance authority.
`c2c state migrate --from <path>` is an explicit one-time import of recognized
durable JSON under `auth/`, `permissions/`, `tunnels/`, `endpoints/`,
`autostart/`, and `prefs.json`. It excludes runtime, logs, sessions, executions,
and execution output; it does not overwrite destination files and records a
completion marker.

**Windows autostart**: the Registry Run backend stores a command capped at 240
characters that
starts a `.cmd` launcher under the C2C state directory. The launcher is
atomically published and restores the configured `C2C_STATE_DIR` before
starting the Bridge. Host Run access uses 64-bit `StdRegProv` against an
explicit `HKEY_USERS\<SID>` authority, rather than assuming the process
`HKCU` view is the interactive user's Run key. Backend changes publish a
pending registration first, verify the selected authority, and roll back the
Run value and launcher on failure; legacy caller-view cleanup is checked
against the host view before the transition is marked stable.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails during initial setup, C2C may fall back to Quick Tunnel. Once
the named preference is saved, runtime recovery never silently switches to a
Quick URL. `c2c restore -w <workspace> --json` reuses or starts the Bridge,
restores the configured tunnel, checks the public health endpoint, and reports
whether the saved connector endpoint still matches. It does not pair again,
change ChatGPT settings, revoke tokens, or recreate AuthStore. A missing or
invalid named credential is reported as an action needed. Quick URLs are marked
unstable and are not restart-safe for an existing connector.

Named startup retries only classified transient DNS or network failures, using
up to six attempts and a 75-second total deadline (default delays: 2, 4, 8, 16,
and 16 seconds). A permanent or unclassified failure stops immediately; this
retry policy is independent of Quick Tunnel startup. The public self-probe
checks the C2C `/health` response; it does not prove that ChatGPT can
authenticate or complete a connector tool call. For a confirmed Named Tunnel,
if Bridge/runtime identity, configured endpoint, and tunnel connection remain
valid, a degraded public probe (including `ECONNRESET`) is diagnostic only: by
itself it does not trigger restart, mark restore as `actionNeeded`, or set a
nonzero exit code. Quick Tunnel health still uses the public probe to detect
`quickTunnelFailed`.
