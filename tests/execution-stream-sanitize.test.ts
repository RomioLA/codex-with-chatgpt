import { describe, expect, it } from "vitest";
import { StreamingSanitizer } from "../src/execution/stream-sanitize.js";

function sanitizeInChunks(input: string, splitAt: number): string {
  const sanitizer = new StreamingSanitizer();
  return sanitizer.push(input.slice(0, splitAt)) +
    sanitizer.push(input.slice(splitAt)) +
    sanitizer.finish();
}

describe("StreamingSanitizer", () => {
  it("redacts secrets split at every chunk boundary", () => {
    const samples = [
      "prefix c2c_at_abcdefghijklmnopqrstuvwxyz0123456789 suffix",
      "Authorization: Bearer bearer-double-secret",
      'tool --api-key="quoted secret material" --mode safe',
      "pairing code ABCD-EFGH failed",
      "wrote /Users/alice/private/project/file.ts",
      String.raw`wrote C:\Users\alice\private\project\file.ts`,
    ];

    for (const input of samples) {
      for (let splitAt = 0; splitAt <= input.length; splitAt++) {
        const output = sanitizeInChunks(input, splitAt);
        expect(output).not.toContain("c2c_at_");
        expect(output).not.toContain("bearer-double-secret");
        expect(output).not.toContain("quoted secret material");
        expect(output).not.toContain("ABCD-EFGH");
        expect(output).not.toContain("/Users/alice");
        expect(output).not.toContain(String.raw`C:\Users\alice`);
        if (input.includes("/Users/")) expect(output).toContain("/Users/[user]/private");
        if (input.includes("C:\\Users\\")) expect(output).toContain("C:\\Users\\[user]\\private");
      }
    }
  });

  it("redacts GitHub, OpenAI, and other token-shaped values across multiple chunks", () => {
    const secrets = [
      `ghp_${"g".repeat(24)}`,
      `github_pat_${"p".repeat(24)}`,
      `sk-${"s".repeat(24)}`,
      `xoxb-${"x".repeat(16)}`,
      `AKIA${"A".repeat(16)}`,
      `AIza${"a".repeat(24)}`,
    ];
    const sanitizer = new StreamingSanitizer();
    const output = secrets
      .map((secret) => {
        let result = "";
        for (let i = 0; i < secret.length; i += 3) result += sanitizer.push(secret.slice(i, i + 3));
        result += sanitizer.push("\n");
        return result;
      })
      .join("") + sanitizer.finish();

    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(secrets.length);
  });

  it("does not duplicate markers when a token is also inside a sensitive field", () => {
    const auth = sanitizeInChunks("Authorization: Bearer c2c_at_abcdefghijklmnopqrstuv", 20);
    const password = sanitizeInChunks("password=ghp_" + "g".repeat(24), 17);

    expect(auth).toBe("Authorization: Bearer [REDACTED]");
    expect(password).toBe("password=[REDACTED]");
  });

  it("consumes an unbounded key-value secret without retaining or emitting it", () => {
    const sanitizer = new StreamingSanitizer();
    const secret = "x".repeat(200_000);
    let output = sanitizer.push(`password=${secret}`);
    output += sanitizer.finish();

    expect(output).toBe("password=[REDACTED]");
    expect(output).not.toContain("x");
  });

  it("keeps sensitive-key detection across a long whitespace gap", () => {
    const sanitizer = new StreamingSanitizer();
    const gap = " ".repeat(120);
    const output = sanitizer.push("password") +
      sanitizer.push(gap) +
      sanitizer.push("=") +
      sanitizer.push(`${"secret".repeat(40)} done`) +
      sanitizer.finish();

    expect(output).toBe(`password${gap}=[REDACTED] done`);
  });

  it("keeps a long ordinary single line streaming and does not mark it truncated", () => {
    const sanitizer = new StreamingSanitizer();
    const line = "ordinary-output-".repeat(12_000);
    let output = "";
    for (let i = 0; i < line.length; i += 4_096) output += sanitizer.push(line.slice(i, i + 4_096));
    output += sanitizer.finish();

    expect(output).toBe(line);
    expect(sanitizer.truncated).toBe(false);
    expect(sanitizer.restrictedReason).toBeUndefined();
  });

  it("fails closed on private-key markers split across chunks", () => {
    const sanitizer = new StreamingSanitizer();
    const output =
      sanitizer.push("safe prefix\n-----BEGIN RSA PRIVATE") +
      sanitizer.push(" KEY-----\nprivate-material-must-not-escape") +
      sanitizer.push("\n-----END RSA PRIVATE KEY-----\nmore output") +
      sanitizer.finish();

    expect(output).toContain("safe prefix\n");
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(output).not.toContain("private-material-must-not-escape");
    expect(sanitizer.restrictedReason).toBe("private_key");
    expect(sanitizer.truncated).toBe(true);
    expect(sanitizer.push("later output")).toBe("");
  });

  it("detects PGP private-key markers and flushes only the safe prefix", () => {
    const sanitizer = new StreamingSanitizer();
    const output = sanitizer.push("done; ") + sanitizer.push("-----BEGIN PGP PRIVATE KEY BLOCK-----secret");

    expect(output).toContain("done; ");
    expect(output).not.toContain("PGP PRIVATE");
    expect(output).not.toContain("secret");
    expect(sanitizer.restrictedReason).toBe("private_key");
    expect(sanitizer.truncated).toBe(true);
  });

  it("flushes ordinary short tails and finish is idempotent", () => {
    const sanitizer = new StreamingSanitizer();
    expect(sanitizer.push("short output")).toBe("");
    expect(sanitizer.finish()).toBe("short output");
    expect(sanitizer.finish()).toBe("");
  });
});
