import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { setLevel3Enabled, isLevel3Enabled, listLevel3Requests, getLevel3Request, getLevel3RequestPreview, approveLevel3Request, revokeLevel3Request, type Level3Risk } from "../execution/level3-approval.js";
import { approveGitRepository, previewGitRepositoryApproval, listGitRepositoryApprovals, revokeGitRepositoryApproval, type ApproveGitRepositoryInput } from "../git-write/index.js";
import { previewGitReview, acknowledgeGitReview } from "../execution/git-review-hold.js";

type Options = { workspace?: string; json: boolean };
function workspace(opts: Options): Workspace { return new Workspace(path.resolve(opts.workspace ?? process.cwd())); }
function output(data: object, json: boolean) { process.stdout.write(JSON.stringify(data, null, json ? undefined : 2) + "\n"); }
function guarded<T extends Options>(action: (opts: T) => object) {
  return (opts: T) => { try { output(action(opts), opts.json); } catch (error) { output({ ok: false, error: (error as Error).message }, opts.json); process.exitCode = 1; } };
}
function common(command: Command): Command { return command.option("-w, --workspace <path>").option("--json", "machine-readable output", false); }

/** Local-only authority: these functions are never registered with MCP. */
export function registerV13Cli(program: Command): void {
  const level3 = program.command("level3").description("Individually approve exact commands; cwd is not an OS sandbox");
  common(level3.command("status")).action(guarded((opts: Options) => {
    const ws = workspace(opts);
    return { ok: true, workspaceId: ws.id, enabled: isLevel3Enabled(ws.id) };
  }));
  for (const enabled of [true, false]) {
    const command = common(level3.command(enabled ? "enable" : "disable"));
    if (enabled) command.requiredOption("--approve", "explicitly enable the separate Level 3 approval workflow");
    command.action(guarded((opts: Options) => {
      const ws = workspace(opts); setLevel3Enabled(ws.id, enabled, true);
      return { ok: true, workspaceId: ws.id, enabled: isLevel3Enabled(ws.id) };
    }));
  }
  common(level3.command("list")).action(guarded((opts: Options) => {
    const ws = workspace(opts);
    return { ok: true, workspaceId: ws.id, requests: listLevel3Requests(ws.id).map((r) => ({ requestId: r.requestId,
      digest: r.digest, clientId: r.clientId, repositoryPath: r.repositoryPath, status: r.status, expiresAt: r.expiresAt })) };
  }));
  common(level3.command("inspect").requiredOption("--request <id>")).action(guarded((opts: Options & { request: string }) => {
    const ws = workspace(opts); const record = getLevel3Request(ws.id, opts.request);
    const request = record ? getLevel3RequestPreview(ws.id, opts.request, record.clientId) : null;
    if (!request) throw new Error("LEVEL3_REQUEST_NOT_FOUND");
    return { ok: true, workspaceId: ws.id, request, warning: "Review the entire command and materials. Approved programs run as this Windows user and can access resources beyond cwd. Only the exact request digest is approved." };
  }));
  common(level3.command("approve").requiredOption("--request <id>").requiredOption("--digest <sha256>")
    .requiredOption("--risk <risk>", "development or destructive-system")
    .requiredOption("--approve", "approve the exact inspected command")
    .option("--allow-system", "explicitly authorize destructive or system operations", false))
    .option("--allow-dynamic", "acknowledge unresolved dynamic-code entry semantics", false)
    .action(guarded((opts: Options & { request: string; digest: string; risk: Level3Risk; allowSystem: boolean; allowDynamic: boolean }) => {
      const ws = workspace(opts);
      const request = approveLevel3Request(ws, opts.request, opts.digest, true, { risk: opts.risk, ...(opts.allowSystem ? { allowSystem: true as const } : {}), ...(opts.allowDynamic ? { allowDynamic: true as const } : {}) });
      return { ok: true, workspaceId: ws.id, requestId: request.requestId, digest: request.digest, status: request.status };
    }));
  common(level3.command("revoke").requiredOption("--request <id>"))
    .action(guarded((opts: Options & { request: string }) => ({ ok: true, revoked: revokeLevel3Request(workspace(opts).id, opts.request, true) })));

  const git = program.command("git-write").description("Local allowlist for structured Git operations");
  common(git.command("review").option("-r, --repository <path>", "repository", ".")
    .option("--approve", "acknowledge inspected uncertain state", false).option("--job <id>").option("--digest <sha256>"))
    .action(guarded((opts: Options & { repository: string; approve: boolean; job?: string; digest?: string }) => {
      const ws = workspace(opts); const review = previewGitReview(ws, opts.repository);
      if (!opts.approve) return { ok: true, review, instruction: "Inspect the recorded job and local/remote changes. Re-read state before resuming; acknowledgement never rolls back data or confirms an unknown remote result." };
      if (!opts.job || !opts.digest) throw new Error("GIT_REVIEW_APPROVAL_REQUIRED");
      acknowledgeGitReview(ws, opts.repository, opts.job, opts.digest, true);
      return { ok: true, acknowledged: opts.job };
    }));
  common(git.command("list")).action(guarded((opts: Options) => {
    const ws = workspace(opts); return { ok: true, workspaceId: ws.id, approvals: listGitRepositoryApprovals(ws.id) };
  }));
  common(git.command("approve").option("-r, --repository <path>", "workspace-relative repository root", ".")
    .requiredOption("--policy <file>", "local JSON with allowedOperations, allowedBranches, allowedRemotes, optional approvedCredentialHelper/approvedProxy")
    .option("--approve", "store the reviewed policy", false).option("--digest <sha256>", "digest returned by preview"))
    .action(guarded((opts: Options & { repository: string; policy: string; approve: boolean; digest?: string }) => {
      const ws = workspace(opts);
      const file = path.resolve(opts.policy); const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("INVALID_POLICY");
      const policy = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<ApproveGitRepositoryInput, "localApproval">;
      if (!policy || typeof policy !== "object" || Array.isArray(policy) ||
          Object.keys(policy).some((key) => !["allowedOperations", "allowedBranches", "allowedRemotes", "approvedCredentialHelper", "approvedProxy"].includes(key))) throw new Error("INVALID_POLICY");
      const preview = previewGitRepositoryApproval(ws, opts.repository, policy);
      if (!opts.approve) return { ok: true, approvalRequired: true, ...preview,
        authorizationScope: "repository-wide; shared by all OAuth clients with git.write scope",
        instruction: "Inspect this exact repository and local allowlist, then rerun with --approve --digest. Hooks and arbitrary helpers are disabled; optional approved GCM runs in the controlled job." };
      if (opts.digest !== preview.digest) throw new Error("POLICY_DIGEST_MISMATCH");
      const approval = approveGitRepository(ws, opts.repository, { ...policy, localApproval: true }, opts.digest);
      return { ok: true, approval };
    }));
  common(git.command("revoke").option("-r, --repository <path>", "workspace-relative repository root", "."))
    .action(guarded((opts: Options & { repository: string }) => ({ ok: true, revoked: revokeGitRepositoryApproval(workspace(opts), opts.repository, { localApproval: true }) })));
}
