import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { AuthStore, AuthStoreCorruptError, DEFAULT_SCOPES, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { readAuthorizationEpoch } from "../src/permission/store.js";
import { makeTmpDir, cleanup, write, isolateStateDir, pkceVerifierAndChallenge } from "./helpers.js";

let root: string;
let bridge: Bridge;
let base: string;

const REDIRECT_URI = "http://127.0.0.1:19999/callback";

// WHATWG Fetch port-blocking set: https://fetch.spec.whatwg.org/#port-blocking
const FETCH_FORBIDDEN_PORTS = new Set<number>([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
  77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119,
  123, 135, 137, 139, 143, 179, 389, 427, 465, 512, 513, 514, 515, 526,
  530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6697, 10080,
]);
const SAFE_PORT_ATTEMPT_LIMIT = 16;

async function bindEphemeralPort(host: string): Promise<{ server: NetServer; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closePortProbe(server);
    throw new Error("The ephemeral port probe returned no TCP address.");
  }
  return { server, port: address.port };
}

function closePortProbe(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function allocateFetchSafePort(host = "127.0.0.1"): Promise<number> {
  for (let attempt = 1; attempt <= SAFE_PORT_ATTEMPT_LIMIT; attempt += 1) {
    const probe = await bindEphemeralPort(host);
    const fetchSafe = !FETCH_FORBIDDEN_PORTS.has(probe.port);
    await closePortProbe(probe.server);
    if (fetchSafe) return probe.port;
  }
  throw new Error(`Could not allocate a Fetch-safe ephemeral port after ${SAFE_PORT_ATTEMPT_LIMIT} attempts.`);
}

async function startBridgeWithFetchSafePort(
  options: Omit<Parameters<typeof startBridge>[0], "port">,
): Promise<Bridge> {
  const host = options.host ?? "127.0.0.1";
  for (let attempt = 1; attempt <= SAFE_PORT_ATTEMPT_LIMIT; attempt += 1) {
    const port = await allocateFetchSafePort(host);
    const bridge = await startBridge({ ...options, port });
    if (!FETCH_FORBIDDEN_PORTS.has(bridge.port)) return bridge;
    await bridge.close();
  }
  throw new Error(`Bridge startup selected a Fetch-forbidden port after ${SAFE_PORT_ATTEMPT_LIMIT} safe-port attempts.`);
}

beforeEach(async () => {
  isolateStateDir();
  root = makeTmpDir("oauth-ws");
  write(root, "hello.txt", "hello oauth\n");
  bridge = await startBridgeWithFetchSafePort({
    workspaceRoot: root,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
  });
  base = bridge.localBaseUrl();
});

afterEach(async () => {
  await bridge.close();
  cleanup(root);
});

async function registerClient(): Promise<string> {
  const response = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT-Test", redirect_uris: [REDIRECT_URI] }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

async function authorizeWithPairing(
  clientId: string,
  challenge: string,
  pairingCode: string,
  state = "st-123",
  scope: string | string[] | null = DEFAULT_SCOPES.join(" ")
): Promise<{ code: string | null; location: string | null; page?: string; status?: number }> {
  const authorizeUrl = new URL(`${base}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (Array.isArray(scope)) {
    for (const value of scope) authorizeUrl.searchParams.append("scope", value);
  } else if (scope !== null) {
    authorizeUrl.searchParams.set("scope", scope);
  }

  const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
  const html = await pageResponse.text();
  const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
  if (!requestId) return { code: null, location: pageResponse.headers.get("location"), page: html, status: pageResponse.status };

  const postResponse = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, pairing_code: pairingCode }),
    redirect: "manual",
  });
  if (postResponse.status !== 302) {
    return { code: null, location: null, page: await postResponse.text(), status: postResponse.status };
  }
  const location = postResponse.headers.get("location");
  const code = location ? new URL(location).searchParams.get("code") : null;
  return { code, location, page: html, status: postResponse.status };
}

async function exchangeToken(
  clientId: string,
  code: string,
  verifier: string,
  scope?: string
): Promise<{ status: number; body: Record<string, string> }> {
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      ...(scope === undefined ? {} : { scope }),
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

describe("discovery metadata", () => {
  it("allocates only Fetch-safe ephemeral ports", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = await allocateFetchSafePort();
      expect(FETCH_FORBIDDEN_PORTS.has(port)).toBe(false);
    }
  });

  it("uses the configured public tunnel authority for incremental auth and discovery", async () => {
    const publicUrl = "https://trusted-tunnel.example";
    const publicBridge = await startBridgeWithFetchSafePort({
      workspaceRoot: makeTmpDir("oauth-public-ws"),
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("oauth-public-auth"), "store.json"),
      tunnelProvider: {
        name: "isolated-test",
        start: async () => publicUrl,
        restart: async () => publicUrl,
        stop: async () => {},
        status: () => ({ running: true, url: publicUrl, provider: "isolated-test" }),
        getPublicUrl: () => publicUrl,
        doctor: async () => ({ provider: "isolated-test", binaryFound: true, binaryPath: null, running: true, url: publicUrl, problems: [] }),
      },
    });
    try {
      const local = publicBridge.localBaseUrl();
      const start = await fetch(`${local}/admin/tunnel/start`, { method: "POST", headers: { authorization: `Bearer ${publicBridge.adminToken}` } });
      expect(start.status).toBe(200);
      const metadata = await fetch(`${local}/.well-known/oauth-protected-resource/mcp`, { headers: { host: "attacker.invalid" } });
      expect(await metadata.json()).toMatchObject({ resource: `${publicUrl}/mcp`, authorization_servers: [publicUrl] });
      const old = publicBridge.authStore.issueTokens({ clientId: "public-test-client", scopes: ["workspace.read", "offline_access"] });
      const call = await fetch(`${local}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${old.accessToken}`, host: "attacker.invalid", "x-forwarded-proto": "http" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 52, method: "tools/call", params: { name: "execution_list", arguments: { limit: 1 } } }),
      });
      expect(call.status).toBe(200);
      const rpc = await call.json() as { result: { _meta: Record<string, string[]> } };
      expect(rpc.result._meta["mcp/www_authenticate"][0]).toContain(`resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp"`);
      expect(JSON.stringify(rpc)).not.toContain("attacker.invalid");
    } finally {
      await publicBridge.close();
    }
  });

  it("keeps discovery and HTTP auth challenges independent of request Host/proxy headers", async () => {
    const headers = { host: "attacker.invalid", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" };
    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, { headers });
    const resource = await metadata.json() as { resource: string; authorization_servers: string[] };
    expect(resource.resource).toBe(`${base}/mcp`);
    expect(resource.authorization_servers).toEqual([base]);
    const discovery = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers });
    const issuer = await discovery.json() as { issuer: string; authorization_endpoint: string };
    expect(issuer.issuer).toBe(base);
    expect(issuer.authorization_endpoint).toBe(`${base}/oauth/authorize`);
    const denied = await fetch(`${base}/mcp`, { method: "POST", headers });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(denied.headers.get("www-authenticate")).not.toContain("attacker.invalid");
  });

  it("serves protected resource metadata", async () => {
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toContain("/mcp");
    expect(body.authorization_servers.length).toBe(1);
  });

  it("serves authorization server metadata with PKCE S256", async () => {
    const response = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(body.registration_endpoint).toContain("/oauth/register");
  });

  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("advertises all supported capabilities at %s", async (endpoint) => {
    const response = await fetch(`${base}${endpoint}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scopes_supported: string[] };
    expect(body.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });
});

describe("explicit OAuth capabilities", () => {
  it("uses one full-scope consent for the registered ChatGPT app on chatgpt.com", async () => {
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const registration = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "chatgpt-full-consent");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "workspace.read execution.read offline_access");

    const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();
    for (const label of [
      "Read limited host system diagnostics",
      "Start execution jobs",
      "Cancel execution jobs",
      "Perform locally authorized Git writes",
      "Request and run individually approved local commands (Level 3)",
    ]) expect(html).toContain(label);

    const pairing = bridge.pairing.create();
    const consent = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }),
      redirect: "manual",
    });
    expect(consent.status).toBe(302);
    const location = consent.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as Record<string, string>;
    expect(token.scope.split(" ")).toEqual([...SUPPORTED_SCOPES]);
  });

  it("does not expand a ChatGPT-named client when its redirect is not chatgpt.com", async () => {
    const registration = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [REDIRECT_URI] }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json() as { client_id: string };
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const requested = ["workspace.read", "offline_access"];
    const authorization = await authorizeWithPairing(clientId, challenge, pairing.code, "non-chatgpt-redirect", requested.join(" "));
    const token = await exchangeToken(clientId, authorization.code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.scope.split(" ")).toEqual(requested);
  });

  it("upgrades only through explicit authorization and leaves old access/refresh grants unchanged", async () => {
    const executionScopes = ["execution.jobs.read", "execution.run", "execution.cancel"];
    const legacyScopes = ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"];
    const clientId = await registerClient();
    const oldPkce = pkceVerifierAndChallenge();
    const oldAuthorization = await authorizeWithPairing(clientId, oldPkce.challenge, bridge.pairing.create().code, "old-grant", legacyScopes.join(" "));
    const old = await exchangeToken(clientId, oldAuthorization.code!, oldPkce.verifier);
    expect(old.status).toBe(200);
    expect(old.body.scope.split(" ")).toEqual(legacyScopes);

    const listJobs = async (token: string) => {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "execution_list", arguments: { limit: 1 } } }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { result: { isError?: boolean; content: { text: string }[]; structuredContent?: unknown; _meta?: Record<string, unknown> } };
    };
    const denied = (await listJobs(old.body.access_token)).result;
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).error).toBe("INSUFFICIENT_SCOPE");
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="This operation requires the 'execution.jobs.read' scope.", scope="execution.jobs.read"`]);

    const refreshedResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: old.body.refresh_token, client_id: clientId, scope: [...legacyScopes, ...executionScopes].join(" ") }),
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json() as Record<string, string>;
    expect(refreshed.scope.split(" ")).toEqual(legacyScopes);
    expect((await listJobs(refreshed.access_token)).result.isError).toBe(true);

    const newPkce = pkceVerifierAndChallenge();
    const requested = [...legacyScopes, ...executionScopes];
    const explicit = await authorizeWithPairing(clientId, newPkce.challenge, bridge.pairing.create().code, "explicit-execution", requested.join(" "));
    for (const label of ["View execution job status", "Start execution jobs", "Cancel execution jobs"]) expect(explicit.page).toContain(label);
    expect(new URL(explicit.location!).searchParams.get("state")).toBe("explicit-execution");
    const upgraded = await exchangeToken(clientId, explicit.code!, newPkce.verifier);
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.scope.split(" ")).toEqual(requested);
    const listed = (await listJobs(upgraded.body.access_token)).result;
    expect(listed.isError ?? false).toBe(false);
    expect(listed.structuredContent).toEqual({ jobs: [] });
    for (const token of [old.body.access_token, refreshed.access_token]) {
      const verdict = bridge.authStore.verifyAccessToken(token);
      expect(verdict.ok && verdict.record.scopes).toEqual(legacyScopes);
    }
  });

  const newCapabilities = [
    { scope: "workspace.write", label: "Create and modify files in this workspace", mutation: true },
    { scope: "workspace.delete", label: "Delete files in this workspace", mutation: true },
    { scope: "filesystem.external.read", label: "Read permitted files outside this workspace", mutation: false },
    { scope: "filesystem.external.write", label: "Create and modify permitted files outside this workspace", mutation: true },
    { scope: "system.read", label: "Read limited host system diagnostics", mutation: false },
    { scope: "execution.jobs.read", label: "View execution job status", mutation: false },
    { scope: "execution.run", label: "Start execution jobs", mutation: true },
    { scope: "execution.cancel", label: "Cancel execution jobs", mutation: true },
  ];

  it.each([
    { scope: null, expected: [...DEFAULT_SCOPES], mutation: true },
    { scope: "", expected: [...DEFAULT_SCOPES], mutation: true },
    { scope: " \t ", expected: [...DEFAULT_SCOPES], mutation: true },
    { scope: "workspace.read offline_access", expected: ["workspace.read", "offline_access"], mutation: false },
    ...newCapabilities.map(({ scope, mutation }) => ({ scope, expected: [scope], mutation })),
    ...newCapabilities.map(({ scope, mutation }) => ({
      scope: `${DEFAULT_SCOPES.join(" ")} ${scope}`,
      expected: [...new Set([...DEFAULT_SCOPES, scope])],
      mutation: true,
    })),
    { scope: "unknown workspace.read", expected: ["workspace.read"], mutation: false },
    { scope: "unknown+workspace.write++workspace.write workspace.read", expected: ["workspace.write", "workspace.read"], mutation: true },
  ])("grants exactly the requested capabilities for $scope", async ({ scope, expected, mutation }) => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const authorization = await authorizeWithPairing(clientId, challenge, pairing.code, "scope-test", scope);
    expect(authorization.code).toBeTruthy();
    expect(authorization.page?.includes("(read-only)")).toBe(!mutation);
    for (const capability of newCapabilities) {
      expect(authorization.page?.includes(capability.label)).toBe(expected.includes(capability.scope));
    }
    expect(authorization.page).not.toContain("Delete files outside this workspace");

    // A token request cannot add capabilities absent from the authorization code.
    const token = await exchangeToken(clientId, authorization.code!, verifier, SUPPORTED_SCOPES.join(" "));
    expect(token.status).toBe(200);
    expect(token.body.scope.split(" ")).toEqual(expected);
    expect(Boolean(token.body.refresh_token)).toBe(expected.includes("offline_access"));
    expect(bridge.authStore.verifyAccessToken(token.body.access_token)).toMatchObject({
      ok: true,
      record: { scopes: expected },
    });
  });

  it.each(["unknown", "+", "workspace.write,workspace.delete", ["workspace.read", "workspace.write"]])(
    "rejects unsupported or malformed authorization scopes %j",
    async (scope) => {
      const clientId = await registerClient();
      const { challenge } = pkceVerifierAndChallenge();
      const pairing = bridge.pairing.create();
      const result = await authorizeWithPairing(clientId, challenge, pairing.code, "invalid-scope", scope);
      expect(result.code).toBeNull();
      expect(result.status).toBe(302);
      const redirect = new URL(result.location!);
      expect(redirect.searchParams.get("error")).toBe("invalid_scope");
      expect(redirect.searchParams.get("state")).toBe("invalid-scope");
      expect(result.page).not.toContain('name="request_id"');
    }
  );

  it("keeps write capabilities accurate when a pairing error re-renders the page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA", "write-error", "filesystem.external.write");
    expect(result.status).toBe(401);
    expect(result.page).toContain("Create and modify permitted files outside this workspace");
    expect(result.page).not.toContain("(read-only)");
    expect(result.page).not.toContain("Delete files outside this workspace");
  });
});

