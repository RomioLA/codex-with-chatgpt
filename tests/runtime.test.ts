import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  findBridgeObservation,
  findLiveBridge,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { restoreWorkspace } from "../src/process/recovery.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    vi.unstubAllGlobals();
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("does not accept matching health before a live runtime identity is published", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-listening-stale-runtime");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const auth = path.join(makeTmpDir("obs-listening-stale-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: auth,
    });
    try {
      // Model the production startup window: the new Bridge is already
      // listening and returns matching /health, while the persisted runtime
      // still carries the previous process identity/admin token.
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, bridge.port));

      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("runtime_identity_stale");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      // Do not spawn a second Bridge while the instance lock belongs to this listener.
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);

      // Simulate the new Bridge publishing its own runtime after listen().
      const observedInfo = await adminFetch<{ pid: number; port: number; startedAt: string }>(
        { ...stubRuntime(workspace.id, workspace.root, process.pid, bridge.port), adminToken: bridge.adminToken },
        "GET",
        "/admin/info",
      );
      const published = {
        ...stubRuntime(workspace.id, workspace.root, observedInfo.pid, observedInfo.port),
        adminToken: bridge.adminToken,
        startedAt: observedInfo.startedAt,
      };
      writeRuntimeState(published);
      const ready = await ensureBridge(root);
      expect(ready).toMatchObject({ spawned: false, runtime: published });

      // Even with a live PID and matching /health, an incorrect admin token is terminal.
      writeRuntimeState({ ...published, adminToken: "stale-test-token" });
      await expect(ensureBridge(root)).rejects.toThrow(/admin authentication or identity mismatch/);
    } finally {
      await bridge.close();
    }
  });

  it("retries a temporarily unavailable admin interface only within the identity-checked window", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-admin-temporary");
    dirs.push(root);
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    const originalFetch = globalThis.fetch;
    let temporaryFailures = 0;
    try {
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/admin/info") && temporaryFailures < 2) {
          temporaryFailures += 1;
          return Promise.reject(Object.assign(new Error("temporary reset"), { code: "ECONNRESET" }));
        }
        return originalFetch(input, init);
      });
      const ready = await ensureBridge(root);
      expect(ready.spawned).toBe(false);
      expect(ready.runtime.pid).toBe(process.pid);
      expect(temporaryFailures).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      await bridge.close();
    }
  });

  it("fails closed when a stale runtime PID is alive but belongs to another process", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-reused-pid");
    dirs.push(root);
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
    });
    unrelated.unref();
    try {
      if (!unrelated.pid) throw new Error("failed to start isolated unrelated PID fixture");
      // The stored PID belongs to an unrelated, still-running process.
      // The live Bridge has the same workspace and port, but a different token.
      writeRuntimeState(stubRuntime(bridge.workspace.id, bridge.workspace.root, unrelated.pid, bridge.port));
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy"); // /health plus PID liveness alone is insufficient.
      await expect(ensureBridge(root)).rejects.toThrow(/admin authentication or identity mismatch/);
      const outcome = await restoreWorkspace(root);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("bridgeIdentityMismatch");
      expect(outcome.tunnelAction).toBe("notConfigured");
    } finally {
      await bridge.close();
      if (unrelated.pid) {
        try {
          process.kill(unrelated.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("cold-starts and reuses a real isolated daemon on an ephemeral port", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-cold-daemon");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    let started = false;
    try {
      const first = await ensureBridge(root, { port: 0 });
      started = true;
      expect(first.spawned).toBe(true);
      expect(first.runtime.port).toBeGreaterThan(0);
      expect(first.runtime.port).not.toBe(48765);
      expect(first.runtime.workspaceId).toBe(workspace.id);
      const second = await ensureBridge(root);
      expect(second.spawned).toBe(false);
      expect(second.runtime).toEqual(first.runtime);
      const restored = await restoreWorkspace(root);
      expect(restored.ok).toBe(true);
      expect(restored.bridgeAction).toBe("reused");
    } finally {
      if (started) {
        expect(await stopBridge(root)).toBe(true);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const observed = await findBridgeObservation(workspace.id);
          if (observed.state === "stopped") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect((await findBridgeObservation(workspace.id)).state).toBe("stopped");
      }
    }
  }, 15_000);

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it.skipIf(process.platform !== "win32")("treats EPERM from process.kill as present on Windows", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-windows-eperm");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-windows-eperm-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    const originalKill = process.kill;
    try {
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === process.pid && signal === 0) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return originalKill(pid, signal as number);
      }) as typeof process.kill);

      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      const reused = await ensureBridge(root);
      expect(reused).toMatchObject({
        spawned: false,
        runtime: { pid: process.pid, port: bridge.port, workspaceId: bridge.workspace.id },
      });
      writeRuntimeState({ ...reused.runtime, adminToken: "stale-test-token" });
      await expect(ensureBridge(root)).rejects.toThrow(/admin authentication or identity mismatch/);
      killSpy.mockRestore();
    } finally {
      vi.restoreAllMocks();
      await bridge.close();
    }
  });

  it("rejects reuse when health matches but the PID probe has an unknown error", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-pid-unknown-health");
    dirs.push(root);
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const originalKill = process.kill;
    try {
      writeRuntimeState({
        ...stubRuntime(bridge.workspace.id, bridge.workspace.root, process.pid, bridge.port),
        adminToken: bridge.adminToken,
      });
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === process.pid && signal === 0) {
          throw Object.assign(new Error("access denied"), { code: "EACCES" });
        }
        return originalKill(pid, signal as number);
      }) as typeof process.kill);

      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation).toMatchObject({ state: "unknown", reason: "pid_unknown" });
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain.*pid_unknown/);
    } finally {
      vi.restoreAllMocks();
      await bridge.close();
    }
  });

  it.skipIf(process.platform !== "win32")("keeps Windows EPERM unknown when health probe fails", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-windows-eperm-probe-failed");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, process.pid, 1));
    const originalKill = process.kill;
    vi.stubGlobal("fetch", () => Promise.reject(new Error("health endpoint unavailable")));
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === process.pid && signal === 0) {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return originalKill(pid, signal as number);
    }) as typeof process.kill);

    try {
      const observation = await findBridgeObservation(workspace.id);
      expect(observation).toMatchObject({ state: "unknown", reason: "probe_failed" });
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain.*probe_failed/);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("keeps EPERM unknown when the reported platform is not Windows", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-nonwindows-eperm");
    dirs.push(root);
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    const originalKill = process.kill;
    try {
      writeRuntimeState({
        ...stubRuntime(bridge.workspace.id, bridge.workspace.root, process.pid, bridge.port),
        adminToken: bridge.adminToken,
      });
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === process.pid && signal === 0) {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        }
        return originalKill(pid, signal as number);
      }) as typeof process.kill);
      const processProxy = new Proxy(process, {
        get(target, property) {
          if (property === "platform") return "linux";
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      vi.stubGlobal("process", processProxy);

      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation).toMatchObject({ state: "unknown", reason: "pid_unknown" });
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      await bridge.close();
    }
  });
});
