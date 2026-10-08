import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { HostObservation } from "../src/host-observation/service.js";
import { Workspace } from "../src/workspace/manager.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir } from "./helpers.js";

const names = ["host_context", "process_query", "process_tree", "network_listeners", "network_status", "dns_resolve", "path_inspect"];
const args = [{}, { pid: 1 }, { pid: 1 }, {}, {}, { hostname: "example.com" }, { path: "." }];
const methods = ["context", "processes", "tree", "listeners", "network", "dns", "path"] as const;
afterEach(() => vi.restoreAllMocks());
async function connect(scopes?: string[]) {
  const server = createMcpServer({ workspace: new Workspace(makeTmpDir("host-mcp")), logger: nullLogger });
  const client = new Client({ name: "host-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const original = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) => original(message, { ...options, authInfo: scopes ? {
    token: "fixture-only", clientId: "host-test", scopes,
  } : undefined });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
function data(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0].text);
}
describe("host MCP capability gates", () => {
  it.each([undefined, ["workspace.read"], ["workspace.write", "workspace.delete", "filesystem.external.write"]])("requires system.read regardless of file scopes: %j", async scopes => {
    const mock = vi.spyOn(HostObservation.prototype, "context");
    const session = await connect(scopes);
    try {
      for (let i = 0; i < names.length; i++) {
        const result = await session.client.callTool({ name: names[i], arguments: args[i] });
        expect(result.isError).toBe(true); expect(data(result).error).toBe("INSUFFICIENT_SCOPE");
      }
      expect(mock).not.toHaveBeenCalled();
    } finally { await session.close(); }
  });
  it("allows all seven with system.read alone and leaves file mutation denied", async () => {
    for (const method of methods) vi.spyOn(HostObservation.prototype, method).mockResolvedValue({ fixture: method } as never);
    const session = await connect(["system.read"]);
    try {
      for (let i = 0; i < names.length; i++) {
        const result = await session.client.callTool({ name: names[i], arguments: args[i] });
        expect(result.isError).not.toBe(true); expect(result.structuredContent).toEqual({ fixture: methods[i] });
      }
      const mutation = await session.client.callTool({ name: "create_file", arguments: { path: "no.txt", content: "no" } });
      expect(data(mutation).error).toBe("INSUFFICIENT_SCOPE");
      const listed = await session.client.listTools();
      for (const name of names) expect(listed.tools.find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true);
      for (const name of names) expect(listed.tools.find(t => t.name === name)?.inputSchema.additionalProperties).toBe(false);
      for (const name of ["run_shell", "execute_command", "powershell", "cmd", "kill_process", "start_process"]) {
        expect(listed.tools.find(t => t.name === name)).toBeUndefined();
      }
    } finally { await session.close(); }
  });
  it("rejects unfiltered dumps and suppresses raw internal errors", async () => {
    vi.spyOn(HostObservation.prototype, "context").mockRejectedValue(new Error("raw token fixture-secret"));
    const session = await connect(["system.read"]);
    try {
      const invalid = await session.client.callTool({ name: "process_query", arguments: {} });
      expect(data(invalid).error).toBe("INVALID_INPUT");
      const unknown = await session.client.callTool({ name: "process_query", arguments: { pid: 1, script: "fixture" } });
      expect(unknown.isError).toBe(true);
      const failure = await session.client.callTool({ name: "host_context", arguments: {} });
      expect(data(failure).error).toBe("SYSTEM_QUERY_FAILED");
      expect(JSON.stringify(failure)).not.toContain("fixture-secret");
    } finally { await session.close(); }
  });
});
