import type { Logger } from "../logger/index.js";

export type BridgeShutdownSource =
  | "cli_stop"
  | "cli_restart"
  | "doctor_repair"
  | "tunnel_transition"
  | "tunnel_configuration"
  | "admin_shutdown"
  | "sigint"
  | "sigterm";

export type AdminShutdownSource = Exclude<BridgeShutdownSource, "sigint" | "sigterm">;
export type ShutdownLifecycleEvent = "shutdown_requested" | "shutdown_begin" | "shutdown_complete" | "shutdown_failed";

const ADMIN_SHUTDOWN_SOURCES = new Set<AdminShutdownSource>([
  "cli_stop",
  "cli_restart",
  "doctor_repair",
  "tunnel_transition",
  "tunnel_configuration",
  "admin_shutdown",
]);

/** Accept only a small, fixed source value from the authenticated local admin route. */
export function resolveAdminShutdownSource(body: unknown): AdminShutdownSource {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "admin_shutdown";
  const source = (body as Record<string, unknown>).source;
  return typeof source === "string" && ADMIN_SHUTDOWN_SOURCES.has(source as AdminShutdownSource)
    ? source as AdminShutdownSource
    : "admin_shutdown";
}

export function recordShutdownLifecycle(
  logger: Pick<Logger, "info">,
  event: ShutdownLifecycleEvent,
  source: BridgeShutdownSource,
): void {
  try {
    logger.info(event, { source });
  } catch {
    // Lifecycle observation must never prevent shutdown.
  }
}

function safeErrorName(error: unknown): string {
  try {
    if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(error.name)) return error.name;
  } catch {
    // A hostile error property must not interfere with Node's default exit behavior.
  }
  return "UNKNOWN";
}

/** Observe process termination without installing an uncaughtException handler. */
export function observeBridgeProcessLifecycle(
  logger: Pick<Logger, "error" | "info">,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  const onFatal = (error: Error, origin: "uncaughtException" | "unhandledRejection"): void => {
    const safeOrigin = origin === "uncaughtException" || origin === "unhandledRejection" ? origin : "UNKNOWN";
    try {
      logger.error("uncaught_exception_observed", { origin: safeOrigin, errorName: safeErrorName(error) });
    } catch {
      // This observer is intentionally passive; Node retains its default behavior.
    }
  };
  const onExit = (code: number): void => {
    const safeCode = Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
    try {
      logger.info("process_exit_observed", { code: safeCode });
    } catch {
      // Exit observation is best effort and must not change process termination.
    }
  };

  target.on("uncaughtExceptionMonitor", onFatal);
  target.on("exit", onExit);
  return () => {
    target.off("uncaughtExceptionMonitor", onFatal);
    target.off("exit", onExit);
  };
}
