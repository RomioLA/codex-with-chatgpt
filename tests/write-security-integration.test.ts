import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { DEFAULT_SCOPES, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { readPermission, setPermission } from "../src/permission/index.js";
import { makeTmpDir, pkceVerifierAndChallenge, write } from "./helpers.js";

const redirectUri = "http://127.0.0.1:19999/integration-callback";
const legacyScopes = ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"];
const fileScopes = ["workspace.read", "workspace.write", "workspace.delete", "filesystem.external.read", "filesystem.external.write"];
const cliEntry = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
let root: string;
let outside: string;
let state: string;
let bridge: Bridge;
let sequence = 0;
const clients: Client[] = [];
const sessions = new Map<string, Promise<{ client: Client; token: Token; clientId: string }>>();

interface Token { access_token: string; refresh_token?: string; scope: string }
function fresh(label = "fixture.txt") { return `${++sequence}-${label}`; }
function decode(result: Awaited<ReturnType<Client["callTool"]>>) {
  return JSON.parse((result.content as { text: string }[])[0].text);
}
async function call(client: Client, name: string, args: Record<string, unknown>, error?: string) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ?? false).toBe(Boolean(error));
  const data = decode(result);
  if (error) expect(data.error).toBe(error);
  return data;
}

async function connect(accessToken: string, target = bridge): Promise<Client> {
  const client = new Client({ name: "write-security-oauth", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${target.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  }));
  return client;
}

