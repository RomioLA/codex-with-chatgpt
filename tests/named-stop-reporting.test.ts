import { afterEach, describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const STOP_ERROR_TOKEN = "raw-cloudflared-stop-token-do-not-leak";

class ControlledStopTunnel implements TunnelProvider {
  stopCalls = 0;
  rejectStop = false;

  readonly name = "cloudflare-named";

  async start(): Promise<string> {
    return "https://stop-test.example.com";
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.rejectStop) throw new Error(`cloudflared stop detail ${STOP_ERROR_TOKEN}`);
  }

  async restart(): Promise<string> {
    return this.start();
  }

  status(): TunnelStatus {
    return {
      running: true,
      url: "https://stop-test.example.com",
      provider: this.name,
      processRunning: true,
      connected: true,
    };
  }

  getPublicUrl(): string | null {
    return "https://stop-test.example.com";
  }

  async doctor(): Promise<TunnelDoctorReport> {
    return {
      provider: this.name,
      binaryFound: true,
      binaryPath: "fake-cloudflared",
      running: true,
      url: "https://stop-test.example.com",
      problems: [],
    };
  }
}

function workspaceRoot(name: string): string {
  roots.push(isolateStateDir());
  const root = makeTmpDir(name);
  roots.push(root);
  write(root, "readme.txt", "isolated tunnel stop reporting fixture\n");
  return root;
}

async function postStop(bridge: Awaited<ReturnType<typeof startBridge>>): Promise<Response> {
  return fetch(`${bridge.localBaseUrl()}/admin/tunnel/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${bridge.adminToken}` },
  });
}

afterEach(() => {
  while (roots.length) cleanup(roots.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("Named Tunnel stop route reporting", () => {
  it("returns a safe failure when stop cannot be confirmed and keeps Bridge health available", async () => {
    const root = workspaceRoot("named-stop-rejected");
    const tunnel = new ControlledStopTunnel();
    tunnel.rejectStop = true;
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, tunnelProvider: tunnel });
    try {
      const response = await postStop(bridge);
      const body = await response.json() as Record<string, unknown>;
      const health = await fetch(`${bridge.localBaseUrl()}/health`);

      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: "tunnel_stop_failed",
        message: "Tunnel stop could not be confirmed.",
      });
      expect(body).not.toHaveProperty("stopped", true);
      expect(JSON.stringify(body)).not.toContain(STOP_ERROR_TOKEN);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ service: "c2c-bridge", status: "ok" });
      expect(tunnel.stopCalls).toBe(1);
    } finally {
      // Bridge.close also stops the provider; make cleanup succeed after the
      // request-specific rejection has been observed.
      tunnel.rejectStop = false;
      await bridge.close();
    }
  });

  it("returns stopped true when the provider confirms a successful stop", async () => {
    const root = workspaceRoot("named-stop-success");
    const tunnel = new ControlledStopTunnel();
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, tunnelProvider: tunnel });
    try {
      const response = await postStop(bridge);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ stopped: true });
      expect(tunnel.stopCalls).toBe(1);
    } finally {
      await bridge.close();
    }
  });
});
