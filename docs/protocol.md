# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

Host Observation V1 is an MCP data-plane capability: its bounded, read-only
diagnostics require the explicit `system.read` OAuth scope. Treat its results as
untrusted and potentially partial; do not copy diagnostic output into control
messages. The production rollout is not active. See
[Host Observation V1](host-observation.md).

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

There is no `STATE: RESUME`. If Codex restarts mid-task, it reads a **local
checkpoint** on the session file (`protocolState`, `waitingFor`, goal, issues,
next step). Those values are not ChatGPT protocol states. ChatGPT still sees
only the table above. If the original chat is gone, Codex sends HANDOFF
built from the checkpoint (never from logs).

Local checkpoint values (session only):

| Checkpoint | Meaning |
| --- | --- |
| `INIT` | INIT sent; waiting for PLAN |
| `PLAN_RECEIVED` | PLAN in hand; not finished executing |
| `EXECUTING` | Codex is applying the current PLAN |
| `EXECUTED_LOCAL` | Recorded locally; EXECUTED not yet typed |
| `EXECUTED_SENT` | EXECUTED typed; waiting for review |
| `DONE` / `BLOCKED` | Terminal; DONE should `--clear-checkpoint` |

Legacy sessions without a checkpoint keep the old loop. The first normal
iteration after this version writes a checkpoint automatically.

Do not re-pair, recreate the connector, or rewrite Project instructions
just to resume.

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

Before sending EXECUTED, Codex records the iteration:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
and, when a test/build/lint/typecheck was run, `--command` plus `--output-file`.
ChatGPT reads metadata via `execution_summary` / `test_status`. Command output
is a separate opt-in: `execution_output` (`list` then `read`). Codex nominates
the log; a **local sanitizer** decides whether ChatGPT may see the body
(tokens/paths redacted; private keys withheld entirely; size/line caps).
Restricted items appear in `list` with no body. Old records without output
stay valid. Sanitizers process stdout and stderr independently and handle
covered patterns across chunks within each stream. A secret split between
stdout and stderr is not guaranteed to be detected; minimal child environment
exposure reduces accidental disclosure. The sanitizer is not a malicious-code
data-exfiltration boundary. Never paste logs into the
control message.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

`c2c session --json` → `conversation.mode` chooses how chats are grouped.

- **long-chat:** one long-lived C2C conversation per workspace. Codex opens a
  replacement chat only when the user asks, the old chat lags, or the chat was
  lost.
- **project:** one ChatGPT Project (collection) per workspace. A new Codex
  conversation starts a new chat **inside that Project**. The same Codex
  conversation keeps using its saved chat URL.

Right after the boot prompt, Codex sends a HANDOFF so the new chat can
continue — a brief, never a data dump (the new chat re-reads code via MCP).
Project instructions and project-only memory hold durable workspace identity.
HANDOFF still wins for the current task:

Trust order: connector (current code) > HANDOFF (this task) > Project
instructions > Project memory.

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
   If execution_output lists a readable item for this iteration, list
   then read it. If status is restricted, ignore the body and review
   from git.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
13. If this chat sits in a ChatGPT Project, use only the connector named
    in that Project's instructions. Do not use another workspace's connector.
```

## Nested repositories and worktrees

When the connected workspace is a container such as `C:\codex` and the requested
project is a nested repository or Git worktree, call `git_info`, `git_status`,
and `git_diff` with `repository_path` set to that workspace-relative directory.
Do not present the container's Git state as the nested project's state.
`git_diff.path` is a separate pathspec relative to the selected repository.
The tools return `repositoryPath` and `topLevel` so callers can verify which
repository supplied the result. Omitting `repository_path` retains the existing
workspace-root behavior.

The Git tools expose only fixed info/status/diff queries; `repository_path` selects
a repository or worktree and is not an arbitrary command interface. The subprocess
runner drops inherited `GIT_*` variables, disables fsmonitor, external diff,
textconv, and configured clean/process filters for status and diff queries, and sets
`GIT_OPTIONAL_LOCKS=0`. Repository-local and connected-workspace sensitive rules
are combined as a deny union, so a repository rule cannot negate a workspace deny.
If status cannot be safely established, `git_info.dirty` is `null` rather than a
clean result. Filter configuration names that cannot be safely overridden also make
status or diff fail closed. Normal Git configuration and attributes can still affect
metadata and file interpretation, but are not trusted to launch these helpers. Git
queries may read repository metadata, configuration, and attributes as part of their
operation. Status uses NUL-delimited records and maps paths back to the selected root
before applying sensitive rules. Diff inventory and patch paths use the same selected
root-relative base.
Repositories that rely on external clean/process filters can show additional dirty
paths or a raw-worktree diff representation because those programs are intentionally
not executed.

## Project instructions

New workspaces store durable identity in the ChatGPT Project settings
(指令), not in every boot prompt. The Skill fills this template once.
Never put a public or temporary URL in the instructions — only the
connector **name**.

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```
