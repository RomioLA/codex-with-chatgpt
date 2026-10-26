# Troubleshooting

For startup recovery, use the explicit local recovery command:

```
c2c restore -w <workspace> --json
```

It reuses or starts the workspace Bridge and restores the configured tunnel
without changing the saved tunnel preference. It never generates a pairing code,
revokes OAuth tokens, or changes ChatGPT connector settings. `c2c doctor` defaults
to auto-repair and may update the Codex sandbox allowlist, start or restart Bridge,
start an explicitly stopped Named Tunnel (Quick Tunnel follows its existing health gate), or write endpoint metadata. `c2c doctor --no-fix` and `c2c status --json`
are read-only. A healthy
public self-probe only confirms that the C2C `/health` endpoint answered; it
does not prove ChatGPT authentication or a connector tool call succeeds.

## Common situations

### MCP `-32603 Internal error` or C2C tools unavailable

`-32603` alone does not prove that the local Bridge exited. Separate the failure
layer: a ChatGPT platform/tool invocation rejection means the request did not
reach C2C; a structured `INSUFFICIENT_SCOPE`, `LOCAL_PERMISSION_DENIED`, or
Git policy error means the request reached C2C and was rejected by authorization
or policy; a Bridge stop/unresponsive identity, Tunnel connectivity problem, or
connector configuration problem needs separate evidence. Do not relabel an
OAuth, permission, or Git policy refusal as an outage.

If all C2C tools are offline, local Codex can recover through an independent
local path; it does not need to call C2C to recover C2C, and Remote is not a
required step. Use only an existing trusted Runtime/Launcher or installation
handoff record:

1. Read the relevant Windows Task Scheduler Action and WorkingDirectory, or use
   the existing official Launcher's read-only **Check** action for the workspace
   it is configured to manage. This query only reads existing task actions:

   ```powershell
   Get-ScheduledTask -ErrorAction SilentlyContinue |
     Where-Object { $_.TaskName -like 'C2C-Workspace-Autostart-*' } |
     Select-Object -First 16 |
     ForEach-Object { $task = $_; $task.Actions | ForEach-Object {
       [pscustomobject]@{ TaskName = $task.TaskName; Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory }
     } } | Format-List | Out-String -Width 2000 | ForEach-Object { $_.Substring(0, [Math]::Min($_.Length, 6000)) }
   ```
   For the repository's official Task launcher, the selected Action's last
   argument is a base64url JSON payload. This reads the selected task payload
   only; it does not run the Action or a candidate CLI:

   ```powershell
   $task = Get-ScheduledTask -TaskName '<exact task name from the read-only list>' -ErrorAction Stop
   if (@($task.Actions).Count -ne 1) { throw 'Task action is not unique.' }
   $action = @($task.Actions)[0]
   $tokens = [regex]::Matches([string]$action.Arguments, '[A-Za-z0-9_-]{40,}')
   if ($tokens.Count -lt 1) { throw 'Task payload was not found.' }
   $encoded = $tokens[$tokens.Count - 1].Value.Replace('-', '+').Replace('_', '/')
   $encoded += '=' * ((4 - $encoded.Length % 4) % 4)
   $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json -ErrorAction Stop
   if ($payload.version -ne 1 -or $payload.workspaceId -notmatch '^[a-f0-9]{12}$' -or
       -not [IO.Path]::IsPathRooted([string]$payload.workspaceRoot) -or -not [IO.Path]::IsPathRooted([string]$payload.stateDir)) { throw 'Task payload identity is invalid.' }
   $runtimeRoot = [IO.Path]::GetFullPath([string]$action.WorkingDirectory)
   $c2cNode = Join-Path $runtimeRoot 'node\node.exe'
   $c2cCli = Join-Path $runtimeRoot 'dist\cli\index.js'
   if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) { throw 'Runtime root is missing.' }
   if ((Get-Item -LiteralPath $runtimeRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime root reparse point rejected.' }
   foreach ($file in @($c2cNode, $c2cCli, (Join-Path $runtimeRoot 'dist\autostart\task-launcher.js'), (Join-Path $runtimeRoot 'assets\c2c-autostart-task.cmd'))) {
     if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Runtime file missing: $file" }
     if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime reparse point rejected: $file" }
   }
   [pscustomobject]@{ WorkspaceId = $payload.workspaceId; WorkspaceRoot = $payload.workspaceRoot; StateRoot = $payload.stateDir; RuntimeRoot = $runtimeRoot; Node = $c2cNode; Cli = $c2cCli; Command = $action.Execute }
   ```

   These paths are candidates only. Do not run that Node/CLI until the Runtime
   root and workspace association pass the original trusted install record or
   the existing official Launcher's validation.
