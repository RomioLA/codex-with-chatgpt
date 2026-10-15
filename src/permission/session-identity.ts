import { createHash } from "node:crypto";
import { readWindowsSessionIdentitySync } from "../host-observation/windows.js";

export interface WindowsSessionIdentity {
  bootId: string;
  bootTime: string;
  userSid: string;
  sessionId: number;
  logonId: string;
}

let cachedFingerprint: string | null | undefined;
let negativeCacheUntil = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return a local-only digest; the OS identity fields are never sent through MCP. */
export function fingerprintWindowsSessionIdentity(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const { bootId, bootTime, userSid, sessionId, logonId } = value;
  if (typeof bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) return null;
  if (typeof bootTime !== "string" || !Number.isFinite(Date.parse(bootTime))) return null;
  if (typeof userSid !== "string" || !/^S-\d+(?:-\d+)+$/i.test(userSid)) return null;
  if (!Number.isSafeInteger(sessionId) || (sessionId as number) < 0) return null;
  if (typeof logonId !== "string" || !/^[0-9a-f]{16}$/i.test(logonId)) return null;

  const canonical = JSON.stringify({
    bootId: bootId.toLowerCase(),
    bootTime: new Date(bootTime).toISOString(),
    userSid: userSid.toUpperCase(),
    sessionId,
    logonId: logonId.toLowerCase(),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The Windows tuple combines boot GUID/time, user SID, process session ID, and
 * the token's AuthenticationId (logon LUID). A session ID alone is not authority.
 */
export function getCurrentSessionIdentityFingerprint(): string | null {
  if (cachedFingerprint) return cachedFingerprint;
  if (cachedFingerprint === null && Date.now() < negativeCacheUntil) return null;

  const fingerprint = fingerprintWindowsSessionIdentity(readWindowsSessionIdentitySync());
  if (fingerprint) {
    cachedFingerprint = fingerprint;
    return fingerprint;
  }

  cachedFingerprint = null;
  negativeCacheUntil = Date.now() + 5_000;
  return null;
}
