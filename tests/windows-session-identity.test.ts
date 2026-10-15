import { describe, expect, it } from "vitest";
import { readWindowsSessionIdentitySync } from "../src/host-observation/windows.js";
import { fingerprintWindowsSessionIdentity } from "../src/permission/session-identity.js";

const sample = {
  bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  bootTime: "2026-10-15T01:02:03.0000000Z",
  userSid: "S-1-5-21-100-200-300-1001",
  sessionId: 4,
  logonId: "00000000000123ab",
};

describe("Windows session identity fingerprint", () => {
  it("binds boot, user, Windows session, and token logon identity", () => {
    const expected = fingerprintWindowsSessionIdentity(sample);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintWindowsSessionIdentity({ ...sample })).toBe(expected);
    expect(fingerprintWindowsSessionIdentity({ ...sample, bootId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" })).not.toBe(expected);
    expect(fingerprintWindowsSessionIdentity({ ...sample, bootTime: "2026-10-16T01:02:03.0000000Z" })).not.toBe(expected);
    expect(fingerprintWindowsSessionIdentity({ ...sample, userSid: "S-1-5-21-100-200-300-1002" })).not.toBe(expected);
    expect(fingerprintWindowsSessionIdentity({ ...sample, sessionId: 5 })).not.toBe(expected);
    expect(fingerprintWindowsSessionIdentity({ ...sample, logonId: "00000000000123ac" })).not.toBe(expected);
  });

  it("rejects incomplete or malformed identity data", () => {
    expect(fingerprintWindowsSessionIdentity(null)).toBeNull();
    expect(fingerprintWindowsSessionIdentity({ ...sample, bootId: "not-a-boot-id" })).toBeNull();
    expect(fingerprintWindowsSessionIdentity({ ...sample, sessionId: -1 })).toBeNull();
    expect(fingerprintWindowsSessionIdentity({ ...sample, logonId: "" })).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("reads a stable current Windows identity across fresh PowerShell queries", () => {
    const first = fingerprintWindowsSessionIdentity(readWindowsSessionIdentitySync());
    const second = fingerprintWindowsSessionIdentity(readWindowsSessionIdentitySync());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });
});
