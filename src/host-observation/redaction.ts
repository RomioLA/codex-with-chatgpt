const REDACTED = "[REDACTED]";
const MAX_COMMAND_LINE_LENGTH = 32_768;
const MAX_PERCENT_DECODE_PASSES = 8;

interface TextLayer {
  text: string;
  sourceStart: number[];
  sourceEnd: number[];
}

interface RedactionRange {
  start: number;
  end: number;
  replacement?: string;
}

interface ParsedValue {
  start: number;
  end: number;
}

const SENSITIVE_KEY =
  /(?<![A-Za-z0-9])(?:pairing[\s_-]*code|client[\s_-]*secret|access[\s_-]*token|refresh[\s_-]*token|api[\s_-]*key|session[\s_-]*(?:id|token)|credential(?:s)?|authorization|password|passwd|secret|bearer|cookie|session|token)(?![A-Za-z0-9_])/gi;
const HEX_BYTE = /^[\da-f]{2}$/i;

/** Redact credential values from a command line while retaining ordinary arguments. */
export function redactCommandLine(value: string): string {
  if (value.length === 0) return value;
  if (value.length > MAX_COMMAND_LINE_LENGTH) return REDACTED;

  const ranges: RedactionRange[] = findOpaqueShellRanges(value);
  let layer = initialLayer(value);
  let decodePasses = 0;

  // Decode percent escapes a layer at a time so encoded key names still map back
  // to the exact source bytes. Repeated encoding is common in URL fragments.
  for (;;) {
    collectSensitiveRanges(value, layer, ranges);
    collectUriUserInfoRanges(value, layer, ranges);
    const decoded = decodePercentLayer(layer);
    if (!decoded.changed) break;
    layer = decoded.layer;
    decodePasses += 1;
    if (decodePasses >= MAX_PERCENT_DECODE_PASSES) {
      collectSensitiveRanges(value, layer, ranges);
      collectUriUserInfoRanges(value, layer, ranges);
      if (decodePercentLayer(layer).changed) return REDACTED;
      break;
    }
  }

  if (ranges.length === 0) return value;

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: RedactionRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      if (!previous.replacement && range.start === previous.start) previous.replacement = range.replacement;
    } else {
      merged.push({ ...range });
    }
  }

  let output = "";
  let cursor = 0;
  for (const range of merged) {
    output += value.slice(cursor, range.start) + (range.replacement ?? REDACTED);
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function initialLayer(source: string): TextLayer {
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    sourceStart.push(index);
    sourceEnd.push(index + 1);
  }
  return { text: source, sourceStart, sourceEnd };
}

function decodePercentLayer(layer: TextLayer): { changed: boolean; layer: TextLayer } {
  const text: string[] = [];
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  let changed = false;

  for (let index = 0; index < layer.text.length;) {
    if (
      layer.text[index] === "%" &&
      index + 2 < layer.text.length &&
      HEX_BYTE.test(layer.text.slice(index + 1, index + 3))
    ) {
      text.push(String.fromCharCode(Number.parseInt(layer.text.slice(index + 1, index + 3), 16)));
      sourceStart.push(layer.sourceStart[index]);
      sourceEnd.push(layer.sourceEnd[index + 2]);
      index += 3;
      changed = true;
      continue;
    }

    text.push(layer.text[index]);
    sourceStart.push(layer.sourceStart[index]);
    sourceEnd.push(layer.sourceEnd[index]);
    index += 1;
  }

  return { changed, layer: { text: text.join(""), sourceStart, sourceEnd } };
}

function collectSensitiveRanges(source: string, layer: TextLayer, ranges: RedactionRange[]): void {
  SENSITIVE_KEY.lastIndex = 0;
  let coveredUntil = 0;
  for (let match = SENSITIVE_KEY.exec(layer.text); match; match = SENSITIVE_KEY.exec(layer.text)) {
    const keyStart = match.index;
    if (keyStart < coveredUntil) continue;
    const keyEnd = keyStart + match[0].length;
    const parsed = parseValue(source, layer, keyStart, keyEnd);
    if (!parsed || parsed.end <= parsed.start) continue;
    coveredUntil = Math.max(coveredUntil, parsed.end);

    const rawStart = layer.sourceStart[parsed.start];
    const rawEnd = layer.sourceEnd[parsed.end - 1];
    if (rawEnd > rawStart) ranges.push({ start: rawStart, end: rawEnd });
  }
}

