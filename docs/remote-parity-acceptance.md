# C2C Local Full Access — Remote Parity Acceptance Contract

Status: product requirement / non-regression baseline

This document defines the long-term acceptance target for C2C Local Full Access.

The purpose is not to copy Remote Desktop Commander internally. The purpose is to ensure that, once the local user explicitly grants Full Access, routine local development and host work does not have to fall back to Remote because C2C artificially lacks permission or execution flexibility.

## 1. Governing principle

Under the same Windows user, login session, and elevation context:

> C2C Full Access must be capable of performing the ordinary non-GUI local operations that Remote Desktop Commander can perform.

C2C may use a safer internal architecture: structured APIs, Job Objects, output sanitization, workspace identity, audit logs, stale-write checks, bounded output, or other controls.

Those controls are implementation and safety improvements. They must not silently turn Full Access into a materially weaker capability tier.

## 2. Authorization principle

The user selects the local permission mode.

For Full Access, that selection is the authorization decision for ordinary local operations.

Full Access must not require an additional per-command human approval workflow merely because the operation is expressed as a generic command.

In particular, ordinary Full Access execution must not depend on:

- manually approving every command;
- manually approving a digest for every command;
- pre-registering every test/build/lint command;
- enabling a separate Level 3 feature solely to obtain generic execution;
- maintaining a trusted-command allowlist as the only route to normal developer commands.

Restricted/readonly modes may deliberately provide narrower capabilities.

Explicitly exceptional product exclusions may still exist, but they must be documented as product requirements, not introduced incidentally by implementation.

## 3. Capability acceptance matrix

| Capability | Remote baseline | C2C Full Access target | Release requirement |
|---|---|---|---|
| Read local files | Yes | Yes | REQUIRED |
| Create/modify local files | Yes | Yes | REQUIRED |
| Delete local files/directories where current Windows user is authorized | Yes | Yes, except explicitly documented product exclusions | REQUIRED |
| PowerShell execution | Yes | Yes | REQUIRED |
| CMD execution | Yes | Yes | REQUIRED |
| Direct .exe/program execution | Yes | Yes | REQUIRED |
| Node/Python execution with normal argv | Yes | Yes | REQUIRED |
| Package-manager/test/build/lint/typecheck commands | Yes | Yes | REQUIRED |
| Explicit valid cwd | Yes | Yes | REQUIRED |
| Long-running process execution | Yes | Yes | REQUIRED |
| Job status/output/cancellation | Yes | Yes; preferably more structured than Remote | REQUIRED |
| Read process state | Yes | Yes | REQUIRED |
| Manage processes under same user authority | Yes | Yes, subject to explicit product exclusions | REQUIRED |
| Git read operations | Yes | Yes | REQUIRED |
| Normal Git write operations | Yes | Yes without an extra per-operation approval in Full Access | REQUIRED |
| Host diagnostics | Yes | Yes | REQUIRED |
| Registry/service/task-scheduler operations through authorized command execution | Yes | Yes under same user/elevation, unless explicitly excluded | REQUIRED |
| Per-command C2C approval for ordinary Full Access commands | No | No | REQUIRED |
| Trusted-command registration required for ordinary Full Access commands | No | No | REQUIRED |
| Separate Level 3 enablement required for generic Full Access command execution | No | No | REQUIRED |

## 4. Preferred execution UX

The C2C path should be no more cumbersome than the generic Remote path for common work.

A normal command should conceptually be expressible as:

- execution mode: PowerShell / CMD / direct program;
- executable or command;
- arguments;
- cwd;
- timeout.

If the command is short, C2C should ideally be able to return completion, exit code, and bounded sanitized output in one tool interaction.

If the command is long-running, C2C should return a job id and expose structured status/output/cancel operations.

The web model should not be forced into a multi-step approval ceremony for every ordinary command.

## 5. C2C-first tool-selection requirement

When both C2C and Remote are available:

- repository/file/Git/process/command work should prefer C2C when C2C has the needed capability;
- Remote is appropriate for GUI/UAC/interactive desktop work, C2C recovery, or a capability C2C genuinely has not implemented;
- inability caused only by an avoidable C2C policy restriction counts as a C2C product gap, not as a valid reason to normalize Remote fallback.

Tool descriptions should make this preference clear to the web model.

## 6. Non-regression rule

Before release, reviewers should explicitly answer:

`REMOTE_PARITY_ACCEPTANCE = PASS | FAIL | NOT_YET_IMPLEMENTED`

A release is a parity regression if it does any of the following without explicit product-owner approval:

- removes an existing Full Access capability;
- adds mandatory per-command approval to ordinary Full Access work;
- turns generic developer execution back into trusted-command-only execution;
- requires Level 3 enablement solely to run generic commands in Full Access;
- causes routine previously-supported work to require Remote again.

Security fixes should preserve parity whenever technically possible.

If a security issue truly requires capability reduction, document the exact conflict and obtain an explicit product decision rather than silently narrowing the model.

## 7. Relationship to historical V1.3 documents

Documents such as `docs/v1.3-level3.md` and `docs/v1.3-final-permission-matrix.md` describe historical V1.3 implementation and evidence.

They remain useful history, but their per-command approval model is not the final Full Access product contract.

For future Full Access design decisions, this acceptance contract and the root `AGENTS.md` non-regression rules take precedence unless the product owner explicitly changes the requirement.

## 8. Version boundary: V1.3.2 parity, V1.4 native workflow advantage

V1.3.2 closes the capability gap: Full Access must be able to perform the ordinary non-GUI local operations that would otherwise force a fallback to Remote.

V1.4 is a separate optimization layer. It does not weaken or redefine the V1.3.2 parity contract. Its goal is to make C2C materially preferable for AI-driven repository and local-development work by reducing tool round-trips and by allowing deterministic long-running workflows to persist independently of a single ChatGPT turn.

The V1.4 scope is defined in `docs/v1.4-plan.md` and includes:

- bounded batch read/search/evidence collection;
- persistent deterministic Task Jobs with checkpoints, retry, status, result retrieval and cancellation;
- an explicit tool-preference acceptance gate comparing C2C against generic Remote workflows.

A missing V1.4 optimization must not be used to excuse a V1.3.2 Remote-parity failure, and V1.4 must not reintroduce the Full Access restrictions prohibited by this contract.
