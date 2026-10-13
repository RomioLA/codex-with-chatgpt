import path from "node:path";
import fs from "node:fs";

/**
 * The Level 3 shell modes pass one command string to a real shell. This helper
 * deliberately recognizes only common, literal script-entry forms; it is not
 * a PowerShell or cmd.exe parser.
 */
export type ScriptEntryEngine = "program" | "powershell" | "cmd";

export interface ScriptEntryBindingInput {
  engine: ScriptEntryEngine;
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Absolute process working directory. */
  cwd: string;
  /** Required for direct program mode. */
  executable?: string;
  /** Required for direct program mode; each item is one already-separated argv value. */
  args?: readonly string[];
  /** Required for PowerShell and cmd mode. */
  command?: string;
}

export type ScriptEntrySource = "program-argument" | "shell-command";

export interface BoundScriptEntry {
  /** Literal script path as it appeared in argv or command text. */
  reference: string;
  /** Lexically resolved path. File existence and repository containment are checked by Level 3. */
  absolutePath: string;
  /** Workspace-relative path to append to Level3Spec.materials before canonicalization. */
  materialPath: string;
  source: ScriptEntrySource;
}

export type ScriptEntryUncertainty =
  | "shell-expansion"
  | "computed-path"
  | "computed-command"
  | "unsupported-shell-syntax"
  | "unclosed-quote"
  | "ambiguous-command-search"
  | "interpreter-eval"
  | "opaque-nested-command";

export interface ScriptEntryBindingResult {
  /** Explicit script files that the caller must add to the approved materials. */
  entries: BoundScriptEntry[];
  /** Convenience list matching Level3Spec.materials. */
  materials: string[];
  /** True whenever command behavior may select or construct another entry at runtime. */
  hasUnresolvedSemantics: boolean;
  /** Stable, deduplicated reasons for local review and approval preview. */
  uncertainties: ScriptEntryUncertainty[];
}

interface Token {
  value: string;
  dynamic: boolean;
}

interface LexedCommand {
  segments: Token[][];
  uncertainties: Set<ScriptEntryUncertainty>;
}

const SCRIPT_EXTENSIONS = new Set([
  ".ps1", ".cmd", ".bat", ".py", ".pyw", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
]);
const POWERSHELL_ENTRY_EXTENSIONS = new Set([".ps1"]);
const CMD_ENTRY_EXTENSIONS = new Set([".cmd", ".bat"]);

const INTERPRETERS = new Set([
  "python", "python2", "python3", "py", "node", "deno", "bun", "tsx", "ts-node",
  "pwsh", "powershell", "cmd", "wscript", "cscript", "ruby", "perl", "bash", "sh",
]);

const POWERSHELL_BUILTINS = new Set([
  "add-content", "cd", "clear-host", "cls", "copy-item", "dir", "echo", "exit", "foreach-object",
  "get-childitem", "get-command", "get-content", "get-help", "get-item", "get-location", "iex",
  "invoke-expression", "join-path", "ls", "measure-object", "move-item", "new-item", "pop-location",
  "push-location", "pwd", "remove-item", "resolve-path", "select-object", "set-content", "set-location", "start-process",
  "sort-object", "split-path", "start-sleep", "test-path", "where-object", "write-debug", "write-error",
  "write-host", "write-output", "write-progress", "write-verbose", "write-warning",
]);

const CMD_BUILTINS = new Set([
  "::", "assoc", "break", "call", "cd", "chcp", "chdir", "cls", "color", "copy", "date", "del", "dir",
  "echo", "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink",
  "move", "path", "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir",
  "set", "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
]);

const UNCERTAINTY_ORDER: ScriptEntryUncertainty[] = [
  "shell-expansion", "computed-path", "computed-command", "unsupported-shell-syntax", "unclosed-quote",
  "ambiguous-command-search", "interpreter-eval", "opaque-nested-command",
];

function extensionOf(value: string): string {
  return path.extname(value).toLowerCase();
}

function hasScriptExtension(value: string): boolean {
  return SCRIPT_EXTENSIONS.has(extensionOf(value));
}

