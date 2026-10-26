import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import {
  observeBridgeProcessLifecycle,
  resolveAdminShutdownSource,
} from "../src/diagnostics/bridge-lifecycle.js";
import { Logger } from "../src/logger/index.js";
import { stopBridge } from "../src/process/daemon.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
  vi.restoreAllMocks();
});

function testTunnel() {
  return {
    name: "isolated-lifecycle-test",
    start: async () => "",
    restart: async () => "",
    stop: async () => undefined,
    status: () => ({ running: false, url: null, provider: "isolated-lifecycle-test" }),
    getPublicUrl: () => null,
    doctor: async () => ({
      provider: "isolated-lifecycle-test",
      binaryFound: false,
      binaryPath: null,
      running: false,
      url: null,
      problems: [],
    }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}

describe("Bridge lifecycle attribution", () => {
  it("accepts only bounded admin source values and never accepts signal claims", () => {
    expect(resolveAdminShutdownSource({ source: "cli_stop" })).toBe("cli_stop");
    expect(resolveAdminShutdownSource({ source: "cli_restart" })).toBe("cli_restart");
    expect(resolveAdminShutdownSource({ source: "doctor_repair" })).toBe("doctor_repair");
    expect(resolveAdminShutdownSource({ source: "tunnel_configuration" })).toBe("tunnel_configuration");
    expect(resolveAdminShutdownSource({ source: "sigint" })).toBe("admin_shutdown");
    expect(resolveAdminShutdownSource({ source: "x".repeat(100_000) })).toBe("admin_shutdown");
    expect(resolveAdminShutdownSource(null)).toBe("admin_shutdown");
  });

  it("observes fatal and exit events without installing an uncaughtException handler", () => {
    const target = new EventEmitter();
    const error = vi.fn();
    const info = vi.fn();
    const logger = { error, info } as unknown as Logger;
    const stopObserving = observeBridgeProcessLifecycle(logger, target as unknown as NodeJS.Process);
    const fatal = Object.assign(new Error("secret payload"), { name: "TypeError" });

    target.emit("uncaughtExceptionMonitor", fatal, "uncaughtException");
    target.emit("exit", 9);

    expect(error).toHaveBeenCalledWith("uncaught_exception_observed", {
      origin: "uncaughtException",
      errorName: "TypeError",
    });
    expect(info).toHaveBeenCalledWith("process_exit_observed", { code: 9 });
    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(JSON.stringify([error.mock.calls, info.mock.calls])).not.toContain("secret payload");

    stopObserving();
    expect(target.listenerCount("uncaughtExceptionMonitor")).toBe(0);
    expect(target.listenerCount("exit")).toBe(0);
  });

  it("records an authenticated shutdown source once in lifecycle order", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-lifecycle-admin");
    dirs.push(root);
    write(root, "readme.txt", "lifecycle fixture\n");
    const logger = new Logger({ file: null });
    const events: Array<{ event: string; metadata?: unknown }> = [];
    vi.spyOn(logger, "info").mockImplementation((event, metadata) => {
      if (event.startsWith("shutdown_")) events.push({ event, metadata });
    });
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      logger,
      tunnelProvider: testTunnel(),
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      const health = await fetch(`${bridge.localBaseUrl()}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok" });

      const unauthorized = await fetch(`${bridge.localBaseUrl()}/admin/shutdown`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ source: "cli_stop", detail: "secret payload" }),
      });
      expect(unauthorized.status).toBe(404);
      expect(events).toEqual([]);

      expect(await stopBridge(root, "cli_stop")).toBe(true);
      await waitFor(() => events.some(({ event }) => event === "shutdown_complete"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.map(({ event }) => event)).toEqual([
        "shutdown_requested",
        "shutdown_begin",
        "shutdown_complete",
      ]);
      expect(events.map(({ metadata }) => metadata)).toEqual([
        { source: "cli_stop" },
        { source: "cli_stop" },
        { source: "cli_stop" },
      ]);
      expect(JSON.stringify(events)).not.toContain(bridge.adminToken);
      expect(JSON.stringify(events)).not.toContain("secret payload");
      expect(exit).toHaveBeenCalledWith(0);

      await bridge.close("sigterm");
      expect(events).toHaveLength(3);
    } finally {
      exit.mockRestore();
      await bridge.close().catch(() => undefined);
    }
  });

  it("keeps SIGINT and SIGTERM shutdown sources distinct", async () => {
    dirs.push(isolateStateDir());
    const seenSources: string[] = [];

    for (const source of ["sigint", "sigterm"] as const) {
      const root = makeTmpDir(`bridge-lifecycle-${source}`);
      dirs.push(root);
      write(root, "readme.txt", "lifecycle fixture\n");
      const logger = new Logger({ file: null });
      vi.spyOn(logger, "info").mockImplementation((event, metadata) => {
        if (event === "shutdown_requested") {
          seenSources.push((metadata as { source: string }).source);
        }
      });
      const bridge = await startBridge({
        workspaceRoot: root,
        port: 0,
        persistRuntime: false,
        logger,
        tunnelProvider: testTunnel(),
      });
      await bridge.close(source);
    }

    expect(seenSources).toEqual(["sigint", "sigterm"]);
  });

  it("continues shutdown when lifecycle logging fails", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("bridge-lifecycle-log-failure");
    dirs.push(root);
    write(root, "readme.txt", "lifecycle fixture\n");
    const logger = new Logger({ file: null });
    const originalInfo = logger.info.bind(logger);
    vi.spyOn(logger, "info").mockImplementation((event, metadata) => {
      if (event.startsWith("shutdown_")) throw new Error("observer failed");
      originalInfo(event, metadata);
    });
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      logger,
      tunnelProvider: testTunnel(),
    });

    await expect(bridge.close("sigint")).resolves.toBeUndefined();
    await expect(fetch(`${bridge.localBaseUrl()}/health`)).rejects.toThrow();
  });
});
