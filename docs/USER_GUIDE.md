# C2C Local V1.5 — User guide

[中文](USER_GUIDE.zh-CN.md) · [Installation](INSTALL.md) · [AI guide](AI_GUIDE.md)

After installation and OAuth pairing, ask ChatGPT:

> Use C2C to inspect the README and Git status in my connected workspace. Start read-only and ask before changing code.

Always verify the actual connector with **workspace_info**, and inspect **permission_status** before permission-sensitive operations. Nested repositories require an explicit workspace-relative repository_path for Git operations.

| Goal | C2C tool |
| --- | --- |
| Read multiple files | batch_read (up to 16 items, bounded and paginated) |
| Multiple searches | batch_search (up to 8 queries, shared scan budget) |
| Review evidence | collect_evidence (explicit files, search, Git and existing job evidence) |
| Generic command | **execution_run** (program, powershell, cmd) |
| Track an execution | execution_status / execution_job_output / execution_cancel |
| Fixed durable plan | task_create / task_status / task_list / task_result / task_output / task_cancel |

Generic **execution_run** is preferred for V1.5 Level2 Full Access. It requires a valid temporary Level2 grant and execution.run OAuth scope but **not** legacy execution_start recipe registration or Level3 per-command approval. Supported structured `git_write` operations at effective Level2 do not require an unconditional separate Repository Approval; Level1 retains that policy gate. Repository identity, expected state, OAuth scope, operation policy and user authorization still apply.

A persistent Task is a finite, immutable plan, **not** an autonomous agent. At WAITING_FOR_MODEL it stops for a new decision. After a crash or cancellation the outcome of a child command can be uncertain; **never automatically replay potential side effects**. Query status, result and output first.

### Recovery

In the built repository directory, with your actual workspace replacing C:\Projects:

~~~powershell
node .\bin\c2c.js status -w 'C:\Projects' --json
node .\bin\c2c.js restore -w 'C:\Projects' --json
~~~

Named Tunnel reconnects normally keep the existing connector and OAuth pairing. A healthy /health alone does not prove authenticated MCP tool access; test with a real C2C tool call. Don't paste credentials, tokens or private source files into public discussions.

See [Troubleshooting](troubleshooting.md).
