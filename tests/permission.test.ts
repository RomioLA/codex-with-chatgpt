import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkMovePermission,
  checkPermission,
  readPermission,
  setPermission,
  type MovePermissionCheckInput,
  type PermissionCheckInput,
} from "../src/permission/index.js";

const WORKSPACE_A = "111111111111";
const WORKSPACE_B = "222222222222";

let stateDir: string;
let previousStateDir: string | undefined;
let usedWorkspaceIds: Set<string>;

function stateFile(workspaceId: string): string {
  return path.join(stateDir, "permissions", `${workspaceId}.json`);
}

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-permission-test-"));
  usedWorkspaceIds = new Set();
  process.env.C2C_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const workspaceId of usedWorkspaceIds) {
    try {
      fs.unlinkSync(stateFile(workspaceId));
    } catch {
      // The file may not have been created by a fail-closed read.
    }
  }
  try {
    fs.rmdirSync(path.join(stateDir, "permissions"));
  } catch {
    // The directory may not have been created.
  }
  try {
    fs.rmdirSync(stateDir);
  } catch {
    // Keep cleanup limited to this test's known, empty temporary directory.
  }

  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("permission state", () => {
  it("defaults to readonly when no file exists", () => {
    usedWorkspaceIds.add(WORKSPACE_A);
    expect(readPermission(WORKSPACE_A)).toBe("readonly");
  });

  it("persists level1 and reads it back", () => {
    usedWorkspaceIds.add(WORKSPACE_A);
    expect(setPermission(WORKSPACE_A, "level1")).toBe("level1");
    expect(readPermission(WORKSPACE_A)).toBe("level1");
  });

  it("persists level2 and reads it back", () => {
    usedWorkspaceIds.add(WORKSPACE_A);
    setPermission(WORKSPACE_A, "level2");
    expect(readPermission(WORKSPACE_A)).toBe("level2");
  });

  it("isolates permission state by workspace ID", () => {
    usedWorkspaceIds.add(WORKSPACE_A);
    usedWorkspaceIds.add(WORKSPACE_B);
    setPermission(WORKSPACE_A, "level2");

    expect(readPermission(WORKSPACE_A)).toBe("level2");
    expect(readPermission(WORKSPACE_B)).toBe("readonly");
  });

  it("re-reads persisted state instead of keeping an in-memory mode", () => {
    usedWorkspaceIds.add(WORKSPACE_A);
    setPermission(WORKSPACE_A, "level1");

    const file = stateFile(WORKSPACE_A);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    persisted.mode = "level2";
    fs.writeFileSync(file, JSON.stringify(persisted));

    expect(readPermission(WORKSPACE_A)).toBe("level2");
  });

  it.each([
    ["malformed JSON", "{"],
    ["invalid mode", JSON.stringify({ version: 1, workspaceId: WORKSPACE_A, mode: "level3", updatedAt: "now" })],
    ["unknown version", JSON.stringify({ version: 2, workspaceId: WORKSPACE_A, mode: "level2", updatedAt: "now" })],
    ["mismatched workspace", JSON.stringify({ version: 1, workspaceId: WORKSPACE_B, mode: "level2", updatedAt: "now" })],
    ["missing required field", JSON.stringify({ version: 1, workspaceId: WORKSPACE_A, mode: "level2" })],
  ])("fails closed for %s", (_caseName, contents) => {
    usedWorkspaceIds.add(WORKSPACE_A);
    fs.mkdirSync(path.dirname(stateFile(WORKSPACE_A)), { recursive: true });
    fs.writeFileSync(stateFile(WORKSPACE_A), contents);

    expect(readPermission(WORKSPACE_A)).toBe("readonly");
  });

  it("fails closed for an invalid workspace ID", () => {
    expect(readPermission("../level2")).toBe("readonly");
    expect(() => setPermission("../level2", "level2")).toThrow("Invalid workspaceId");
  });
});

