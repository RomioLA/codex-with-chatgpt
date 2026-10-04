import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { findBridgeObservation, type BridgeObservation, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, type EnsureBridgeResult } from "./daemon.js";
import { Logger, type Logger as LoggerType } from "../logger/index.js";
import { readLastEndpoint, mcpUrlFromPublic, normalizePublicUrl } from "../config/endpoint.js";
import { readPermission, type PermissionMode } from "../permission/index.js";
import {
  inspectNamedTunnelCredentials,
  type NamedTunnelCredentialStatus,
} from "../tunnel/named-provision.js";
import { isNamedTunnelReady, readTunnelState, type TunnelPreference } from "../tunnel/state.js";

export interface RecoveryAdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string; detail?: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
  permissionMode: PermissionMode;
}

export type RecoveryReason =
  | "bridgeStopped"
  | "bridgeUncertain"
  | "bridgeRecoveryFailed"
  | "tunnelPreferenceUnset"
  | "namedConfigurationMissing"
  | "needsCloudflareLogin"
  | "credentialsMissing"
  | "namedCredentialsInvalid"
  | "namedRuntimeMismatch"
  | "namedRecoveryFailed"
  | "cloudflaredMissing"
  | "hostnameUnavailable"
  | "quickTunnelStopped"
  | "quickTunnelFailed"
  | "quickRuntimeMismatch"
  | "connectorEndpointMissing"
  | "connectorEndpointChanged";

export interface RuntimeDiagnostics {
  workspace: { path: string; id: string };
  bridge: {
    status: "running" | "stopped" | "uncertain";
    pid: number | null;
    port: number | null;
    reason?: string;
  };
  permission: PermissionMode;
  tunnelPreference: TunnelPreference;
  tunnel: {
    status: "running" | "stopped" | "broken" | "unknown";
    provider: string | null;
    detail?: string;
    namedCredentialStatus?: NamedTunnelCredentialStatus;
  };
  configuredHostname: string | null;
  currentPublicUrl: string | null;
  connectorEndpoint: string | null;
  connectorEndpointSource: "local_saved_endpoint" | null;
  connectorEndpointMatchesCurrent: boolean | null;
  connectorEndpointHealthy: boolean | null;
  endpointStable: boolean;
  restartSafeConnector: boolean;
  oauth: { tokenCount: number };
  recovery: { status: "healthy" | "actionNeeded"; reason: RecoveryReason | null };
}

export interface RestoreResult {
  ok: boolean;
  bridgeAction: "reused" | "started" | "unknown";
  tunnelAction: "reused" | "started" | "restarted" | "notConfigured" | "failed";
  diagnostics: RuntimeDiagnostics;
  reason: RecoveryReason | null;
  detail?: string;
}

export interface RecoveryOptions {
  ensureBridgeImpl?: (workspaceRoot: string) => Promise<EnsureBridgeResult>;
  adminFetchImpl?: <T = unknown>(runtime: RuntimeState, method: "GET" | "POST", route: string, timeoutMs?: number) => Promise<T>;
  fetchImpl?: typeof fetch;
  logger?: LoggerType;
}

type Observation = BridgeObservation;

function namedCredentialReason(status: NamedTunnelCredentialStatus): RecoveryReason {
  if (status === "missing_account_certificate") return "needsCloudflareLogin";
  if (status === "missing_credentials") return "credentialsMissing";
  if (status === "missing_tunnel_id") return "namedConfigurationMissing";
  return "namedCredentialsInvalid";
}

async function publicHealth(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => null)) as { service?: unknown; status?: unknown } | null;
    return payload?.service === "c2c-bridge" && payload.status === "ok";
  } catch {
    return false;
  }
}

