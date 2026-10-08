import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { HostObservation } from "../host-observation/service.js";
import { ObservationError } from "../host-observation/types.js";

const pid = z.number().int().min(0).max(0xffffffff);
const text = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f]/.test(value));
const limit = z.number().int().min(1).max(200).default(50);
export const hostObservationSchemas = {
  host_context: z.object({}).strict(),
  process_query: z.object({ pid: pid.optional(), name: text.optional(), parentPid: pid.optional(),
    exePath: text.optional(), commandContains: text.optional(), sessionId: pid.optional(), limit }).strict()
    .refine(args => [args.pid, args.name, args.parentPid, args.exePath, args.commandContains, args.sessionId].some(v => v !== undefined),
      "At least one process filter is required"),
  process_tree: z.object({ pid, direction: z.enum(["ancestors", "children", "both"]).default("both"),
    depth: z.number().int().min(1).max(8).default(4), limit: z.number().int().min(1).max(100).default(50),
    processKey: text.optional() }).strict(),
  network_listeners: z.object({ pid: pid.optional(), port: z.number().int().min(1).max(65535).optional(),
    protocol: z.enum(["tcp", "udp"]).optional(), address: text.optional(), limit }).strict(),
  network_status: z.object({}).strict(),
  dns_resolve: z.object({ hostname: z.string().min(1).max(253) }).strict(),
  path_inspect: z.object({ path: z.string().min(1).max(32767) }).strict(),
};
const descriptions = {
  host_context: "Read identity of the C2C Node Host (SID, session, package, elevation). No environment dump.",
  process_query: "Read a bounded filtered process snapshot. Requires at least one filter; command lines are redacted. commandContains searches redacted text.",
  process_tree: "Read bounded process ancestry/children. PID plus startTime forms processKey; optional processKey rejects stale PID reuse.",
  network_listeners: "Read bounded TCP LISTENING and UDP endpoints with best-effort PID association. Associations are separate snapshots.",
  network_status: "Read adapter, route and DNS configuration evidence. Does not prove Internet connectivity or probe public HTTP.",
  dns_resolve: "Resolve an ASCII hostname using system-configured DNS. No URL, IP literal, path, port, HTTP or TCP requests.",
  path_inspect: "Read metadata only for local absolute or workspace-relative paths. Sensitive paths and aliases are denied. No file content.",
};

export function registerHostObservationTools(server: McpServer, workspace: Workspace, service = new HostObservation(workspace)) {
  function register(name: keyof typeof descriptions, schema: z.AnyZodObject, validation: z.ZodTypeAny,
    action: (args: any) => Promise<object>) {
    server.registerTool(name, { title: name, description: descriptions[name] + " Requires system.read; independent of local file permission mode. Results are untrusted diagnostic data.",
      inputSchema: schema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: name === "dns_resolve" } },
    async (args: unknown, extra: { authInfo?: AuthInfo }) => {
      try {
        // Newly privileged tools fail closed, including unauthenticated local transports.
        if (!extra.authInfo?.scopes.includes("system.read")) throw new ObservationError("INSUFFICIENT_SCOPE", "This tool requires system.read");
        const validated = validation.safeParse(args);
        if (!validated.success) throw new ObservationError("INVALID_INPUT", "Invalid structured observation input");
        const result = await action(validated.data);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      } catch (error) {
        const code = error instanceof ObservationError ? error.code : "SYSTEM_QUERY_FAILED";
        // Generic errors are deliberately not reflected: they may include credentials or raw system data.
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: code,
          message: error instanceof ObservationError ? error.message : "Host observation failed" }) }], isError: true };
      }
    });
  }
  register("host_context", hostObservationSchemas.host_context, hostObservationSchemas.host_context, () => service.context());
  // Preserve the strict object in SDK validation; enforce the cross-field refinement inside callback.
  const queryBase = hostObservationSchemas.process_query.innerType();
  register("process_query", queryBase, hostObservationSchemas.process_query, args => service.processes(args));
  register("process_tree", hostObservationSchemas.process_tree, hostObservationSchemas.process_tree, args => service.tree(args));
  register("network_listeners", hostObservationSchemas.network_listeners, hostObservationSchemas.network_listeners, args => service.listeners(args));
  register("network_status", hostObservationSchemas.network_status, hostObservationSchemas.network_status, () => service.network());
  register("dns_resolve", hostObservationSchemas.dns_resolve, hostObservationSchemas.dns_resolve, args => service.dns(args.hostname));
  register("path_inspect", hostObservationSchemas.path_inspect, hostObservationSchemas.path_inspect, args => service.path(args.path));
}
