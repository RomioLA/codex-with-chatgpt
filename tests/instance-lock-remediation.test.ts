import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as oauth from "../src/auth/oauth.js";
import * as processIdentity from "../src/process/bridge-process-identity.js";
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
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("missing");
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
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("live_pid_unverified");
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
    expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("stale");

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

  it("fails closed when a live Bridge-like PID is recorded", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-pid-reuse");
    const helper = write(root, "dist/cli/index.js", "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, [helper, "serve", "--workspace", root], { stdio: "ignore" });
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockResolvedValue("bridge");
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
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("live_pid_unverified");
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      expect(await probeBridge(await unusedPort())).toBeNull();
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The child may already have exited.
        }
      }
    }
  });

  it("recovers a live PID that process creation identity proves is unrelated", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-reused-unrelated-pid");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockResolvedValue("unrelated");
    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
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
        createdAt: new Date().toISOString(),
        processStartTime: "2026-11-01T00:00:00.0000000Z",
      }));
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("stale");
      bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(workspace.id);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
      const owner = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid: number };
      expect(owner.pid).toBe(process.pid);
    } finally {
      ownerProbe.mockRestore();
      if (bridge) await bridge.close();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
      }
    }
  });

  it("never recovers a live lock lacking processStartTime even if process identity looks unrelated", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-legacy-no-starttime-live");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockResolvedValue("unrelated");
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated legacy lock fixture");
      const lockToken = randomBytes(16).toString("hex");
      const lockFile = bridgeInstanceLockFile(workspace.id);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token: lockToken,
        createdAt: new Date().toISOString(),
      }));
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("live_pid_unverified");
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(ownerProbe).not.toHaveBeenCalled();
      const surviving = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { token: string; pid: number };
      expect(surviving.token).toBe(lockToken);
      expect(surviving.pid).toBe(child.pid);
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
      }
    }
  });

  it("does not recover a live lock when the process identity query misses its PID", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-identity-missing-race");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockResolvedValue("missing");
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated PID identity fixture");
      const lockFile = bridgeInstanceLockFile(workspace.id);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token: randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      }));
      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("live_pid_unverified");
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
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

  it("does not unlink a newer lock published while async owner verification is in flight", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-recovery-toctou-race");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const lockFile = bridgeInstanceLockFile(workspace.id);
    const tokenA = randomBytes(16).toString("hex");
    const tokenB = randomBytes(16).toString("hex");
    let probeCalls = 0;
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockImplementation(async () => {
      probeCalls += 1;
      if (probeCalls === 1) {
        return "unrelated";
      }
      if (probeCalls === 2) {
        // Simulate another Bridge publishing a fresh lock while recoverDeadOwner awaits WMI probe.
        fs.writeFileSync(lockFile, JSON.stringify({
          version: 1,
          workspaceId: workspace.id,
          pid: process.pid,
          token: tokenB,
          createdAt: new Date().toISOString(),
          processStartTime: "2026-11-04T08:38:12.1447236Z",
        }));
        return "unrelated";
      }
      return "bridge";
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated TOCTOU fixture");
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token: tokenA,
        createdAt: new Date(0).toISOString(),
        processStartTime: "2026-11-01T00:00:00.0000000Z",
      }));

      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(probeCalls).toBeGreaterThanOrEqual(3);
      expect(fs.existsSync(lockFile)).toBe(true);
      const surviving = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { token: string; pid: number };
      expect(surviving.token).toBe(tokenB);
      expect(surviving.pid).toBe(process.pid);
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
      }
    }
  });

  it("releases the instance lock when AuthStore initialization fails during startup", async () => {
    const stateRoot = isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-corrupt-auth-startup");
    const authDir = path.join(stateRoot, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    const corruptAuthFile = path.join(authDir, `${workspace.id}.json`);
    fs.writeFileSync(corruptAuthFile, '{"clients":[],"tokens":[', "utf8");

    await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
      .rejects.toThrow(/invalid json|corrupt/i);
    expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("missing");
  });

  it("passes recorded processStartTime to owner verification and keeps a matching live Bridge lock", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-process-start-time");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const observedStartTimes: Array<string | null | undefined> = [];
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner")
      .mockImplementation(async (_pid, _workspaceRoot, expectedStartTime) => {
        observedStartTimes.push(expectedStartTime);
        return expectedStartTime === "2026-11-04T08:38:12.1447236Z" ? "bridge" : "unrelated";
      });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated processStartTime fixture");
      const lockFile = bridgeInstanceLockFile(workspace.id);
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token: randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
        processStartTime: "2026-11-04T08:38:12.1447236Z",
      }));

      expect(await inspectBridgeInstanceLock(workspace.id, root)).toBe("live_pid_unverified");
      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(observedStartTimes).toEqual([
        "2026-11-04T08:38:12.1447236Z",
        "2026-11-04T08:38:12.1447236Z",
      ]);
      expect(fs.existsSync(lockFile)).toBe(true);
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
      }
    }
  });

  it("does not unlink a lock whose processStartTime changed while recovery was in flight", async () => {
    isolateStateDir();
    const { root, workspace } = makeWorkspace("lock-recovery-start-time-race");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const lockFile = bridgeInstanceLockFile(workspace.id);
    const token = randomBytes(16).toString("hex");
    let probeCalls = 0;
    const ownerProbe = vi.spyOn(processIdentity, "observeBridgeProcessOwner").mockImplementation(async (_pid, _root, expectedStartTime) => {
      probeCalls += 1;
      if (probeCalls === 2) {
        fs.writeFileSync(lockFile, JSON.stringify({
          version: 1,
          workspaceId: workspace.id,
          pid: child.pid,
          token,
          createdAt: new Date().toISOString(),
          processStartTime: "2026-11-04T08:38:12.1447236Z",
        }));
        return "unrelated";
      }
      return expectedStartTime === "2026-11-04T08:38:12.1447236Z" ? "bridge" : "unrelated";
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("Could not start isolated startTime race fixture");
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        pid: child.pid,
        token,
        createdAt: new Date(0).toISOString(),
        processStartTime: "2026-11-01T00:00:00.0000000Z",
      }));

      await expect(startBridge({ workspaceRoot: root, port: 0, persistRuntime: false }))
        .rejects.toThrow(/live but unverified|cannot be verified/i);
      expect(probeCalls).toBeGreaterThanOrEqual(3);
      expect(fs.existsSync(lockFile)).toBe(true);
      const surviving = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { processStartTime?: string };
      expect(surviving.processStartTime).toBe("2026-11-04T08:38:12.1447236Z");
    } finally {
      ownerProbe.mockRestore();
      if (child.pid) {
        try { child.kill("SIGKILL"); } catch { /* the child may already have exited */ }
      }
    }
  });
});
