import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as oauth from "../src/auth/oauth.js";
import { startBridge } from "../src/bridge/server.js";
import { bridgeInstanceLockFile, inspectBridgeInstanceLock } from "../src/bridge/instance-lock.js";
import { findBridgeObservation, probeBridge, readRuntimeState, writeRuntimeState } from "../src/bridge/runtime.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { getStateDir } from "../src/config/paths.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const roots: string[] = [];

function makeWorkspace(name: string): { root: string; workspace: Workspace } {
  const root = makeTmpDir(name);
  roots.push(root);
  write(root, "readme.txt", "isolated bridge lock test\n");
  return { root, workspace: new Workspace(root) };
}

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port assigned"));
      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function closeExternal(server: net.Server, sockets: Set<net.Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitUntilStopped(workspaceId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await findBridgeObservation(workspaceId)).state === "stopped") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Isolated test Bridge did not stop in time");
}

afterEach(() => {
  for (const root of roots) cleanup(root);
  roots.length = 0;
  delete process.env.C2C_STATE_DIR;
});

describe("workspace Bridge instance lock remediation", () => {
  it("can retry after route initialization fails without retaining an instance lock", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-route-initialization-failure");
    const router = vi.spyOn(oauth, "createOAuthRouter").mockImplementationOnce(() => {
      throw new Error("Injected route initialization failure");
    });
    try {
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow("Injected route initialization failure");
      expect(inspectBridgeInstanceLock(workspace.id)).toBe("missing");
    } finally {
      router.mockRestore();
    }
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    try {
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(workspace.id);
    } finally {
      await bridge.close();
    }
  });

  it("stores the authoritative lock under getStateDir and locks persistRuntime:false instances", async () => {
    const stateRoot = isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-authority");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const lockFile = bridgeInstanceLockFile(workspace.id);
    try {
      expect(path.relative(getStateDir(), lockFile).startsWith(".." + path.sep)).toBe(false);
      expect(fs.existsSync(lockFile)).toBe(true);
      expect(inspectBridgeInstanceLock(workspace.id)).toBe("live_pid_unverified");
      expect(bridge.port).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(stateRoot, "runtime", `${workspace.id}.json`))).toBe(false);
    } finally {
      await bridge.close();
    }
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("blocks the same workspace on a different candidate port", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-alternate-port");
    const preferred = await unusedPort();
    const bridge = await startBridge({ workspaceRoot: root, port: preferred, persistRuntime: false });
    try {
      // The preferred port is occupied by this workspace, so this also proves
      // that EADDRINUSE cannot fall back to an ephemeral duplicate.
      await expect(startBridge({ workspaceRoot: root, port: preferred, persistRuntime: false }))
        .rejects.toThrow(/instance lock|another Bridge/i);
      // A different available candidate cannot bypass the same workspace guard.
      await expect(startBridge({ workspaceRoot: root, port: await unusedPort(), persistRuntime: false }))
        .rejects.toThrow(/instance lock|another Bridge/i);
      const health = await probeBridge(bridge.port);
      expect(health?.workspaceId).toBe(workspace.id);
    } finally {
      await bridge.close();
    }
  });

  it("allows only one Bridge when two ensureBridge calls race", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-concurrent-ensure");
    const preferredPort = await unusedPort();
    try {
      const results = await Promise.allSettled([
        ensureBridge(root, { port: preferredPort }),
        ensureBridge(root, { port: preferredPort }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThan(0);
      const runtimes = fulfilled.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof ensureBridge>>>).value.runtime);
      expect(new Set(runtimes.map((runtime) => `${runtime.pid}:${runtime.port}`)).size).toBe(1);
      expect((await probeBridge(runtimes[0]!.port))?.workspaceId).toBe(workspace.id);
      expect(readRuntimeState(workspace.id)?.pid).toBe(runtimes[0]!.pid);
    } finally {
      await stopBridge(root);
      await waitUntilStopped(workspace.id);
    }
  }, 30_000);

  it.each(["stale", "missing"] as const)("does not start a second Bridge with a %s runtime and a live lock", async (runtimeKind) => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace(`lock-live-${runtimeKind}-runtime`);
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    try {
      if (runtimeKind === "missing") {
        fs.rmSync(path.join(getStateDir(), "runtime", `${workspace.id}.json`), { force: true });
      } else {
        const staleRuntimePort = await unusedPort();
        writeRuntimeState({
          service: SERVICE_NAME,
          version: VERSION,
          workspaceId: workspace.id,
          workspaceRoot: root,
          pid: 999_999_999,
          port: staleRuntimePort,
          adminToken: "isolated-stale-test-token",
          publicUrl: null,
          startedAt: new Date(0).toISOString(),
        });
      }
      await expect(ensureBridge(root, { port: await unusedPort() }))
        .rejects.toThrow(/uncertain|lock|verify|another bridge/i);
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(workspace.id);
    } finally {
      await bridge.close();
    }
  });

  it("recovers a lock whose recorded process is dead", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-stale-dead-owner");
    const lockFile = bridgeInstanceLockFile(workspace.id);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({
      version: 1,
      workspaceId: workspace.id,
      pid: 999_999_999,
      token: randomBytes(16).toString("hex"),
      createdAt: new Date(0).toISOString(),
    }));
    expect(inspectBridgeInstanceLock(workspace.id)).toBe("stale");

    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    try {
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(workspace.id);
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
      expect(owner.pid).toBe(process.pid);
      expect(fs.existsSync(`${lockFile}.recovery`)).toBe(false);
    } finally {
      await bridge.close();
    }
  });

  it("fails closed when a live unrelated PID is recorded, without claiming PID ownership", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-pid-reuse");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated PID reuse fixture");
      const lockFile = bridgeInstanceLockFile(workspace.id);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token: randomBytes(16).toString("hex"),
        createdAt: new Date(0).toISOString(),
      }));
      expect(inspectBridgeInstanceLock(workspace.id)).toBe("live_pid_unverified");
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await probeBridge(await unusedPort())).toBeNull();
    } finally {
      if (child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may already have exited.
        }
      }
    }
  });

  it("falls back for an unrelated preferred-port owner without bypassing the workspace guard", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-unrelated-port-owner");
    const externalSockets = new Set<net.Socket>();
    const external = net.createServer((socket) => {
      externalSockets.add(socket);
      socket.once("close", () => externalSockets.delete(socket));
      socket.end("unrelated service\n");
    });
    await new Promise<void>((resolve, reject) => {
      external.once("error", reject);
      external.listen(0, "127.0.0.1", () => resolve());
    });
    const address = external.address();
    if (!address || typeof address === "string") throw new Error("No external fixture port assigned");
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    try {
      bridge = await startBridge({ workspaceRoot: root, port: address.port, persistRuntime: false });
      expect(bridge.port).not.toBe(address.port);
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(workspace.id);
      await expect(startBridge({ workspaceRoot: root, port: await unusedPort(), persistRuntime: false }))
        .rejects.toThrow(/instance lock|another Bridge/i);
    } finally {
      if (bridge) await bridge.close();
      await closeExternal(external, externalSockets);
    }
  });
});