// Every MCP credential in this suite goes through registration, pairing,
// authorization-code + PKCE exchange, and bearer middleware. Never issueTokens.
async function authorize(scope?: string) {
  const base = bridge.localBaseUrl();
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Wave2-Integration", redirect_uris: [redirectUri] }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const pairing = await fetch(`${base}/admin/pairing`, {
    method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
  expect(pairing.status).toBe(200);
  const { code: pairingCode } = await pairing.json() as { code: string };
  const { verifier, challenge } = pkceVerifierAndChallenge();
  const url = new URL(`${base}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    state: "wave2-security", code_challenge: challenge, code_challenge_method: "S256",
  })) url.searchParams.set(key, value);
  if (scope !== undefined) url.searchParams.set("scope", scope);
  const page = await fetch(url, { redirect: "manual" });
  expect(page.status).toBe(200);
  const requestId = (await page.text()).match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  expect(requestId).toBeTruthy();
  const consent = await fetch(`${base}/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId!, pairing_code: pairingCode }), redirect: "manual",
  });
  expect(consent.status).toBe(302);
  const callback = new URL(consent.headers.get("location")!);
  expect(callback.searchParams.get("state")).toBe("wave2-security");
  const code = callback.searchParams.get("code");
  expect(code).toBeTruthy();
  const exchange = await fetch(`${base}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      redirect_uri: redirectUri, code: code!, code_verifier: verifier }),
  });
  expect(exchange.status).toBe(200);
  const token = await exchange.json() as Token;
  expect(token.scope.split(" ")).toEqual(scope === undefined ? legacyScopes : scope.split(" "));
  return { client: await connect(token.access_token), token, clientId };
}

function session(scopes?: string[]) {
  const key = scopes?.join(" ") ?? "<default>";
  if (!sessions.has(key)) sessions.set(key, authorize(scopes?.join(" ")));
  return sessions.get(key)!;
}

beforeAll(async () => {
  root = makeTmpDir("write-security-workspace");
  outside = makeTmpDir("write-security-external");
  state = makeTmpDir("write-security-state");
  vi.stubEnv("C2C_STATE_DIR", state);
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
});
beforeEach(() => setPermission(bridge.workspace.id, "readonly"));
afterAll(async () => {
  for (const client of clients) await client.close();
  await bridge?.close();
  vi.unstubAllEnvs();
  // Retain isolated fixtures; no recursive cleanup and no preload hook.
});

describe("real OAuth -> MCP -> local permission -> filesystem safety", () => {
  it("A: omitted scope grants only legacy defaults and denies create at local level2", async () => {
    expect([...DEFAULT_SCOPES]).toEqual(legacyScopes);
    expect([...SUPPORTED_SCOPES]).toEqual([...legacyScopes, ...fileScopes.slice(1)]);
    const { client, token } = await session();
    expect(token.scope.split(" ")).toEqual(legacyScopes);
    setPermission(bridge.workspace.id, "level2");
    const relative = fresh();
    await call(client, "create_file", { path: relative, content: "denied" }, "INSUFFICIENT_SCOPE");
    expect(fs.existsSync(path.join(root, relative))).toBe(false);
  });

  it("B: explicit workspace.write cannot bypass local readonly", async () => {
    const { client } = await session(["workspace.write"]);
    const relative = fresh();
    await call(client, "create_file", { path: relative, content: "denied" }, "LOCAL_PERMISSION_DENIED");
    expect(fs.existsSync(path.join(root, relative))).toBe(false);
  });

  it("C: explicit workspace.write + level1 creates but cannot delete without workspace.delete", async () => {
    const { client } = await session(["workspace.write"]);
    setPermission(bridge.workspace.id, "level1");
    const relative = fresh();
    const created = await call(client, "create_file", { path: relative, content: "keep" });
    expect(fs.readFileSync(path.join(root, relative), "utf8")).toBe("keep");
    await call(client, "delete_file", { path: relative, expected_hash: created.newHash }, "INSUFFICIENT_SCOPE");
    expect(fs.readFileSync(path.join(root, relative), "utf8")).toBe("keep");
  });

  it.each(["level1", "level2"] as const)("D/E: workspace.delete + %s enforces the local delete gate", async (mode) => {
    const { client } = await session(["workspace.delete"]);
    setPermission(bridge.workspace.id, mode);
    const relative = fresh();
    const file = write(root, relative, "delete fixture");
    await call(client, "delete_file", { path: relative, expected_hash: hash("delete fixture") },
      mode === "level1" ? "LOCAL_PERMISSION_DENIED" : undefined);
    expect(fs.existsSync(file)).toBe(mode === "level1");
  });

  it("F: external.read + level1 returns full-byte hash across pages", async () => {
    const { client } = await session(["filesystem.external.read"]);
    setPermission(bridge.workspace.id, "level1");
    const text = "中文\r\nexternal bytes\n";
    const file = write(outside, fresh(), text);
    const first = await call(client, "read_external_file", { path: file, limit: 2 });
    const next = await call(client, "read_external_file", { path: file, offset: first.nextOffset, limit: 2 });
    expect(first.content + next.content).toBe(text.slice(0, 4));
    expect(first.contentHash).toBe(hash(fs.readFileSync(file)));
    expect(next.contentHash).toBe(first.contentHash);
  });

  it("G/H: external.write is denied at level1 and creates/replaces/edits at level2", async () => {
    const { client } = await session(["filesystem.external.write"]);
    const file = path.join(outside, fresh());
    setPermission(bridge.workspace.id, "level1");
    await call(client, "create_external_file", { path: file, content: "original" }, "LOCAL_PERMISSION_DENIED");
    expect(fs.existsSync(file)).toBe(false);
    setPermission(bridge.workspace.id, "level2");
    const created = await call(client, "create_external_file", { path: file, content: "original" });
    const replaced = await call(client, "replace_external_file", { path: file, content: "replacement", expected_hash: created.newHash });
    await call(client, "edit_external_file", { path: file, old_text: "replacement", new_text: "edited", expected_hash: replaced.newHash });
    expect(fs.readFileSync(file, "utf8")).toBe("edited");
  });

  it("I: no external move/delete, recursive delete, or remote permission mutation surface", async () => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    const tools = (await client.listTools()).tools;
    expect(tools.filter((tool) => /permission/.test(tool.name)).map((tool) => tool.name)).toEqual(["permission_status"]);
    for (const name of ["delete_external_file", "move_external_file", "delete_directory", "set_permission", "permission_set", "permission_elevate"]) {
      expect(tools.map((tool) => tool.name)).not.toContain(name);
      const denied = await client.callTool({ name, arguments: {} });
      expect(denied.isError).toBe(true);
      expect((denied.content as { text: string }[])[0].text).toContain(`Tool ${name} not found`);
    }
    const external = write(outside, fresh(), "keep external");
    const internal = write(root, fresh(), "keep workspace");
    for (const [source, destination] of [
      [external, fresh()], [path.basename(internal), path.join(outside, fresh())], [external, path.join(outside, fresh())],
    ]) await call(client, "move_file", { source, destination }, "PATH_OUTSIDE_WORKSPACE");
    await call(client, "delete_file", { path: external, expected_hash: hash("keep external") }, "PATH_OUTSIDE_WORKSPACE");
    await call(client, "delete_file", { path: ".", expected_hash: hash("") }, "NOT_A_FILE");
    expect(fs.readFileSync(external, "utf8")).toBe("keep external");
    expect(fs.readFileSync(internal, "utf8")).toBe("keep workspace");
    for (const endpoint of ["/admin/permission", "/admin/set-permission"]) {
      const response = await fetch(`${bridge.localBaseUrl()}${endpoint}`, {
        method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ mode: "level1" }),
      });
      expect(response.status).toBe(404);
    }
    expect(readPermission(bridge.workspace.id)).toBe("level2");
  });

  const operations = ["create_file", "replace_file", "edit_file", "move_file", "delete_file", "create_directory",
    "read_external_file", "create_external_file", "replace_external_file", "edit_external_file"];
  function argsFor(tool: string) {
    const relative = fresh();
    write(root, relative, "keep");
    const external = write(outside, fresh(), "keep");
    if (tool === "move_file") return { source: relative, destination: fresh() };
    if (tool === "create_directory") return { path: fresh("directory") };
    const isExternal = tool.includes("external");
    return { path: tool.startsWith("create") ? (isExternal ? path.join(outside, fresh()) : fresh()) : (isExternal ? external : relative),
      content: "denied", expected_hash: hash("keep"), old_text: "keep", new_text: "denied" };
  }

  it.each(operations)("real default token denies %s even at level2", async (tool) => {
    const { client } = await session();
    setPermission(bridge.workspace.id, "level2");
    await call(client, tool, argsFor(tool), "INSUFFICIENT_SCOPE");
  });
  it.each(operations)("real explicit token cannot bypass readonly for %s", async (tool) => {
    const { client } = await session(fileScopes);
    await call(client, tool, argsFor(tool), "LOCAL_PERMISSION_DENIED");
  });

  it("local CLI changes MCP/admin mode and actual writes on one live Bridge without restart", async () => {
    const { client } = await session(fileScopes);
    const originalBase = bridge.localBaseUrl();
    const observe = async (mode: string) => {
      expect(await call(client, "permission_status", {})).toEqual({ workspaceId: bridge.workspace.id, mode });
      const response = await fetch(`${originalBase}/admin/info`, { headers: { authorization: `Bearer ${bridge.adminToken}` } });
      expect(response.status).toBe(200);
      expect((await response.json() as { permissionMode: string }).permissionMode).toBe(mode);
      expect(bridge.localBaseUrl()).toBe(originalBase);
    };
    await observe("readonly");
    await call(client, "create_file", { path: fresh(), content: "denied" }, "LOCAL_PERMISSION_DENIED");
    for (const [arg, mode] of [["1", "level1"], ["2", "level2"], ["readonly", "readonly"]]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", cliEntry, "permission", arg, "--json", "-w", root], {
        cwd: path.dirname(path.dirname(path.dirname(cliEntry))), encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: state },
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout).mode).toBe(mode);
      await observe(mode);
      const file = fresh();
      await call(client, "create_file", { path: file, content: "live" }, mode === "readonly" ? "LOCAL_PERMISSION_DENIED" : undefined);
      expect(fs.existsSync(path.join(root, file))).toBe(mode !== "readonly");
    }
  });

  it("persisted readonly-era refresh cannot gain new capabilities after loading upgraded Bridge", async () => {
    const legacy = await authorize(legacyScopes.join(" "));
    setPermission(bridge.workspace.id, "level2");
    for (const client of clients) await client.close();
    clients.length = 0;
    sessions.clear();
    await bridge.close();
    bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });

    const response = await fetch(`${bridge.localBaseUrl()}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: legacy.clientId,
        refresh_token: legacy.token.refresh_token!, scope: SUPPORTED_SCOPES.join(" ") }),
    });
    expect(response.status).toBe(200);
    const refreshed = await response.json() as Token;
    expect(refreshed.scope.split(" ")).toEqual(legacyScopes);
    const client = await connect(refreshed.access_token, bridge);
    const relative = fresh();
    await call(client, "create_file", { path: relative, content: "denied" }, "INSUFFICIENT_SCOPE");
    expect(fs.existsSync(path.join(root, relative))).toBe(false);
    await client.close();
  });

  it("real OAuth stale replace/edit/delete preserves newer bytes for both locations", async () => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    const relative = fresh();
    const internal = write(root, relative, "A\r\n完整文件\n");
    const external = write(outside, fresh(), "A\r\n完整文件\n");
    const snapshots = [
      await call(client, "read_file", { path: relative, start_line: 1, end_line: 1 }),
      await call(client, "read_external_file", { path: external, limit: 1 }),
    ];
    expect(snapshots[0].contentHash).toBe(hash(fs.readFileSync(internal)));
    expect(snapshots[1].contentHash).toBe(hash(fs.readFileSync(external)));
    for (const file of [internal, external]) fs.writeFileSync(file, "B\r\nnewer bytes\n");
    for (const [index, suffix, file] of [[0, "file", relative], [1, "external_file", external]] as const) {
      await call(client, `replace_${suffix}`, { path: file, content: "bad", expected_hash: snapshots[index].contentHash }, "STALE_FILE");
      await call(client, `edit_${suffix}`, { path: file, old_text: "A", new_text: "bad", expected_hash: snapshots[index].contentHash }, "STALE_FILE");
    }
    await call(client, "delete_file", { path: relative, expected_hash: snapshots[0].contentHash }, "STALE_FILE");
    expect(fs.readFileSync(internal, "utf8")).toBe("B\r\nnewer bytes\n");
    expect(fs.readFileSync(external, "utf8")).toBe("B\r\nnewer bytes\n");
  });

  it.each(["level1", "level2"] as const)("state-file read cannot expose the local control plane at %s", async (mode) => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, mode);
    const file = path.join(state, "permissions", `${bridge.workspace.id}.json`);
    await call(client, "read_external_file", { path: file }, "ACCESS_DENIED_SENSITIVE_FILE");
  });

  it("state-file writes cannot alter or create local permission records at level2", async () => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    const file = path.join(state, "permissions", `${bridge.workspace.id}.json`);
    const bytes = fs.readFileSync(file);
    const content = JSON.stringify({ version: 1, workspaceId: bridge.workspace.id, mode: "readonly", updatedAt: "fixture" });
    await call(client, "replace_external_file", { path: file, content, expected_hash: hash(bytes) }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call(client, "edit_external_file", { path: file, old_text: "level2", new_text: "readonly", expected_hash: hash(bytes) }, "ACCESS_DENIED_SENSITIVE_FILE");
    const other = path.join(state, "permissions", "abcdef123456.json");
    await call(client, "create_external_file", { path: other, content }, "ACCESS_DENIED_SENSITIVE_FILE");
    expect(fs.existsSync(other)).toBe(false);
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(readPermission(bridge.workspace.id)).toBe("level2");
  });

  it("sensitive targets remain denied through real external junctions", async (context) => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    const target = makeTmpDir("write-security-sensitive");
    const sensitive = write(target, ".ssh/ordinary.txt", "FAKE_SECRET=fixture\n");
    const alias = path.join(outside, fresh("link"));
    try { fs.symlinkSync(path.join(target, ".ssh"), alias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    // Neither the alias directory nor the filename is sensitive; the target is.
    const linked = path.join(alias, "ordinary.txt");
    await call(client, "read_external_file", { path: linked }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call(client, "replace_external_file", { path: linked, content: "bad", expected_hash: hash(fs.readFileSync(sensitive)) }, "ACCESS_DENIED_SENSITIVE_FILE");
    expect(fs.readFileSync(sensitive, "utf8")).toBe("FAKE_SECRET=fixture\n");
  });

  it("state-file protection follows external aliases and denies workspace read/mutation aliases", async (context) => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    const externalAlias = path.join(outside, fresh("state-alias"));
    try { fs.symlinkSync(state, externalAlias, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return context.skip();
      throw error;
    }
    const file = path.join(externalAlias, "permissions", `${bridge.workspace.id}.json`);
    await call(client, "read_external_file", { path: file }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call(client, "replace_external_file", { path: file, content: "bad", expected_hash: hash(fs.readFileSync(file)) }, "ACCESS_DENIED_SENSITIVE_FILE");

    const nestedState = path.join(root, fresh("local-state"));
    vi.stubEnv("C2C_STATE_DIR", nestedState);
    try {
      setPermission(bridge.workspace.id, "level2");
      const relative = `${path.basename(nestedState)}/permissions/${bridge.workspace.id}.json`;
      await call(client, "read_file", { path: relative }, "ACCESS_DENIED_SENSITIVE_FILE");
      await call(client, "replace_file", { path: relative, content: "bad", expected_hash: hash(fs.readFileSync(path.join(root, relative))) }, "ACCESS_DENIED_SENSITIVE_FILE");
      expect(readPermission(bridge.workspace.id)).toBe("level2");
    } finally { vi.stubEnv("C2C_STATE_DIR", state); }
  });

  it("file capabilities cannot expand Git control-plane writes", async () => {
    const { client } = await session(fileScopes);
    setPermission(bridge.workspace.id, "level2");
    // Isolated metadata-shaped fixtures only. Never execute Git or any hook.
    const gitConfig = write(root, ".git/config", "fixture git config\n");
    await call(client, "replace_file", { path: ".git/config", content: "bad", expected_hash: hash(fs.readFileSync(gitConfig)) }, "ACCESS_DENIED_SENSITIVE_FILE");
    await call(client, "create_file", { path: ".git/remote-created", content: "bad" }, "ACCESS_DENIED_SENSITIVE_FILE");
    const globalConfig = write(outside, ".gitconfig", "fixture global config\n");
    await call(client, "replace_external_file", { path: globalConfig, content: "bad", expected_hash: hash(fs.readFileSync(globalConfig)) }, "ACCESS_DENIED_SENSITIVE_FILE");
    const xdgConfig = write(outside, ".config/git/config", "fixture xdg config\n");
    await call(client, "replace_external_file", { path: xdgConfig, content: "bad", expected_hash: hash(fs.readFileSync(xdgConfig)) }, "ACCESS_DENIED_SENSITIVE_FILE");
    expect(fs.readFileSync(gitConfig, "utf8")).toBe("fixture git config\n");
    expect(fs.readFileSync(globalConfig, "utf8")).toBe("fixture global config\n");
    expect(fs.readFileSync(xdgConfig, "utf8")).toBe("fixture xdg config\n");
  });
});
