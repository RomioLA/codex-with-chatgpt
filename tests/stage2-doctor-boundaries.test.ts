import fs from "node:fs";
import http, { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { writeLastEndpoint } from "../src/config/endpoint.js";
import { writeRuntimeState, SERVICE_NAME, VERSION } from "../src/bridge/runtime.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { Workspace } from "../src/workspace/manager.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");
const TUNNEL_ID = "77777777-7777-4777-8777-777777777777";
const NAMED_HOST = "c2c-stage2.example.test";

type Mode = "quick" | "named";
type NamedState = "connected" | "stopped" | "disconnected" | "unknown";

interface FixtureOptions {
  mode?: Mode;
  namedState?: NamedState;
  publicHealth?: "healthy" | "degraded";
  withEndpoint?: boolean;
  reportedHostname?: string;
  reportedTunnelHostname?: string;
  startResponseUrl?: string;
  startedAdminHostname?: string;
}

interface Fixture {
  root: string;
  stateDir: string;
  codexHome: string;
  workspace: Workspace;
  runtimeFile: string;
  tunnelFile: string;
  endpointFile: string;
  authDir: string;
  codexConfig: string;
  cloudflaredPath: string;
  preloadFile: string;
  certFile: string;
  credentialFile: string;
  publicUrl: string | null;
  publicServer?: Server;
  bridgeServer?: Server;
  posts: string[];
  adminInfoGets: number;
  envBefore: Record<string, string | undefined>;
}

const ENV_KEYS = [
  "C2C_STATE_DIR",
  "CODEX_HOME",
  "C2C_CLOUDFLARED_PATH",
  "TUNNEL_ORIGIN_CERT",
  "TUNNEL_CRED_FILE",
] as const;

function makeTempDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function saveEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener address");
  return address.port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function disposeFixture(fixture: Fixture): Promise<void> {
  await closeServer(fixture.bridgeServer);
  await closeServer(fixture.publicServer);
  restoreEnvironment(fixture.envBefore);
}

function createFixtureBase(options: { cloudflared?: boolean } = {}): Fixture {
  const root = makeTempDirectory("c2c-stage2-doctor-ws-");
  const stateDir = makeTempDirectory("c2c-stage2-doctor-state-");
  const codexHome = makeTempDirectory("c2c-stage2-doctor-codex-");
  const workspace = new Workspace(root);
  const envBefore = saveEnvironment();
  const fixture: Fixture = {
    root,
    stateDir,
    codexHome,
    workspace,
    runtimeFile: path.join(stateDir, "runtime", `${workspace.id}.json`),
    tunnelFile: path.join(stateDir, "tunnels", `${workspace.id}.json`),
    endpointFile: path.join(stateDir, "endpoints", `${workspace.id}.json`),
    authDir: path.join(stateDir, "auth"),
    codexConfig: path.join(codexHome, "config.toml"),
    cloudflaredPath: path.join(stateDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared"),
    preloadFile: path.join(stateDir, "degraded-public-probe.mjs"),
    certFile: path.join(root, "cert.pem"),
    credentialFile: path.join(root, "tunnel.json"),
    publicUrl: null,
    posts: [],
    adminInfoGets: 0,
    envBefore,
  };

  process.env.C2C_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHome;
  process.env.C2C_CLOUDFLARED_PATH = fixture.cloudflaredPath;
  if (options.cloudflared !== false) {
    fs.writeFileSync(fixture.cloudflaredPath, "isolated placeholder; never executed", "utf8");
    if (process.platform !== "win32") fs.chmodSync(fixture.cloudflaredPath, 0o755);
  }

  return fixture;
}

async function createLiveFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = createFixtureBase();
  const mode = options.mode ?? "quick";
  const namedState = options.namedState ?? "connected";
  const degraded = options.publicHealth === "degraded";

  if (mode === "quick") {
    fixture.publicServer = http.createServer((_req, res) => {
      sendJson(res, degraded ? 503 : 200, { service: SERVICE_NAME, status: "ok" });
    });
    const publicPort = await listen(fixture.publicServer);
    fixture.publicUrl = `http://127.0.0.1:${publicPort}`;
  } else {
    fixture.publicUrl = `https://${options.reportedHostname ?? NAMED_HOST}`;
    fs.writeFileSync(fixture.certFile, "synthetic certificate marker", "utf8");
    fs.writeFileSync(fixture.credentialFile, JSON.stringify({ TunnelID: TUNNEL_ID, TunnelSecret: "synthetic-secret" }), "utf8");
    process.env.TUNNEL_ORIGIN_CERT = fixture.certFile;
    process.env.TUNNEL_CRED_FILE = fixture.credentialFile;
    fs.writeFileSync(fixture.preloadFile, `
const originalFetch = globalThis.fetch.bind(globalThis);
const probeStatus = ${degraded ? 503 : 200};
const probeBody = ${JSON.stringify(JSON.stringify({ service: SERVICE_NAME, status: degraded ? "degraded" : "ok" }))};
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://") && url.endsWith("/health")) {
    return new Response(probeBody, { status: probeStatus, headers: { "content-type": "application/json" } });
  }
  return originalFetch(input, init);
};
`, "utf8");
  }

  let adminInfo: Record<string, unknown>;
  fixture.bridgeServer = http.createServer((req, res) => {
    const route = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && route === "/health") {
      sendJson(res, 200, { service: SERVICE_NAME, version: VERSION, workspaceId: fixture.workspace.id, status: "ok" });
      return;
    }
    if (req.method === "GET" && route === "/admin/info") {
      if (req.headers.authorization !== "Bearer stage2-test-admin-token") {
        sendJson(res, 404, { message: "not found" });
      } else {
        fixture.adminInfoGets += 1;
        sendJson(res, 200, adminInfo);
      }
      return;
    }
    if (req.method === "POST" && route === "/mcp") {
      sendJson(res, 401, { message: "unauthorized" });
      return;
    }
    if (req.method === "POST") {
      fixture.posts.push(route);
      if (route === "/admin/tunnel/start") {
        const startedAdminUrl = options.startedAdminHostname
          ? `https://${options.startedAdminHostname}`
          : fixture.publicUrl;
        adminInfo = {
          ...adminInfo,
          publicUrl: startedAdminUrl,
          tunnel: {
            running: true,
            url: startedAdminUrl,
            provider: mode === "named" ? "cloudflare-named" : "cloudflare-quick",
            ...(mode === "named" ? { processRunning: true, connected: true } : {}),
          },
        };
        sendJson(res, 200, { url: options.startResponseUrl ?? fixture.publicUrl, message: "started" });
      } else {
        sendJson(res, 200, { ok: true });
      }
      return;
    }
    sendJson(res, 404, { message: "not found" });
  });

  const bridgePort = await listen(fixture.bridgeServer);
  let tunnel: Record<string, unknown>;
  let publicUrl: string | null = fixture.publicUrl;
  const tunnelUrl = options.reportedTunnelHostname
    ? `https://${options.reportedTunnelHostname}`
    : fixture.publicUrl;
  if (mode === "named") {
    tunnel = namedState === "stopped"
      ? { running: false, url: null, provider: "cloudflare-named", processRunning: false, connected: false }
      : namedState === "disconnected"
        ? { running: true, url: tunnelUrl, provider: "cloudflare-named", processRunning: true, connected: false }
        : namedState === "unknown"
          ? { running: true, url: tunnelUrl, provider: "cloudflare-named" }
          : { running: true, url: tunnelUrl, provider: "cloudflare-named", processRunning: true, connected: true };
    if (namedState === "stopped") publicUrl = null;
  } else {
    tunnel = { running: true, url: fixture.publicUrl, provider: "cloudflare-quick" };
  }

  adminInfo = {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: fixture.workspace.id,
    workspaceName: fixture.workspace.name,
    workspaceRoot: fixture.workspace.root,
    port: bridgePort,
    publicUrl,
    tunnel,
    tokenCount: 0,
    pairingActive: false,
    pid: process.pid,
    startedAt: "2026-10-26T00:00:00.000Z",
    permissionMode: "readonly",
  };
  writeRuntimeState({
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: fixture.workspace.id,
    workspaceRoot: fixture.workspace.root,
    pid: process.pid,
    port: bridgePort,
    adminToken: "stage2-test-admin-token",
    publicUrl,
    startedAt: "2026-10-26T00:00:00.000Z",
  });
  writeTunnelState(mode === "named"
    ? {
        workspaceId: fixture.workspace.id,
        preference: "named",
        askedAt: "2026-10-26T00:00:00.000Z",
        provider: "cloudflare-named",
        tunnelName: `c2c-${fixture.workspace.id}`,
        tunnelId: TUNNEL_ID,
        hostname: NAMED_HOST,
        zone: "example.test",
      }
    : {
        workspaceId: fixture.workspace.id,
        preference: "quick",
        askedAt: "2026-10-26T00:00:00.000Z",
        provider: "cloudflare-quick",
      });

  if (options.withEndpoint) {
    writeLastEndpoint({
      workspaceId: fixture.workspace.id,
      port: bridgePort,
      publicUrl: fixture.publicUrl,
      mcpUrl: fixture.publicUrl ? `${fixture.publicUrl}/mcp` : null,
    });
  }

  return fixture;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

async function runCli(fixture: Fixture, args: string[]): Promise<CliResult> {
  const preloadArgs = fixture.preloadFile && fs.existsSync(fixture.preloadFile)
    ? ["--import", pathToFileURL(fixture.preloadFile).href]
    : [];
  const child = spawn(process.execPath, ["--import", "tsx", ...preloadArgs, cliEntry, ...args], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      C2C_STATE_DIR: fixture.stateDir,
      CODEX_HOME: fixture.codexHome,
      C2C_CLOUDFLARED_PATH: fixture.cloudflaredPath,
      TUNNEL_ORIGIN_CERT: fs.existsSync(fixture.certFile) ? fixture.certFile : "",
      TUNNEL_CRED_FILE: fs.existsSync(fixture.credentialFile) ? fixture.credentialFile : "",
    },
  });

  return await new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string =>
      current.length >= 1_000_000 ? current : current + chunk.toString("utf8").slice(0, 1_000_000 - current.length);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ status: null, stdout, stderr, error: "CLI test child timed out after 20 seconds" });
    }, 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: null, stdout, stderr, error: error.message });
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("V1.5 Stage 2 doctor boundaries", () => {
  it("keeps status read-only when no Bridge runtime exists and points to explicit restore", async () => {
    const fixture = createFixtureBase({ cloudflared: false });
    try {
      expect(fs.readdirSync(fixture.stateDir)).toEqual([]);
      const text = await runCli(fixture, ["status", "-w", fixture.root]);
      expect(text.status, `${text.stdout}\n${text.stderr}`).toBe(0);
      expect(text.stdout).toContain("c2c restore -w <workspace>");

      const json = await runCli(fixture, ["status", "--json", "-w", fixture.root]);
      expect(json.status, `${json.stdout}\n${json.stderr}`).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        running: false,
        diagnostics: { bridge: { status: "stopped" } },
      });
      expect(fs.readdirSync(fixture.stateDir)).toEqual([]);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("keeps --no-fix read-only and makes default doctor side effects explicit", async () => {
    const fixture = await createLiveFixture({ mode: "quick", publicHealth: "healthy" });
    try {
      const noFix = await runCli(fixture, ["doctor", "--json", "--no-fix", "-w", fixture.root]);
      expect(noFix.status, `${noFix.stdout}\n${noFix.stderr}`).toBe(1);
      expect(JSON.parse(noFix.stdout)).toMatchObject({
        repairMode: "read-only",
        repairEffects: [],
      });
      expect(fs.existsSync(fixture.endpointFile)).toBe(false);
      expect(fs.existsSync(fixture.codexConfig)).toBe(false);
      expect(fs.existsSync(fixture.authDir)).toBe(false);
      expect(fixture.posts).toEqual([]);

      const autoFix = await runCli(fixture, ["doctor", "--json", "-w", fixture.root]);
      expect(JSON.parse(autoFix.stdout)).toMatchObject({
        repairMode: "auto-repair",
        repairEffects: expect.arrayContaining([
          "codex_sandbox_allowlist",
          "bridge_start_or_restart",
          "tunnel_start",
          "endpoint_metadata_write",
        ]),
      });
      expect(fs.existsSync(fixture.endpointFile)).toBe(true);
      expect(fs.existsSync(fixture.codexConfig)).toBe(true);

      const text = await runCli(fixture, ["doctor", "-w", fixture.root]);
      expect(text.stdout).toContain("模式：自动修复");
      expect(text.stdout).toContain("只读诊断请使用 `c2c doctor --no-fix`");
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("does not start a confirmed connected Named Tunnel when its public probe is degraded", async () => {
    const fixture = await createLiveFixture({
      mode: "named",
      namedState: "connected",
      publicHealth: "degraded",
      withEndpoint: true,
    });
    try {
      const result = await runCli(fixture, ["doctor", "--json", "-w", fixture.root]);
      expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        report: { tunnel?: { ok: boolean; detail?: string } };
        diagnostics?: { publicProbe?: { publicProbeStatus?: string }; recovery?: { status?: string } };
        namedRepair?: { needed: boolean; userMessage?: string };
      };
      expect(fixture.posts).not.toContain("/admin/tunnel/start");
      expect(fixture.posts).not.toContain("/admin/shutdown");
      expect(payload.report.tunnel).toMatchObject({ ok: true });
      expect(payload.report.tunnel?.detail).toContain("public health probe is degraded");
      expect(payload.diagnostics?.publicProbe?.publicProbeStatus).toBe("degraded");
      expect(payload.diagnostics?.recovery?.status).toBe("healthy");
      expect(payload.namedRepair).toMatchObject({ needed: false });
    } finally {
      await disposeFixture(fixture);
    }
  });

  it.each([
    ["the configured hostname differs from the runtime URL", { reportedHostname: "wrong-stage2.example.test" }],
    ["publicUrl hides a conflicting tunnel.url", { reportedTunnelHostname: "other-stage2.example.test" }],
  ] as const)("rejects a healthy Named probe when %s", async (_reason, overrides) => {
    const fixture = await createLiveFixture({
      mode: "named",
      publicHealth: "healthy",
      ...overrides,
    });
    try {
      const result = await runCli(fixture, ["doctor", "--json", "-w", fixture.root]);
      expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(1);
      const payload = JSON.parse(result.stdout) as { report: { tunnel?: { ok: boolean; detail?: string } } };
      expect(payload.report.tunnel?.ok).toBe(false);
      expect(fixture.posts).not.toContain("/admin/tunnel/start");
      expect(fs.existsSync(fixture.endpointFile)).toBe(false);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it.each(["unknown", "disconnected"] as const)(
    "does not auto-start a Named Tunnel whose reported state is %s",
    async (namedState) => {
      const fixture = await createLiveFixture({
        mode: "named",
        namedState,
        publicHealth: "healthy",
      });
      try {
        const result = await runCli(fixture, ["doctor", "--json", "-w", fixture.root]);
        expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(1);
        const payload = JSON.parse(result.stdout) as { report: { tunnel?: { ok: boolean; detail?: string } } };
        expect(fixture.posts).not.toContain("/admin/tunnel/start");
        expect(fixture.posts).not.toContain("/admin/shutdown");
        expect(payload.report.tunnel?.ok).toBe(false);
        expect(payload.report.tunnel?.detail).toMatch(/skipped|unverified/i);
        expect(fs.existsSync(fixture.endpointFile)).toBe(false);
      } finally {
        await disposeFixture(fixture);
      }
    },
  );

  it.each([
    ["the start response returned the wrong hostname", { startResponseUrl: "https://wrong-start.example.test" }],
    ["the refreshed Admin status reports the wrong hostname", { startedAdminHostname: "wrong-admin.example.test" }],
  ] as const)("rejects a Named start when %s", async (_reason, overrides) => {
    const fixture = await createLiveFixture({
      mode: "named",
      namedState: "stopped",
      publicHealth: "healthy",
      ...overrides,
    });
    try {
      const result = await runCli(fixture, ["doctor", "--json", "-w", fixture.root]);
      expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(1);
      const payload = JSON.parse(result.stdout) as { report: { tunnel?: { ok: boolean; detail?: string } } };
      expect(payload.report.tunnel?.ok).toBe(false);
      expect(fixture.posts.filter((route) => route === "/admin/tunnel/start")).toHaveLength(1);
      expect(fixture.adminInfoGets).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(fixture.endpointFile)).toBe(false);
    } finally {
      await disposeFixture(fixture);
    }
  });

  it("starts a confirmed stopped Named Tunnel and preserves the Quick Tunnel repair gate", async () => {
    const named = await createLiveFixture({
      mode: "named",
      namedState: "stopped",
      publicHealth: "healthy",
    });
    try {
      const result = await runCli(named, ["doctor", "--json", "-w", named.root]);
      expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`).toBe(0);
      const payload = JSON.parse(result.stdout) as { report: { tunnel?: { ok: boolean } } };
      expect(payload.report.tunnel?.ok).toBe(true);
      expect(named.posts.filter((route) => route === "/admin/tunnel/start")).toHaveLength(1);
      expect(named.adminInfoGets).toBeGreaterThanOrEqual(2);
      expect(fs.existsSync(named.endpointFile)).toBe(true);
    } finally {
      await disposeFixture(named);
    }

    const quick = await createLiveFixture({ mode: "quick", publicHealth: "degraded", withEndpoint: true });
    try {
      await runCli(quick, ["doctor", "--json", "-w", quick.root]);
      expect(quick.posts.filter((route) => route === "/admin/tunnel/start")).toHaveLength(1);
    } finally {
      await disposeFixture(quick);
    }
  });
});