describe("permission policy", () => {
  const cases: Array<[PermissionCheckInput, boolean]> = [
    [{ mode: "readonly", location: "workspace", operation: "read" }, true],
    [{ mode: "readonly", location: "workspace", operation: "write" }, false],
    [{ mode: "readonly", location: "workspace", operation: "delete" }, false],
    [{ mode: "readonly", location: "outside", operation: "read" }, false],
    [{ mode: "readonly", location: "outside", operation: "write" }, false],
    [{ mode: "readonly", location: "outside", operation: "delete" }, false],
    [{ mode: "level1", location: "workspace", operation: "read" }, true],
    [{ mode: "level1", location: "workspace", operation: "write" }, true],
    [{ mode: "level1", location: "workspace", operation: "delete" }, false],
    [{ mode: "level1", location: "outside", operation: "read" }, true],
    [{ mode: "level1", location: "outside", operation: "write" }, false],
    [{ mode: "level1", location: "outside", operation: "delete" }, false],
    [{ mode: "level2", location: "workspace", operation: "read" }, true],
    [{ mode: "level2", location: "workspace", operation: "write" }, true],
    [{ mode: "level2", location: "workspace", operation: "delete" }, true],
    [{ mode: "level2", location: "outside", operation: "read" }, true],
    [{ mode: "level2", location: "outside", operation: "write" }, true],
    [{ mode: "level2", location: "outside", operation: "delete" }, false],
  ];

  it.each(cases)("applies %o => %s", (input, expected) => {
    expect(checkPermission(input)).toBe(expected);
  });

  it.each(["readonly", "level1", "level2"] as const)(
    "always denies outside deletion in %s",
    (mode) => {
      expect(checkPermission({ mode, location: "outside", operation: "delete" })).toBe(false);
    }
  );

  it("denies malformed policy input", () => {
    expect(checkPermission({ mode: "level3", location: "workspace", operation: "write" } as never)).toBe(false);
    expect(checkPermission({ mode: "level2", location: "outside", operation: "execute" } as never)).toBe(false);
  });
});

describe("move permission policy", () => {
  const cases: Array<[MovePermissionCheckInput, boolean]> = [
    [{ mode: "readonly", sourceLocation: "workspace", destinationLocation: "workspace" }, false],
    [{ mode: "readonly", sourceLocation: "workspace", destinationLocation: "outside" }, false],
    [{ mode: "readonly", sourceLocation: "outside", destinationLocation: "workspace" }, false],
    [{ mode: "readonly", sourceLocation: "outside", destinationLocation: "outside" }, false],
    [{ mode: "level1", sourceLocation: "workspace", destinationLocation: "workspace" }, true],
    [{ mode: "level1", sourceLocation: "workspace", destinationLocation: "outside" }, false],
    [{ mode: "level1", sourceLocation: "outside", destinationLocation: "workspace" }, false],
    [{ mode: "level1", sourceLocation: "outside", destinationLocation: "outside" }, false],
    [{ mode: "level2", sourceLocation: "workspace", destinationLocation: "workspace" }, true],
    [{ mode: "level2", sourceLocation: "workspace", destinationLocation: "outside" }, false],
    [{ mode: "level2", sourceLocation: "outside", destinationLocation: "workspace" }, false],
    [{ mode: "level2", sourceLocation: "outside", destinationLocation: "outside" }, false],
  ];

  it.each(cases)("applies move policy %o => %s", (input, expected) => {
    expect(checkMovePermission(input)).toBe(expected);
  });

  it("denies malformed move input", () => {
    expect(checkMovePermission(null as never)).toBe(false);
    expect(
      checkMovePermission({
        mode: "level3",
        sourceLocation: "workspace",
        destinationLocation: "workspace",
      } as never)
    ).toBe(false);
    expect(
      checkMovePermission({
        mode: "level1",
        sourceLocation: "unknown",
        destinationLocation: "workspace",
      } as never)
    ).toBe(false);
    expect(
      checkMovePermission({
        mode: "level1",
        sourceLocation: "workspace",
        destinationLocation: "unknown",
      } as never)
    ).toBe(false);
  });
});
