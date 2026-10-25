import { createHash } from "node:crypto";
import {
  readWindowsSessionIdentitySync,
  readWindowsSessionIdentitySyncDetailed,
  type SessionIdentityFailureReason,
} from "../host-observation/windows.js";

export interface WindowsSessionIdentity {
  bootId: string;
  bootTime: string;
  userSid: string;
  sessionId: number;
  logonId: string;
}

let cachedFingerprint: string | null | undefined;
let negativeCacheUntil = 0;
/** Last observed failure reason, for diagnostics only. Never used for authorization. */
let lastFailureReason: SessionIdentityFailureReason | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonicalise a boot timestamp WITHOUT losing precision.
 *
 * The identity script emits a Windows FILETIME magnitude (tick 0 = 1601-01-01),
 * so `new Date(bootTime).toISOString()` is not lossless: it truncates to
 * milliseconds and would make two different boots collide while also normalising
 * away the sub-millisecond part that distinguishes a real boot. This function:
 *   - accepts ISO-8601 text only (a documented, unambiguous input shape);
 *   - converts FILETIME-magnitude timestamps exactly to Unix nanoseconds;
 *   - keeps ANY other ISO timestamp at its declared precision;
 *   - returns null for anything it cannot convert exactly, so callers fail closed.
 *
 * Because the input is ISO text rather than a JS Date, the canonical string is
 * identical on every host and locale; only the textual form is normalised.
 */
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:?\d{2})$/;

export function canonicalBootTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ISO_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31) return null;
  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) return null;

  // Exact Gregorian-day count since the Unix epoch (no Date object involved).
  const daysFromCivil = (y: number, m: number, d: number): bigint => {
    const adjusted = BigInt(m <= 2 ? y - 1 : y);
    const era = (adjusted >= 0n ? adjusted : adjusted - 399n) / 400n;
    const yearOfEra = adjusted - era * 400n;
    const dayOfYear = (153n * BigInt(m + (m > 2 ? -3 : 9)) + 2n) / 5n + BigInt(d) - 1n;
    const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
    return era * 146_097n + dayOfEra - 719_468n;
  };

  const days = daysFromCivil(yearNumber, monthNumber, dayNumber);
  const secondsOfDay = BigInt(hourNumber * 3600 + minuteNumber * 60 + secondNumber);
  let unixSeconds = days * 86_400n + secondsOfDay;

  // Apply a numeric zone offset so equivalent instants normalise identically.
  if (zone !== "Z") {
    const sign = zone.startsWith("-") ? -1n : 1n;
    const digits = zone.slice(1).replace(":", "");
    const offsetSeconds = sign * (BigInt(digits.slice(0, 2)) * 3600n + BigInt(digits.slice(2, 4)) * 60n);
    unixSeconds -= offsetSeconds;
  }

  // Exact instant in 100ns ticks since the Unix epoch. The ISO text already
  // carries the instant, so no FILETIME rebasing is needed here; the fractional
  // part is preserved verbatim at up to 7 digits (100ns resolution).
  const fractionTicks = BigInt((fraction ?? "").padEnd(7, "0") || "0");
  const momentTicks = unixSeconds * 10_000_000n + fractionTicks;

  const epochSeconds = momentTicks / 10_000_000n;
  const subSecondTicks = momentTicks % 10_000_000n;
  if (epochSeconds < -62_135_596_800n || epochSeconds > 253_402_300_799n) return null;

  const civil = ((): { y: number; m: number; d: number } => {
    // Inverse of daysFromCivil (Howard Hinnant's algorithm) using exact integers.
    const epochDays = epochSeconds / 86_400n;
    const z = epochDays + 719_468n;
    const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
    const dayOfEra = z - era * 146_097n;
    const yearOfEra = (dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
    const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
    const mp = (5n * dayOfYear + 2n) / 153n;
    const dayOfMonth = dayOfYear - (153n * mp + 2n) / 5n + 1n;
    const monthOfYear = mp < 10n ? mp + 3n : mp - 9n;
    const yearValue = yearOfEra + era * 400n + (monthOfYear <= 2n ? 1n : 0n);
    return { y: Number(yearValue), m: Number(monthOfYear), d: Number(dayOfMonth) };
  })();

  const secondsWithinDay = epochSeconds - (epochSeconds / 86_400n) * 86_400n;
  const hours = Number(secondsWithinDay / 3600n);
  const minutes = Number((secondsWithinDay % 3600n) / 60n);
  const seconds = Number(secondsWithinDay % 60n);
  const milliseconds = Number(subSecondTicks / 10_000n);
  const subMillisecondTicks = subSecondTicks % 10_000n;

  const pad = (input: number, width = 2): string => String(input).padStart(width, "0");
  const base = `${pad(civil.y, 4)}-${pad(civil.m)}-${pad(civil.d)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}Z`;
  // Only widen the text when there really is sub-millisecond resolution, so the
  // canonical form keeps the established ISO shape for ordinary boot times (this
  // matters because the persisted grant was written with that exact shape).
  return subMillisecondTicks === 0n
    ? base
    : `${base.slice(0, -1)}${pad(Number(subMillisecondTicks), 4)}Z`;
}

/** Return a local-only digest; the OS identity fields are never sent through MCP. */
export function fingerprintWindowsSessionIdentity(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const { bootId, bootTime, userSid, sessionId, logonId } = value;
  if (typeof bootId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) return null;
  const canonicalBoot = canonicalBootTime(bootTime);
  if (canonicalBoot === null) return null;
  if (typeof userSid !== "string" || !/^S-\d+(?:-\d+)+$/i.test(userSid)) return null;
  if (!Number.isSafeInteger(sessionId) || (sessionId as number) < 0) return null;
  if (typeof logonId !== "string" || !/^[0-9a-f]{16}$/i.test(logonId)) return null;

  const canonical = JSON.stringify({
    bootId: bootId.toLowerCase(),
    bootTime: canonicalBoot,
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
    lastFailureReason = null;
    return fingerprint;
  }

  cachedFingerprint = null;
  negativeCacheUntil = Date.now() + 5_000;
  lastFailureReason = observeFailureReason();
  return null;
}

/**
 * Diagnostics only: why the identity is currently unavailable. Never authorizes
 * anything; a non-null value always accompanies a fail-closed (null) fingerprint.
 */
export function getSessionIdentityFailureReason(): SessionIdentityFailureReason | null {
  return lastFailureReason;
}

function observeFailureReason(): SessionIdentityFailureReason | null {
  try {
    const detailed = readWindowsSessionIdentitySyncDetailed();
    return detailed.ok ? "IDENTITY_REJECTED" : detailed.reason;
  } catch {
    return "INTERPRETER_FAILED";
  }
}

/** Test/CLI helper: drop the cached fingerprint after an OS identity change. */
export function resetSessionIdentityCache(): void {
  cachedFingerprint = undefined;
  negativeCacheUntil = 0;
  lastFailureReason = null;
}