2. Match the task/registration to the exact intended workspace path and ID.
   Verify the effective state root (`C2C_STATE_DIR` or the Task payload value),
   Runtime root, bundled Node, CLI entry point, task working directory and
   launcher arguments refer to the same installed Runtime. The existing Task
   Launcher contract binds Node, `dist/cli/index.js`, and launcher to one
   Runtime; the repository's Permission Launcher validates its configured
   workspace and protected Runtime path and rejects reparse points. Use the
   original installation handoff/Launcher path checks as evidence. A state
   folder, task name, PATH hit, source checkout, directory/version string, or
   `node --version` by itself does not establish Runtime authority.
3. Only after trusted installation/Launcher evidence associates the Runtime,
   workspace, and state root, run `status -w <workspace> --json` from that same
   Runtime. Confirm `diagnostics.workspace.id` against the trusted installation
   record. Read `diagnostics.bridge.status` as the Bridge observation; when
   running, cross-check top-level `workspaceId`, `pid`, and `port` against
   `diagnostics.bridge.pid/port`. Stop if the Bridge is uncertain, the top-level
   state is `unknown`, or any identity is inconsistent. This is the current read-only diagnostic
   and does not migrate permission state. Do not use `permission status` for
   this preflight: it can acquire a write lock, create the permissions
   directory, migrate a legacy permission file, and write the Level1 baseline.
   Run `restore -w <workspace> --json` once, explicitly, only when the status
   result calls for recovery. The canonical PowerShell example is in the
   `c2c-local` Skill; do not maintain duplicate copies here. The public CLI has
   no general Runtime-install discovery command, and the repository Launcher's
   discovery is scoped to its configured workspace and its Check action is not
   a restore command.
4. If no matching Launcher/task/installation record exists, or workspace,
   state root, Runtime paths, or file identity do not match, stop and report the
   specific missing evidence. Ask the local maintainer to provide the trusted
   installation record or repair the official installation. Do not try a PATH
   or old source CLI, change the task, kill a process, delete state, reset
   permissions, re-pair OAuth, or change Tunnel preference. Remote remains an
   independent fallback where appropriate; it cannot override an execution
   environment refusal.

The source Skill or a committed V1.5 change does not prove that this machine's
Runtime has been deployed. Check the actual installed Runtime evidence before
claiming a new source feature is available.

### "Bridge 未运行"
Use the explicit `c2c restore -w <workspace> --json` action when recovery is
intended. The default `c2c doctor` can auto-repair and is not a read-only status
command. Use `c2c doctor --no-fix --json` for read-only diagnostics. A Named
Tunnel confirmed connected with a matching hostname is not restarted when only
the public `/health` probe is degraded; a confirmed-stopped Named Tunnel may be
started by auto-repair, while disconnected/unknown state is not auto-started.
Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If `status` or `doctor --no-fix` says the Bridge state is **uncertain** (无法确认),
do not start a second Bridge or delete the ChatGPT connector. Treat identity as
unknown, collect the reported local diagnostics, and ask the local maintainer to
confirm Runtime/Bridge identity. Do not use default auto-repair doctor as a
read-only retry.

### Codex Web GPT launcher or model catalog is missing

This repository installs the Codex Skill and the C2C Bridge. It does **not**
ship the separate `Codex Web GPT` desktop launcher or the native Codex model
catalog UI. If that launcher says **Install into Codex / 安装到 Codex** is
incomplete, separate route installation from catalog verification:

