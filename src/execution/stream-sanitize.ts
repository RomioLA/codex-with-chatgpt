/**
 * Incremental counterpart to sanitizeExecutionOutput.
 *
 * Instances are per stream. The private-key look-behind and token look-behind
 * are fixed size; open-ended secret values are consumed by state rather than
 * retained in a line-sized buffer.
 */

const PRIVATE_KEY_HEADER = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/;
const PRIVATE_HEADER_WINDOW = 64;
const TOKEN_WINDOW = 48;
const MAX_KEY_TAIL = 24;
const REDACTED = "[REDACTED]";

type TokenCandidate = {
  start: number;
  end: number;
  skipClass: RegExp;
  boundaryBefore: boolean;
  boundaryAfter: "word" | "any" | "none";
};

type HomeCandidate = {
  start: number;
  prefixEnd: number;
  pathStyle: "unix" | "windows";
  replacementPrefix: string;
};

type ValueMode =
  | { kind: "none" }
  | { kind: "value_start"; key: string }
  | { kind: "quoted_value"; quote: string; escaped: boolean }
  | { kind: "unquoted_value" }
  | { kind: "auth_first_word"; value: string }
  | { kind: "auth_token" }
  | { kind: "auth_rest_of_line" };

const TOKEN_PATTERNS: Array<{
  pattern: RegExp;
  skipClass: RegExp;
  boundaryBefore: boolean;
  boundaryAfter: "word" | "any" | "none";
}> = [
  { pattern: /c2c_(?:at|rt|ac|admin)_[A-Za-z0-9_-]+/g, skipClass: /[A-Za-z0-9_-]/, boundaryBefore: false, boundaryAfter: "none" },
  { pattern: /ghp_[A-Za-z0-9]{20,}/g, skipClass: /[A-Za-z0-9]/, boundaryBefore: true, boundaryAfter: "none" },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, skipClass: /[A-Za-z0-9_]/, boundaryBefore: true, boundaryAfter: "none" },
  { pattern: /sk-[A-Za-z0-9]{20,}/g, skipClass: /[A-Za-z0-9]/, boundaryBefore: true, boundaryAfter: "none" },
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, skipClass: /[A-Za-z0-9-]/, boundaryBefore: true, boundaryAfter: "none" },
  { pattern: /AKIA[0-9A-Z]{16}/g, skipClass: /[A-Za-z0-9_]/, boundaryBefore: true, boundaryAfter: "word" },
  { pattern: /AIza[0-9A-Za-z_-]{20,}/g, skipClass: /[A-Za-z0-9_-]/, boundaryBefore: true, boundaryAfter: "none" },
];

const SENSITIVE_KEYS = [
  "authorization",
  "access_token",
  "refresh_token",
  "client_secret",
  "code_verifier",
  "password",
  "passwd",
  "secret",
  "api_key",
  "api-key",
  "apikey",
  "code",
  "token",
];

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

