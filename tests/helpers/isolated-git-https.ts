import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { makeTmpDir } from "../helpers.js";

const CLOUDFLARED_EXE = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const MAX_POST_BYTES = 8 * 1024 * 1024;
const MAX_CGI_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CLOUDFLARED_CAPTURE_BYTES = 32 * 1024;
const STARTUP_TIMEOUT_MS = 60_000;
const CHILD_STOP_TIMEOUT_MS = 5_000;

export type IsolatedGitHttpFault = "normal" | "unauthorized" | "drop-receive-pack-response";

export interface IsolatedGitHttpObservation {
  method: string;
  path: string;
  query: string;
  contentType: string | null;
  requestBytes: number;
  backendExitCode: number | null;
  backendStderrBytes: number;
  httpStatus: number;
  responseBytes: number;
  responseDropped: boolean;
}

export interface IsolatedGitHttpRoute {
  readonly token: string;
  readonly url: string;
  readonly bareRepository: string;
  setFault(fault: IsolatedGitHttpFault): void;
}

export interface IsolatedGitHttpsFixture {
  readonly publicHost: string;
  readonly loopbackOrigin: string;
  createRoute(): IsolatedGitHttpRoute;
  setGitExecutable(executable: string): void;
  observations(): IsolatedGitHttpObservation[];
  close(): Promise<void>;
}

interface RouteState {
  token: string;
  projectRoot: string;
  bareRepository: string;
  fault: IsolatedGitHttpFault;
}

