import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { HostFilesystem } from "../src/workspace/host-filesystem.js";
import { Workspace } from "../src/workspace/manager.js";
import { setPermission, type PermissionMode } from "../src/permission/index.js";
import { getWriteAuditPath } from "../src/write/safety.js";
import { nullLogger } from "../src/logger/index.js";
import { makeTmpDir, write } from "./helpers.js";

const scopes = ["workspace.read", "workspace.write", "workspace.delete", "filesystem.external.read", "filesystem.external.write"];
const staleHash = "0".repeat(64);
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
let root: string;
let outside: string;
let state: string;
let bridge: Bridge;
let client: Client;
let limited: Client;
let sequence = 0;
let directoryLinks = false;

function fresh(label = "fixture.txt") { return `${++sequence}-${label}`; }
function data(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { type: string; text: string }[])[0].text);
}
async function call(name: string, args: Record<string, unknown>, expected?: string, target = client) {
  const result = await target.callTool({ name, arguments: args });
  if (expected) {
    expect(result.isError).toBe(true);
    expect(data(result).error).toBe(expected);
  } else {
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual(data(result));
  }
  return data(result);
}
async function connect(granted: string[]): Promise<Client> {
  // Issue a controlled test token; OAuth scope registration belongs to the independent 2C task.
  const tokens = bridge.authStore.issueTokens({ clientId: fresh("client"), scopes: granted });
  const connected = new Client({ name: "file-tools-test", version: "1" });
  await connected.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  }));
  return connected;
}

beforeAll(async () => {
  root = makeTmpDir("mcp-file-workspace");
  outside = makeTmpDir("mcp-file-external");
  state = makeTmpDir("mcp-file-state");
  vi.stubEnv("C2C_STATE_DIR", state);
  write(root, "snapshot.txt", "first\r\nsecond\n第三行\n");
  write(outside, "ordinary.txt", "external fixture\n");
  write(outside, ".env", "FAKE_SECRET=fixture-only\n");
  try {
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(root, path.join(outside, "into-workspace"), process.platform === "win32" ? "junction" : "dir");
    directoryLinks = true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false,
    authStoreFile: path.join(state, "auth.json") });
  client = await connect(scopes);
  limited = await connect(["workspace.read"]);
});

beforeEach(() => {
  vi.restoreAllMocks();
  setPermission(bridge.workspace.id, "readonly");
});

afterAll(async () => {
  await client?.close();
  await limited?.close();
  await bridge?.close();
  vi.unstubAllEnvs();
  // Retain all fixtures. No recursive cleanup or real workspace/state mutation.
});