- The launcher can successfully write its local `openai_base_url` route while
  the existing Codex process is still using the old configuration.
- Fully quit Codex, including its background/tray `ChatGPT.exe` process on
  Microsoft Store Windows installations, then reopen it. Closing only the
  window is not a restart. Keep the launcher open while it verifies the
  catalog.
- Repeating the install step does not reload an already-running Codex process.
  It only writes the same route again and can reset the pending verification
  state.

For the C2C repository itself, verify the checkout and installed Skill path,
rebuild with `corepack pnpm install && corepack pnpm build`, then run:

```
c2c doctor --no-fix --json -w <workspace>
c2c status --json -w <workspace>
```

If those checks are healthy but the separate Web GPT launcher or model picker
still fails, capture the OS, Codex version, launcher version, exact UI error,
and timestamp for the launcher issue. Do not change tunnel settings or delete
the saved route as a workaround: the launcher owns its route backup and is
expected to restore it when its Bridge is turned off.

### Everything was quit and ChatGPT can no longer connect
Run `c2c restore -w <workspace> --json` and inspect `diagnostics`.

- With a configured Named Tunnel, the hostname stays the same across restarts.
  A healthy restore keeps the saved connector endpoint and OAuth state, so no
  pairing or connector change is needed.
- With a Quick Tunnel, a restart can produce a different URL. The report marks
  `endpointStable: false`, `restartSafeConnector: false`, and reports
  `connectorEndpointChanged` when the active URL no longer matches the saved
  connector endpoint. The user must update that connector manually; C2C does
  not edit ChatGPT settings.

Use `c2c status --json -w <workspace>` to inspect Bridge, permission, tunnel
preference, active public URL, locally saved connector endpoint, OAuth token
count, and recovery reason without triggering a repair. C2C cannot read the
ChatGPT account's connector settings; endpoint matching compares local state
with the currently reachable tunnel.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Run `c2c status --json -w <workspace>` to inspect first, then run the explicit
`c2c restore -w <workspace> --json` if recovery is needed. Default `doctor`
also performs auto-repair; use `doctor --no-fix --json` for read-only diagnostics.
For a configured Named Tunnel, credential and hostname failures are reported
explicitly. Restore does not fall back to a Quick URL or change the connector.
When the Named Tunnel connection, Bridge/runtime identity, and configured
endpoint are reconfirmed, a degraded public self-probe (including
`ECONNRESET`) is diagnostic only: it does not trigger a restart, set recovery
to `actionNeeded`, or by itself produce exit code 1. That probe requests only
the Bridge `/health` route; it does not exercise OAuth or an MCP tool call. Do
not treat the probe failure as `hostnameUnavailable`; use an actual connector
call to check the end-to-end path. Quick Tunnel uses an independent health
decision and may report `quickTunnelFailed` when its public probe fails.
For a Quick Tunnel, compare the active public URL with `connectorEndpoint` and
update the ChatGPT connector manually if they differ. Do not generate a pairing
code during runtime recovery.

Named Tunnel startup retries only recognized transient DNS or network failures,
for up to six attempts and a 75-second total deadline. Permanent, unknown, or
credential failures stop without retrying. The retry policy is independent of
Quick Tunnel startup. A healthy Named Tunnel self-probe still reports only the
Bridge `/health` endpoint, not a successful connector request.

### `LOCAL_PERMISSION_DENIED` or a file operation is unavailable

To inspect current Bridge, workspace, and permission diagnostics without
permission migration, use `c2c status --json -w <workspace>`. The separate
`permission status` command may acquire a write lock, create the permissions
directory, migrate a legacy permission file, and write a Level1 baseline; do
not use it for a read-only offline recovery preflight. For the saved local
permission mode in ordinary maintenance:

```text
c2c permission status -w <workspace>
```

