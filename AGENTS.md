# AGENTS.md

## C2C Local product contract

This repository has a long-term product requirement that must not be silently weakened by later security refactors or implementation convenience.

### Full Access means Remote parity

When the local user has explicitly selected C2C Full Access / the highest local permission mode, C2C is intended to replace Remote Desktop Commander for non-GUI local development and host operations.

The target is capability parity under the same Windows user, session, and elevation context.

Full Access must therefore be able to support, directly through C2C:

- PowerShell and CMD command execution;
- direct executable launch;
- Node, Python, package-manager, test, build, lint, typecheck and developer-tool execution with normal arguments;
- explicit working-directory selection where valid;
- long-running jobs, cancellation, status and output retrieval;
- local file operations required by development and host maintenance;
- Git operations required by normal development workflows;
- process inspection and management;
- host operations that the same user could perform through a generic terminal/Remote tool, subject only to explicit platform safety exclusions documented as product requirements.

### No per-command approval in Full Access

The user's choice of Full Access is itself the authorization boundary for ordinary local operations.

Do not reintroduce any of the following as a mandatory requirement for ordinary Full Access operation:

- per-command human approval;
- per-command digest confirmation;
- trusted-command registry membership as a prerequisite for generic execution;
- a separately enabled Level 3 gate solely to obtain generic command execution;
- repeated local approval prompts for operations that Remote Desktop Commander can perform directly under the same user/session/elevation.

Historical Level 3 approval flows may remain for restricted modes, compatibility, auditing, or genuinely exceptional policy boundaries, but they are not the final Full Access product model.

### Security mechanisms are enhancements, not capability downgrades

C2C should prefer structured and auditable execution over a raw remote shell. The following are desirable and should be preserved where practical:

- workspace/repository identity;
- stale-write and concurrency protection;
- OAuth/client binding;
- Job Object lifecycle control;
- output sanitization and secret protection;
- bounded output retention;
- structured Git and process results;
- audit logs;
- crash recovery;
- reparse/path validation;
- explicit readonly/restricted modes.

These mechanisms must not be used as justification to make Full Access materially less capable than Remote Desktop Commander.

If a safety design prevents Remote-parity behavior in Full Access, treat that as a product-design conflict requiring explicit user/product-owner approval, not as an implementation detail that may be silently tightened.

### Tool-selection goal

C2C Local is the preferred tool for local repository and host work when C2C is connected and exposes the required capability.

Remote Desktop Commander is a fallback for:

- GUI-only interaction;
- UAC/interactive desktop operations C2C cannot represent;
- C2C outage, repair, or disaster recovery;
- a capability explicitly documented as not yet implemented by C2C.

Do not use Remote merely because it is more convenient if C2C can perform the operation.

At the same time, do not solve this preference problem by adding artificial C2C restrictions. The intended solution is to make C2C Full Access sufficiently complete and ergonomic that the preferred path is also the shortest practical path.

### Release non-regression rule

For future C2C releases, Full Access Remote parity is a release acceptance requirement.

A change that removes an already-supported Full Access capability, adds new per-command approval to an ordinary operation, or forces routine development work back to Remote must be treated as a product-contract regression unless explicitly approved by the product owner.

The acceptance matrix is maintained in:

`docs/remote-parity-acceptance.md`

Historical documents describing earlier V1.3 Level 3 or narrower permission behavior must not override this contract.
