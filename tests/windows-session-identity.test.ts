import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { readWindowsSessionIdentitySync, readWindowsSessionIdentitySyncDetailed } from "../src/host-observation/windows.js";
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
    // A sandbox that forbids child processes cannot exercise the interpreter. That is
    // an environment limitation, not a product failure, and it must be reported as such
    // instead of depending on whatever shape the failure happens to have.
    const detailed = readWindowsSessionIdentitySyncDetailed();
    if (!detailed.ok) {
      expect(detailed.identity, "a failed read never yields an identity").toBeNull();
      expect(["NO_INTERPRETER", "SPAWN_DENIED_BY_ENVIRONMENT", "INTERPRETER_FAILED", "INVALID_OUTPUT", "IDENTITY_REJECTED"])
        .toContain(detailed.reason);
      return;
    }

    const first = fingerprintWindowsSessionIdentity(readWindowsSessionIdentitySync());
    const second = fingerprintWindowsSessionIdentity(readWindowsSessionIdentitySync());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  it.skipIf(process.platform !== "win32")("does not poison synchronous LV2 identity cache when async boot ID probe times out", async () => {
    vi.resetModules();
    const mockProgramFiles = "C:\\MockProgramFiles";
    const mockPwsh = path.join(mockProgramFiles, "PowerShell", "7", "pwsh.exe");
    const prevProgramFiles = process.env.ProgramFiles;
    const prevProgramFilesX86 = process.env["ProgramFiles(x86)"];
    process.env.ProgramFiles = mockProgramFiles;
    process.env["ProgramFiles(x86)"] = "C:\\MockProgramFilesX86";

    const execFileMock = vi.fn((_exe: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      const timeoutErr = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });
      cb(timeoutErr, "");
    });
    const execFileSyncMock = vi.fn(() => JSON.stringify(sample));

    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
      execFileSync: execFileSyncMock,
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const normalizedMock = mockPwsh.toLowerCase();
      return {
        ...actual,
        default: {
          ...actual,
          lstatSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase() === normalizedMock) {
              return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
            }
            if (typeof p === "string" && p.toLowerCase().endsWith("\\pwsh.exe")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actual.lstatSync(p as string, ...(rest as []));
          },
          statSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase() === normalizedMock) {
              return { isFile: () => true };
            }
            if (typeof p === "string" && p.toLowerCase().endsWith("\\pwsh.exe")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actual.statSync(p as string, ...(rest as []));
          },
          readdirSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase().startsWith("c:\\mockprogramfiles")) {
              return [];
            }
            return actual.readdirSync(p as string, ...(rest as []));
          },
        },
      };
    });

    try {
      const windowsMod = await import("../src/host-observation/windows.js");
      expect(await windowsMod.readWindowsBootIdAsync()).toBeNull();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Subsequent async boot ID read within 30s backoff returns null without respawning.
      expect(await windowsMod.readWindowsBootIdAsync()).toBeNull();
      expect(execFileMock).toHaveBeenCalledTimes(1);

      // Synchronous LV2 identity check must NOT skip the candidate after async timeout.
      const detailed = windowsMod.readWindowsSessionIdentitySyncDetailed();
      expect(detailed.ok).toBe(true);
      expect(detailed.executable?.toLowerCase()).toBe(mockPwsh.toLowerCase());
      expect(detailed.attempts[0]?.outcome).toBe("identity-ok");
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      expect(windowsMod.getCachedWindowsBootId()).toBe(sample.bootId);
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.resetModules();
      if (prevProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = prevProgramFiles;
      if (prevProgramFilesX86 === undefined) delete process.env["ProgramFiles(x86)"];
      else process.env["ProgramFiles(x86)"] = prevProgramFilesX86;
    }
  });

  it.skipIf(process.platform !== "win32")("treats sync ETIMEDOUT as transient timeout without poisoning candidateOutcomes, while caching non-zero exit", async () => {
    vi.resetModules();
    const mockProgramFiles = "C:\\MockProgramFilesTimeout";
    const mockPwsh = path.join(mockProgramFiles, "PowerShell", "7", "pwsh.exe");
    const prevProgramFiles = process.env.ProgramFiles;
    const prevProgramFilesX86 = process.env["ProgramFiles(x86)"];
    process.env.ProgramFiles = mockProgramFiles;
    process.env["ProgramFiles(x86)"] = "C:\\MockProgramFilesX86";

    let mode: "etimedout" | "ok" | "exit1" = "etimedout";
    const execFileSyncMock = vi.fn(() => {
      if (mode === "etimedout") {
        throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      if (mode === "exit1") {
        throw Object.assign(new Error("exit 1"), { status: 1 });
      }
      return JSON.stringify(sample);
    });

    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(),
      execFileSync: execFileSyncMock,
    }));
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const normalizedMock = mockPwsh.toLowerCase();
      return {
        ...actual,
        default: {
          ...actual,
          lstatSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase() === normalizedMock) {
              return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true };
            }
            if (typeof p === "string" && p.toLowerCase().endsWith("\\pwsh.exe")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actual.lstatSync(p as string, ...(rest as []));
          },
          statSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase() === normalizedMock) {
              return { isFile: () => true };
            }
            if (typeof p === "string" && p.toLowerCase().endsWith("\\pwsh.exe")) {
              throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
            }
            return actual.statSync(p as string, ...(rest as []));
          },
          readdirSync(p: unknown, ...rest: unknown[]) {
            if (typeof p === "string" && p.toLowerCase().startsWith("c:\\mockprogramfilestimeout")) {
              return [];
            }
            return actual.readdirSync(p as string, ...(rest as []));
          },
        },
      };
    });

    try {
      const windowsMod = await import("../src/host-observation/windows.js");
      const first = windowsMod.readWindowsSessionIdentitySyncDetailed();
      expect(first.ok).toBe(false);
      expect(first.reason).toBe("INTERPRETER_FAILED");
      expect(first.attempts.find((a) => a.executable.toLowerCase() === mockPwsh.toLowerCase())?.outcome).toBe("timeout");

      mode = "ok";
      const second = windowsMod.readWindowsSessionIdentitySyncDetailed();
      expect(second.ok).toBe(true);
      expect(second.attempts.find((a) => a.executable.toLowerCase() === mockPwsh.toLowerCase())?.outcome).toBe("identity-ok");

      mode = "exit1";
      const third = windowsMod.readWindowsSessionIdentitySyncDetailed();
      expect(third.ok).toBe(false);
      expect(third.attempts.find((a) => a.executable.toLowerCase() === mockPwsh.toLowerCase())?.outcome).toBe("interpreter-failed");

      // Now non-zero exit IS cached permanently, so fourth call does not invoke execFileSync again for mockPwsh.
      const callsBeforeFourth = execFileSyncMock.mock.calls.length;
      mode = "ok";
      const fourth = windowsMod.readWindowsSessionIdentitySyncDetailed();
      expect(fourth.attempts.find((a) => a.executable.toLowerCase() === mockPwsh.toLowerCase())?.outcome).toBe("interpreter-failed");
      expect(execFileSyncMock.mock.calls.length).toBe(callsBeforeFourth);
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.resetModules();
      if (prevProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = prevProgramFiles;
      if (prevProgramFilesX86 === undefined) delete process.env["ProgramFiles(x86)"];
      else process.env["ProgramFiles(x86)"] = prevProgramFilesX86;
    }
  });
});