export async function collectRuntimeDiagnostics(
  workspaceRoot: string,
  opts: {
    observation?: Observation;
    info?: RecoveryAdminInfo | null;
    fetchImpl?: typeof fetch;
    adminFetchImpl?: RecoveryOptions["adminFetchImpl"];
  } = {}
): Promise<RuntimeDiagnostics> {
  const workspace = new Workspace(workspaceRoot);
  const observation = opts.observation ?? (await findBridgeObservation(workspace.id));
  const tunnelState = readTunnelState(workspace.id);
  const lastEndpoint = readLastEndpoint(workspace.id);
  const preference = tunnelState.preference;
  const namedReady = isNamedTunnelReady(tunnelState);
  const credential = preference === "named" ? inspectNamedTunnelCredentials(tunnelState.tunnelId) : null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let info = opts.info ?? null;
  let bridgeStatus: RuntimeDiagnostics["bridge"]["status"];
  let bridgeReason: string | undefined;

  if (observation.state === "healthy") {
    bridgeStatus = "running";
    if (!info) {
      try {
        info = await (opts.adminFetchImpl ?? adminFetch)<RecoveryAdminInfo>(observation.runtime, "GET", "/admin/info");
      } catch (error) {
        bridgeStatus = "uncertain";
        bridgeReason = `admin_probe_failed:${(error as Error).message}`;
      }
    }
  } else if (observation.state === "stopped") {
    bridgeStatus = "stopped";
    bridgeReason = observation.reason;
  } else {
    bridgeStatus = "uncertain";
    bridgeReason = observation.reason;
  }

  const activeUrl = info?.tunnel.running ? info.publicUrl ?? info.tunnel.url : null;
  const endpointHealthy = activeUrl ? await publicHealth(activeUrl, fetchImpl) : false;
  const connectorEndpoint = lastEndpoint?.mcpUrl ?? null;
  const currentMcp = mcpUrlFromPublic(activeUrl);
  const endpointMatches = connectorEndpoint && currentMcp
    ? normalizePublicUrl(connectorEndpoint) === normalizePublicUrl(currentMcp)
    : null;
  const connectorHealthy =
    connectorEndpoint && endpointMatches !== null ? Boolean(endpointMatches && endpointHealthy) : null;
  const endpointStable = preference === "named" && namedReady;
  const tunnelStatus: RuntimeDiagnostics["tunnel"]["status"] =
    bridgeStatus === "uncertain"
      ? "unknown"
      : !info?.tunnel.running
        ? "stopped"
        : endpointHealthy
          ? "running"
          : "broken";

  let reason: RecoveryReason | null = null;
  if (bridgeStatus === "uncertain") reason = "bridgeUncertain";
  else if (bridgeStatus === "stopped") reason = "bridgeStopped";
  else if (preference === "named" && !namedReady) reason = "namedConfigurationMissing";
  else if (credential && credential.status !== "ready") reason = namedCredentialReason(credential.status);
  else if (preference === "named" && info?.tunnel.provider !== "cloudflare-named") reason = "namedRecoveryFailed";
  else if (preference === "named" && !endpointHealthy) reason = activeUrl ? "hostnameUnavailable" : "namedRecoveryFailed";
  else if (preference === "quick" && info?.tunnel.provider !== "cloudflare-quick") reason = "quickRuntimeMismatch";
  else if (preference === "quick" && !endpointHealthy) reason = activeUrl ? "quickTunnelFailed" : "quickTunnelStopped";
  else if (preference === "unset" && lastEndpoint?.mcpUrl) reason = "tunnelPreferenceUnset";
  else if ((preference === "named" || preference === "quick") && !connectorEndpoint) reason = "connectorEndpointMissing";
  else if ((preference === "named" || preference === "quick") && endpointMatches === false) reason = "connectorEndpointChanged";

  const runtime = observation.state === "healthy" ? observation.runtime : observation.runtime;
  return {
    workspace: { path: workspace.root, id: workspace.id },
    bridge: {
      status: bridgeStatus,
      pid: info?.pid ?? runtime?.pid ?? null,
      port: info?.port ?? runtime?.port ?? null,
      ...(bridgeReason ? { reason: bridgeReason } : {}),
    },
    permission: info?.permissionMode ?? readPermission(workspace.id),
    tunnelPreference: preference,
    tunnel: {
      status: tunnelStatus,
      provider: info?.tunnel.provider ?? null,
      ...(info?.tunnel.detail ? { detail: info.tunnel.detail } : {}),
      ...(credential ? { namedCredentialStatus: credential.status } : {}),
    },
    configuredHostname: tunnelState.hostname ?? null,
    currentPublicUrl: activeUrl,
    connectorEndpoint,
    connectorEndpointSource: connectorEndpoint ? "local_saved_endpoint" : null,
    connectorEndpointMatchesCurrent: endpointMatches,
    connectorEndpointHealthy: connectorHealthy,
    endpointStable,
    restartSafeConnector: endpointStable,
    oauth: { tokenCount: info?.tokenCount ?? new AuthStore(workspace.id).tokenCount() },
    recovery: { status: reason ? "actionNeeded" : "healthy", reason },
  };
}

