import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const EXECUTION_TOOL_SCOPES = {
  execution_start: "execution.run",
  execution_status: "execution.jobs.read",
  execution_job_output: "execution.jobs.read",
  execution_cancel: "execution.cancel",
  execution_list: "execution.jobs.read",
  level3_request: "execution.level3",
  level3_request_status: "execution.level3",
  level3_start: "execution.level3",
  git_write: "git.write",
  git_branches: "git.read",
} as const;

type ExecutionTool = keyof typeof EXECUTION_TOOL_SCOPES;
type ExecutionScope = (typeof EXECUTION_TOOL_SCOPES)[ExecutionTool];
type OAuthScheme = { type: "oauth2"; scopes: ExecutionScope[] };

export function executionToolAuth(name: ExecutionTool) {
  const securitySchemes: OAuthScheme[] = [{ type: "oauth2", scopes: [EXECUTION_TOOL_SCOPES[name]] }];
  return { securitySchemes, _meta: { securitySchemes } };
}

/** Quote RFC 7235 auth parameters; never allow a header/challenge line break. */
function quote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Invalid OAuth challenge parameter");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function executionScopeChallenge(resourceMetadataUri: string, scope: ExecutionScope): string {
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
          if (!isExecutionTool(tool.name)) return tool;
          const auth = executionToolAuth(tool.name);
          return { ...tool, securitySchemes: auth.securitySchemes, _meta: { ...tool._meta, ...auth._meta } };
        }),
      };
    });
  };
  return () => { server.server.setRequestHandler = original; };
}

function isExecutionTool(name: string): name is ExecutionTool {
  return Object.hasOwn(EXECUTION_TOOL_SCOPES, name);
}
