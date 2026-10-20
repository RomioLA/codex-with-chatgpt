import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const EXECUTION_TOOL_SCOPES = {
  execution_run: "execution.run",
  execution_start: "execution.run",
  execution_status: "execution.jobs.read",
  execution_job_output: "execution.jobs.read",
  execution_cancel: "execution.cancel",
  execution_list: "execution.jobs.read",
  level3_request: "execution.level3",
  level3_request_status: "execution.level3",
  level3_start: "execution.level3",
  git_compare: "git.read",
  git_write: "git.write",
  git_branches: "git.read",
} as const;

export const SYSTEM_TOOL_SCOPES = {
  host_context: "system.read",
  process_query: "system.read",
  process_tree: "system.read",
  network_listeners: "system.read",
  network_status: "system.read",
  dns_resolve: "system.read",
  path_inspect: "system.read",
} as const;

export const BATCH_TOOL_SCOPES = {
  batch_read: "workspace.read",
  batch_search: "workspace.search",
} as const;

type ExecutionTool = keyof typeof EXECUTION_TOOL_SCOPES;
type ExecutionScope = (typeof EXECUTION_TOOL_SCOPES)[ExecutionTool];
type SystemTool = keyof typeof SYSTEM_TOOL_SCOPES;
type BatchTool = keyof typeof BATCH_TOOL_SCOPES;
type OAuthScope = ExecutionScope | (typeof SYSTEM_TOOL_SCOPES)[SystemTool] | (typeof BATCH_TOOL_SCOPES)[BatchTool];
type OAuthScheme = { type: "oauth2"; scopes: ExecutionScope[] };
type SystemOAuthScheme = { type: "oauth2"; scopes: (typeof SYSTEM_TOOL_SCOPES)[SystemTool][] };
type BatchOAuthScheme = { type: "oauth2"; scopes: (typeof BATCH_TOOL_SCOPES)[BatchTool][] };

export function executionToolAuth(name: ExecutionTool) {
  const securitySchemes: OAuthScheme[] = [{ type: "oauth2", scopes: [EXECUTION_TOOL_SCOPES[name]] }];
  return { securitySchemes, _meta: { securitySchemes } };
}

export function systemToolAuth(name: SystemTool) {
  const securitySchemes: SystemOAuthScheme[] = [{ type: "oauth2", scopes: [SYSTEM_TOOL_SCOPES[name]] }];
  return { securitySchemes, _meta: { securitySchemes } };
}

export function batchToolAuth(name: BatchTool) {
  const securitySchemes: BatchOAuthScheme[] = [{ type: "oauth2", scopes: [BATCH_TOOL_SCOPES[name]] }];
  return { securitySchemes, _meta: { securitySchemes } };
}

/** Task creation scopes depend on the immutable plan and are enforced per call. */
export function taskCreateToolAuth() {
  const securitySchemes = [{ type: "oauth2" as const, scopes: [] as string[] }];
  return {
    securitySchemes,
    _meta: {
      securitySchemes,
      "c2c/task-scope-model": "plan-derived",
    },
  };
}

/** Quote RFC 7235 auth parameters; never allow a header/challenge line break. */
function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Invalid OAuth challenge parameter");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function executionScopeChallenge(resourceMetadataUri: string, scope: OAuthScope): string {
  return `Bearer resource_metadata=${quote(resourceMetadataUri)}, error="insufficient_scope", ` +
    `error_description=${quote(`This operation requires the '${scope}' scope.`)}, scope=${quote(scope)}`;
}

/**
 * SDK 1.30 preserves _meta but does not emit top-level securitySchemes.
 * Decorate its public tools/list handler during registration, retaining the
 * SDK's schemas, annotations, enabled filtering, and tools/call validation.
 * No private SDK fields or dependency upgrade are needed.
 */
export function installExecutionOAuthListing(server: McpServer): () => void {
  const original = server.server.setRequestHandler;
  const register = original.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if (!Object.is(schema, ListToolsRequestSchema)) return register(schema, handler);
    register(schema, async (request, extra) => {
      const result = ListToolsResultSchema.parse(await handler(request, extra));
      return {
        ...result,
        tools: result.tools.map((tool) => {
          const auth = authForTool(tool.name);
          if (!auth) return tool;
          return { ...tool, securitySchemes: auth.securitySchemes, _meta: { ...tool._meta, ...auth._meta } };
        }),
      };
    });
  };
  return () => { server.server.setRequestHandler = original; };
}

function authForTool(
  name: string
): ReturnType<typeof executionToolAuth> | ReturnType<typeof systemToolAuth> | ReturnType<typeof batchToolAuth> | ReturnType<typeof taskCreateToolAuth> | null {
  if (name === "task_create") return taskCreateToolAuth();
  if (name === "task_status" || name === "task_result") return executionToolAuth("execution_status");
  if (name === "task_list") return executionToolAuth("execution_list");
  if (name === "task_output") return executionToolAuth("execution_job_output");
  if (name === "task_cancel") return executionToolAuth("execution_cancel");
  if (Object.hasOwn(EXECUTION_TOOL_SCOPES, name)) return executionToolAuth(name as ExecutionTool);
  if (Object.hasOwn(SYSTEM_TOOL_SCOPES, name)) return systemToolAuth(name as SystemTool);
  if (Object.hasOwn(BATCH_TOOL_SCOPES, name)) return batchToolAuth(name as BatchTool);
  return null;
}
