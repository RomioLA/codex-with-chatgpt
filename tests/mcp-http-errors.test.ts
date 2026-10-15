import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../src/logger/index.js";
import { createMcpHttpHandler } from "../src/mcp/http.js";

async function invoke(makeServer: () => McpServer, entries: unknown[], body: unknown) {
  const logger = {
    error: (_message: string, extra?: unknown) => entries.push(extra),
  } as unknown as Logger;
  const response = {
    headersSent: false,
    headers: new Map<string, string>(),
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); return this; },
    status(value: number) { this.statusCode = value; return this; },
    json(value: unknown) { this.body = value; this.headersSent = true; return this; },
    on() { return this; },
  };
  const req = { method: "POST", body } as Request;
  const handler = createMcpHttpHandler(makeServer, logger);
  await handler(req, response as unknown as Response);
  return response;
}

describe("MCP HTTP error boundary", () => {
  it("contains server construction failures and logs only safe correlated diagnostics", async () => {
    const entries: unknown[] = [];
    const response = await invoke(() => {
      throw new Error("sensitive request body and c2c_at_12345678901234567890");
    }, entries, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "workspace_info", arguments: {} } });
    const body = JSON.stringify(response.body);
    const diagnostics = JSON.stringify(entries);

    expect(response.statusCode).toBe(500);
    const requestId = response.headers.get("x-correlation-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body).toContain("Internal server error");
    expect(body).not.toContain("sensitive");
    expect(body).not.toContain("c2c_at_");
    expect(diagnostics).toContain(requestId);
    expect(diagnostics).toContain('"toolName":"workspace_info"');
    expect(diagnostics).toContain('"phase":"server_create"');
    expect(diagnostics).toContain('"errorName":"Error"');
    expect(diagnostics).not.toContain("sensitive");
    expect(diagnostics).not.toContain("c2c_at_");
  });

  it("contains transport failures and records the failing phase without raw error text", async () => {
    vi.spyOn(StreamableHTTPServerTransport.prototype, "handleRequest")
      .mockRejectedValueOnce(new Error("private file content /workspace/.env API_KEY=secret"));
    const entries: unknown[] = [];
    const response = await invoke(() => ({
      connect: async () => undefined,
      close: async () => undefined,
    }) as unknown as McpServer, entries, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "git_status", arguments: {} } });
    const body = JSON.stringify(response.body);
    const diagnostics = JSON.stringify(entries);

    expect(response.statusCode).toBe(500);
    expect(diagnostics).toContain('"phase":"handle_request"');
    expect(diagnostics).toContain('"toolName":"git_status"');
    expect(body).not.toContain("private file content");
    expect(diagnostics).not.toContain("private file content");
    expect(diagnostics).not.toContain("API_KEY");
    expect(diagnostics).not.toContain("/workspace/.env");
  });

  it("rejects secret-bearing custom error names, codes, and stack function names", async () => {
    const error = new Error("private failure");
    Object.defineProperties(error, {
      name: { value: "c2c_access_secret" },
      code: { value: "TOKEN_SECRET" },
      stack: { value: "Error: private failure\n    at leak_secret_token (C:\\workspace\\secret.ts:7:9)" },
    });
    const entries: unknown[] = [];
    const response = await invoke(() => { throw error; }, entries, {
      jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workspace_info", arguments: {} },
    });
    const diagnostics = JSON.stringify(entries);
    const entry = entries[0] as Record<string, unknown>;

    expect(response.statusCode).toBe(500);
    expect(diagnostics).not.toContain("c2c_access_secret");
    expect(diagnostics).not.toContain("TOKEN_SECRET");
    expect(diagnostics).not.toContain("leak_secret_token");
    expect(diagnostics).not.toContain("secret.ts");
    expect(entry.errorName).toBe("UnknownError");
    expect(entry.errorCode).toBeUndefined();
    expect(entry.stackFrames).toEqual(["7:9"]);
  });

  it("omits unregistered tool names from error logs", async () => {
    const entries: unknown[] = [];
    const response = await invoke(() => { throw new Error("private failure"); }, entries, {
      jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "c2c_access_secret", arguments: {} },
    });
    const diagnostics = JSON.stringify(entries);

    expect(response.statusCode).toBe(500);
    expect(diagnostics).not.toContain("c2c_access_secret");
    expect((entries[0] as Record<string, unknown>).toolName).toBeUndefined();
  });
});
