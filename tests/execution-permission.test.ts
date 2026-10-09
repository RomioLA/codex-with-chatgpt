import { describe, expect, it } from "vitest";
import { checkExecutionPermission } from "../src/execution/permission.js";

describe("execution permission", () => {
  it("requires execution.run, writable local mode, and trusted command authority", () => {
    for (const mode of ["level1", "level2"] as const) {
      expect(checkExecutionPermission({ mode, scopes: ["execution.run"], action: "start", hasTrustedCommand: true })).toBe(true);
      expect(checkExecutionPermission({ mode, scopes: ["execution.run"], action: "start", hasTrustedCommand: false })).toBe(false);
    }
    expect(checkExecutionPermission({ mode: "readonly", scopes: ["execution.run"], action: "start", hasTrustedCommand: true })).toBe(false);
    expect(checkExecutionPermission({ mode: "level1", scopes: ["execution.read"], action: "start", hasTrustedCommand: true })).toBe(false);
  });

  it("keeps read and cancel scopes independent and available after permission downgrade", () => {
    expect(checkExecutionPermission({ mode: "readonly", scopes: ["execution.jobs.read"], action: "read" })).toBe(true);
    expect(checkExecutionPermission({ mode: "readonly", scopes: ["execution.cancel"], action: "cancel" })).toBe(true);
    expect(checkExecutionPermission({ mode: "level1", scopes: ["execution.jobs.read"], action: "cancel" })).toBe(false);
    expect(checkExecutionPermission({ mode: "level2", scopes: ["execution.cancel"], action: "read" })).toBe(false);
  });
});