function normalizeCommandName(value: string): string {
  const basename = path.basename(value).toLowerCase();
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

function isInterpreter(value: string): boolean {
  return INTERPRETERS.has(normalizeCommandName(value));
}

function existsAsFileInput(input: ScriptEntryBindingInput, reference: string): boolean {
  const target = path.resolve(input.cwd, reference);
  const relative = path.relative(input.workspaceRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(target))) return false;
  try {
    // Never probe a file through a reparse parent. Return it as a material
    // candidate so canonicalization rejects the path instead of omitting it.
    let parent = input.workspaceRoot;
    for (const component of relative.split(path.sep).slice(0, -1)) {
      parent = path.join(parent, component);
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink()) return true;
      if (!stat.isDirectory()) return false;
    }
    const stat = fs.lstatSync(target);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function lexShell(command: string, engine: "powershell" | "cmd"): LexedCommand {
  const segments: Token[][] = [];
  const uncertainties = new Set<ScriptEntryUncertainty>();
  let segment: Token[] = [];
  let value = "";
  let tokenDynamic = false;
  let quote: "'" | '"' | null = null;

  const flushToken = () => {
    if (value.length > 0 || tokenDynamic) segment.push({ value, dynamic: tokenDynamic });
    value = "";
    tokenDynamic = false;
  };
  const flushSegment = () => {
    flushToken();
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (engine === "powershell" && quote === "'" && char === "'" && next === "'") {
      value += "'";
      index += 1;
      continue;
    }

    if (quote !== null) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (engine === "powershell" && quote === '"' && char === "`") {
        uncertainties.add("unsupported-shell-syntax");
        tokenDynamic = true;
        if (next !== undefined) {
          value += next;
          index += 1;
        }
        continue;
      }
      if (engine === "powershell" && quote === '"' && char === "$") {
        uncertainties.add("shell-expansion");
        tokenDynamic = true;
      }
      if (engine === "cmd" && (char === "%" || char === "!")) {
        uncertainties.add("shell-expansion");
        tokenDynamic = true;
      }
      value += char;
      continue;
    }

    if (engine === "powershell" && char === "#") {
      flushToken();
      while (index < command.length && command[index] !== "\n" && command[index] !== "\r") index += 1;
      if (index < command.length) flushSegment();
      continue;
    }

    if (char === '"' || (engine === "powershell" && char === "'")) {
      quote = char;
      continue;
    }

    if (engine === "powershell" && char === "`") {
      uncertainties.add("unsupported-shell-syntax");
      tokenDynamic = true;
      if (next !== undefined) {
        value += next;
        index += 1;
      }
      continue;
    }
    if (engine === "powershell" && char === "$") {
      uncertainties.add("shell-expansion");
      tokenDynamic = true;
      value += char;
      continue;
    }
    if (engine === "cmd" && char === "^") {
      uncertainties.add("unsupported-shell-syntax");
      tokenDynamic = true;
      if (next !== undefined) {
        value += next;
        index += 1;
      }
      continue;
    }
    if (engine === "cmd" && (char === "%" || char === "!")) {
      uncertainties.add("shell-expansion");
      tokenDynamic = true;
      value += char;
      continue;
    }

    if (char === "\r" || char === "\n") {
      flushSegment();
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flushToken();
      continue;
    }

    if (engine === "powershell" && (char === "(" || char === ")" || char === "{" || char === "}" || char === "<" || char === ">" || char === ",")) {
      uncertainties.add("unsupported-shell-syntax");
      flushSegment();
      continue;
    }
    if (engine === "cmd" && (char === "(" || char === ")" || char === "<" || char === ">")) {
      uncertainties.add("unsupported-shell-syntax");
      flushSegment();
      continue;
    }

    if (char === ";" || char === "|") {
      flushSegment();
      continue;
    }
    if (char === "&") {
      flushToken();
      if (engine === "powershell" && segment.length === 0) {
        // PowerShell's leading & is a call operator, not a command separator.
        segment.push({ value: "&", dynamic: false });
      } else {
        if (segment.length > 0) segments.push(segment);
        segment = [];
      }
      if (next === "&") index += 1;
      continue;
    }

    if (engine === "powershell" && char === "~") {
      uncertainties.add("shell-expansion");
      tokenDynamic = true;
    }
    value += char;
  }

  if (quote !== null) uncertainties.add("unclosed-quote");
  flushSegment();
  return { segments, uncertainties };
}

