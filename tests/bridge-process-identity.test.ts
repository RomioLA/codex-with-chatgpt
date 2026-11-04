import { describe, expect, it } from "vitest";
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

  it("proves a non-Node process cannot own the Bridge PID", () => {
    expect(classifyBridgeProcessIdentity(identity({
      name: "sunshine.exe",
      exePath: "C:\\Program Files\\Sunshine\\sunshine.exe",
      commandLine: null,
    }), "C:\\codex")).toBe("unrelated");
  });

  it("does not confuse another workspace's C2C Bridge with this workspace", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: '"C:\\Runtime\\dist\\cli\\index.js" serve --workspace "C:\\other"',
    }), "C:\\codex")).toBe("unrelated");
  });

  it("keeps an ambiguous Node server process unknown", () => {
    expect(classifyBridgeProcessIdentity(identity({
      commandLine: 'node.exe some-server.js serve --workspace "C:\\codex"',
    }), "C:\\codex")).toBe("unknown");
  });

  it("treats a missing process as missing", () => {
    expect(classifyBridgeProcessIdentity(identity({ found: false }), "C:\\codex")).toBe("missing");
  });
});