function isKeyCharacter(char: string): boolean {
  return /[A-Za-z0-9_-]/.test(char);
}

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isHomeTerminator(char: string, style: "unix" | "windows"): boolean {
  return style === "unix"
    ? /[\/\s"'`]/.test(char)
    : /[\\/\s"'`]/.test(char);
}

function findHomeCandidate(input: string): HomeCandidate | undefined {
  const prefixes: Array<Omit<HomeCandidate, "start" | "prefixEnd"> & { prefix: RegExp }> = [
    { prefix: /\/Users\//g, pathStyle: "unix", replacementPrefix: "/Users/[user]" },
    { prefix: /\/home\//g, pathStyle: "unix", replacementPrefix: "/home/[user]" },
    { prefix: /C:\\Users\\/gi, pathStyle: "windows", replacementPrefix: String.raw`C:\Users\[user]` },
  ];
  const candidates: HomeCandidate[] = [];
  for (const item of prefixes) {
    item.prefix.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = item.prefix.exec(input)) !== null) {
      const prefixEnd = match.index + match[0].length;
      if (prefixEnd < input.length && !isHomeTerminator(input[prefixEnd], item.pathStyle)) {
        candidates.push({
          start: match.index,
          prefixEnd,
          pathStyle: item.pathStyle,
          replacementPrefix: item.replacementPrefix,
        });
      }
    }
  }
  return candidates.sort((a, b) => a.start - b.start)[0];
}

function findTokenCandidate(input: string, previousChar: string | undefined, atEnd: boolean): TokenCandidate | undefined {
  const candidates: TokenCandidate[] = [];
  for (const item of TOKEN_PATTERNS) {
    item.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = item.pattern.exec(input)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const before = start > 0 ? input[start - 1] : previousChar;
      if (item.boundaryBefore && isWordCharacter(before)) continue;
      const after = input[end];
      if (item.boundaryAfter === "word" && after === undefined && !atEnd) continue;
      if (item.boundaryAfter === "word" && isWordCharacter(after)) continue;
      candidates.push({
        start,
        end,
        skipClass: item.skipClass,
        boundaryBefore: item.boundaryBefore,
        boundaryAfter: item.boundaryAfter,
      });
    }
  }

  // Pairing-code-shaped values handled by the non-streaming logger sanitizer.
  const pairPattern = /[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairPattern.exec(input)) !== null) {
    const start = pair.index;
    const end = start + pair[0].length;
    const before = start > 0 ? input[start - 1] : previousChar;
    const after = input[end];
    if (isWordCharacter(before) || (after === undefined && !atEnd) || isWordCharacter(after)) continue;
    candidates.push({
      start,
      end,
      skipClass: /$a/, // This fixed-width value has no continuation state.
      boundaryBefore: true,
      boundaryAfter: "word",
    });
  }
  return candidates.sort((a, b) => a.start - b.start)[0];
}

/** Sanitize one stdout or stderr stream without retaining a complete line. */
export class StreamingSanitizer {
  private privateTail = "";
  private pending = "";
  private previousRawChar: string | undefined;
  private wordTail = "";
  private sensitiveKey: string | undefined;
  private mode: ValueMode = { kind: "none" };
  private tokenSkip: RegExp | undefined;
  private homeSkip: "unix" | "windows" | undefined;
  private closed = false;
  private _restrictedReason: "private_key" | undefined;
  private _truncated = false;

  /** A non-null reason means the caller must treat this entire stream as restricted. */
  get restrictedReason(): "private_key" | undefined {
    return this._restrictedReason;
  }

  /** True when fail-closed handling discarded output after detecting a private key. */
  get truncated(): boolean {
    return this._truncated;
  }

  /** Accept a chunk and return the portion that is safe to release now. */
  push(chunk: string): string {
    if (this.closed || this._restrictedReason) return "";
    let output = "";
    for (const char of chunk) {
      this.privateTail += char;
      const privateMatch = PRIVATE_KEY_HEADER.exec(this.privateTail);
      if (privateMatch) {
        output += this.acceptSafeText(this.privateTail.slice(0, privateMatch.index), true);
        this.privateTail = "";
        output += this.finishPending();
        this._restrictedReason = "private_key";
        this._truncated = true;
        return output;
      }
      if (this.privateTail.length > PRIVATE_HEADER_WINDOW) {
        output += this.acceptSafeText(this.privateTail[0]);
        this.privateTail = this.privateTail.slice(1);
      }
    }
    return output;
  }

  /** Flush a safe suffix. Repeated calls return an empty string. */
  finish(): string {
    if (this.closed) return "";
    this.closed = true;
    if (this._restrictedReason) return "";

    const privateMatch = PRIVATE_KEY_HEADER.exec(this.privateTail);
    if (privateMatch) {
      const safePrefix = this.privateTail.slice(0, privateMatch.index);
      this.privateTail = "";
      const output = this.acceptSafeText(safePrefix, true) + this.finishPending();
      this._restrictedReason = "private_key";
      this._truncated = true;
      return output;
    }

    let output = this.acceptSafeText(this.privateTail, true);
    this.privateTail = "";
    output += this.finishPending();
    return output;
  }

