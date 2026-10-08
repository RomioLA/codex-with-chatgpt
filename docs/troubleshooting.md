# Troubleshooting

For startup recovery, use the explicit local recovery command:

```
c2c restore -w <workspace> --json
```

It reuses or starts the workspace Bridge, restores the saved tunnel preference,
and checks the public health endpoint. It never generates a pairing code,
revokes OAuth tokens, or changes ChatGPT connector settings. `c2c doctor` remains
the broader diagnostic command; `c2c status --json` is read-only. A healthy
public self-probe only confirms that the C2C `/health` endpoint answered; it
does not prove ChatGPT authentication or a connector tool call succeeds.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

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
c2c doctor --json -w <workspace>
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
Run `c2c restore -w <workspace> --json` or `c2c doctor --json -w <workspace>`.
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

Check the workspace's saved local mode:

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
`TUNNEL_CRED_FILE`) to run. `c2c doctor --json` reports whether the certificate
is missing, the credential is missing or unreadable, the JSON is invalid, or
the saved Tunnel ID does not match. It never prints credential contents or
repairs the file automatically.

When the diagnostic says the credential is missing, recover the credential for
the existing Tunnel with `cloudflared tunnel token --cred-file` and then run
`c2c doctor` again. Do not paste the generated credential into ChatGPT or a
project file.

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
```
c2c stop
c2c setup
```

re-creates the bridge, tunnel and pairing session from scratch. Existing
authorizations stay valid unless you also ran `c2c unpair`.
