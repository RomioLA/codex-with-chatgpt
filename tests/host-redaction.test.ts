import { describe, expect, it } from "vitest";
import { redactCommandLine } from "../src/host-observation/redaction.js";

describe("redactCommandLine", () => {
  it("redacts sensitive values across common command-line and environment forms", () => {
    const result = redactCommandLine(
      'tool --access_token=access-one --refresh_token refresh-two --password="two words" /passwd:pass-three CLIENT_SECRET=secret-four --api-key api-five --secret standalone-secret --credential credential-secret'
    );

    for (const secret of [
      "access-one",
      "refresh-two",
      "two words",
      "pass-three",
      "secret-four",
      "api-five",
      "standalone-secret",
      "credential-secret",
    ]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("tool");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts quoted authorization headers and the complete bare bearer value", () => {
    const result = redactCommandLine(
      'curl -H "Authorization: Bearer bearer-double-secret" -H \'Authorization: Bearer bearer-single-secret\' --authorization=Bearer bearer-option-secret --authorization=Basic basic-option-secret "Authorization"="Bearer bearer-quoted-key-secret" --mode safe'
    );

    expect(result).not.toContain("bearer-double-secret");
    expect(result).not.toContain("bearer-single-secret");
    expect(result).not.toContain("bearer-option-secret");
    expect(result).not.toContain("basic-option-secret");
    expect(result).not.toContain("bearer-quoted-key-secret");
    expect(result).not.toContain("Bearer");
    expect(result).toContain("--mode safe");
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("redacts URL query and fragment secrets with encoded names and values", () => {
    const result = redactCommandLine(
      "curl 'https://example.invalid/path?%61ccess%5Ftoken=url%2Dsecret&mode=public#api%2Dkey=fragment%2Dsecret'"
    );

    expect(result).not.toContain("url%2Dsecret");
    expect(result).not.toContain("fragment%2Dsecret");
    expect(result).toContain("mode=public");
  });

  it("redacts URI userinfo credentials and preserves ordinary hosts and paths", () => {
    const result = redactCommandLine(
      "client postgres://alice:db-secret@db.example/app mysql://root:mysql-secret@db.example/db http://web-user:web-secret@web.example/login"
    );

    for (const secret of ["alice", "db-secret", "root", "mysql-secret", "web-user", "web-secret"]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("db.example/app");
    expect(result).toContain("db.example/db");
    expect(result).toContain("web.example/login");
  });

  it("redacts percent-encoded URI userinfo and fails closed on ambiguous at signs", () => {
    const encoded = redactCommandLine(
      "postgres://alice%40team:db%2Dsecret@db.example/app mysql://root:p%40ss@db.example/db"
    );
    const encodedDelimiter = redactCommandLine("https://alice%3Asecret%40db.example/path");
    const ambiguous = redactCommandLine("http://alice:ambiguous-secret@proxy@internal.example/path");

    for (const secret of ["alice%40team", "db%2Dsecret", "root", "p%40ss"]) {
      expect(encoded).not.toContain(secret);
    }
    expect(encoded).toContain("db.example/app");
    expect(encoded).toContain("db.example/db");
    expect(encodedDelimiter).not.toContain("alice");
    expect(encodedDelimiter).not.toContain("secret");
    expect(encodedDelimiter).toContain("/path");
    expect(ambiguous).not.toContain("alice");
    expect(ambiguous).not.toContain("ambiguous-secret");
    expect(ambiguous).not.toContain("internal.example");
    expect(ambiguous).toContain("/path");
  });

  it("preserves unquoted URL parameters while redacting each sensitive parameter", () => {
    const result = redactCommandLine(
      "https://host/path?access_token=first-secret&refresh_token=second-secret&x=1#api_key=third-secret&view=full"
    );

    for (const secret of ["first-secret", "second-secret", "third-secret"]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain("&x=1");
    expect(result).toContain("&view=full");
  });

  it("redacts encoded ampersand-separated credentials inside a URL value", () => {
    const result = redactCommandLine(
      "https://host/path?access_token=first%26refresh_token%3Dencoded-secret&api_key=outer-secret&x=1"
    );

    expect(result).not.toContain("first%26refresh_token%3Dencoded-secret");
    expect(result).not.toContain("encoded-secret");
    expect(result).not.toContain("outer-secret");
    expect(result).toContain("&x=1");
  });

  it("redacts repeatedly percent-encoded key names", () => {
    const result = redactCommandLine("https://example.invalid/?%252561ccess%255Ftoken=deep-secret&ok=1");

    expect(result).not.toContain("deep-secret");
    expect(result).toContain("&ok=1");
  });

  it("redacts mixed-case, quoted keys, and keys with spaces or separators", () => {
    const result = redactCommandLine(
      `tool --PaSsWoRd='mixed secret' "api_key"="quoted-secret" pairing code: pair-secret /SESSION_ID:session-secret`
    );

    for (const secret of ["mixed secret", "quoted-secret", "pair-secret", "session-secret"]) {
      expect(result).not.toContain(secret);
    }
  });

  it("redacts multiple secrets in one command while retaining ordinary arguments", () => {
    const result = redactCommandLine(
      "tool --mode fast ACCESS_TOKEN=one-secret --verbose --cookie=two-secret --timeout 5"
    );

    expect(result).not.toContain("one-secret");
    expect(result).not.toContain("two-secret");
    expect(result).toContain("--mode fast");
    expect(result).toContain("--verbose");
    expect(result).toContain("--timeout 5");
  });

  it("fails closed for bare cookie values containing spaces", () => {
    const bare = redactCommandLine("tool --cookie a=b c=d --mode safe");
    const quoted = redactCommandLine('tool --cookie "a=b; c=d" --mode safe');
    const header = redactCommandLine("tool Cookie=one=abc; two=def --mode safe");

    for (const value of [bare, quoted, header]) {
      expect(value).not.toContain("a=b");
      expect(value).not.toContain("c=d");
      expect(value).not.toContain("one=abc");
      expect(value).not.toContain("two=def");
    }
    expect(bare).toContain("--mode safe");
    expect(quoted).toContain("--mode safe");
  });

  it("keeps non-sensitive parameters intact", () => {
    const command = "tool --mode fast /count:4 --exit_code 1 OTHER=value https://example.invalid/?page=2&sort=name";
    expect(redactCommandLine(command)).toBe(command);
  });

  it("redacts the uncertain suffix for shell injection syntax", () => {
    const commands = [
      "tool --password=$(printf 'injected secret') --mode safe",
      "tool --password=first-secret; echo second-secret",
      "tool --password=first-secret\\ second-secret --mode safe",
      "tool --password=abc^ def --mode safe",
      "tool --password=first-secret%3B%20echo%20second-secret --mode safe",
    ];

    for (const command of commands) {
      const result = redactCommandLine(command);
      expect(result).not.toContain("injected secret");
      expect(result).not.toContain("first-secret");
      expect(result).not.toContain("second-secret");
      expect(result).not.toContain("abc^");
      expect(result).not.toContain("def");
    }
  });

  it("redacts opaque PowerShell encoded commands and cmd /c payloads", () => {
    const encoded = [
      "powershell -EncodedCommand BASE64-ACCESS-TOKEN-PAYLOAD",
      "pwsh -ExecutionPolicy Bypass -EncodedCommand BASE64-REFRESH-TOKEN-PAYLOAD --mode safe",
      "pwsh -EncodedC BASE64-ENCODEDC-PAYLOAD",
      "pwsh -en BASE64-EN-PAYLOAD",
      "pwsh -ec BASE64-EC-PAYLOAD",
      "pwsh -ea BASE64-ENCODEDARGUMENTS-PAYLOAD",
      "pwsh -EncodedArguments BASE64-ENCODEDARGUMENTS-FULL-PAYLOAD",
      "PowerShell.exe -e BASE64-CLIENT-SECRET-PAYLOAD",
      "pwsh -UnknownOption Bypass -EncodedCommand BASE64-UNKNOWN-PAYLOAD",
    ];
    const commandShell = 'cmd /d /s /c "tool --password=cmd-secret"';
    const opaqueCommandShell = "cmd /d /s /c CMD-OPAQUE-SECRET";

    for (const command of encoded) {
      const result = redactCommandLine(command);
      expect(result).not.toContain("BASE64-");
      expect(result).toMatch(/\[REDACTED\]/);
    }
    expect(redactCommandLine(commandShell)).not.toContain("cmd-secret");
    expect(redactCommandLine(opaqueCommandShell)).not.toContain("CMD-OPAQUE-SECRET");
  });

  it("fails closed when percent encoding exceeds the bounded decode depth", () => {
    let key = "%70%61%73%73%77%6f%72%64";
    for (let depth = 0; depth < 9; depth += 1) key = key.replace(/%/g, "%25");
    const result = redactCommandLine(`tool --${key}=deep-secret --mode safe`);

    expect(result).not.toContain("deep-secret");
    expect(result).toBe("[REDACTED]");
  });

  it("does not leave an unclosed quoted secret visible", () => {
    const result = redactCommandLine('tool --password="unfinished secret with spaces');
    expect(result).not.toContain("unfinished secret with spaces");
  });
});