  private acceptSafeText(text: string, finalize = false): string {
    let output = "";
    for (const char of text) {
      this.pending += char;
      output += this.drainPending(false);
    }
    if (finalize) output += this.drainPending(true);
    return output;
  }

  private drainPending(atEnd: boolean): string {
    let output = "";
    while (this.pending.length > 0) {
      if (this.tokenSkip) {
        const originalLength = this.pending.length;
        let index = 0;
        while (index < this.pending.length && this.tokenSkip.test(this.pending[index])) index++;
        const consumedAll = index === originalLength;
        if (index > 0) {
          this.previousRawChar = this.pending[index - 1];
          this.pending = this.pending.slice(index);
        }
        if (consumedAll && !atEnd) break;
        this.tokenSkip = undefined;
        if (this.pending.length === 0) break;
        continue;
      }

      if (this.homeSkip) {
        const originalLength = this.pending.length;
        let index = 0;
        while (index < this.pending.length && !isHomeTerminator(this.pending[index], this.homeSkip)) index++;
        const consumedAll = index === originalLength;
        if (index > 0) {
          this.previousRawChar = this.pending[index - 1];
          this.pending = this.pending.slice(index);
        }
        if (consumedAll && !atEnd) break;
        this.homeSkip = undefined;
        if (this.pending.length === 0) break;
        continue;
      }

      const home = findHomeCandidate(this.pending);
      const token = findTokenCandidate(this.pending, this.previousRawChar, atEnd);
      if (home && (!token || home.start <= token.start)) {
        output += this.consumePendingPrefix(home.start);
        output += this.emitDetectedRedaction(home.replacementPrefix);
        let usernameEnd = home.prefixEnd - home.start;
        while (usernameEnd < this.pending.length && !isHomeTerminator(this.pending[usernameEnd], home.pathStyle)) usernameEnd++;
        if (usernameEnd === this.pending.length && !atEnd) {
          if (usernameEnd > home.prefixEnd) this.previousRawChar = this.pending[usernameEnd - 1];
          this.pending = "";
          this.homeSkip = home.pathStyle;
          break;
        }
        if (usernameEnd > home.prefixEnd) this.previousRawChar = this.pending[usernameEnd - 1];
        this.pending = this.pending.slice(usernameEnd);
        continue;
      }
      if (token) {
        output += this.consumePendingPrefix(token.start);
        output += this.emitDetectedRedaction(REDACTED);
        const consumedEnd = token.end;
        const extendsToBufferEnd = consumedEnd === this.pending.length && token.boundaryAfter === "none";
        if (consumedEnd > 0) this.previousRawChar = this.pending[consumedEnd - 1];
        this.pending = this.pending.slice(consumedEnd);
        if (extendsToBufferEnd) this.tokenSkip = token.skipClass;
        continue;
      }

      if (this.pending.length > TOKEN_WINDOW || atEnd) {
        output += this.consumePendingPrefix(1);
        continue;
      }
      break;
    }
    return output;
  }

  private consumePendingPrefix(length: number): string {
    const prefix = this.pending.slice(0, length);
    this.pending = this.pending.slice(length);
    let output = "";
    for (const char of prefix) {
      output += this.processPlainChar(char);
      this.previousRawChar = char;
    }
    return output;
  }