function collectUriUserInfoRanges(source: string, layer: TextLayer, ranges: RedactionRange[]): void {
  const scheme = /[A-Za-z][A-Za-z\d+.-]*:\/\//g;
  for (let match = scheme.exec(layer.text); match; match = scheme.exec(layer.text)) {
    const authorityStart = match.index + match[0].length;
    let authorityEnd = authorityStart;
    while (authorityEnd < layer.text.length) {
      const char = layer.text[authorityEnd];
      if (isLiteral(source, layer, authorityEnd) && (/[/?#]/.test(char) || isWhitespace(char) || isQuote(char))) break;
      authorityEnd += 1;
    }
    if (authorityEnd <= authorityStart) continue;

    const literalAt: number[] = [];
    let encodedAt = false;
    for (let index = authorityStart; index < authorityEnd; index += 1) {
      if (layer.text[index] !== "@") continue;
      if (isLiteral(source, layer, index)) literalAt.push(index);
      else encodedAt = true;
    }

    const rawStart = layer.sourceStart[authorityStart];
    if (literalAt.length === 1 && literalAt[0] > authorityStart) {
      const rawEnd = layer.sourceEnd[literalAt[0]];
      ranges.push({ start: rawStart, end: rawEnd, replacement: `${REDACTED}@` });
    } else if (literalAt.length > 1 || (literalAt.length === 0 && encodedAt)) {
      const rawEnd = layer.sourceEnd[authorityEnd - 1];
      if (rawEnd > rawStart) ranges.push({ start: rawStart, end: rawEnd });
    }
  }
}

function parseValue(source: string, layer: TextLayer, keyStart: number, keyEnd: number): ParsedValue | null {
  const { text } = layer;
  let cursor = keyEnd;

  // JSON-style quoted keys place a closing quote between the key and separator.
  if (isQuote(text[cursor]) && isLiteral(source, layer, cursor)) {
    let probe = cursor + 1;
    while (probe < text.length && isWhitespace(text[probe])) probe += 1;
    if (text[probe] === "=" || text[probe] === ":") cursor += 1;
  }

  while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  const hadWhitespaceAfterKey = cursor > keyEnd;
  if (text[cursor] === "=" || text[cursor] === ":") {
    cursor += 1;
    while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  } else if (!hadWhitespaceAfterKey) {
    return null;
  }

  if (cursor >= text.length) return null;
  const valueStart = cursor;
  if (isWhitespace(text[valueStart]) || isLiteral(source, layer, valueStart) && /[&#]/.test(text[valueStart])) return null;

  const inUrlParameter = isInsideUrlParameter(layer, keyStart);
  const quoteContext = findQuoteContext(source, layer, keyStart);
  const outerQuote = inUrlParameter ? null : quoteContext;
  if (isQuote(text[valueStart]) && isLiteral(source, layer, valueStart)) {
    const quote = text[valueStart];
    const close = findClosingQuote(source, layer, valueStart + 1, quote);
    if (close < 0) return { start: valueStart + 1, end: text.length };

    const contentStart = valueStart + 1;
    const unsafeExpansion = quote === '"' && containsLiteralShellExpansion(source, layer, contentStart, close);
    return { start: contentStart, end: unsafeExpansion ? text.length : close };
  }

  if (outerQuote) {
    const close = findClosingQuote(source, layer, valueStart, outerQuote);
    return { start: valueStart, end: close < 0 ? text.length : close };
  }

  let end = valueStart;
  while (end < text.length) {
    if (inUrlParameter && quoteContext && isLiteral(source, layer, end) && text[end] === quoteContext) break;
    if (isLiteral(source, layer, end) && isWhitespace(text[end])) break;
    if (isLiteral(source, layer, end) && /[&#]/.test(text[end])) {
      if (inUrlParameter && isWellFormedUrlParameterAhead(source, layer, end)) break;
      return { start: valueStart, end: text.length };
    }
    end += 1;
  }
  if (end === valueStart) return null;

  const keyText = text.slice(keyStart, keyEnd).replace(/[\s_-]+/g, "").toLowerCase();
  if (keyText === "cookie" && !inUrlParameter && !quoteContext) {
    end = extendBareCookieValue(source, layer, end);
  }
  const first = text.slice(valueStart, end);
  // Unquoted authorization values often contain a scheme and a credential.
  const isAuthorizationValue = keyText === "authorization";
  const isBearerValue = keyText === "bearer" && first.toLowerCase() === "bearer";
  const isPairingCodePhrase = keyText === "pairingcode" && first.toLowerCase() === "is";
  if (isAuthorizationValue || isBearerValue || isPairingCodePhrase) {
    let secondStart = end;
    while (secondStart < text.length && isWhitespace(text[secondStart])) secondStart += 1;
    if (secondStart < text.length && !isCommandOptionAt(source, layer, secondStart)) {
      let secondEnd = secondStart;
      while (
        secondEnd < text.length &&
        !(isLiteral(source, layer, secondEnd) && isWhitespace(text[secondEnd])) &&
        !(isLiteral(source, layer, secondEnd) && /[&#]/.test(text[secondEnd]))
      ) secondEnd += 1;
      end = secondEnd;
    }
  }

  // Shell syntax can make a nominal value span more than one word. Hide the
  // remaining command when its extent cannot be parsed with confidence.
  if (containsLiteralShellSyntax(source, layer, valueStart, end)) return { start: valueStart, end: text.length };
  return { start: valueStart, end };
}

function isInsideUrlParameter(layer: TextLayer, keyStart: number): boolean {
  let lastBoundary = -1;
  let queryMarker = -1;
  for (let index = 0; index < keyStart; index += 1) {
    const char = layer.text[index];
    if (isWhitespace(char) || isQuote(char)) {
      lastBoundary = index;
      queryMarker = -1;
    } else if (char === "?" || char === "#") {
      queryMarker = index;
    }
  }
  return queryMarker > lastBoundary;
}

function isWellFormedUrlParameterAhead(source: string, layer: TextLayer, delimiter: number): boolean {
  let cursor = delimiter + 1;
  if (cursor >= layer.text.length || isWhitespace(layer.text[cursor])) return false;
  for (; cursor < layer.text.length; cursor += 1) {
    const char = layer.text[cursor];
    if (isLiteral(source, layer, cursor) && isWhitespace(char)) return false;
    if (char === "=") return cursor > delimiter + 1;
    if ((char === "&" || char === "#") && isLiteral(source, layer, cursor)) return false;
  }
  return false;
}

function extendBareCookieValue(source: string, layer: TextLayer, initialEnd: number): number {
  let end = initialEnd;
  let cursor = initialEnd;
  while (cursor < layer.text.length) {
    while (cursor < layer.text.length && isLiteral(source, layer, cursor) && isWhitespace(layer.text[cursor])) cursor += 1;
    if (cursor >= layer.text.length || isCommandOptionAt(source, layer, cursor)) break;
    while (cursor < layer.text.length && !(isLiteral(source, layer, cursor) && isWhitespace(layer.text[cursor]))) cursor += 1;
    end = cursor;
  }
  return end;
}

function isCommandOptionAt(source: string, layer: TextLayer, index: number): boolean {
  if (!isLiteral(source, layer, index)) return false;
  const char = layer.text[index];
  if (char === "-") {
    if (isLiteral(source, layer, index + 1) && layer.text[index + 1] === "-") {
      return isLiteral(source, layer, index + 2) && /[A-Za-z]/.test(layer.text[index + 2]);
    }
    return isLiteral(source, layer, index + 1) && /[A-Za-z]/.test(layer.text[index + 1]);
  }
  if (char === "/") {
    return isLiteral(source, layer, index + 1) && /[A-Za-z]/.test(layer.text[index + 1]);
  }
  return false;
}

function findOpaqueShellRanges(source: string): RedactionRange[] {
  const ranges: RedactionRange[] = [];
  const commandShell = /(^|[\s"'`])(?:(?:[^\s"'`]*[\\/])?(?:cmd(?:\.exe)?))(?=$|[\s"'`])/gi;
  for (let match = commandShell.exec(source); match; match = commandShell.exec(source)) {
    let cursor = match.index + match[0].length;
    while (isQuote(source[cursor])) cursor += 1;
    const range = findCmdPayloadRange(source, cursor);
    if (range) ranges.push(range);
  }

  const powershell = /(^|[\s"'`])(?:(?:[^\s"'`]*[\\/])?(?:powershell|pwsh)(?:\.exe)?)(?=$|[\s"'`])/gi;
  for (let match = powershell.exec(source); match; match = powershell.exec(source)) {
    let cursor = match.index + match[0].length;
    while (isQuote(source[cursor])) cursor += 1;
    const range = findPowerShellPayloadRange(source, cursor);
    if (range) ranges.push(range);
  }

  return ranges;
}

interface CommandToken {
  text: string;
  start: number;
  end: number;
}

function nextCommandToken(source: string, from: number): CommandToken | null {
  let cursor = from;
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  if (cursor >= source.length) return null;

  const start = cursor;
  let quote: "'" | '"' | null = null;
  while (cursor < source.length) {
    const char = source[cursor];
    if (quote && char === "\\" && quote === '"' && cursor + 1 < source.length) {
      cursor += 2;
      continue;
    }
    if (quote === null && isQuote(char)) quote = char;
    else if (quote === char) quote = null;
    else if (quote === null && /\s/.test(char)) break;
    cursor += 1;
  }
  return { text: source.slice(start, cursor), start, end: cursor };
}

function unquoteToken(value: string): string {
  return value.length >= 2 && isQuote(value[0]) && value[value.length - 1] === value[0]
    ? value.slice(1, -1)
    : value;
}

function findCmdPayloadRange(source: string, from: number): RedactionRange | null {
  let cursor = from;
  for (;;) {
    const token = nextCommandToken(source, cursor);
    if (!token) return null;
    cursor = token.end;

    const switchText = unquoteToken(token.text);
    if (!switchText.startsWith("/")) return { start: token.start, end: source.length };
    const separator = switchText.search(/[:=]/);
    const switchName = (separator >= 0 ? switchText.slice(0, separator) : switchText).toLowerCase();

    if (switchName === "/c" || switchName === "/k") {
      const rawSeparator = token.text.search(/[:=]/);
      if (rawSeparator >= 0 && rawSeparator + 1 < token.text.length) {
        return { start: token.start + rawSeparator + 1, end: source.length };
      }
      const command = nextCommandToken(source, token.end);
      return command ? { start: command.start, end: source.length } : null;
    }

    if (["/d", "/s", "/q", "/a", "/u"].includes(switchName) && separator < 0) continue;
    if (["/e", "/f", "/t", "/v"].includes(switchName)) {
      if (separator < 0) {
        const switchValue = nextCommandToken(source, token.end);
        if (!switchValue) return null;
        if (switchValue.text.startsWith("/")) return { start: switchValue.start, end: source.length };
        cursor = switchValue.end;
      }
      continue;
    }

    return { start: token.start, end: source.length };
  }
}

function findPowerShellPayloadRange(source: string, from: number): RedactionRange | null {
  let cursor = from;
  const valueOptions = [
    "executionpolicy",
    "inputformat",
    "outputformat",
    "configurationname",
    "configurationfile",
    "settingsfile",
    "workingdirectory",
    "psconsolefile",
    "custompipename",
    "version",
  ];
  const noValueOptions = ["nologo", "noexit", "noninteractive", "noprofile", "sta", "mta"];

  for (;;) {
    const token = nextCommandToken(source, cursor);
    if (!token) return null;
    cursor = token.end;

    const optionText = unquoteToken(token.text);
    if (!optionText.startsWith("-")) return { start: token.start, end: source.length };
    const separator = optionText.search(/[:=]/);
    const optionName = (separator >= 0 ? optionText.slice(0, separator) : optionText)
      .replace(/^-+/, "")
      .toLowerCase();
    const rawSeparator = token.text.search(/[:=]/);
    const hasInlineValue = separator >= 0 && separator + 1 < optionText.length;

    if (isEncodedPowerShellOption(optionName)) {
      if (hasInlineValue && rawSeparator >= 0 && rawSeparator + 1 < token.text.length) {
        return { start: token.start + rawSeparator + 1, end: source.length };
      }
      const payload = nextCommandToken(source, token.end);
      return payload ? { start: payload.start, end: source.length } : null;
    }

    if (isPowerShellCommandOption(optionName)) {
      if (hasInlineValue && rawSeparator >= 0 && rawSeparator + 1 < token.text.length) {
        return { start: token.start + rawSeparator + 1, end: source.length };
      }
      const payload = nextCommandToken(source, token.end);
      return payload ? { start: payload.start, end: source.length } : null;
    }

    if (isPowerShellValueOption(optionName, valueOptions)) {
      if (hasInlineValue) continue;
      const optionValue = nextCommandToken(source, token.end);
      if (!optionValue) return null;
      if (optionValue.text.startsWith("-")) return { start: optionValue.start, end: source.length };
      cursor = optionValue.end;
      continue;
    }

    if (isPowerShellNoValueOption(optionName, noValueOptions) && separator < 0) continue;
    return { start: token.start, end: source.length };
  }
}

function isEncodedPowerShellOption(name: string): boolean {
  return name === "e" || name === "ec" || name === "ea" ||
    (name.length >= 2 && ("encodedcommand".startsWith(name) || "encodedarguments".startsWith(name)));
}

function isPowerShellCommandOption(name: string): boolean {
  return name === "command" || name === "c" || (name.length >= 2 && "command".startsWith(name));
}

function isPowerShellValueOption(name: string, fullNames: string[]): boolean {
  const aliases = new Set(["ep", "if", "of", "cn", "cf", "wd", "psc", "cpn"]);
  return aliases.has(name) || (name.length >= 2 && fullNames.some((fullName) => fullName.startsWith(name)));
}

function isPowerShellNoValueOption(name: string, fullNames: string[]): boolean {
  const aliases = new Set(["nol", "noe", "noni", "nop", "s", "m"]);
  return aliases.has(name) || (name.length >= 2 && fullNames.some((fullName) => fullName.startsWith(name)));
}

function findQuoteContext(source: string, layer: TextLayer, end: number): "'" | '"' | null {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < end; index += 1) {
    const char = layer.text[index];
    if (!isLiteral(source, layer, index)) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === null && isQuote(char)) quote = char;
    else if (quote === char) quote = null;
  }
  return quote;
}

function findClosingQuote(source: string, layer: TextLayer, start: number, quote: "'" | '"'): number {
  let escaped = false;
  for (let index = start; index < layer.text.length; index += 1) {
    if (!isLiteral(source, layer, index)) continue;
    const char = layer.text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

function containsLiteralShellExpansion(source: string, layer: TextLayer, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!isLiteral(source, layer, index)) continue;
    if (layer.text[index] === "`" || layer.text[index] === "$") return true;
  }
  return false;
}

function containsLiteralShellSyntax(source: string, layer: TextLayer, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    if (!isLiteral(source, layer, index)) continue;
    if (/[\\$;|&<>`()^]/.test(layer.text[index])) return true;
  }
  return false;
}

function isLiteral(source: string, layer: TextLayer, index: number): boolean {
  return (
    index >= 0 &&
    index < layer.text.length &&
    layer.sourceEnd[index] === layer.sourceStart[index] + 1 &&
    source[layer.sourceStart[index]] === layer.text[index]
  );
}

function isQuote(value: string | undefined): value is "'" | '"' {
  return value === "'" || value === '"';
}

function isWhitespace(value: string | undefined): boolean {
  return value !== undefined && /\s/.test(value);
}