describe("authorization + token flow", () => {
  it("completes the full pairing + PKCE flow and calls MCP", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code, location } = await authorizeWithPairing(clientId, challenge, pairing.code);
    expect(code).toBeTruthy();
    expect(location).toContain("state=st-123");

    const token = await exchangeToken(clientId, code!, verifier);
    expect(token.status).toBe(200);
    expect(token.body.access_token).toMatch(/^c2c_at_/);
    expect(token.body.refresh_token).toMatch(/^c2c_rt_/);
    expect(token.body.token_type).toBe("Bearer");

    // authorized MCP request
    const mcpResponse = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.body.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(mcpResponse.status).toBe(200);
  });

  it("rejects a wrong pairing code", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    bridge.pairing.create();
    const result = await authorizeWithPairing(clientId, challenge, "AAAA-AAAA");
    expect(result.code).toBeNull();
    expect(result.status).toBe(401);
    expect(result.page).toContain("Incorrect pairing code");
  });

  it("escapes the workspace name in the pairing page", async () => {
    const xssWorkspaceRoot = makeTmpDir("oauth-html");
    write(xssWorkspaceRoot, ".c2c.json", JSON.stringify({ name: "<script>alert('xss')</script>" }));
    const xssBridge = await startBridgeWithFetchSafePort({
      workspaceRoot: xssWorkspaceRoot,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth-html"), "store.json"),
    });

    try {
      const xssBase = xssBridge.localBaseUrl();
      const registration = await fetch(`${xssBase}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "HTML-Test", redirect_uris: [REDIRECT_URI] }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${xssBase}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", client.client_id);
      authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(authorizeUrl, { redirect: "manual" });
      expect(response.status).toBe(200);
      const html = await response.text();

      expect(html).not.toContain("<script>alert('xss')</script>");
      expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
    } finally {
      await xssBridge.close();
      cleanup(xssWorkspaceRoot);
    }
  });

  it("sets browser security headers on the pairing page", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects PKCE verifier mismatch", async () => {
    const clientId = await registerClient();
    const { challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const token = await exchangeToken(clientId, code!, "wrong-verifier-wrong-verifier-wrong");
    expect(token.status).toBe(400);
    expect(token.body.error).toBe("invalid_grant");
  });

  it("authorization codes are one-time", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const first = await exchangeToken(clientId, code!, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeToken(clientId, code!, verifier);
    expect(second.status).toBe(400);
  });

  it("requires PKCE at the authorization endpoint", async () => {
    const clientId = await registerClient();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authorizeUrl.searchParams.set("response_type", "code");
    const response = await fetch(authorizeUrl, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=invalid_request");
  });

  it("rejects registration with non-https redirect uris", async () => {
    const response = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example.com/cb"] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("token enforcement on /mcp", () => {
  const mcpCall = (token?: string): Promise<Response> =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  it("401 without a token, with resource metadata pointer", async () => {
    const response = await mcpCall();
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("401 with an invalid token", async () => {
    const response = await mcpCall("c2c_at_totally-invalid");
    expect(response.status).toBe(401);
  });

  it("401 with an expired token", async () => {
    const expired = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      accessTtlMs: -1000,
    });
    const response = await mcpCall(expired.accessToken);
    expect(response.status).toBe(401);
  });

  it("403 with a token bound to another workspace", async () => {
    const foreign = bridge.authStore.issueTokens({
      clientId: "test",
      scopes: ["workspace.read"],
      workspaceId: "deadbeef0000",
    });
    const response = await mcpCall(foreign.accessToken);
    expect(response.status).toBe(403);
  });

  it("401 after revocation", async () => {
    const tokens = bridge.authStore.issueTokens({ clientId: "test", scopes: ["workspace.read"] });
    expect((await mcpCall(tokens.accessToken)).status).toBe(200);
    bridge.authStore.revokeToken(tokens.accessToken);
    expect((await mcpCall(tokens.accessToken)).status).toBe(401);
  });
});

describe("refresh token rotation", () => {
  it.each([
    ["workspace.read", "offline_access"],
    ["workspace.read", "workspace.write", "offline_access"],
    ["workspace.delete", "offline_access"],
    ["filesystem.external.read", "offline_access"],
    ["filesystem.external.write", "offline_access"],
    ["system.read", "offline_access"],
    [...DEFAULT_SCOPES],
    ["execution.jobs.read", "offline_access"],
    ["execution.run", "offline_access"],
    ["execution.cancel", "offline_access"],
  ])("cannot gain capabilities through refresh: %j", async (...scopes) => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code, "refresh-scope", scopes.join(" "));
    const initial = await exchangeToken(clientId, code!, verifier);
    expect(initial.status).toBe(200);
    let refreshToken = initial.body.refresh_token;

    for (const requestedScope of [undefined, SUPPORTED_SCOPES.join(" ")]) {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          ...(requestedScope === undefined ? {} : { scope: requestedScope }),
        }),
      });
      expect(response.status).toBe(200);
      const rotated = (await response.json()) as Record<string, string>;
      expect(rotated.scope.split(" ")).toEqual(scopes);
      expect(rotated.refresh_token).not.toBe(refreshToken);
      expect(bridge.authStore.verifyAccessToken(rotated.access_token)).toMatchObject({ ok: true, record: { scopes } });
      refreshToken = rotated.refresh_token;
    }
  });

  it("rotates refresh tokens and invalidates the old one", async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const pairing = bridge.pairing.create();
    const { code } = await authorizeWithPairing(clientId, challenge, pairing.code);
    const initial = await exchangeToken(clientId, code!, verifier);

    const refresh = async (refreshToken: string): Promise<{ status: number; body: Record<string, string> }> => {
      const response = await fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    };

    const rotated = await refresh(initial.body.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(initial.body.refresh_token);

    const replayed = await refresh(initial.body.refresh_token);
    expect(replayed.status).toBe(400);
  });
});

describe("Gemini and confidential client compatibility", () => {
  it("rejects openid email profile scope expansion for publicly registered Gemini or google.com redirects", async () => {
    for (const redirectUri of [
      "https://gemini.google.com/callback",
      "https://evil.googleusercontent.com/callback",
      "https://docs.google.com/callback",
    ]) {
      const registration = await fetch(`${base}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Gemini Web", redirect_uris: [redirectUri] }),
      });
      expect(registration.status).toBe(201);
      const { client_id: clientId } = (await registration.json()) as { client_id: string };
      const { challenge } = pkceVerifierAndChallenge();

      const authorizeUrl = new URL(`${base}/oauth/authorize`);
      authorizeUrl.searchParams.set("client_id", clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("state", "gemini-public-rejected");
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("scope", "openid email profile");

      const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
      expect(pageResponse.status).toBe(302);
      const location = new URL(pageResponse.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("invalid_scope");
      expect(location.searchParams.get("state")).toBe("gemini-public-rejected");
    }
  });

  it("expands scopes to full SUPPORTED_SCOPES for trustedLocalClient and displays callback host", async () => {
    const redirectUri = "https://gemini.google.com/callback";
    const trusted = bridge.authStore.registerClient({
      clientName: "Gemini Web",
      redirectUris: [redirectUri],
      tokenEndpointAuthMethod: "none",
      trustedLocalClient: true,
    });
    const { verifier, challenge } = pkceVerifierAndChallenge();

    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", trusted.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "gemini-trusted-state");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("scope", "openid email profile");

    const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    expect(html).toContain("Gemini Web is requesting access to workspace");
    expect(html).not.toContain("ChatGPT is requesting access to workspace");
    expect(html).toContain("Callback host: <strong>gemini.google.com</strong>");
    const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();

    bridge.pairing.create();
    const badAttempt = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: "AAAA-AAAA" }),
      redirect: "manual",
    });
    expect(badAttempt.status).toBe(401);
    expect(await badAttempt.text()).toContain("Callback host: <strong>gemini.google.com</strong>");

    const pairing = bridge.pairing.create();
    const consent = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }),
      redirect: "manual",
    });
    expect(consent.status).toBe(302);
    const location = consent.headers.get("location");
    expect(location).toBeTruthy();
    const code = new URL(location!).searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        client_id: trusted.clientId,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = (await tokenResponse.json()) as Record<string, string>;
    expect(token.scope.split(" ")).toEqual([...SUPPORTED_SCOPES]);
  });

  it("supports client_secret_basic registration, token exchange, refresh, and rejects invalid secret with 401", async () => {
    const redirectUri = "https://gemini.google.com/callback";
    const registration = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Gemini Confidential",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    expect(registration.status).toBe(201);
    const registered = (await registration.json()) as {
      client_id: string;
      client_secret?: string;
      client_secret_expires_at?: number;
      token_endpoint_auth_method?: string;
    };
    expect(registered.token_endpoint_auth_method).toBe("client_secret_basic");
    expect(registered.client_secret).toMatch(/^c2c_cs_/);
    expect(registered.client_secret_expires_at).toBe(0);

    const storedClient = bridge.authStore.getClient(registered.client_id);
    expect(storedClient?.clientSecretHash).toMatch(/^[a-f0-9]{64}$/);
    expect((storedClient as Record<string, unknown> | undefined)?.clientSecret).toBeUndefined();

    const { verifier, challenge } = pkceVerifierAndChallenge();
    const authorizeUrl = new URL(`${base}/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const pageResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(pageResponse.status).toBe(200);
    const html = await pageResponse.text();
    const requestId = html.match(/name="request_id" value="([a-f0-9]+)"/)?.[1];
    expect(requestId).toBeTruthy();

    const pairing = bridge.pairing.create();
    const consent = await fetch(`${base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId!, pairing_code: pairing.code }),
      redirect: "manual",
    });
    const code = new URL(consent.headers.get("location")!).searchParams.get("code")!;

    const wrongBasic = Buffer.from(`${encodeURIComponent(registered.client_id)}:wrong-secret`).toString("base64");
    const wrongTokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${wrongBasic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    expect(wrongTokenResponse.status).toBe(401);
    expect(wrongTokenResponse.headers.get("www-authenticate")).toBe('Basic realm="c2c"');
    expect(await wrongTokenResponse.json()).toEqual({ error: "invalid_client" });

    const validBasic = Buffer.from(
      `${encodeURIComponent(registered.client_id)}:${encodeURIComponent(registered.client_secret!)}`
    ).toString("base64");
    const tokenResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${validBasic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const initial = (await tokenResponse.json()) as Record<string, string>;
    expect(initial.access_token).toMatch(/^c2c_at_/);
    expect(initial.refresh_token).toMatch(/^c2c_rt_/);

    const wrongRefresh = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${wrongBasic}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
      }),
    });
    expect(wrongRefresh.status).toBe(401);
    expect(wrongRefresh.headers.get("www-authenticate")).toBe('Basic realm="c2c"');
    expect(await wrongRefresh.json()).toEqual({ error: "invalid_client" });

    const refreshResponse = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${validBasic}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
      }),
    });
    expect(refreshResponse.status).toBe(200);
    const refreshed = (await refreshResponse.json()) as Record<string, string>;
    expect(refreshed.access_token).toMatch(/^c2c_at_/);
    expect(refreshed.refresh_token).not.toBe(initial.refresh_token);
  });

  it("enforces Basic vs POST auth method exclusivity, rejects unknown clients, and does not consume code before client auth", async () => {
    const basicReg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "BasicOnly",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    const basicClient = (await basicReg.json()) as { client_id: string; client_secret: string };

    const postReg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "PostOnly",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_post",
      }),
    });
    const postClient = (await postReg.json()) as { client_id: string; client_secret: string };

    const publicClientId = await registerClient();

    // Authorization code for BasicOnly client
    const { verifier: basicVerifier, challenge: basicChallenge } = pkceVerifierAndChallenge();
    const basicAuth = await authorizeWithPairing(basicClient.client_id, basicChallenge, bridge.pairing.create().code);
    expect(basicAuth.code).toBeTruthy();

    // Unknown client without Basic header -> 400 invalid_client, and code stays unconsumed
    const unknownPost = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        client_id: "nonexistent_client",
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(unknownPost.status).toBe(400);
    expect(unknownPost.headers.get("www-authenticate")).toBeNull();
    expect(await unknownPost.json()).toEqual({ error: "invalid_client" });

    // Unknown client with Basic header -> 401 with WWW-Authenticate
    const unknownBasic = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from("nonexistent_client:secret").toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(unknownBasic.status).toBe(401);
    expect(unknownBasic.headers.get("www-authenticate")).toBe('Basic realm="c2c"');
    expect(await unknownBasic.json()).toEqual({ error: "invalid_client" });

    // BasicOnly client trying POST secret -> 401 with WWW-Authenticate: Basic
    const basicWithPost = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        client_id: basicClient.client_id,
        client_secret: basicClient.client_secret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(basicWithPost.status).toBe(401);
    expect(basicWithPost.headers.get("www-authenticate")).toBe('Basic realm="c2c"');
    expect(await basicWithPost.json()).toEqual({ error: "invalid_client" });

    // Mixing Basic header + POST client_secret -> 400 invalid_request
    const validBasicHeader = `Basic ${Buffer.from(
      `${encodeURIComponent(basicClient.client_id)}:${encodeURIComponent(basicClient.client_secret)}`
    ).toString("base64")}`;
    const mixedBasicAndPost = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: validBasicHeader,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        client_secret: basicClient.client_secret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(mixedBasicAndPost.status).toBe(400);
    expect(await mixedBasicAndPost.json()).toEqual({ error: "invalid_request" });

    // Mixing Basic header + mismatched body client_id -> 400 invalid_request
    const mixedClientId = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: validBasicHeader,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        client_id: postClient.client_id,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(mixedClientId.status).toBe(400);
    expect(await mixedClientId.json()).toEqual({ error: "invalid_request" });

    // Non-Basic Authorization scheme -> 400 invalid_request
    const bearerHeader = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer not-basic",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        client_id: basicClient.client_id,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(bearerHeader.status).toBe(400);
    expect(await bearerHeader.json()).toEqual({ error: "invalid_request" });

    // Code is still intact and succeeds with proper Basic auth!
    const basicValid = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: validBasicHeader,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: basicAuth.code!,
        code_verifier: basicVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(basicValid.status).toBe(200);

    // PostOnly client tests
    const { verifier: postVerifier, challenge: postChallenge } = pkceVerifierAndChallenge();
    const postAuth = await authorizeWithPairing(postClient.client_id, postChallenge, bridge.pairing.create().code);
    expect(postAuth.code).toBeTruthy();

    // PostOnly rejects Basic auth
    const postWithBasic = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(postClient.client_id)}:${encodeURIComponent(postClient.client_secret)}`
        ).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: postAuth.code!,
        code_verifier: postVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(postWithBasic.status).toBe(401);
    expect(await postWithBasic.json()).toEqual({ error: "invalid_client" });

    // PostOnly rejects empty client_secret -> 400 invalid_request
    const postEmptySecret = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: postAuth.code!,
        code_verifier: postVerifier,
        client_id: postClient.client_id,
        client_secret: "",
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(postEmptySecret.status).toBe(400);
    expect(await postEmptySecret.json()).toEqual({ error: "invalid_request" });

    // PostOnly rejects wrong secret -> 401 without Basic challenge
    const postWrongSecret = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: postAuth.code!,
        code_verifier: postVerifier,
        client_id: postClient.client_id,
        client_secret: "wrong",
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(postWrongSecret.status).toBe(401);
    expect(postWrongSecret.headers.get("www-authenticate")).toBeNull();
    expect(await postWrongSecret.json()).toEqual({ error: "invalid_client" });

    // PostOnly succeeds with valid POST secret
    const postValid = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: postAuth.code!,
        code_verifier: postVerifier,
        client_id: postClient.client_id,
        client_secret: postClient.client_secret,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(postValid.status).toBe(200);

    // Public client (none) rejects POST secret and Basic auth
    const { verifier: pubVerifier, challenge: pubChallenge } = pkceVerifierAndChallenge();
    const pubAuth = await authorizeWithPairing(publicClientId, pubChallenge, bridge.pairing.create().code);
    const pubWithSecret = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: pubAuth.code!,
        code_verifier: pubVerifier,
        client_id: publicClientId,
        client_secret: "unexpected-secret",
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(pubWithSecret.status).toBe(401);
    expect(await pubWithSecret.json()).toEqual({ error: "invalid_client" });
  });

  it("rejects non-string req.body fields and blocks unauthenticated concurrent refresh_token collision", async () => {
    const reg = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ConcurrentConfidential",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    });
    const client = (await reg.json()) as { client_id: string; client_secret: string };
    const { verifier, challenge } = pkceVerifierAndChallenge();
    const auth = await authorizeWithPairing(client.client_id, challenge, bridge.pairing.create().code);

    const basicHeader = `Basic ${Buffer.from(
      `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`
    ).toString("base64")}`;
    const initialRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicHeader,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: auth.code!,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    expect(initialRes.status).toBe(200);
    const initial = (await initialRes.json()) as { refresh_token: string };

    // Non-string client_id array injection via JSON -> 400 invalid_request
    const arrayInjection = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: [client.client_id],
        refresh_token: initial.refresh_token,
      }),
    });
    expect(arrayInjection.status).toBe(400);
    expect(await arrayInjection.json()).toEqual({ error: "invalid_request" });

    // Non-object / array body -> 400 invalid_request
    const arrayBody = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["not-an-object"]),
    });
    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toEqual({ error: "invalid_request" });

    // Concurrent refresh race: unauthenticated attacker vs legitimate Basic client
    const [attackerRes, legitRes] = await Promise.all([
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: initial.refresh_token,
        }),
      }),
      fetch(`${base}/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: basicHeader,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: initial.refresh_token,
        }),
      }),
    ]);

    expect(attackerRes.status).toBe(401);
    expect(attackerRes.headers.get("www-authenticate")).toBe('Basic realm="c2c"');
    expect(await attackerRes.json()).toEqual({ error: "invalid_client" });

    expect(legitRes.status).toBe(200);
    const legitBody = (await legitRes.json()) as { access_token: string; refresh_token: string };
    expect(legitBody.access_token).toMatch(/^c2c_at_/);
    expect(legitBody.refresh_token).not.toBe(initial.refresh_token);
  });

  it("preserves existing refresh token in memory when AuthStore.refresh fails to persist to disk", () => {
    const dir = makeTmpDir("auth-atomic-refresh");
    try {
      const store = new AuthStore("atomic-ws", { file: path.join(dir, "store.json") });
      const client = store.registerClient({
        clientName: "AtomicTest",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none",
      });
      const issued = store.issueTokens({
        clientId: client.clientId,
        scopes: ["workspace.read", "offline_access"],
      });
      expect(issued.refreshToken).toBeTruthy();
      const beforeCount = store.tokenCount();

      const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("ENOSPC: simulated disk write failure");
      });
      try {
        expect(() => store.refresh(issued.refreshToken!, client.clientId)).toThrow("ENOSPC");
      } finally {
        writeSpy.mockRestore();
      }

      // Original tokens remain intact in memory and can still be refreshed after disk recovers
      expect(store.tokenCount()).toBe(beforeCount);
      expect(store.verifyAccessToken(issued.accessToken).ok).toBe(true);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      const diskBeforeRetry = fs.readFileSync(path.join(dir, "store.json"), "utf8");
      const retry = store.refresh(issued.refreshToken!, client.clientId);
      expect(retry.ok).toBe(true);
      if (!retry.ok) throw new Error(retry.reason);
      expect(retry.tokens.refreshToken).not.toBe(issued.refreshToken);
      expect(fs.readFileSync(path.join(dir, "store.json"), "utf8")).not.toBe(diskBeforeRetry);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      cleanup(dir);
    }
  });

  it("fails closed with AuthStoreCorruptError instead of treating corrupt auth files as empty", () => {
    const dir = makeTmpDir("auth-corrupt-fail-closed");
    try {
      const file = path.join(dir, "store.json");
      const truncated = '{"clients":[{"clientId":"c1","redirectUris":["http://127.0.0.1/cb"],"createdAt":"2026-01-01T00:00:00Z"}],"tokens":[';
      fs.writeFileSync(file, truncated, "utf8");
      expect(() => new AuthStore("corrupt-ws", { file })).toThrow(AuthStoreCorruptError);
      expect(fs.readFileSync(file, "utf8")).toBe(truncated);

      fs.writeFileSync(file, "[]", "utf8");
      expect(() => new AuthStore("corrupt-ws", { file })).toThrow(AuthStoreCorruptError);

      fs.writeFileSync(file, JSON.stringify({ clients: [] }), "utf8");
      expect(() => new AuthStore("corrupt-ws", { file })).toThrow(AuthStoreCorruptError);

      fs.writeFileSync(file, JSON.stringify({ clients: [{ bad: true }], tokens: [] }), "utf8");
      expect(() => new AuthStore("corrupt-ws", { file })).toThrow(AuthStoreCorruptError);

      const dirAsFile = path.join(dir, "dir-store.json");
      fs.mkdirSync(dirAsFile);
      expect(() => new AuthStore("corrupt-ws", { file: dirAsFile })).toThrow(AuthStoreCorruptError);
    } finally {
      cleanup(dir);
    }
  });

  it("registers trusted local OAuth clients exclusively through the loopback admin endpoint", async () => {
    const unauthenticated = await fetch(`${base}/admin/oauth-clients`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: "Gemini Admin Test",
        redirectUris: ["https://gemini.google.com/callback"],
      }),
    });
    expect(unauthenticated.status).toBe(404);

    const createdResponse = await fetch(`${base}/admin/oauth-clients`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bridge.adminToken}`,
      },
      body: JSON.stringify({
        clientName: "Gemini Admin Test",
        redirectUris: ["https://gemini.google.com/callback"],
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      clientId: string;
      clientSecret: string;
      tokenEndpointAuthMethod: string;
    };
    expect(created.clientId).toMatch(/^c2c_client_/);
    expect(created.clientSecret).toMatch(/^c2c_cs_/);
    expect(created.tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(bridge.authStore.getClient(created.clientId)?.trustedLocalClient).toBe(true);
  });

  it("halts token validation/issuance and reconciles from disk when post-rename verification fails", () => {
    const dir = makeTmpDir("auth-post-rename-reconcile");
    try {
      const storeFile = path.join(dir, "store.json");
      const store = new AuthStore("a1b2c3d4e5f6", { file: storeFile });
      const client = store.registerClient({
        clientName: "PostRenameTest",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none",
      });
      const initial = store.issueTokens({
        clientId: client.clientId,
        scopes: ["workspace.read", "offline_access"],
      });

      // Block read-back on storeFile right after renameWithWindowsRetry publishes the rotated state.
      const realOpenSync = fs.openSync.bind(fs);
      let denyStoreRead = true;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
        if (denyStoreRead && path.resolve(String(filePath)) === path.resolve(storeFile) && flags === "r") {
          const err = Object.assign(new Error("EACCES: transient post-rename read failure"), { code: "EACCES" });
          throw err;
        }
        return realOpenSync(filePath as fs.PathLike, flags as fs.OpenMode, mode as fs.Mode | undefined);
      }) as typeof fs.openSync);
      const realReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath, options) => {
        if (
          denyStoreRead &&
          typeof filePath === "string" &&
          path.resolve(filePath) === path.resolve(storeFile)
        ) {
          const err = Object.assign(new Error("EACCES: transient read failure"), { code: "EACCES" });
          throw err;
        }
        return realReadFileSync(filePath as fs.PathOrFileDescriptor, options as never);
      }) as typeof fs.readFileSync);

      try {
        expect(() => store.refresh(initial.refreshToken!, client.clientId)).toThrow(/EACCES/);

        // While reconciliation cannot read storeFile, token checks and writes fail closed.
        expect(store.verifyAccessToken(initial.accessToken).ok).toBe(false);
        expect(store.hasActiveAuthorization(client.clientId, ["workspace.read"])).toBe(false);
        expect(() => store.issueTokens({ clientId: client.clientId, scopes: ["workspace.read"] }))
          .toThrow(AuthStoreCorruptError);
        expect(() => store.registerClient({ redirectUris: [REDIRECT_URI] }))
          .toThrow(AuthStoreCorruptError);
      } finally {
        denyStoreRead = false;
        openSpy.mockRestore();
        readSpy.mockRestore();
      }

      // Once readable again, subsequent operations reconcile disk first instead of writing stale tokens back.
      const diskRotatedSnapshot = JSON.parse(fs.readFileSync(storeFile, "utf8")) as { tokens: Array<{ hash: string }> };
      expect(diskRotatedSnapshot.tokens).toHaveLength(3);

      store.registerClient({ clientName: "AfterReconcile", redirectUris: [REDIRECT_URI] });
      expect(store.refresh(initial.refreshToken!, client.clientId)).toEqual({
        ok: false,
        reason: "invalid_grant",
      });
      const diskAfterSave = JSON.parse(fs.readFileSync(storeFile, "utf8")) as { tokens: Array<{ hash: string }> };
      expect(diskAfterSave.tokens.map((t) => t.hash)).toEqual(diskRotatedSnapshot.tokens.map((t) => t.hash));
    } finally {
      cleanup(dir);
    }
  });

  it("clears in-memory tokens immediately in revokeAll even if authorization epoch update fails", () => {
    const dir = makeTmpDir("auth-revoke-all-epoch-fail");
    const wsId = "b1c2d3e4f5a6";
    const permDir = path.join(process.env.C2C_STATE_DIR!, "permissions");
    fs.mkdirSync(permDir, { recursive: true });
    const permFile = path.join(permDir, `${wsId}.json`);
    try {
      const storeFile = path.join(dir, "store.json");
      const store = new AuthStore(wsId, { file: storeFile });
      const client = store.registerClient({
        clientName: "EpochFailClient",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none",
      });
      const issued = store.issueTokens({
        clientId: client.clientId,
        scopes: ["workspace.read", "offline_access"],
      });

      // Force incrementAuthorizationEpoch to throw after persistState empties store.json.
      fs.writeFileSync(permFile, "{corrupt-permission-file", "utf8");
      expect(() => store.revokeAll()).toThrow("AUTHORIZATION_EPOCH_UNAVAILABLE");

      // Old tokens must neither validate in memory nor be usable while epoch bump is pending.
      expect(store.verifyAccessToken(issued.accessToken).ok).toBe(false);
      expect(store.hasActiveAuthorization(client.clientId, ["workspace.read"])).toBe(false);
      expect(() => store.registerClient({ redirectUris: [REDIRECT_URI] })).toThrow("AUTHORIZATION_EPOCH_UNAVAILABLE");

      // Once permission state is repaired, reconciliation completes the epoch bump and never writes old tokens back.
      fs.unlinkSync(permFile);
      store.registerClient({ clientName: "PostRecoveryClient", redirectUris: [REDIRECT_URI] });
      const persisted = JSON.parse(fs.readFileSync(storeFile, "utf8")) as { tokens: unknown[] };
      expect(persisted.tokens).toEqual([]);
      expect(store.verifyAccessToken(issued.accessToken).ok).toBe(false);
    } finally {
      if (fs.existsSync(permFile)) fs.unlinkSync(permFile);
      cleanup(dir);
    }
  });

  it("invalidates pending auth codes and bumps authorizationEpoch on reconciliation when revokeAll fails post-rename verification", () => {
    const dir = makeTmpDir("auth-revoke-all-post-rename-fail");
    const wsId = "c1d2e3f4a5b6";
    try {
      const storeFile = path.join(dir, "store.json");
      const store = new AuthStore(wsId, { file: storeFile });
      const client = store.registerClient({
        clientName: "RevokeAllPostRenameClient",
        redirectUris: [REDIRECT_URI],
        tokenEndpointAuthMethod: "none",
      });
      const { challenge } = pkceVerifierAndChallenge();
      const pendingCode = store.createAuthorizationCode({
        clientId: client.clientId,
        redirectUri: REDIRECT_URI,
        codeChallenge: challenge,
        scopes: ["workspace.read", "offline_access"],
        pairingSessionId: "pair-session-1",
      });
      const issued = store.issueTokens({
        clientId: client.clientId,
        scopes: ["workspace.read", "offline_access"],
      });
      const epochBefore = readAuthorizationEpoch(wsId) ?? 0;

      // Simulate Windows denying read-back immediately after atomicReplace renames empty tokens onto store.json.
      const realOpenSync = fs.openSync.bind(fs);
      let denyStoreRead = true;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((filePath, flags, mode) => {
        if (denyStoreRead && path.resolve(String(filePath)) === path.resolve(storeFile) && flags === "r") {
          throw Object.assign(new Error("EACCES: transient post-rename read failure"), { code: "EACCES" });
        }
        return realOpenSync(filePath as fs.PathLike, flags as fs.OpenMode, mode as fs.Mode | undefined);
      }) as typeof fs.openSync);
      const realReadFileSync = fs.readFileSync.bind(fs);
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((filePath, options) => {
        if (denyStoreRead && typeof filePath === "string" && path.resolve(filePath) === path.resolve(storeFile)) {
          throw Object.assign(new Error("EACCES: transient read failure"), { code: "EACCES" });
        }
        return realReadFileSync(filePath as fs.PathOrFileDescriptor, options as never);
      }) as typeof fs.readFileSync);

      try {
        expect(() => store.revokeAll()).toThrow(/EACCES/);
        expect(() => store.consumeAuthorizationCode(pendingCode)).toThrow(AuthStoreCorruptError);
        expect(store.verifyAccessToken(issued.accessToken).ok).toBe(false);
        expect(store.hasActiveAuthorization(client.clientId, ["workspace.read"])).toBe(false);
      } finally {
        denyStoreRead = false;
        openSpy.mockRestore();
        readSpy.mockRestore();
      }

      // After disk becomes readable again, reconciliation must reject the old auth code AND complete the epoch bump.
      expect(store.consumeAuthorizationCode(pendingCode)).toBeNull();
      expect(readAuthorizationEpoch(wsId)).toBeGreaterThan(epochBefore);
      expect(store.verifyAccessToken(issued.accessToken).ok).toBe(false);
      expect(store.tokenCount()).toBe(0);
    } finally {
      cleanup(dir);
    }
  });
});
