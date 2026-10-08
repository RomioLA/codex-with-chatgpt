# Host Observation V1

Host Observation adds seven bounded, read-only MCP tools for host identity,
processes, network state, DNS resolution, and path metadata.

## Rollout and authorization

The implementation is present and registered in this source tree; production
activation is not part of this change. No production restart or OAuth
reauthorization is needed now. Enabling it later requires separate user
authorization to deploy and reauthorize the connector.

Every tool call independently requires the OAuth scope `system.read`, including
local transports. The scope is not in `DEFAULT_SCOPES`. Existing refresh tokens
keep their stored scope set, so refresh never adds `system.read`. This scope is
separate from the local file permission mode: it does not permit file mutations,
elevate the Windows process, or bypass operating-system access checks and
sensitive-path rules. All seven tools are annotated read-only; their results
remain untrusted diagnostic data.
OAuth authorization still filters unknown scope names and rejects requests
that contain no supported scopes.

## Tool inputs and limits

All schemas are strict and reject unknown properties. Text filters are 1–1024
characters and reject control characters unless a tool has a narrower rule.

| Tool | Input and bounds | Default / behavior |
| --- | --- | --- |
| `host_context` | Empty object | Reports host platform/version/architecture, host PID, effective state root, and available identity fields; it does not dump environment variables. |
| `process_query` | At least one of `pid`, `name`, `parentPid`, `exePath`, `commandContains`, `sessionId`; PID-like values are integers from 0 to 4,294,967,295. | `limit` defaults to 50, maximum 200. The Windows CIM provider caps its snapshot at 4,096 processes. Redacted `commandLine` values are capped at 8,192 characters. |
| `process_tree` | Required `pid`; `direction` is `ancestors`, `children`, or `both`; optional `processKey`. | Direction defaults to `both`; `depth` defaults to 4 (range 1–8); `limit` defaults to 50 (range 1–100). |
| `network_listeners` | Optional PID, `port` 1–65,535, `protocol` `tcp`/`udp`, and address. | `limit` defaults to 50, maximum 200. Reports TCP LISTENING and UDP endpoints. |
| `network_status` | Empty object | Up to 64 adapters, 32 addresses per adapter, and 64 DNS server addresses; exposes truncation. Reports configured default-route presence, not reachability. |
| `dns_resolve` | One `hostname`, 1–253 characters; runtime validation requires an ASCII DNS hostname, not an IP literal. | Uses system-configured DNS; returns up to 64 unique addresses. It makes no HTTP or TCP request. |
| `path_inspect` | One `path`, 1–32,767 characters. | Metadata only for regular files/directories. Accepts local-drive absolute or workspace-relative paths. Returns identity, attributes, owner SID, and a bounded ACL summary when available. |

The process tree uses PID plus start time as a process identity key and can
reject a stale key. Listener rows and process details are captured separately,
so PID association is best effort and marked `SNAPSHOT_UNVERIFIED`.

## Evidence and privacy limits

Process data is a non-atomic CIM snapshot. Fields may be missing or inaccessible;
`UNAVAILABLE` or `ACCESS_DENIED` is not evidence that a process exited. Results
carry partial/truncated indicators when the source cannot provide a complete
snapshot. `processExited` is true only when a PID is absent from a complete
snapshot; it is false when the PID exists but another requested filter does not
match, and null when a truncated snapshot cannot establish whether it was
present. When CIM returns an empty field and the reason cannot be established,
the field status is `UNAVAILABLE`; do not infer `ACCESS_DENIED`.

Command-line credential-like values are redacted before they are returned and
before filtering, then the redacted value is capped at 8,192 characters.
`commandContains` searches only the redacted representation,
so callers cannot test whether a hidden secret substring exists. The filter is
case-insensitive.

`network_status` returns configuration evidence only. Its `internetReachable`
value is null and its field status is `NOT_SUPPORTED`. A default route or DNS
server list does not prove Internet access. `dns_resolve` is the only tool here
that performs a network lookup, and it only resolves the supplied validated
hostname through system DNS.

`path_inspect` never reads file contents. UNC paths, Windows device namespaces,
and alternate data streams are not supported. Existing mandatory and
workspace-specific sensitive-path policies apply to the requested path and its
canonical target. In particular, `.git` is on the mandatory sensitive list, so
path inspection rejects it before metadata lookup; Host Observation cannot
investigate a `.git` owner.

For a supported path, Windows opens one native handle with
`OPEN_REPARSE_POINT` and `BACKUP_SEMANTICS`, then reads file identity,
attributes, owner, and DACL summary from that same handle. It compares the
handle's volume/file identity to the Node path identity, then rechecks the
canonical path and entry identity; a mismatch returns `PATH_CHANGED` and
suppresses all metadata. If the handle opens without `READ_CONTROL`, identity
and attributes can still be returned while `owner` and `aclSummary` are null
with `ACCESS_DENIED` field statuses. The owner is returned as a SID without
account-name translation; the ACL summary contains only protection state,
explicit/inherited ACE counts, and whether the DACL is null. It does not expose
full ACL entries or SDDL. `nullDacl` cannot distinguish a missing DACL from an
explicit null DACL. Missing paths return nullable metadata fields with
`UNAVAILABLE` status; permission failures are null with `ACCESS_DENIED`, and
other field-level failures retain their `UNAVAILABLE` status.

The `reparseTag` field is null with `NOT_SUPPORTED` status. A verified
symlink/junction may return its canonical target; other reparse points expose
the reparse attribute but report the target as `NOT_SUPPORTED`. Missing or
unavailable metadata values remain present as null with a corresponding
`fieldStatus` such as `UNAVAILABLE` or `ACCESS_DENIED`.

PowerShell 7 queries run through `execFile` with a fixed, source-controlled
script and no shell. The script is passed as a fixed encoded command; request
data is JSON on stdin and is never inserted into the script or process
arguments. Executable selection checks only these fixed candidates:

- `%ProgramFiles%\PowerShell\7\pwsh.exe`
- `<user-home>\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`

The bundled Codex runtime is supported; installing PowerShell under Program
Files is not required. The code does not search PATH/current directory or
download an executable. Queries are limited to four concurrent calls, 15
seconds, and a 4 MiB output buffer. Unsupported platforms or missing candidates
return `NOT_SUPPORTED`. Raw stderr and generic exception details are not
returned to MCP callers.
