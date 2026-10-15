import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger/index.js";

type FailurePhase = "server_create" | "transport_create" | "server_connect" | "handle_request";

const SAFE_ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError",
  "AggregateError", "AbortError", "McpError", "ZodError",
]);
const SAFE_ERROR_CODES = new Set([
  "EACCES", "EADDRINUSE", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "EPIPE", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN",
]);
const SAFE_PROTOCOL_CODES = new Set([-32700, -32600, -32601, -32602, -32603, -32000]);
const REGISTERED_TOOL_NAMES = new Set([
  "workspace_info", "list_directory", "read_file", "read_image", "search_workspace", "git_info", "git_status", "git_diff",
  "test_status", "execution_summary", "execution_output", "execution_start", "execution_status", "execution_list",
  "execution_job_output", "execution_cancel", "permission_status", "create_file", "replace_file", "edit_file",
  "create_external_file", "replace_external_file", "edit_external_file", "create_directory", "delete_file", "move_file",
  "read_external_file", "git_branches", "level3_request", "level3_request_status", "level3_start", "git_write",
  "host_context", "process_query", "process_tree", "network_listeners", "network_status", "dns_resolve", "path_inspect",
]);

function safeErrorDetails(error: unknown): { errorName: string; errorCode?: string; stackFrames: string[] } {
  let errorName = "UnknownError";
  let errorCode: string | undefined;
  let stack: string | undefined;
  if (error && (typeof error === "object" || typeof error === "function")) {
    try {
      const candidate = (error as { name?: unknown }).name;
      if (typeof candidate === "string" && SAFE_ERROR_NAMES.has(candidate)) errorName = candidate;
    } catch { /* getters on foreign errors are untrusted */ }
    try {
      const candidate = (error as { code?: unknown }).code;
      if (typeof candidate === "string" && SAFE_ERROR_CODES.has(candidate)) errorCode = candidate;
      else if (typeof candidate === "number" && SAFE_PROTOCOL_CODES.has(candidate)) errorCode = String(candidate);
    } catch { /* getters on foreign errors are untrusted */ }
    try {
      const candidate = (error as { stack?: unknown }).stack;
      if (typeof candidate === "string") stack = candidate;
    } catch { /* getters on foreign errors are untrusted */ }
  }

  // Never log arbitrary function names, paths, or the stack's first line.
  // Numeric locations are the only values retained from untrusted stacks.
  const stackFrames = (stack ?? "").slice(0, 4096).split("\n").slice(1, 5).flatMap((line) => {
    const match = /^\s*at (?:[^\r\n(]*\()?[^()\r\n]*?:(?<line>\d{1,7}):(?<column>\d{1,5})\)?\s*$/.exec(line);
    if (!match?.groups?.line || !match.groups.column) return [];
    return [`${match.groups.line}:${match.groups.column}`];
  });
  return { errorName, ...(errorCode ? { errorCode } : {}), stackFrames };
}

function safeToolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" && REGISTERED_TOOL_NAMES.has(name) ? name : undefined;
}

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST.
 * This maximizes compatibility with remote MCP clients (including ChatGPT)
 * and avoids cross-request session state on a public endpoint.
 */
export function createMcpHttpHandler(makeServer: () => McpServer, logger: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method === "GET" || req.method === "DELETE") {
      // Stateless mode: no server-initiated streams, no sessions to delete.
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
      return;
    }
    const requestId = randomUUID();
    res.setHeader("x-correlation-id", requestId);
    let phase: FailurePhase = "server_create";
    let server: McpServer | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      server = makeServer();
      phase = "transport_create";
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport?.close().catch(() => undefined);
        void server?.close().catch(() => undefined);
      });
      phase = "server_connect";
      await server.connect(transport);
      phase = "handle_request";
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("MCP request handling failed", {
        requestId,
        method: req.method,
        ...(safeToolName(req.body) ? { toolName: safeToolName(req.body) } : {}),
        phase,
        ...safeErrorDetails(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };
}