function getScriptReference(token: Token, uncertainties: Set<ScriptEntryUncertainty>): string | undefined {
  if (!hasScriptExtension(token.value)) return undefined;
  if (token.dynamic || /[*?]/.test(token.value)) {
    uncertainties.add("computed-path");
    return undefined;
  }
  return token.value;
}

function shellEntryExtensionAllowed(engine: "powershell" | "cmd", value: string): boolean {
  const extension = extensionOf(value);
  return engine === "powershell"
    ? POWERSHELL_ENTRY_EXTENSIONS.has(extension)
    : CMD_ENTRY_EXTENSIONS.has(extension);
}

function optionValue(value: string): string | undefined {
  const separator = value.indexOf("=");
  if (separator < 0 || separator === value.length - 1) return undefined;
  return value.slice(separator + 1).replace(/^['"]|['"]$/g, "");
}

function bindingResult(input: ScriptEntryBindingInput, found: Array<{ reference: string; source: ScriptEntrySource }>, uncertainties: Set<ScriptEntryUncertainty>): ScriptEntryBindingResult {
  const entries: BoundScriptEntry[] = [];
  const seen = new Set<string>();
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const cwd = path.resolve(input.cwd);

  for (const item of found) {
    const absolutePath = path.resolve(cwd, item.reference);
    const key = process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({
      reference: item.reference,
      absolutePath,
      materialPath: path.relative(workspaceRoot, absolutePath).split(path.sep).join("/"),
      source: item.source,
    });
  }

  const orderedUncertainties = UNCERTAINTY_ORDER.filter((reason) => uncertainties.has(reason));
  return {
    entries,
    materials: entries.map((entry) => entry.materialPath),
    hasUnresolvedSemantics: orderedUncertainties.length > 0,
    uncertainties: orderedUncertainties,
  };
}

function addProgramEntries(input: ScriptEntryBindingInput, found: Array<{ reference: string; source: ScriptEntrySource }>, uncertainties: Set<ScriptEntryUncertainty>): void {
  const args = input.args ?? [];
  const interpreter = input.executable ? normalizeCommandName(input.executable) : "";
  const isNode = ["node", "deno", "bun", "tsx", "ts-node"].includes(interpreter);
  const isPython = ["python", "python2", "python3", "py"].includes(interpreter);
  const allowed = (value: string) => {
    const extension = extensionOf(value);
    if (isNode) return [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension);
    if (isPython) return [".py", ".pyw"].includes(extension);
    return hasScriptExtension(value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if ((isNode && (arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print")) ||
        (isPython && (arg === "-c" || arg === "-m"))) {
      uncertainties.add("interpreter-eval");
    }
    const attached = optionValue(arg);
    const candidate = attached ?? arg;
    const relative = path.relative(input.workspaceRoot, path.resolve(input.cwd, candidate));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      // No external filesystem probe. Unknown program parameters may select
      // external resources; exact argv alone does not freeze those contents.
      uncertainties.add("computed-path");
    }
    if (allowed(candidate) || existsAsFileInput(input, candidate)) {
      found.push({ reference: candidate, source: "program-argument" });
    }
  }
}

function addShellEntries(input: ScriptEntryBindingInput, engine: "powershell" | "cmd", found: Array<{ reference: string; source: ScriptEntrySource }>, uncertainties: Set<ScriptEntryUncertainty>): void {
  const lexed = lexShell(input.command ?? "", engine);
  for (const reason of lexed.uncertainties) uncertainties.add(reason);

  for (const segment of lexed.segments) {
    if (segment.length === 0) continue;
    let commandIndex = 0;
    if (engine === "powershell" && segment[0]!.value === "&") commandIndex = 1;

    if (engine === "powershell" && segment[commandIndex]?.value === ".") {
      const target = segment[commandIndex + 1];
      if (target) {
        const reference = getScriptReference(target, uncertainties);
        if (reference && shellEntryExtensionAllowed(engine, reference)) found.push({ reference, source: "shell-command" });
      }
      continue;
    }

    if (commandIndex >= segment.length) continue;
    let commandToken = segment[commandIndex]!;
    let commandValue = commandToken.value;
    let commandName = normalizeCommandName(commandValue);

    if (engine === "cmd" && commandName === "call") {
      commandIndex += 1;
      commandToken = segment[commandIndex] ?? commandToken;
      commandValue = commandToken.value;
      commandName = normalizeCommandName(commandValue);
    }

    const directEntry = getScriptReference(commandToken, uncertainties);
    if (directEntry && shellEntryExtensionAllowed(engine, directEntry)) {
      if (!path.isAbsolute(directEntry) && !/[\\/]/.test(directEntry)) {
        if (engine === "cmd" && existsAsFileInput(input, directEntry)) {
          found.push({ reference: directEntry, source: "shell-command" });
        } else {
          uncertainties.add("ambiguous-command-search");
        }
      } else {
        found.push({ reference: directEntry, source: "shell-command" });
      }
      continue;
    }

    if (engine === "cmd" && commandName === "start") {
      for (const token of segment.slice(commandIndex + 1)) {
        const reference = getScriptReference(token, uncertainties);
        if (reference && shellEntryExtensionAllowed(engine, reference)) {
          if (!path.isAbsolute(reference) && !/[\\/]/.test(reference)) uncertainties.add("ambiguous-command-search");
          else found.push({ reference, source: "shell-command" });
        }
      }
      continue;
    }

    const builtins = engine === "powershell" ? POWERSHELL_BUILTINS : CMD_BUILTINS;
    if (builtins.has(commandName)) {
      if ((commandName === "invoke-expression" || commandName === "iex") && segment.length > commandIndex + 1) {
        uncertainties.add("computed-command");
      }
      if (engine === "powershell" && commandName === "start-process") {
        const args = segment.slice(commandIndex + 1);
        for (let index = 0; index < args.length; index += 1) {
          const token = args[index]!;
          const option = token.value.toLowerCase();
          if (option === "-filepath" || option === "-argumentlist") {
            const next = args[index + 1];
            if (next) {
              const reference = getScriptReference(next, uncertainties);
              if (reference) found.push({ reference, source: "shell-command" });
            }
          } else {
            const attached = optionValue(token.value);
            if (attached && hasScriptExtension(attached)) {
              const reference = getScriptReference({ value: attached, dynamic: token.dynamic }, uncertainties);
              if (reference) found.push({ reference, source: "shell-command" });
            }
          }
        }
      }
      continue;
    }

    const interpreter = isInterpreter(commandValue);
    if (!interpreter && commandToken.dynamic) uncertainties.add("computed-command");
    if (!interpreter && !/[\\/]/.test(commandValue) && !commandToken.dynamic) {
      // A bare command can resolve through a mutable PATH or shell alias/function.
      uncertainties.add("ambiguous-command-search");
    }

    for (const token of segment.slice(commandIndex + 1)) {
      const reference = getScriptReference(token, uncertainties);
      if (reference) found.push({ reference, source: "shell-command" });
    }

    if (interpreter) {
      const args = segment.slice(commandIndex + 1).map((token) => token.value.toLowerCase());
      if (args.some((arg) => ["-c", "-m", "-e", "--eval", "--print", "-command", "-encodedcommand"].includes(arg))) {
        uncertainties.add("interpreter-eval");
      }
      if ((commandName === "cmd" && args.some((arg) => arg === "/c" || arg === "/k")) ||
          (["pwsh", "powershell"].includes(commandName) && args.some((arg) => arg === "-command" || arg === "-encodedcommand"))) {
        uncertainties.add("opaque-nested-command");
      }
    }
  }
}

/**
 * Finds common literal external script entries and maps them to workspace-relative
 * material paths. The caller must merge `materials` into the request before the
 * existing Level 3 canonicalization, snapshot, digest, approval, and native path.
 */
export function bindLevel3ScriptEntries(input: ScriptEntryBindingInput): ScriptEntryBindingResult {
  const found: Array<{ reference: string; source: ScriptEntrySource }> = [];
  const uncertainties = new Set<ScriptEntryUncertainty>();

  if (input.engine === "program") addProgramEntries(input, found, uncertainties);
  else addShellEntries(input, input.engine, found, uncertainties);

  return bindingResult(input, found, uncertainties);
}