Change it only from the local machine with `c2c permission readonly`,
`c2c permission 1`, or `c2c permission 2`. OAuth scopes are a separate gate:
changing the local mode does not add mutation scopes to an existing token.
`level1` permits workspace file changes and permitted external reads;
`level2` adds workspace file deletion and external file changes. Deletion is
limited to one regular workspace file per call. External deletion and
cross-boundary moves are not available.

### Host Observation returns INSUFFICIENT_SCOPE or NOT_SUPPORTED

Every Host Observation tool call requires the explicit `system.read` OAuth
scope. The default grant excludes it, and refreshing an older token never adds
it. This source feature is not active in production; no restart or reauthorization
is needed now. A later activation requires separate authorization to deploy and
reauthorize the connector.

For a tool-level `NOT_SUPPORTED` error, check that the host is Windows and one
fixed PowerShell 7 executable candidate exists. The bundled Codex runtime is
accepted; a Program Files installation is not required. `path_inspect` also
returns tool-level `NOT_SUPPORTED` for targets other than regular files and
directories. A field-level `NOT_SUPPORTED` may be an intentional limit such as
Internet reachability or a reparse tag. `ACCESS_DENIED` and `UNAVAILABLE`
describe incomplete OS evidence, not proof that a process or path does not
exist. Path inspection never returns file contents, and the sensitive-path rule
rejects `.git` including owner inspection. See
[Host Observation V1](host-observation.md).

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.
Autostart recovery should use Named mode; Quick Tunnel is temporary and is not
restart-safe for an existing connector.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes. Generate one only
when the ChatGPT Authorize page is ready:

```
c2c pair
```

Older codes become invalid immediately. Do not mint a code during `c2c doctor`.

### Temporary address keeps dropping on a UDP-filtered network
cloudflared defaults to QUIC. If the tunnel reconnects over and over on a
corporate network, set `C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.
Leave it unset to keep cloudflared's default.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\OpenAI\c2c-local`). A non-empty `C2C_STATE_DIR` overrides the
default. Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `<codex-home>/config.toml`, where
`<codex-home>` is a non-empty `CODEX_HOME` when set, otherwise `~/.codex`
(`%USERPROFILE%\.codex` on Windows). After that, later chats do not need
elevation.

To explicitly import durable state from an older directory, use
`c2c state migrate --from <old-state-dir>`. It copies only recognized durable
settings, never overwrites conflicting destination files, excludes runtime
data and logs, and writes a completion marker so the same destination cannot
be migrated twice.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Fixed hostname is configured, but the Named Tunnel does not start on Windows
`cert.pem` and the Named Tunnel credential are different files. `cert.pem`
proves that `cloudflared` has an account certificate; the tunnel still needs
`%USERPROFILE%\.cloudflared\<TUNNEL-UUID>.json` (or the file selected by
`TUNNEL_CRED_FILE`) to run. `c2c doctor --no-fix --json` reports whether the certificate
is missing, the credential is missing or unreadable, the JSON is invalid, or
the saved Tunnel ID does not match. It never prints credential contents or
repairs the file automatically.

When the read-only diagnostic says the credential is missing, a local operator
may recover it for the existing Tunnel with `cloudflared tunnel token --cred-file`
only when that credential repair is explicitly authorized. Then rerun
`c2c doctor --no-fix --json` to confirm it is readable. Do not paste the
generated credential into ChatGPT or a project file. Recovery/restore does not
perform this credential repair.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### Completely stuck

First inspect with `status --json -w <workspace>` or the read-only
`doctor --no-fix --json -w <workspace>`. If the Bridge is confirmed stopped and
the formal Runtime/workspace association is known, run one explicit
`restore -w <workspace> --json`. If identity is uncertain, stop, preserve the
current process, and collect the reported diagnostics; do not start a second
instance or kill a PID. If C2C tools are offline, follow the independent
Runtime discovery and state-root checks above. Remote is an independent
fallback, not a prerequisite.

Do not use `setup` to repair an ordinary outage: it can configure Tunnel and
pairing. OAuth, pairing, Tunnel credentials/preferences, and connector changes
are separate repair actions and require explicit user authorization plus
evidence that they are the failing layer.