  private processPlainChar(char: string): string {
    if (this.mode.kind === "quoted_value") {
      if (this.mode.escaped) {
        this.mode.escaped = false;
        return "";
      }
      if (char === "\\") {
        this.mode.escaped = true;
        return "";
      }
      if (char === this.mode.quote) {
        this.mode = { kind: "none" };
        this.resetKeyScan();
        return char;
      }
      return "";
    }
    if (this.mode.kind === "unquoted_value") {
      if (isWhitespace(char)) {
        this.mode = { kind: "none" };
        this.resetKeyScan();
        return char;
      }
      return "";
    }
    if (this.mode.kind === "auth_first_word") {
      if (isWhitespace(char)) {
        const isBearer = this.mode.value.toLowerCase() === "bearer";
        this.mode = isBearer ? { kind: "auth_token" } : { kind: "auth_rest_of_line" };
        this.resetKeyScan();
        return isBearer ? `Bearer ${REDACTED}` : `${REDACTED}${char}`;
      }
      const next = this.mode.value + char;
      if (next.length <= 6 && "bearer".startsWith(next.toLowerCase())) {
        this.mode.value = next;
        return "";
      }
      this.mode = { kind: "auth_rest_of_line" };
      this.resetKeyScan();
      return REDACTED;
    }
    if (this.mode.kind === "auth_token") {
      if (isWhitespace(char)) {
        this.mode = { kind: "none" };
        this.resetKeyScan();
        return char;
      }
      return "";
    }
    if (this.mode.kind === "auth_rest_of_line") {
      if (char === "\n" || char === "\r") {
        this.mode = { kind: "none" };
        this.resetKeyScan();
        return char;
      }
      return "";
    }
    if (this.mode.kind === "value_start") {
      if (isWhitespace(char)) return char;
      const key = this.mode.key;
      if (char === "'" || char === '"') {
        this.mode = { kind: "quoted_value", quote: char, escaped: false };
        this.resetKeyScan();
        return `${char}${REDACTED}`;
      }
      if (key === "authorization") {
        this.mode = { kind: "auth_first_word", value: char };
        this.resetKeyScan();
        if (!"bearer".startsWith(char.toLowerCase())) {
          this.mode = { kind: "auth_rest_of_line" };
          return REDACTED;
        }
        return "";
      }
      this.mode = { kind: "unquoted_value" };
      this.resetKeyScan();
      return REDACTED;
    }

    if (this.sensitiveKey) {
      if (isWhitespace(char) || char === '"' || char === "'") return char;
      if (char === ":" || char === "=") {
        const key = this.sensitiveKey;
        this.mode = { kind: "value_start", key };
        this.sensitiveKey = undefined;
        this.wordTail = "";
        return char;
      }
      this.sensitiveKey = undefined;
    }

    if (isKeyCharacter(char)) {
      this.wordTail = (this.wordTail + char).slice(-MAX_KEY_TAIL);
      return char;
    }

    const key = this.findSensitiveKey(this.wordTail);
    this.wordTail = "";
    if (key) {
      if (isWhitespace(char) || char === '"' || char === "'") {
        this.sensitiveKey = key;
        return char;
      }
      if (char === ":" || char === "=") {
        this.mode = { kind: "value_start", key };
        return char;
      }
    }
    return char;
  }

  private findSensitiveKey(tail: string): string | undefined {
    return SENSITIVE_KEYS.find((key) => tail.toLowerCase().endsWith(key));
  }

  private emitDetectedRedaction(replacement: string): string {
    if (this.mode.kind === "value_start") {
      this.mode = this.mode.key === "authorization"
        ? { kind: "auth_rest_of_line" }
        : { kind: "unquoted_value" };
      this.resetKeyScan();
      return replacement;
    }
    if (this.mode.kind === "auth_first_word") {
      this.mode = { kind: "auth_rest_of_line" };
      this.resetKeyScan();
      return replacement;
    }
    if (this.mode.kind === "quoted_value" ||
        this.mode.kind === "unquoted_value" ||
        this.mode.kind === "auth_token" ||
        this.mode.kind === "auth_rest_of_line") {
      return "";
    }
    return replacement;
  }

  private resetKeyScan(): void {
    this.wordTail = "";
    this.sensitiveKey = undefined;
  }

  private finishPending(): string {
    let output = this.drainPending(true);
    if (this.mode.kind === "auth_first_word") {
      output += this.mode.value.toLowerCase() === "bearer"
        ? `Bearer ${REDACTED}`
        : REDACTED;
      this.mode = { kind: "none" };
    }
    return output;
  }
}