export async function restoreWorkspace(
  workspaceRoot: string,
  opts: RecoveryOptions = {}
): Promise<RestoreResult> {
  const workspace = new Workspace(workspaceRoot);
  const logger = opts.logger ?? new Logger({ name: "restore" });
  const ensureBridgeImpl = opts.ensureBridgeImpl ?? ensureBridge;
  const adminFetchImpl = opts.adminFetchImpl ?? adminFetch;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tunnelState = readTunnelState(workspace.id);
  const lastEndpoint = readLastEndpoint(workspace.id);
  const preference = tunnelState.preference;

  logger.info(`Restore started workspace=${workspace.root} id=${workspace.id}`);
  logger.info(`Tunnel preference: ${preference}`);

  let bridgeAction: RestoreResult["bridgeAction"] = "unknown";
  let tunnelAction: RestoreResult["tunnelAction"] = preference === "unset" ? "notConfigured" : "failed";
  let reason: RecoveryReason | null = null;
  let detail: string | undefined;
  let runtime: RuntimeState | null = null;
  let info: RecoveryAdminInfo | null = null;

  try {
    const ensured = await ensureBridgeImpl(workspace.root);
    runtime = ensured.runtime;
    bridgeAction = ensured.spawned ? "started" : "reused";
    logger.info(`Bridge ${bridgeAction} workspace=${workspace.id} pid=${runtime.pid} port=${runtime.port}`);
    info = await adminFetchImpl<RecoveryAdminInfo>(runtime, "GET", "/admin/info");
  } catch (error) {
    detail = (error as Error).message;
    const observation = await findBridgeObservation(workspace.id);
    reason = observation.state === "unknown" ? "bridgeUncertain" : "bridgeRecoveryFailed";
    logger.error(`Bridge recovery failed workspace=${workspace.id} reason=${reason}`);
  }

  if (info && runtime && preference !== "unset") {
    const expectedProvider = preference === "named" ? "cloudflare-named" : "cloudflare-quick";
    if (preference === "named") {
      if (!isNamedTunnelReady(tunnelState)) {
        reason = "namedConfigurationMissing";
        detail = "Named Tunnel preference is missing its tunnel name or hostname.";
      } else {
        const credentials = inspectNamedTunnelCredentials(tunnelState.tunnelId);
        if (credentials.status !== "ready") {
          reason = namedCredentialReason(credentials.status);
          detail = `Named Tunnel credentials: ${credentials.status}`;
        }
      }
    }

    if (!reason && info.tunnel.provider !== expectedProvider) {
      reason = preference === "named" ? "namedRuntimeMismatch" : "quickRuntimeMismatch";
      detail = `Bridge tunnel provider is ${info.tunnel.provider}; saved preference is ${preference}.`;
    }

    if (!reason) {
      let url = info.tunnel.running ? info.publicUrl ?? info.tunnel.url : null;
      let healthy = url ? await publicHealth(url, fetchImpl) : false;
      if (!healthy) {
        try {
          const route = info.tunnel.running ? "/admin/tunnel/restart" : "/admin/tunnel/start";
          const started = await adminFetchImpl<{ url?: string; message?: string }>(runtime, "POST", route, 90_000);
          if (!started.url) throw new Error(started.message ?? "Tunnel restore did not return a public URL");
          tunnelAction = route.endsWith("restart") ? "restarted" : "started";
          url = started.url;
          info = await adminFetchImpl<RecoveryAdminInfo>(runtime, "GET", "/admin/info");
          healthy = await publicHealth(url, fetchImpl);
        } catch (error) {
          detail = (error as Error).message;
          reason = /NEED_CLOUDFLARED|cloudflared is not installed|spawn ENOENT/i.test(detail)
            ? "cloudflaredMissing"
            : preference === "named"
              ? "namedRecoveryFailed"
              : "quickTunnelFailed";
        }
      } else {
        tunnelAction = "reused";
      }

      if (!reason && !healthy) {
        reason = preference === "named" ? "hostnameUnavailable" : "quickTunnelFailed";
        detail = preference === "named"
          ? `Named hostname did not pass the public health check: ${tunnelState.hostname}`
          : "Quick Tunnel did not pass the public health check.";
      }

      if (!reason && url) {
        const mcpUrl = mcpUrlFromPublic(url);
        if (!lastEndpoint?.mcpUrl) {
          reason = "connectorEndpointMissing";
          detail = "No saved ChatGPT connector endpoint exists for this workspace.";
        } else if (normalizePublicUrl(lastEndpoint.mcpUrl) !== normalizePublicUrl(mcpUrl ?? "")) {
          reason = "connectorEndpointChanged";
          detail = `The active endpoint changed. ChatGPT still needs the saved connector endpoint ${lastEndpoint.mcpUrl}.`;
        }
      }
    }

    if (!reason) {
      logger.info(`Tunnel ${tunnelAction} mode=${preference} host=${tunnelState.hostname ?? "quick"}`);
    } else {
      tunnelAction = "failed";
      logger.error(`Tunnel restore failed mode=${preference} reason=${reason}`);
    }
  } else if (info && preference === "unset") {
    const priorPublicEndpoint = Boolean(lastEndpoint?.mcpUrl);
    if (priorPublicEndpoint) {
      reason = "tunnelPreferenceUnset";
      detail = "A saved connector endpoint exists, but this workspace has no tunnel preference.";
    }
    logger.info(`Tunnel restore skipped mode=unset workspace=${workspace.id}`);
  }

  let diagnostics: RuntimeDiagnostics;
  try {
    const observation = runtime ? await findBridgeObservation(workspace.id) : undefined;
    diagnostics = await collectRuntimeDiagnostics(workspace.root, {
      observation,
      info,
      fetchImpl,
      adminFetchImpl,
    });
  } catch (error) {
    detail ??= (error as Error).message;
    reason ??= "bridgeRecoveryFailed";
    diagnostics = await collectRuntimeDiagnostics(workspace.root, { fetchImpl });
  }

  if (reason) diagnostics.recovery = { status: "actionNeeded", reason };
  const ok = reason === null;
  logger.info(`Restore ${ok ? "healthy" : "action needed"} workspace=${workspace.id}${reason ? ` reason=${reason}` : ""}`);
  return { ok, bridgeAction, tunnelAction, diagnostics, reason, ...(detail ? { detail } : {}) };
}
