import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { SnapshotRegistry } from "../workspace/batch.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler, safeToolName } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { probeBridge, writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { acquireBridgeInstanceLock, type BridgeInstanceLock } from "./instance-lock.js";
import { applyPermission, ensurePermissionMigrated, PermissionControlError, readPermission, readPermissionStatus, type PermissionMode } from "../permission/index.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../execution/supervisor.js";
import { TaskStore } from "../tasks/task-store.js";
import { TaskSupervisor } from "../tasks/task-supervisor.js";
import {
  eventLoopTraceMiddleware,
  getEventLoopTraceSnapshot,
  isEventLoopTraceEnabled,
  recordEventLoopTrace,
} from "../diagnostics/event-loop-trace.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Internal test seam; production callers use the fixed Windows helper. */
  executionRunner?: ExecutionRunner;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  executionSupervisor: ExecutionSupervisor;
  /** Internal persistent Task runtime. No Task MCP tools are registered in this wave. */
  taskStore: TaskStore;
  taskSupervisor: TaskSupervisor;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Use the preferred port when available. Refuse a same-workspace Bridge;
 * retain ephemeral fallback only when the port belongs to another service.
 */
function listen(
  app: express.Express,
  host: string,
  preferredPort: number,
  workspaceId: string
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          void probeBridge(port, 1000)
            .then((existing) => {
              if (existing?.workspaceId === workspaceId) {
                reject(new Error(`A Bridge for workspace ${workspaceId} is already listening on port ${port}.`));
                return;
              }
              tryListen(0, false);
            })
            .catch(reject);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

/**
 * Parse the Level2 control-plane body. Only `mode` (1|2) or `baseline`
 * (level1|readonly) is accepted; the baseline channel can never elevate.
 */
function parsePermissionRequest(
  raw: unknown
): { mode: PermissionMode } | { error: string; message: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: "PERMISSION_REQUEST_INVALID", message: "A JSON body with mode or baseline is required." };
  }
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return { error: "PERMISSION_REQUEST_INVALID", message: "Request body is not valid JSON." }; }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "PERMISSION_REQUEST_INVALID", message: "Request body must be a JSON object." };
  }
  const record = body as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "mode" && key !== "baseline");
  if (extra.length > 0) {
    return { error: "PERMISSION_REQUEST_INVALID", message: "Unsupported request field." };
  }
  const hasMode = Object.prototype.hasOwnProperty.call(record, "mode");
  const hasBaseline = Object.prototype.hasOwnProperty.call(record, "baseline");
  if (hasMode === hasBaseline) {
    return { error: "PERMISSION_REQUEST_INVALID", message: "Provide exactly one of mode or baseline." };
  }
  if (hasMode) {
    // "1" / "2" are the launcher-facing shorthands; long names are accepted too.
    const value = record.mode;
    if (value === "1" || value === "level1") return { mode: "level1" };
    if (value === "2" || value === "level2") return { mode: "level2" };
    return { error: "PERMISSION_REQUEST_INVALID", message: "mode must be \"1\" or \"2\"." };
  }
  const baseline: unknown = record.baseline;
  if (baseline === "level1") return { mode: "level1" };
  if (baseline === "readonly") return { mode: "readonly" };
  return { error: "PERMISSION_REQUEST_INVALID", message: "baseline must be \"level1\" or \"readonly\"." };
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const snapshotRegistry = new SnapshotRegistry();
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }
  // Upgrade the old persisted state shape before any MCP request can observe it.
  // This local startup migration NEVER grants Level 2: a legacy v1 `mode=level2`
  // record is reduced to a level1 baseline, because Level 2 must be re-enabled by
  // the user in each Windows logon session.
  ensurePermissionMigrated(workspace.id);

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  if (isEventLoopTraceEnabled()) app.use(eventLoopTraceMiddleware);

  const localBaseUrl = (): string => `http://${host === "::1" ? "[::1]" : host}:${port}`;
  // OAuth discovery and challenges share the trusted tunnel/bind authority.
  // Request Host/proxy headers must not choose an authorization server.
  const getBaseUrl = (): string => publicBaseUrl ?? localBaseUrl();

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    if (isEventLoopTraceEnabled()) recordEventLoopTrace("handler_start");
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  let executionSupervisor: ExecutionSupervisor | null = null;
  let taskSupervisor: TaskSupervisor | null = null;
  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({
      workspace,
      logger,
      snapshotRegistry,
      executionSupervisor: executionSupervisor ?? undefined,
      taskSupervisor: taskSupervisor ?? undefined,
      oauthResourceMetadataUri: `${getBaseUrl()}/.well-known/oauth-protected-resource/mcp`,
    }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      if (isEventLoopTraceEnabled()) {
        const toolName = safeToolName(req.body);
        recordEventLoopTrace("auth_done", toolName ? { toolName } : {});
      }
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  if (isEventLoopTraceEnabled()) {
    app.get("/admin/event-loop-trace", adminGuard, (_req, res) => {
      res.json(getEventLoopTraceSnapshot());
    });
  }

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      // Read persisted state per request so local CLI changes are visible without restart.
      permissionMode: readPermission(workspace.id),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/restart", adminGuard, (_req, res) => {
    tunnel
      .restart(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel restart failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    }).catch(() => {
      logger.error("Tunnel stop could not be confirmed");
      res.status(500).json({ error: "tunnel_stop_failed", message: "Tunnel stop could not be confirmed." });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  // ---- Level2 local permission control plane (loopback + admin token only) --
  //
  // This is the Bridge's own Level 2 grant authority and the ONLY supported way
  // to elevate while a Bridge is running: the grant is written with this
  // process's Windows logon identity, so a grant created by any other process
  // cannot be honoured here.
  //
  // It is deliberately NOT registered on /mcp. An OAuth client can never reach
  // it, and it is invisible to remote callers because adminGuard answers 404 for
  // anything that is not a loopback request carrying the runtime admin token.
  //
  //   POST /admin/permission   {"mode":"1"|"2"} | {"baseline":"level1"|"readonly"}
  //   200: {workspaceId,pid,port,startedAt,baselineMode,effectiveMode,sessionElevation}
  //   non-200: {error,code,message}; 409 busy/unverified/not-effective/inconsistent,
  //   500 malformed/unwritable. Never a success body for an unconfirmed grant.
  app.post("/admin/permission", adminGuard, express.text({ type: () => true, limit: "1kb" }), (req, res) => {
    const requested = parsePermissionRequest(req.body);
    if ("error" in requested) {
      res.status(409).json({ error: requested.error, code: requested.error, message: requested.message });
      return;
    }
    let applied;
    try {
      applied = applyPermission(workspace.id, requested.mode);
    } catch (error) {
      if (error instanceof PermissionControlError) {
        logger.warn(`Permission control refused (${error.code})`);
        res.status(error.status).json({ error: error.code, code: error.code, message: error.message });
        return;
      }
      // Defensive: never leak an internal error message or a partial success.
      logger.error("Permission control failed");
      res.status(500).json({
        error: "PERMISSION_CONTROL_FAILED",
        code: "PERMISSION_CONTROL_FAILED",
        message: "Permission state could not be changed; treat the change as unconfirmed.",
      });
      return;
    }
    logger.info(`Permission control applied effectiveMode=${applied.effectiveMode} baseline=${applied.baselineMode}`);
    res.json({
      workspaceId: workspace.id,
      pid: process.pid,
      port,
      startedAt,
      baselineMode: applied.baselineMode,
      effectiveMode: applied.effectiveMode,
      sessionElevation: applied.sessionElevation,
    });
  });

  // Read-only mirror used by callers that only need to verify the live authority.
  app.get("/admin/permission", adminGuard, (_req, res) => {
    const status = readPermissionStatus(workspace.id);
    res.json({
      workspaceId: workspace.id,
      pid: process.pid,
      port,
      startedAt,
      baselineMode: status.baselineMode,
      effectiveMode: status.effectiveMode,
      sessionElevation: status.sessionElevation,
    });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  // Initialize routes before acquiring the guard so a synchronous setup failure
  // cannot strand a lock owned by this still-running process. Every Bridge,
  // including persistRuntime:false instances, must hold it before listening.
  const instanceLock: BridgeInstanceLock = await acquireBridgeInstanceLock(workspace.id);
  const supervisor = new ExecutionSupervisor(workspace, { runner: opts.executionRunner, logger });
  let taskStore: TaskStore;
  try {
    taskStore = new TaskStore(workspace.id);
  } catch (error) {
    await supervisor.shutdown().catch(() => undefined);
    await instanceLock.release().catch(() => undefined);
    throw error;
  }
  const persistentTaskSupervisor = new TaskSupervisor(workspace, taskStore, supervisor, {
    snapshotRegistry,
    requireRecovery: true,
    authorizationValid: (task) => authStore.hasActiveAuthorization(task.ownerClientId, task.authBinding.requiredScopes),
  });
  taskSupervisor = persistentTaskSupervisor;
  // ExecutionJobStore loads in the ExecutionSupervisor constructor. Reconcile
  // TaskStore against it before the listener accepts Task API mutations.
  await persistentTaskSupervisor.recover();
  executionSupervisor = supervisor;
  const listening = await listen(app, host, opts.port ?? DEFAULT_PORT, workspace.id).catch(async (error: unknown) => {
    await supervisor.shutdown().catch(() => undefined);
    await persistentTaskSupervisor.shutdown().catch(() => undefined);
    await instanceLock.release().catch(() => undefined);
    throw error;
  });
  const { server, port } = listening;
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
    };
    writeRuntimeState(state);
  };
  try {
    persistRuntime();
  } catch (error) {
    await supervisor.shutdown().catch(() => undefined);
    await persistentTaskSupervisor.shutdown().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await instanceLock.release().catch(() => undefined);
    throw error;
  }

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await supervisor.shutdown();
    await persistentTaskSupervisor.shutdown();
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id);
    await instanceLock.release().catch(() => undefined);
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    executionSupervisor: supervisor,
    taskStore,
    taskSupervisor: persistentTaskSupervisor,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl,
    close: shutdown,
  };
}
