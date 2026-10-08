import path from "node:path";
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
  tunnel: {
    running: boolean;
    url: string | null;
    provider: string;
    detail?: string;
    processRunning?: boolean;
    connected?: boolean;
  };
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
  | "namedStateUnverified"
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
  publicProbe: {
    publicProbeStatus: "healthy" | "degraded" | "notChecked";
    publicProbeError?:
      | "invalid_url"
      | "timeout"
      | "unavailable"
      | "http_error"
      | "invalid_health_payload"
      | "ECONNRESET"
      | "ENOTFOUND"
      | "ECONNREFUSED"
      | "ETIMEDOUT"
      | "EAI_AGAIN"
      | "EHOSTUNREACH"
      | "ENETUNREACH";
    checkedAt: string | null;
  };
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
  return (await probePublicHealth(url, fetchImpl)).publicProbeStatus === "healthy";
}

type PublicProbeDiagnostics = RuntimeDiagnostics["publicProbe"];

function notCheckedPublicProbe(): PublicProbeDiagnostics {
  return { publicProbeStatus: "notChecked", checkedAt: null };
}

async function probePublicHealth(url: string, fetchImpl: typeof fetch): Promise<PublicProbeDiagnostics> {
  const checkedAt = new Date().toISOString();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { publicProbeStatus: "degraded", publicProbeError: "invalid_url", checkedAt };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { publicProbeStatus: "degraded", publicProbeError: "invalid_url", checkedAt };
  }
  try {
    const response = await fetchImpl(`${url.replace(/\/+$/, "")}/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { publicProbeStatus: "degraded", publicProbeError: "http_error", checkedAt };
    const payload = (await response.json().catch(() => null)) as { service?: unknown; status?: unknown } | null;
    if (payload?.service !== "c2c-bridge" || payload.status !== "ok") {
      return { publicProbeStatus: "degraded", publicProbeError: "invalid_health_payload", checkedAt };
    }
    return { publicProbeStatus: "healthy", checkedAt };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const outerCode = error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
    const cause = error instanceof Error ? error.cause : undefined;
    const causeCode = cause && typeof cause === "object" ? (cause as NodeJS.ErrnoException).code : undefined;
    const code = causeCode ?? outerCode;
    const safeCodes = new Set([
      "ECONNRESET",
      "ENOTFOUND",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ]);
    return {
      publicProbeStatus: "degraded",
      publicProbeError: safeCodes.has(code ?? "")
        ? code as NonNullable<PublicProbeDiagnostics["publicProbeError"]>
        : name === "AbortError" || name === "TimeoutError" ? "timeout" : "unavailable",
      checkedAt,
    };
  }
}

function namedTunnelUrl(url: string | null | undefined, hostname: string | null | undefined): string | null {
  if (!url || !hostname) return null;
  try {
    const parsed = new URL(url);
    const authority = url.match(/^https:\/\/([^/?#]+)/i)?.[1];
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !authority ||
      authority.toLowerCase() !== parsed.hostname.toLowerCase() ||
      parsed.hostname.toLowerCase() !== hostname.toLowerCase() ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      /[?#]/.test(url)
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function namedInfoUrl(info: RecoveryAdminInfo, hostname: string | null | undefined): string | null {
  const publicUrl = namedTunnelUrl(info.publicUrl, hostname);
  const tunnelUrl = namedTunnelUrl(info.tunnel.url, hostname);
  if (info.publicUrl && !publicUrl) return null;
  if (info.tunnel.url && !tunnelUrl) return null;
  if (publicUrl && tunnelUrl && publicUrl !== tunnelUrl) return null;
  return publicUrl ?? tunnelUrl;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function infoMatchesRuntime(info: RecoveryAdminInfo, workspace: Workspace, runtime: RuntimeState): boolean {
  return info.workspaceId === workspace.id &&
    samePath(info.workspaceRoot, workspace.root) &&
    info.pid === runtime.pid &&
    info.port === runtime.port &&
    info.startedAt === runtime.startedAt;
}

function runtimeMatchesObservation(runtime: RuntimeState, observation: BridgeObservation, workspace: Workspace): boolean {
  return observation.state === "healthy" &&
    observation.runtime.workspaceId === workspace.id &&
    samePath(observation.runtime.workspaceRoot, workspace.root) &&
    observation.runtime.pid === runtime.pid &&
    observation.runtime.port === runtime.port &&
    observation.runtime.startedAt === runtime.startedAt &&
    observation.runtime.adminToken === runtime.adminToken;
}

function namedInfoConnected(info: RecoveryAdminInfo): boolean {
  if (!info.tunnel.running || info.tunnel.connected === false || info.tunnel.processRunning === false) return false;
  return true;
}

function namedInfoStartable(info: RecoveryAdminInfo): boolean {
  return info.tunnel.processRunning === false && info.tunnel.connected === false;
}

/** Only fixed provider diagnostics may leave the Named Tunnel boundary. */
function namedStartupDiagnostic(detail: unknown): string | undefined {
  if (typeof detail !== "string" || detail.length > 200) return undefined;
  const match = /^Named tunnel startup (?:retrying|exhausted|failed|cancelled): attempts=[0-6]; category=(?:dns_unavailable|network_unavailable|permanent|unknown|timeout|stopped|binary_missing|termination_unconfirmed); elapsedMs=\d{1,9}(?:; delayMs=\d{1,9})?$/.exec(detail);
  return match?.[0] === detail ? detail : undefined;
}

function namedTunnelDiagnosticStatus(
  info: RecoveryAdminInfo | null,
  url: string | null
): RuntimeDiagnostics["tunnel"]["status"] {
  if (!info) return "unknown";
  if (info.tunnel.provider !== "cloudflare-named") return "broken";
  if (info.tunnel.running && namedInfoConnected(info) && url) return "running";
  if (!info.tunnel.running && namedInfoStartable(info)) return "stopped";
  if (
    !info.tunnel.running &&
    (info.tunnel.processRunning === undefined || info.tunnel.connected === undefined)
  ) return "unknown";
  return "broken";
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
        bridgeReason = preference === "named" ? "admin_probe_failed" : `admin_probe_failed:${(error as Error).message}`;
      }
    }
  } else if (observation.state === "stopped") {
    bridgeStatus = "stopped";
    bridgeReason = observation.reason;
  } else {
    bridgeStatus = "uncertain";
    bridgeReason = observation.reason;
  }

  if (
    preference === "named" &&
    bridgeStatus === "running" &&
    info &&
    observation.state === "healthy" &&
    !infoMatchesRuntime(info, workspace, observation.runtime)
  ) {
    bridgeStatus = "uncertain";
    bridgeReason = "admin_identity_mismatch";
    info = null;
  }

  const namedUrl = preference === "named" &&
      bridgeStatus === "running" &&
      info?.tunnel.provider === "cloudflare-named" &&
      namedInfoConnected(info)
    ? namedInfoUrl(info, tunnelState.hostname)
    : null;
  const activeUrl = preference === "named"
    ? namedUrl
    : info?.tunnel.running ? info.publicUrl ?? info.tunnel.url : null;
  const publicProbe = activeUrl ? await probePublicHealth(activeUrl, fetchImpl) : notCheckedPublicProbe();
  const endpointHealthy = publicProbe.publicProbeStatus === "healthy";
  const connectorEndpoint = lastEndpoint?.mcpUrl ?? null;
  const currentMcp = mcpUrlFromPublic(activeUrl);
  const endpointMatches = connectorEndpoint && currentMcp
    ? normalizePublicUrl(connectorEndpoint) === normalizePublicUrl(currentMcp)
    : null;
  const connectorHealthy =
    connectorEndpoint && endpointMatches !== null ? Boolean(endpointMatches && endpointHealthy) : null;
  const endpointStable = preference === "named" && namedReady;
  const namedConnected = Boolean(namedUrl);
  const tunnelStatus: RuntimeDiagnostics["tunnel"]["status"] = bridgeStatus === "uncertain"
    ? "unknown"
    : preference === "named"
      ? namedTunnelDiagnosticStatus(info, namedUrl)
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
  else if (preference === "named" && info && !info.tunnel.running && !namedInfoStartable(info)) reason = "namedStateUnverified";
  else if (preference === "named" && info && info.tunnel.running && !namedConnected) reason = "namedRuntimeMismatch";
  else if (preference === "named" && info && !info.tunnel.running) reason = "namedRecoveryFailed";
  else if (preference === "named" && !namedUrl) reason = "namedRuntimeMismatch";
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
    publicProbe,
    tunnel: {
      status: tunnelStatus,
      provider: info?.tunnel.provider ?? null,
      ...(preference !== "named" && info?.tunnel.detail ? { detail: info.tunnel.detail } : {}),
      ...(preference === "named" && namedStartupDiagnostic(info?.tunnel.detail)
        ? { detail: namedStartupDiagnostic(info?.tunnel.detail) } : {}),
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
  let namedStartAttempted = false;
  let namedStartInfoRead = false;

  try {
    const ensured = await ensureBridgeImpl(workspace.root);
    runtime = ensured.runtime;
    bridgeAction = ensured.spawned ? "started" : "reused";
    logger.info(`Bridge ${bridgeAction} workspace=${workspace.id} pid=${runtime.pid} port=${runtime.port}`);
    info = await adminFetchImpl<RecoveryAdminInfo>(runtime, "GET", "/admin/info");
  } catch (error) {
    detail = preference === "named" ? "Bridge runtime or admin identity could not be verified." : (error as Error).message;
    const observation = await findBridgeObservation(workspace.id);
    reason = observation.state === "unknown" ? "bridgeUncertain" : "bridgeRecoveryFailed";
    logger.error(`Bridge recovery failed workspace=${workspace.id} reason=${reason}`);
  }

  if (preference === "named" && info && runtime && !reason) {
    try {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") {
        reason = observation.state === "unknown" ? "bridgeUncertain" : "bridgeRecoveryFailed";
        detail = "Bridge runtime health could not be confirmed before Named Tunnel recovery.";
      } else if (
        !runtimeMatchesObservation(runtime, observation, workspace) ||
        !infoMatchesRuntime(info, workspace, observation.runtime)
      ) {
        reason = "namedRuntimeMismatch";
        detail = "Bridge runtime and admin identity do not match.";
      }
    } catch {
      reason = "bridgeUncertain";
      detail = "Bridge runtime health could not be confirmed before Named Tunnel recovery.";
    }
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
      detail = preference === "named"
        ? "Bridge tunnel provider does not match the saved Named preference."
        : `Bridge tunnel provider is ${info.tunnel.provider}; saved preference is ${preference}.`;
    }

    if (!reason && preference === "named") {
      let url: string | null = null;
      let startUrl: string | null = null;
      if (info.tunnel.running) {
        if (!namedInfoConnected(info)) {
          reason = "namedRuntimeMismatch";
          detail = "Named Tunnel connection state is inconsistent.";
        } else {
          url = namedInfoUrl(info, tunnelState.hostname);
          if (!url) {
            reason = "namedRuntimeMismatch";
            detail = "Named Tunnel public URL does not match the configured hostname.";
          } else {
            tunnelAction = "reused";
          }
        }
      } else if (info.tunnel.processRunning === true) {
        reason = "namedRecoveryFailed";
        detail = "Named Tunnel process is present but has not connected.";
      } else if (!namedInfoStartable(info)) {
        reason = "namedStateUnverified";
        detail = "Named Tunnel stopped state cannot be verified safely.";
      } else {
        try {
          namedStartAttempted = true;
          const started = await adminFetchImpl<{ url?: string; message?: string }>(runtime, "POST", "/admin/tunnel/start", 90_000);
          startUrl = namedTunnelUrl(started.url, tunnelState.hostname);
          if (!startUrl) throw new Error("invalid_start_url");
          tunnelAction = "started";
          info = await adminFetchImpl<RecoveryAdminInfo>(runtime, "GET", "/admin/info");
          namedStartInfoRead = true;
          if (info.tunnel.provider !== "cloudflare-named") {
            reason = "namedRuntimeMismatch";
            detail = "Bridge tunnel provider changed during Named Tunnel start.";
          } else if (!namedInfoConnected(info)) {
            reason = "namedRecoveryFailed";
            detail = "Named Tunnel start returned before a connection was confirmed.";
          } else {
            url = namedInfoUrl(info, tunnelState.hostname);
            if (!url || url !== startUrl) {
              reason = "namedRuntimeMismatch";
              detail = "Named Tunnel start URL does not match the confirmed admin URL.";
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const startupDiagnostic = namedStartupDiagnostic(message);
          reason = /NEED_CLOUDFLARED|cloudflared is not installed|spawn ENOENT/i.test(message) ||
            startupDiagnostic?.includes("; category=binary_missing;")
            ? "cloudflaredMissing"
            : "namedRecoveryFailed";
          detail = reason === "cloudflaredMissing"
            ? "cloudflared is not installed or unavailable."
            : "Named Tunnel could not be started and confirmed.";
        }
      }

      if (!reason && url) {
        const mcpUrl = mcpUrlFromPublic(url);
        if (!lastEndpoint?.mcpUrl) {
          reason = "connectorEndpointMissing";
          detail = "No saved ChatGPT connector endpoint exists for this workspace.";
        } else if (normalizePublicUrl(lastEndpoint.mcpUrl) !== normalizePublicUrl(mcpUrl ?? "")) {
          reason = "connectorEndpointChanged";
          detail = "The saved connector endpoint does not match the configured Named hostname.";
        }
      }
    }

    if (!reason && preference === "quick") {
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
            : "quickTunnelFailed";
        }
      } else {
        tunnelAction = "reused";
      }

      if (!reason && !healthy) {
        reason = "quickTunnelFailed";
        detail = "Quick Tunnel did not pass the public health check.";
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

    if (preference === "named" && namedStartAttempted && !namedStartInfoRead && runtime) {
      try {
        info = await adminFetchImpl<RecoveryAdminInfo>(runtime, "GET", "/admin/info");
      } catch {
        info = null;
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
    detail ??= preference === "named" ? "Bridge diagnostics could not be confirmed." : (error as Error).message;
    reason ??= "bridgeRecoveryFailed";
    diagnostics = await collectRuntimeDiagnostics(workspace.root, { fetchImpl });
  }

  if (preference === "named" && !reason && diagnostics.recovery.reason) {
    reason = diagnostics.recovery.reason;
    detail = "Named Tunnel runtime checks did not match the saved configuration.";
  }

  if (preference === "named" && !reason && runtime && info) {
    try {
      const observation = await findBridgeObservation(workspace.id);
      if (observation.state !== "healthy") {
        reason = observation.state === "unknown" ? "bridgeUncertain" : "bridgeRecoveryFailed";
        detail = "Bridge runtime health could not be confirmed after the Named Tunnel probe.";
        diagnostics.bridge.status = observation.state === "unknown" ? "uncertain" : "stopped";
        diagnostics.bridge.reason = "final_runtime_observation_failed";
        diagnostics.tunnel.status = "unknown";
      } else if (!runtimeMatchesObservation(runtime, observation, workspace)) {
        reason = "namedRuntimeMismatch";
        detail = "Bridge runtime identity changed during Named Tunnel recovery.";
        diagnostics.bridge.status = "uncertain";
        diagnostics.bridge.reason = "runtime_identity_mismatch";
        diagnostics.tunnel.status = "unknown";
      } else {
        const finalInfo = await adminFetchImpl<RecoveryAdminInfo>(observation.runtime, "GET", "/admin/info");
        if (!infoMatchesRuntime(finalInfo, workspace, observation.runtime)) {
          reason = "namedRuntimeMismatch";
          detail = "Bridge runtime and final admin identity do not match.";
          diagnostics.bridge.status = "uncertain";
          diagnostics.bridge.reason = "admin_identity_mismatch";
          diagnostics.tunnel.status = "unknown";
        } else if (finalInfo.tunnel.provider !== "cloudflare-named") {
          reason = "namedRuntimeMismatch";
          detail = "Named Tunnel provider changed during recovery.";
          diagnostics.tunnel.status = "broken";
        } else if (!namedInfoConnected(finalInfo)) {
          reason = "namedRecoveryFailed";
          detail = "Named Tunnel connection was not confirmed after its public probe.";
          diagnostics.tunnel.status = "broken";
        } else {
          const previousUrl = namedInfoUrl(info, tunnelState.hostname);
          const finalUrl = namedInfoUrl(finalInfo, tunnelState.hostname);
          if (!previousUrl || !finalUrl || previousUrl !== finalUrl) {
            reason = "namedRuntimeMismatch";
            detail = "Named Tunnel URL changed or no longer matches its configured hostname.";
            diagnostics.tunnel.status = "broken";
          }
        }
      }
    } catch {
      reason = "bridgeUncertain";
      detail = "Bridge runtime and admin identity could not be reconfirmed after the Named Tunnel probe.";
      diagnostics.bridge.status = "uncertain";
      diagnostics.bridge.reason = "final_admin_probe_failed";
      diagnostics.tunnel.status = "unknown";
    }
  }

  if (preference === "named" && reason) tunnelAction = "failed";

  if (preference === "named" && reason === "namedRecoveryFailed") {
    const startupDiagnostic = namedStartupDiagnostic(diagnostics.tunnel.detail);
    if (startupDiagnostic) detail = `${detail ?? "Named Tunnel startup failed."} ${startupDiagnostic}`;
  }

  if (reason) diagnostics.recovery = { status: "actionNeeded", reason };
  const ok = reason === null;
  logger.info(`Restore ${ok ? "healthy" : "action needed"} workspace=${workspace.id}${reason ? ` reason=${reason}` : ""}`);
  return { ok, bridgeAction, tunnelAction, diagnostics, reason, ...(detail ? { detail } : {}) };
}