describe("MCP file tools over real Streamable HTTP", () => {
  it.each(["readonly", "level1", "level2"] as PermissionMode[])("permission_status reports %s and cannot change mode", async (mode) => {
    setPermission(bridge.workspace.id, mode);
    expect(await call("permission_status", {})).toEqual({ workspaceId: bridge.workspace.id, mode });
    const { tools } = await client.listTools();
    const status = tools.find((tool) => tool.name === "permission_status")!;
    expect(status.annotations?.readOnlyHint).toBe(true);
    expect((status.inputSchema as { properties: object }).properties).toEqual({});
  });

  it("workspace read hash covers exact complete bytes across line pages", async () => {
    const first = await call("read_file", { path: "snapshot.txt", start_line: 1, end_line: 1 });
    const second = await call("read_file", { path: "snapshot.txt", start_line: 2, end_line: 2 });
    expect(first.content).toBe("first");
    expect(second.content).toBe("second");
    expect(first.contentHash).toBe(hash(fs.readFileSync(path.join(root, "snapshot.txt"))));
    expect(second.contentHash).toBe(first.contentHash);
    expect(first.nextStartLine).toBe(2);
  });

  for (const mode of ["readonly", "level1", "level2"] as PermissionMode[]) {
    const workspaceAllowed = mode !== "readonly";
    const externalAllowed = mode === "level2";
    const deny = "LOCAL_PERMISSION_DENIED";

    it(`${mode}: workspace create / replace / edit / move / delete / directory matrix`, async () => {
      setPermission(bridge.workspace.id, mode);
      const file = fresh();
      const abs = path.join(root, file);
      await call("create_file", { path: file, content: "original" }, workspaceAllowed ? undefined : deny);
      if (!workspaceAllowed) {
        expect(fs.existsSync(abs)).toBe(false);
        write(root, file, "original");
      }
      const read = await call("read_file", { path: file });
      await call("replace_file", { path: file, content: "replacement", expected_hash: read.contentHash }, workspaceAllowed ? undefined : deny);
      expect(fs.readFileSync(abs, "utf8")).toBe(workspaceAllowed ? "replacement" : "original");
      const next = await call("read_file", { path: file });
      await call("edit_file", { path: file, old_text: workspaceAllowed ? "replacement" : "original", new_text: "edited", expected_hash: next.contentHash }, workspaceAllowed ? undefined : deny);
      const destination = fresh("moved.txt");
      await call("move_file", { source: file, destination }, workspaceAllowed ? undefined : deny);
      expect(fs.existsSync(abs)).toBe(!workspaceAllowed);
      expect(fs.existsSync(path.join(root, destination))).toBe(workspaceAllowed);
      const currentPath = workspaceAllowed ? destination : file;
      const current = await call("read_file", { path: currentPath });
      await call("delete_file", { path: currentPath, expected_hash: current.contentHash }, mode === "level2" ? undefined : deny);
      expect(fs.existsSync(path.join(root, currentPath))).toBe(mode !== "level2");
      const directory = fresh("dir");
      await call("create_directory", { path: directory }, workspaceAllowed ? undefined : deny);
      expect(fs.existsSync(path.join(root, directory))).toBe(workspaceAllowed);
      if (workspaceAllowed) {
        const child = `${directory}/child.txt`;
        await call("create_file", { path: child, content: "child fixture" });
        expect(fs.readFileSync(path.join(root, child), "utf8")).toBe("child fixture");
      }
    });

    it(`${mode}: external read / create / replace / edit matrix`, async () => {
      setPermission(bridge.workspace.id, mode);
      const file = write(outside, fresh(), "external original");
      const created = path.join(outside, fresh("created.txt"));
      const before = fs.readFileSync(file);
      await call("read_external_file", { path: file }, workspaceAllowed ? undefined : deny);
      await call("create_external_file", { path: created, content: "created" }, externalAllowed ? undefined : deny);
      expect(fs.existsSync(created)).toBe(externalAllowed);
      await call("replace_external_file", { path: file, content: "external replacement", expected_hash: hash(before) }, externalAllowed ? undefined : deny);
      const current = fs.readFileSync(file);
      await call("edit_external_file", { path: file, old_text: externalAllowed ? "replacement" : "original", new_text: "edited", expected_hash: hash(current) }, externalAllowed ? undefined : deny);
      expect(fs.readFileSync(file, "utf8")).toBe(externalAllowed ? "external edited" : "external original");
    });

    it(`${mode}: external deletion and moves are unavailable and workspace tools cannot substitute`, async () => {
      setPermission(bridge.workspace.id, mode);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      for (const forbidden of ["delete_external_file", "move_external_file", "delete_directory", "create_external_directory"]) {
        expect(names).not.toContain(forbidden);
      }
      const file = path.join(outside, "ordinary.txt");
      await call("delete_file", { path: file, expected_hash: hash("external fixture\n") }, "PATH_OUTSIDE_WORKSPACE");
      await call("move_file", { source: file, destination: fresh() }, "PATH_OUTSIDE_WORKSPACE");
      await call("move_file", { source: "snapshot.txt", destination: path.join(outside, fresh()) }, "PATH_OUTSIDE_WORKSPACE");
      await call("delete_file", { path: path.relative(root, file), expected_hash: hash("external fixture\n") }, "PATH_OUTSIDE_WORKSPACE");
      expect(fs.readFileSync(file, "utf8")).toBe("external fixture\n");
    });
  }

  it("denies every privileged operation with missing OAuth scope despite local level2", async () => {
    setPermission(bridge.workspace.id, "level2");
    const file = write(root, fresh(), "keep");
    const relative = path.basename(file);
    const external = write(outside, fresh(), "external keep");
    for (const [name, args] of [
      ["create_file", { path: fresh(), content: "no" }],
      ["replace_file", { path: relative, content: "no", expected_hash: hash("keep") }],
      ["edit_file", { path: relative, old_text: "keep", new_text: "no", expected_hash: hash("keep") }],
      ["move_file", { source: relative, destination: fresh() }],
      ["delete_file", { path: relative, expected_hash: hash("keep") }],
      ["create_directory", { path: fresh("dir") }],
      ["read_external_file", { path: external }],
      ["create_external_file", { path: path.join(outside, fresh()), content: "no" }],
      ["replace_external_file", { path: external, content: "no", expected_hash: hash("external keep") }],
      ["edit_external_file", { path: external, old_text: "keep", new_text: "no", expected_hash: hash("external keep") }],
    ] as [string, Record<string, unknown>][]) {
      await call(name, args, "INSUFFICIENT_SCOPE", limited);
    }
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
    expect(fs.readFileSync(external, "utf8")).toBe("external keep");
  });

  it("permission_status requires workspace.read", async () => {
    const noRead = await connect(["workspace.write"]);
    try { await call("permission_status", {}, "INSUFFICIENT_SCOPE", noRead); }
    finally { await noRead.close(); }
  });

  it("rejects missing hashes at the MCP schema boundary", async () => {
    setPermission(bridge.workspace.id, "level2");
    const file = write(root, fresh(), "preserve");
    const external = write(outside, fresh(), "preserve");
    for (const [name, args] of [
      ["replace_file", { path: path.basename(file), content: "bad" }],
      ["edit_file", { path: path.basename(file), old_text: "preserve", new_text: "bad" }],
      ["delete_file", { path: path.basename(file) }],
      ["replace_external_file", { path: external, content: "bad" }],
      ["edit_external_file", { path: external, old_text: "preserve", new_text: "bad" }],
    ] as [string, Record<string, unknown>][]) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain("expected_hash");
    }
    expect(fs.readFileSync(file, "utf8")).toBe("preserve");
    expect(fs.readFileSync(external, "utf8")).toBe("preserve");
  });

  it("rejects stale replace/edit/delete and audits refusals without modifying newer content", async () => {
    setPermission(bridge.workspace.id, "level2");
    const file = write(root, fresh(), "old");
    const relative = path.basename(file);
    const snapshot = await call("read_file", { path: relative });
    fs.writeFileSync(file, "newer");
    await call("replace_file", { path: relative, content: "bad", expected_hash: snapshot.contentHash }, "STALE_FILE");
    await call("edit_file", { path: relative, old_text: "old", new_text: "bad", expected_hash: snapshot.contentHash }, "STALE_FILE");
    await call("delete_file", { path: relative, expected_hash: snapshot.contentHash }, "STALE_FILE");
    const external = write(outside, fresh(), "external");
    await call("replace_external_file", { path: external, content: "bad", expected_hash: staleHash }, "STALE_FILE");
    await call("edit_external_file", { path: external, old_text: "external", new_text: "bad", expected_hash: staleHash }, "STALE_FILE");
    expect(fs.readFileSync(file, "utf8")).toBe("newer");
    expect(fs.readFileSync(external, "utf8")).toBe("external");
    const records = fs.readFileSync(getWriteAuditPath(bridge.workspace.id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.filter((record) => record.path === file)).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "replace", errorCode: "STALE_FILE", success: false }),
      expect.objectContaining({ operation: "edit", errorCode: "STALE_FILE", success: false }),
      expect.objectContaining({ operation: "delete", errorCode: "STALE_FILE", success: false }),
    ]));
    expect(fs.readFileSync(getWriteAuditPath(bridge.workspace.id), "utf8")).not.toContain('"content":');
  });

  it("rejects existing create/destination, missing files, directory delete and ambiguous edits", async () => {
    setPermission(bridge.workspace.id, "level2");
    const relative = fresh();
    const file = write(root, relative, "repeat repeat");
    const external = write(outside, fresh(), "external keep");
    await call("create_file", { path: relative, content: "bad" }, "FILE_ALREADY_EXISTS");
    await call("create_external_file", { path: external, content: "bad" }, "FILE_ALREADY_EXISTS");
    await call("move_file", { source: relative, destination: "snapshot.txt" }, "DESTINATION_EXISTS");
    await call("edit_file", { path: relative, old_text: "repeat", new_text: "bad", expected_hash: hash("repeat repeat") }, "AMBIGUOUS_EDIT");
    await call("replace_file", { path: fresh(), content: "bad", expected_hash: staleHash }, "FILE_NOT_FOUND");
    await call("delete_file", { path: fresh(), expected_hash: staleHash }, "FILE_NOT_FOUND");
    const directory = fresh("directory");
    await call("create_directory", { path: directory });
    await call("delete_file", { path: directory, expected_hash: staleHash }, "NOT_A_FILE");
    await call("create_directory", { path: directory }, "FILE_ALREADY_EXISTS");
    expect(fs.readFileSync(file, "utf8")).toBe("repeat repeat");
  });

  it("denies sensitive targets on all external read/write tools", async () => {
    setPermission(bridge.workspace.id, "level2");
    const sensitive = path.join(outside, ".env");
    await call("read_external_file", { path: sensitive }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call("create_external_file", { path: sensitive, content: "bad" }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call("replace_external_file", { path: sensitive, content: "bad", expected_hash: staleHash }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call("edit_external_file", { path: sensitive, old_text: "FAKE", new_text: "bad", expected_hash: staleHash }, "ACCESS_DENIED_SENSITIVE_FILE");
    expect(fs.readFileSync(sensitive, "utf8")).toContain("fixture-only");
  });

  it("external read is bounded, paginated and hashes original bytes; refuses binary/invalid UTF-8/oversize", async () => {
    setPermission(bridge.workspace.id, "level1");
    const text = "中文 fixture\r\n".repeat(9000);
    const file = write(outside, fresh(), text);
    const first = await call("read_external_file", { path: file, limit: 10 });
    const second = await call("read_external_file", { path: file, offset: first.nextOffset, limit: 10 });
    expect(first.content + second.content).toBe(text.slice(0, 20));
    expect(first.contentHash).toBe(hash(text));
    expect(second.contentHash).toBe(first.contentHash);
    const defaultPage = await call("read_external_file", { path: file });
    expect(Buffer.byteLength(defaultPage.content)).toBeLessThanOrEqual(256 * 1024);
    for (const [bytes, code] of [
      [Buffer.from([65, 0, 66]), "BINARY_FILE"],
      [Buffer.from([0xff, 0xfe]), "BINARY_FILE"],
      [Buffer.alloc(1024 * 1024 + 1, 65), "FILE_TOO_LARGE"],
    ] as [Buffer, string][]) {
      const target = path.join(outside, fresh());
      fs.writeFileSync(target, bytes);
      await call("read_external_file", { path: target }, code);
    }
    await call("read_external_file", { path: path.join(outside, fresh()) }, "FILE_NOT_FOUND");
  });

  it("rejects external-relative intent and host-absolute paths to workspace files", async () => {
    setPermission(bridge.workspace.id, "level2");
    await call("read_external_file", { path: "snapshot.txt" }, "EXTERNAL_PATH_REQUIRED");
    await call("create_external_file", { path: "relative.txt", content: "bad" }, "EXTERNAL_PATH_REQUIRED");
    await call("read_external_file", { path: path.join(root, "snapshot.txt") }, "EXTERNAL_PATH_REQUIRED");
    await call("replace_external_file", { path: path.join(root, "snapshot.txt"), content: "bad", expected_hash: staleHash }, "EXTERNAL_PATH_REQUIRED");
    await call("create_file", { path: path.join(root, fresh()), content: "bad" }, "PATH_OUTSIDE_WORKSPACE");
  });

  it("real junction/symlink crossings cannot bypass either location boundary", async (context) => {
    if (!directoryLinks) return context.skip();
    setPermission(bridge.workspace.id, "level2");
    const target = fresh();
    await call("create_file", { path: `escape/${target}`, content: "bad" }, "PATH_OUTSIDE_WORKSPACE");
    await call("delete_file", { path: "escape/ordinary.txt", expected_hash: hash("external fixture\n") }, "PATH_OUTSIDE_WORKSPACE");
    await call("move_file", { source: "snapshot.txt", destination: `escape/${fresh()}` }, "PATH_OUTSIDE_WORKSPACE");
    await call("move_file", { source: "escape/ordinary.txt", destination: fresh() }, "PATH_OUTSIDE_WORKSPACE");
    await call("read_external_file", { path: path.join(outside, "into-workspace/snapshot.txt") }, "EXTERNAL_PATH_REQUIRED");
    await call("create_external_file", { path: path.join(outside, "into-workspace", fresh()), content: "bad" }, "EXTERNAL_PATH_REQUIRED");
    expect(fs.existsSync(path.join(outside, target))).toBe(false);
  });

  it("revalidates canonical target immediately before mutation", async () => {
    setPermission(bridge.workspace.id, "level2");
    const original = HostFilesystem.prototype.checkOperation;
    let calls = 0;
    vi.spyOn(HostFilesystem.prototype, "checkOperation").mockImplementation(function(requested, operation) {
      const result = original.call(this, requested, operation);
      if (++calls === 2 && result.decision === "requires-permission") {
        return { ...result, target: { ...result.target, abs: path.join(root, fresh("swapped.txt")) } };
      }
      return result;
    });
    const target = fresh();
    await call("create_file", { path: target, content: "bad" }, "PATH_CHANGED");
    expect(fs.existsSync(path.join(root, target))).toBe(false);
  });

  it("rechecks local mode after initial authorization", async () => {
    setPermission(bridge.workspace.id, "level2");
    const original = HostFilesystem.prototype.checkOperation;
    let calls = 0;
    vi.spyOn(HostFilesystem.prototype, "checkOperation").mockImplementation(function(requested, operation) {
      const result = original.call(this, requested, operation);
      if (++calls === 2) setPermission(bridge.workspace.id, "readonly");
      return result;
    });
    const target = fresh();
    await call("create_file", { path: target, content: "bad" }, "LOCAL_PERMISSION_DENIED");
    expect(fs.existsSync(path.join(root, target))).toBe(false);
  });

  it("has accurate mutation annotations and hash requirements", async () => {
    const { tools } = await client.listTools();
    for (const name of ["create_file", "replace_file", "edit_file", "move_file", "delete_file", "create_directory", "create_external_file", "replace_external_file", "edit_external_file"]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.find((tool) => tool.name === "delete_file")?.annotations?.destructiveHint).toBe(true);
    expect(tools.find((tool) => tool.name === "create_file")?.annotations?.destructiveHint).toBe(false);
    for (const name of ["replace_file", "edit_file", "delete_file", "replace_external_file", "edit_external_file"]) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema.required).toContain("expected_hash");
    }
  });

  it("unauthenticated in-process clients cannot bypass OAuth gating", async () => {
    setPermission(bridge.workspace.id, "level2");
    const local = new Client({ name: "unauthenticated", version: "1" });
    const server = createMcpServer({ workspace: new Workspace(root), logger: nullLogger });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), local.connect(clientTransport)]);
    try {
      const target = fresh();
      await call("create_file", { path: target, content: "bad" }, "INSUFFICIENT_SCOPE", local);
      expect(fs.existsSync(path.join(root, target))).toBe(false);
    } finally { await local.close(); await server.close(); }
  });
});
