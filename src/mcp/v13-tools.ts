import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { McpContext } from "./server.js";
import { executionJobView } from "./server.js";
import { executionToolAuth, executionScopeChallenge } from "./oauth.js";
import { classifyLevel3Spec, createLevel3Request, getLevel3Request, type Level3Spec } from "../execution/level3-approval.js";
import type { GitWriteOperation } from "../git-write/index.js";
import { selectGitRepository, runGit } from "../workspace/git.js";

const id = z.string().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const expectation = { expectedHead: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable(), expectedBranch: z.string().min(1).max(200).nullable(),
  expectedStatusHash: z.string().regex(/^[a-f0-9]{64}$/).optional() };
const gitOperation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), ...expectation, paths: z.array(z.string().min(1).max(1024)).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("commit"), ...expectation, message: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("fetch"), ...expectation, remote: z.string().min(1).max(100), branches: z.array(z.string().min(1).max(128)).min(1).max(128).optional() }).strict(),
  z.object({ kind: z.literal("push"), ...expectation, remote: z.string().min(1).max(100), branch: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("pull_ff_only"), ...expectation, remote: z.string().min(1).max(100), branch: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("branch_list"), ...expectation }).strict(),
  z.object({ kind: z.literal("branch_create"), ...expectation, name: z.string().min(1).max(200), startPoint: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal("switch"), ...expectation, name: z.string().min(1).max(200) }).strict(),
]);

function result(data: object) { return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> }; }
function fail(error: string) { return { content: [{ type: "text" as const, text: JSON.stringify({ error }) }], isError: true }; }
function requireCapability(auth: AuthInfo | undefined, scope: "git.read" | "git.write" | "execution.level3", resource?: string) {
  if (!auth?.clientId) return fail("UNAUTHENTICATED");
  if (auth.scopes.includes(scope)) return null;
  return { ...fail("INSUFFICIENT_SCOPE"), ...(resource ? { _meta: { "mcp/www_authenticate": [executionScopeChallenge(resource, scope)] } } : {}) };
}