interface CgiHeader {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function captureText(current: string, chunk: Buffer): string {
  const remaining = Math.max(0, MAX_CLOUDFLARED_CAPTURE_BYTES - Buffer.byteLength(current, "utf8"));
  return remaining === 0 ? current : `${current}${chunk.toString("utf8", 0, remaining)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeCloudflaredEnvironment(isolatedHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:TUNNEL_|CLOUDFLARED?_|CLOUDFLARE_|CF_(?:ACCESS_|TUNNEL_|API_|ZONE_|ACCOUNT_))/i.test(key)) delete env[key];
  }
  return { ...env, HOME: isolatedHome, USERPROFILE: isolatedHome };
}

function gitBackendEnvironment(route: RouteState, request: IncomingMessage, pathname: string, query: string, contentLength: number, serverPort: number, tempRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^(?:TUNNEL_|CLOUDFLARED_|CF_ACCESS_|CF_TUNNEL_)/i.test(key)) delete env[key];
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return {
    ...(systemRoot ? { SystemRoot: systemRoot, WINDIR: systemRoot } : {}),
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    TEMP: tempRoot,
    TMP: tempRoot,
    GIT_PROJECT_ROOT: route.projectRoot,
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_CONFIG_GLOBAL: path.join(tempRoot, "empty-global.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(tempRoot, "empty-system.gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    PATH_INFO: pathname,
    QUERY_STRING: query,
    REQUEST_METHOD: request.method ?? "GET",
    CONTENT_TYPE: typeof request.headers["content-type"] === "string" ? request.headers["content-type"] : "",
    CONTENT_LENGTH: String(contentLength),
    REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
    REMOTE_USER: "",
    SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
    SERVER_NAME: "127.0.0.1",
    SERVER_PORT: String(serverPort),
    GATEWAY_INTERFACE: "CGI/1.1",
    SCRIPT_NAME: "",
    REQUEST_URI: request.url ?? pathname,
    HTTP_HOST: typeof request.headers.host === "string" ? request.headers.host : "localhost",
    HTTP_USER_AGENT: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : "c2c-isolated-git-test",
    HTTP_ACCEPT: typeof request.headers.accept === "string" ? request.headers.accept : "*/*",
    ...(typeof request.headers["git-protocol"] === "string" ? { HTTP_GIT_PROTOCOL: request.headers["git-protocol"] } : {}),
    ...(typeof request.headers["accept-encoding"] === "string" ? { HTTP_ACCEPT_ENCODING: request.headers["accept-encoding"] } : {}),
  };
}

function parseCgiResponse(bytes: Buffer): CgiHeader | null {
  let separator = bytes.indexOf(Buffer.from("\r\n\r\n"));
  let separatorLength = 4;
  if (separator < 0) {
    separator = bytes.indexOf(Buffer.from("\n\n"));
    separatorLength = 2;
  }
  if (separator < 0) return null;
  const lines = bytes.subarray(0, separator).toString("latin1").split(/\r?\n/);
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") {
      const parsed = Number(value.slice(0, 3));
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) status = parsed;
    } else if (/^(?:content-type|cache-control|expires|pragma|last-modified|etag|x-content-type-options)$/i.test(name)) {
      headers[name] = value;
    }
  }
  return { status, headers, body: bytes.subarray(separator + separatorLength) };
}

function statusResponse(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Length": "0", ...headers });
  res.end();
}

function waitChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopOwnedChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* Only this exact child handle is ever signalled. */ }
  if (!await waitChildClose(child, CHILD_STOP_TIMEOUT_MS)) throw new Error("BLOCKED_OWNED_CHILD_DID_NOT_EXIT");
}

function assertCloudflaredBinary(): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(CLOUDFLARED_EXE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a plain file");
  } catch {
    throw new Error("BLOCKED_CLOUDFLARED_EXECUTABLE_UNAVAILABLE");
  }
}

function checkProxyAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port: 7897 });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(new Error("BLOCKED_APPROVED_PROXY_UNAVAILABLE"));
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("timeout")), 1_500);
    socket.once("connect", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

export function resolveGitExecutableFromPath(): string {
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).slice(0, 1024)) {
    if (!folder) continue;
    try {
      const candidate = fs.realpathSync.native(path.resolve(folder, name));
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch { /* Continue through PATH exactly as the Git approval resolver does. */ }
  }
  throw new Error("BLOCKED_GIT_EXECUTABLE_UNAVAILABLE");
}

export async function startIsolatedGitHttpsFixture(): Promise<IsolatedGitHttpsFixture> {
  if (process.platform !== "win32") throw new Error("BLOCKED_NATIVE_HTTPS_TEST_REQUIRES_WINDOWS");
  assertCloudflaredBinary();
  await checkProxyAvailable();

  const fixtureRoot = makeTmpDir("v13-native-https-fixture");
  const tempRoot = makeTmpDir("v13-native-https-temp");
  const configRoot = makeTmpDir("v13-native-https-cloudflared-config");
  const configFile = path.join(configRoot, "cloudflared.yml");
  fs.writeFileSync(configFile, "{}\n", { flag: "wx" });
  fs.writeFileSync(path.join(tempRoot, "empty-global.gitconfig"), "", { flag: "wx" });
  fs.writeFileSync(path.join(tempRoot, "empty-system.gitconfig"), "", { flag: "wx" });

  const routes = new Map<string, RouteState>();
  const observations: IsolatedGitHttpObservation[] = [];
  const backendChildren = new Set<ChildProcessWithoutNullStreams>();
  let gitExecutable = resolveGitExecutableFromPath();
  let cloudflared: ChildProcess | null = null;
  let serverPort = 0;
  let closed = false;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => statusResponse(res, 502));
  });

  const closeServer = async () => {
    if (!server.listening) return;
    const serverWithCloseAll = server as http.Server & { closeAllConnections?: () => void };
    serverWithCloseAll.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    let closeError: unknown = null;
    try { await stopOwnedChild(cloudflared); } catch (error) { closeError = error; }
    for (const child of [...backendChildren]) {
      try { await stopOwnedChild(child); } catch (error) { closeError ??= error; }
    }
    try { await closeServer(); } catch (error) { closeError ??= error; }
    if (closeError) throw closeError;
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let parsedUrl: URL;
    try { parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1"); }
    catch { statusResponse(res, 400); return; }
    const pathname = parsedUrl.pathname;
    const token = pathname.split("/")[1] ?? "";
    const route = routes.get(token);
    const routePrefix = route ? `/${route.token}/repo.git` : "";
    if (!route || (pathname !== routePrefix && !pathname.startsWith(`${routePrefix}/`))) {
      statusResponse(res, 404);
      return;
    }
    if (route.fault === "unauthorized") {
      observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        requestBytes: 0, backendExitCode: null, backendStderrBytes: 0, httpStatus: 401, responseBytes: 0, responseDropped: false });
      statusResponse(res, 401, { "WWW-Authenticate": 'Basic realm="isolated-c2c-git-test"', "Cache-Control": "no-store" });
      req.resume();
      return;
    }
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_POST_BYTES) {
      observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        requestBytes: 0, backendExitCode: null, backendStderrBytes: 0, httpStatus: 413, responseBytes: 0, responseDropped: false });
      statusResponse(res, 413);
      req.resume();
      return;
    }

    const requestBody = await new Promise<{ body: Buffer | null; requestBytes: number; tooLarge: boolean }>((resolve) => {
      const chunks: Buffer[] = [];
      let requestBytes = 0;
      let tooLarge = false;
      req.on("data", (chunk: Buffer) => {
        requestBytes += chunk.byteLength;
        if (requestBytes > MAX_POST_BYTES) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) chunks.push(Buffer.from(chunk));
      });
      req.once("end", () => resolve({ body: tooLarge ? null : Buffer.concat(chunks, requestBytes), requestBytes, tooLarge }));
      req.once("aborted", () => resolve({ body: null, requestBytes, tooLarge: false }));
      req.once("error", () => resolve({ body: null, requestBytes, tooLarge: false }));
    });
    if (requestBody.tooLarge) {
      observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        requestBytes: requestBody.requestBytes, backendExitCode: null, backendStderrBytes: 0, httpStatus: 413, responseBytes: 0, responseDropped: false });
      statusResponse(res, 413);
      return;
    }
    if (!requestBody.body) {
      observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        requestBytes: requestBody.requestBytes, backendExitCode: null, backendStderrBytes: 0, httpStatus: 400, responseBytes: 0, responseDropped: false });
      statusResponse(res, 400);
      return;
    }

    const child = spawn(gitExecutable, ["http-backend"], {
      cwd: route.projectRoot,
      env: gitBackendEnvironment(route, req, pathname, parsedUrl.search.slice(1), requestBody.body.byteLength, serverPort, tempRoot),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
    backendChildren.add(child);
    let stderrBytes = 0;
    let responseBytes = 0;
    let responseTooLarge = false;
    let spawnError = false;
    const output: Buffer[] = [];
    const timeout = setTimeout(() => {
      spawnError = true;
      try { child.kill(); } catch { /* Only the owned CGI child is signalled. */ }
    }, 45_000);
    child.stdout.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_CGI_RESPONSE_BYTES) {
        responseTooLarge = true;
        try { child.kill(); } catch { /* Only the owned CGI child is signalled. */ }
      } else output.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; });
    child.on("error", () => { spawnError = true; });
    child.stdin.end(requestBody.body);
    res.once("close", () => {
      if (!res.writableEnded) {
        try { child.kill(); } catch { /* Only the owned CGI child is signalled. */ }
      }
    });

    child.once("close", (code) => {
      clearTimeout(timeout);
      backendChildren.delete(child);
      if (spawnError || responseTooLarge || code !== 0) {
        observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
          contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
          requestBytes: requestBody.requestBytes, backendExitCode: code, backendStderrBytes: stderrBytes, httpStatus: 502, responseBytes, responseDropped: false });
        statusResponse(res, 502);
        return;
      }
      const cgi = parseCgiResponse(Buffer.concat(output, responseBytes));
      if (!cgi) {
        observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
          contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
          requestBytes: requestBody.requestBytes, backendExitCode: code, backendStderrBytes: stderrBytes, httpStatus: 502, responseBytes, responseDropped: false });
        statusResponse(res, 502);
        return;
      }
      const dropResponse = route.fault === "drop-receive-pack-response" &&
        (req.method ?? "").toUpperCase() === "POST" && pathname.endsWith("/git-receive-pack");
      observations.push({ method: req.method ?? "GET", path: pathname, query: parsedUrl.search.slice(1),
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : null,
        requestBytes: requestBody.requestBytes, backendExitCode: code, backendStderrBytes: stderrBytes, httpStatus: cgi.status,
        responseBytes: cgi.body.byteLength, responseDropped: dropResponse });
      if (dropResponse) {
        res.destroy();
        return;
      }
      res.writeHead(cgi.status, cgi.headers);
      res.end(cgi.body);
    });
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string") reject(new Error("BLOCKED_LOOPBACK_SERVER_START_FAILED"));
        else {
          serverPort = address.port;
          resolve();
        }
      });
    });
  } catch {
    await closeServer();
    throw new Error("BLOCKED_LOOPBACK_SERVER_START_FAILED");
  }

  const loopbackOrigin = `http://127.0.0.1:${serverPort}`;
  try {
    cloudflared = spawn(CLOUDFLARED_EXE, [
      "tunnel", "--config", configFile, "--no-autoupdate", "--protocol", "http2", "--url", loopbackOrigin,
    ], {
      cwd: fixtureRoot,
      env: safeCloudflaredEnvironment(fixtureRoot),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  } catch {
    await close();
    throw new Error("BLOCKED_CLOUDFLARED_SPAWN_FAILED");
  }
  let cloudflaredOutput = "";
  let cloudflaredExit: number | null = null;
  let cloudflaredSpawnError = false;
  cloudflared.stdout?.on("data", (chunk: Buffer) => { cloudflaredOutput = captureText(cloudflaredOutput, chunk); });
  cloudflared.stderr?.on("data", (chunk: Buffer) => { cloudflaredOutput = captureText(cloudflaredOutput, chunk); });
  cloudflared.on("error", () => { cloudflaredSpawnError = true; });
  cloudflared.once("close", (code) => { cloudflaredExit = code; });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let publicHost: string | null = null;
  try {
    while (Date.now() < deadline) {
      const match = cloudflaredOutput.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (match) { publicHost = match[1].toLowerCase(); break; }
      if (cloudflaredSpawnError || cloudflaredExit !== null) {
        throw new Error(`BLOCKED_CLOUDFLARED_EXITED:${cloudflaredExit ?? "spawn-error"}`);
      }
      await delay(100);
    }
    if (!publicHost) throw new Error("BLOCKED_CLOUDFLARED_STARTUP_TIMEOUT");
  } catch (error) {
    try { await close(); } catch { /* Preserve the startup block reason. */ }
    throw error;
  }

  return {
    publicHost,
    loopbackOrigin,
    createRoute(): IsolatedGitHttpRoute {
      const token = randomBytes(24).toString("base64url");
      if (token.length < 24 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("ISOLATED_ROUTE_TOKEN_INVALID");
      const projectRoot = makeTmpDir("v13-native-https-http-backend");
      const routeDirectory = path.join(projectRoot, token);
      fs.mkdirSync(routeDirectory);
      const bareRepository = path.join(routeDirectory, "repo.git");
      routes.set(token, { token, projectRoot, bareRepository, fault: "normal" });
      return {
        token,
        url: `https://${publicHost}/${token}/repo.git`,
        bareRepository,
        setFault(fault) {
          const route = routes.get(token);
          if (!route) throw new Error("ISOLATED_ROUTE_NOT_FOUND");
          route.fault = fault;
        },
      };
    },
    setGitExecutable(executable: string) {
      const canonical = fs.realpathSync.native(executable);
      if (!path.isAbsolute(canonical) || !fs.statSync(canonical).isFile()) throw new Error("ISOLATED_GIT_BACKEND_EXECUTABLE_INVALID");
      gitExecutable = canonical;
    },
    observations() { return observations.map((item) => ({ ...item })); },
    close,
  };
}
