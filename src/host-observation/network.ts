import dns from "node:dns/promises";
import net from "node:net";
import { ObservationError } from "./types.js";

export function validateHostname(hostname: string): string {
  if (typeof hostname !== "string" || hostname.length > 253 || hostname.length === 0 ||
      net.isIP(hostname) || !hostname.split(".").every(label =>
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    throw new ObservationError("INVALID_HOSTNAME", "Expected an ASCII DNS hostname, without scheme, path, port or shell syntax");
  }
  return hostname.toLowerCase();
}
export function dnsError(code: string) {
  if (["ENOTFOUND", "ENODATA", "EAI_NONAME"].includes(code)) return "NOT_FOUND";
  if (["EAI_AGAIN", "ESERVFAIL", "EREFUSED", "ECONNREFUSED"].includes(code)) return "TEMPORARY_FAILURE";
  if (["ETIMEOUT", "ETIMEDOUT"].includes(code)) return "TIMEOUT";
  return "SYSTEM_ERROR";
}
export async function resolveHostname(input: string, createResolver = () => new dns.Resolver({ timeout: 2000, tries: 1 })) {
  const hostname = validateHostname(input);
  const resolver = createResolver();
  // Dedicated c-ares resolver can be cancelled; no lingering lookup thread after timeout.
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; resolver.cancel(); }, 5000);
  try {
    const answers = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses = [...new Set(answers.flatMap(a => a.status === "fulfilled" ? a.value : []))].slice(0, 64);
    const errors = answers.flatMap(a => a.status === "rejected" ? [dnsError(a.reason?.code ?? "")] : []);
    return { hostname, addresses, resolver: "system-configured DNS (Node c-ares)",
      error: addresses.length ? null : timedOut ? "TIMEOUT" : errors.find(e => e !== "NOT_FOUND") ?? "NOT_FOUND",
      partial: errors.length > 0, capturedAt: new Date().toISOString() };
  } finally { clearTimeout(timer); }
}
