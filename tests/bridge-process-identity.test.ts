import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyBridgeProcessIdentity } from "../src/process/bridge-process-identity.js";
import type { WindowsProcessIdentity } from "../src/host-observation/windows.js";

function identity(overrides: Partial<WindowsProcessIdentity> = {}): WindowsProcessIdentity {
  return {
    found: true,
    pid: 1234,
    name: "node.exe",
    exePath: "C:\\Runtime\\node.exe",
    commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex"',
    startTime: "2026-11-04T08:38:12.1447236Z",
    ...overrides,
  };
}

describe("Bridge process identity", () => {
  it("recognizes the C2C serve process for the exact workspace", () => {
    expect(classifyBridgeProcessIdentity(identity(), "C:\\codex")).toBe("bridge");
  });

  it("keeps non-node.exe or renamed Node executables unknown without expectedStartTime", () => {
    expect(classifyBridgeProcessIdentity(identity({
      name: "sunshine.exe",
      exePath: "C:\\Program Files\\Sunshine\\sunshine.exe",
      commandLine: null,
    }), "C:\\codex")).toBe("unknown");

    expect(classifyBridgeProcessIdentity(identity({
      name: "c2c-node.exe",
      exePath: "C:\\Runtime\\c2c-node.exe",
      commandLine: '"C:\\Runtime\\c2c-node.exe" "C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex"',
    }), "C:\\codex")).toBe("unknown");
  });

  it("keeps a legacy C2C Bridge with another --workspace string unknown without expectedStartTime", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\other"',
    }), "C:\\codex")).toBe("unknown");
  });

  it("keeps an ambiguous Node server process unknown", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: 'node.exe some-server.js serve --workspace "C:\\codex"',
    }), "C:\\codex")).toBe("unknown");
  });

  it("treats a missing process as missing", () => {
    expect(classifyBridgeProcessIdentity(identity({ found: false }), "C:\\codex")).toBe("missing");
  });

  it("treats relative --workspace arguments as unknown rather than unrelated", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace .',
    }), "C:\\codex")).toBe("unknown");
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace=.\\sub',
    }), "C:\\codex")).toBe("unknown");
  });

  it("keeps same-prefix --workspace directories unknown without expectedStartTime", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex_other"',
    }), "C:\\codex")).toBe("unknown");
  });

  it("normalizes --workspace=<val>, trailing slashes, and forward slashes", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace="C:/codex/"',
    }), "C:\\codex\\")).toBe("bridge");
  });

  it("treats duplicate, empty, or unclosed-quote --workspace flags as unknown", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex" --workspace "C:\\other"',
    }), "C:\\codex")).toBe("unknown");
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace ""',
    }), "C:\\codex")).toBe("unknown");
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex',
    }), "C:\\codex")).toBe("unknown");
  });

  it("recognizes a live Bridge launched through a Windows junction alias when expectedStartTime matches", () => {
    expect(classifyBridgeProcessIdentity(
      identity({
        commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\junction-alias\\repo"',
        startTime: " 2026-11-04T08:38:12.1447236Z ",
      }),
      "C:\\real-target\\repo",
      { expectedStartTime: "2026-11-04T08:38:12.1447236Z" },
    )).toBe("bridge");
  });

  it("classifies a reused PID as unrelated when expectedStartTime mismatches", () => {
    expect(classifyBridgeProcessIdentity(
      identity({
        commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\codex"',
        startTime: "2026-11-04T09:00:00.0000000Z",
      }),
      "C:\\codex",
      { expectedStartTime: "2026-11-04T08:38:12.1447236Z" },
    )).toBe("unrelated");
  });

  it("keeps identity unknown when WMI startTime is missing even for non-node.exe executables", () => {
    expect(classifyBridgeProcessIdentity(
      identity({
        name: "sunshine.exe",
        exePath: "C:\\Program Files\\Sunshine\\sunshine.exe",
        commandLine: null,
        startTime: null,
      }),
      "C:\\codex",
      { expectedStartTime: "2026-11-04T08:38:12.1447236Z" },
    )).toBe("unknown");

    expect(classifyBridgeProcessIdentity(
      identity({
        name: "c2c-node.exe",
        exePath: "C:\\Runtime\\c2c-node.exe",
        startTime: "2026-11-04T08:38:12.1447236Z",
      }),
      "C:\\codex",
      { expectedStartTime: "2026-11-04T08:38:12.1447236Z" },
    )).toBe("bridge");

    expect(classifyBridgeProcessIdentity(
      identity({
        startTime: null,
      }),
      "C:\\codex",
      { expectedStartTime: "2026-11-04T08:38:12.1447236Z" },
    )).toBe("unknown");
  });

  it("keeps offline c2c CLI invocations unknown without expectedStartTime", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" unpair --workspace "C:\\codex"',
    }), "C:\\codex")).toBe("unknown");
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\bin\\c2c.js" oauth-client create --workspace "C:\\other"',
    }), "C:\\codex")).toBe("unknown");
  });
});

describe("readOwnWindowsProcessStartTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.skipIf(process.platform !== "win32")("retries after transient errors and caches non-empty startTime", async () => {
    vi.resetModules();
    const { ObservationError } = await import("../src/host-observation/types.js");
    const windows = await import("../src/host-observation/windows.js");
    const querySpy = vi.spyOn(windows, "queryWindowsProcessIdentity")
      .mockRejectedValueOnce(new ObservationError("QUERY_BUSY", "busy"))
      .mockResolvedValueOnce({
        found: true,
        pid: process.pid,
        name: "node.exe",
        exePath: process.execPath,
        commandLine: null,
        startTime: "2026-11-04T08:38:12.1447236Z",
      });
    const mod = await import("../src/process/bridge-process-identity.js");

    expect(await mod.readOwnWindowsProcessStartTime()).toBeNull();
    expect(await mod.readOwnWindowsProcessStartTime()).toBe("2026-11-04T08:38:12.1447236Z");
    expect(await mod.readOwnWindowsProcessStartTime()).toBe("2026-11-04T08:38:12.1447236Z");
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform !== "win32")("caches null only when host observation is NOT_SUPPORTED", async () => {
    vi.resetModules();
    const { ObservationError } = await import("../src/host-observation/types.js");
    const windows = await import("../src/host-observation/windows.js");
    const querySpy = vi.spyOn(windows, "queryWindowsProcessIdentity")
      .mockRejectedValue(new ObservationError("NOT_SUPPORTED", "unsupported"));
    const mod = await import("../src/process/bridge-process-identity.js");

    expect(await mod.readOwnWindowsProcessStartTime()).toBeNull();
    expect(await mod.readOwnWindowsProcessStartTime()).toBeNull();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