export function registerV13Tools(server: McpServer, ctx: McpContext): void {
  server.registerTool("git_branches", {
    ...executionToolAuth("git_branches"), title: "Read repository branches",
    description: "List local and remote-tracking branches in the exact workspace-relative repository. This read-only operation does not require Git write permission or a local write grant.",
    inputSchema: { repository_path: z.string().min(1).max(1024), offset: z.number().int().min(0).max(100_000).default(0),
      limit: z.number().int().min(1).max(100).default(50) }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args, extra) => {
    const denied = requireCapability(extra.authInfo, "git.read", ctx.oauthResourceMetadataUri);
    if (denied) return denied;
    try {
      const selected = selectGitRepository(ctx.workspace, args.repository_path);
      if (!selected.isRepo) return fail("INVALID_REPOSITORY");
      const read = runGit(selected.target.root, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/remotes"]);
      if (!read.ok) return fail("STATE_UNAVAILABLE");
      const entries = read.stdout.trim().split(/\r?\n/).filter(Boolean);
      const branches: Array<{ ref: string; head: string }> = [];
      let bytes = 0;
      for (const line of entries.slice(args.offset, args.offset + args.limit)) {
        const parts = line.split("\t");
        if (parts.length !== 2 || parts[0].length > 4096 || !/^refs\/(heads|remotes)\//.test(parts[0]) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(parts[1])) return fail("STATE_UNAVAILABLE");
        const count = Buffer.byteLength(line, "utf8") + 64;
        if (bytes + count > 32 * 1024) break;
        bytes += count; branches.push({ ref: parts[0], head: parts[1] });
      }
      const next = args.offset + branches.length;
      return result({ repository_path: selected.repositoryPath, branches, total: entries.length, has_more: next < entries.length, next_offset: next < entries.length ? next : null });
    } catch { return fail("INVALID_REPOSITORY"); }
  });

  server.registerTool("level3_request", {
    ...executionToolAuth("level3_request"), title: "Request restricted Level 3 command execution",
    description: "Historical restricted controlled path retained for Level 3 workflows. Full Access generic command execution should use execution_run and does not require a Level 3 request. This tool creates an exact-command Level 3 request; safe-development commands may be automatically authorized, while high-risk, destructive, dynamic, or uncertain commands remain pending for local review. Commands can affect the host beyond cwd; cwd is not an OS sandbox.",
    inputSchema: {
      repository_path: z.string().min(1).max(1024), engine: z.enum(["program", "powershell", "cmd"]),
      executable: z.string().min(1).max(1024), args: z.array(z.string().max(8192)).max(128).default([]),
      command: z.string().min(1).max(32768).optional(), cwd: z.string().min(1).max(1024),
      timeout_seconds: z.number().int().min(1).max(3600), materials: z.array(z.string().min(1).max(1024)).max(128).default([]),
    }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const denied = requireCapability(extra.authInfo, "execution.level3", ctx.oauthResourceMetadataUri);
    if (denied) return denied;
    try {
      const spec = { repositoryPath: args.repository_path, engine: args.engine, executable: args.executable,
        args: args.args, ...(args.command === undefined ? {} : { command: args.command }), cwd: args.cwd,
        timeoutSeconds: args.timeout_seconds, materials: args.materials } as Level3Spec;
      const request = createLevel3Request(ctx.workspace, extra.authInfo!.clientId, spec);
      return result({
        request_id: request.requestId,
        digest: request.digest,
        state: request.status,
        expires_at: request.expiresAt,
        launch_expires_at: request.launchExpiresAt,
        approval_required: request.approvalRequired,
        risk_class: request.riskClass,
        instruction: request.approvalRequired
          ? "This command requires local review. Inspect and approve its exact digest, then call level3_start. Approval tools are not exposed through MCP."
          : "This command was classified as safe-development and auto-authorized. Call level3_start with the exact request_id and digest.",
      });
    } catch (error) { return fail((error as Error).message); }
  });

  server.registerTool("level3_request_status", {
    ...executionToolAuth("level3_request_status"), title: "Restricted Level 3 request status",
    description: "Read status for a historical restricted Level 3 request owned by this OAuth client. Full Access generic execution does not use Level 3. No local authority or command materials are returned.",
    inputSchema: { request_id: id }, annotations: { readOnlyHint: true },
  }, async (args, extra) => {
    const denied = requireCapability(extra.authInfo, "execution.level3", ctx.oauthResourceMetadataUri);
    if (denied) return denied;
    try {
      const request = getLevel3Request(ctx.workspace.id, args.request_id);
      if (!request || request.clientId !== extra.authInfo!.clientId) return fail("NOT_FOUND");
      return result({
        request_id: request.requestId,
        digest: request.digest,
        state: request.status,
        expires_at: request.expiresAt,
        launch_expires_at: request.launchExpiresAt,
        approval_required: request.status === "pending",
        risk_class: request.riskClass ?? classifyLevel3Spec(request.spec, ctx.workspace),
      });
    } catch (error) { return fail((error as Error).message); }
  });

  server.registerTool("level3_start", {
    ...executionToolAuth("level3_start"), title: "Start restricted Level 3 command",
    description: "Historical restricted controlled path. Consume one unexpired Level 3 authorization bound to this client and exact digest; Full Access generic execution should use execution_run and does not require Level 3. Run under the existing controlled Windows Job Object. Use execution_status/output/cancel with their separate OAuth scopes.",
    inputSchema: { request_id: id, digest, idempotency_key: key }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const denied = requireCapability(extra.authInfo, "execution.level3", ctx.oauthResourceMetadataUri);
    if (denied) return denied;
    if (!ctx.executionSupervisor) return fail("EXECUTION_UNAVAILABLE");
    const started = ctx.executionSupervisor.startLevel3({ requestId: args.request_id, digest: args.digest,
      idempotencyKey: args.idempotency_key, oauthClientId: extra.authInfo!.clientId, scopes: extra.authInfo!.scopes });
    return started.ok ? result({ job: executionJobView(started.job), duplicate: started.duplicate }) : fail(started.error);
  });

  server.registerTool("git_write", {
    ...executionToolAuth("git_write"), title: "Controlled Git operation",
    description: "Perform one structured operation in an exact locally approved repository/worktree. Call git_info/status first and supply expected HEAD and branch. Local grants restrict operations, branch names and exact HTTPS remotes. No arbitrary Git arguments, forced push, reset, clean, branch deletion or rebase are accepted. Job results include post-operation state confirmation.",
    inputSchema: { repository_path: z.string().min(1).max(1024), operation: gitOperation,
      timeout_seconds: z.number().int().min(1).max(3600), idempotency_key: key },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const denied = requireCapability(extra.authInfo, "git.write", ctx.oauthResourceMetadataUri);
    if (denied) return denied;
    if (!ctx.executionSupervisor) return fail("EXECUTION_UNAVAILABLE");
    const started = ctx.executionSupervisor.startGitWrite({ repositoryPath: args.repository_path,
      operation: args.operation as GitWriteOperation, timeoutSeconds: args.timeout_seconds,
      idempotencyKey: args.idempotency_key, oauthClientId: extra.authInfo!.clientId, scopes: extra.authInfo!.scopes });
    return started.ok ? result({ job: executionJobView(started.job), duplicate: started.duplicate }) : fail(started.error);
  });
}
