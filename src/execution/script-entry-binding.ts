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
  | "unverified-execution-target"
  | "unsupported-execution-target"
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
  quoted?: boolean;
}

interface LexedCommand {
  segments: Token[][];
  uncertainties: Set<ScriptEntryUncertainty>;
}

const SCRIPT_EXTENSIONS = new Set([
  ".ps1", ".cmd", ".bat", ".py", ".pyw", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts",
]);
const POWERSHELL_ENTRY_EXTENSIONS = new Set([".ps1", ".cmd", ".bat", ".exe", ".com"]);
const POWERSHELL_RECOGNIZED_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...POWERSHELL_ENTRY_EXTENSIONS]);
const CMD_ENTRY_EXTENSIONS = new Set([".cmd", ".bat"]);
const CMD_EXECUTABLE_EXTENSIONS = new Set([...CMD_ENTRY_EXTENSIONS, ".exe", ".com"]);
const CMD_RECOGNIZED_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, ...CMD_EXECUTABLE_EXTENSIONS]);
const CMD_START_SWITCH_OPTIONS = new Set([
  "/b", "/i", "/min", "/max", "/separate", "/shared", "/low", "/normal", "/high", "/realtime",
  "/abovenormal", "/wait",
]);
const CMD_START_VALUE_OPTIONS = new Set(["/affinity", "/d", "/node"]);
const START_PROCESS_VALUE_OPTIONS = new Set([
  "-argumentlist", "-credential", "-erroraction", "-errorvariable", "-filepath", "-informationaction",
  "-informationvariable", "-outbuffer", "-outvariable", "-pipelinevariable", "-progressaction",
  "-redirectstandarderror", "-redirectstandardinput", "-redirectstandardoutput", "-verb", "-warningaction",
  "-warningvariable", "-windowstyle", "-workingdirectory",
]);
const START_PROCESS_SWITCH_OPTIONS = new Set([
  "-confirm", "-debug", "-loaduserprofile", "-nonewwindow", "-passthru", "-usenewenvironment", "-verbose",
  "-wait", "-whatif",
]);

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
  "shell-expansion", "computed-path", "unverified-execution-target", "unsupported-execution-target",
  "computed-command", "unsupported-shell-syntax", "unclosed-quote",
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

function markInterpreterCommandUncertainty(
  executable: string,
  args: readonly Token[],
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  const interpreter = normalizeCommandName(executable);
  const values = args.map((token) => token.value.toLowerCase());
  if (values.some((value) => /^(-c|-m|-e|--eval|--print|-command|-encodedcommand)(?:\s|$)/.test(value))) {
    uncertainties.add("interpreter-eval");
  }
  if ((interpreter === "cmd" && values.some((value) => /^\/(?:c|k)(?:\s|$)/.test(value))) ||
      (["pwsh", "powershell"].includes(interpreter) &&
        values.some((value) => /^-(?:command|encodedcommand)(?:\s|$)/.test(value)))) {
    uncertainties.add("opaque-nested-command");
  }
}

function addInterpreterArgumentEntries(
  input: ScriptEntryBindingInput,
  executable: string,
  args: readonly Token[],
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  addProgramEntries({
    engine: "program",
    workspaceRoot: input.workspaceRoot,
    cwd: input.cwd,
    executable,
    args: args.map((token) => token.value),
  }, found, uncertainties);
  markInterpreterCommandUncertainty(executable, args, uncertainties);
  if (args.some((token) => /\.(?:py|pyw|js|mjs|cjs|ts|mts|cts|ps1|cmd|bat)(?:\s|$)/i.test(token.value) &&
      !hasScriptExtension(token.value))) {
    uncertainties.add("unsupported-shell-syntax");
  }
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
  let tokenQuoted = false;
  let quote: "'" | '"' | null = null;

  const flushToken = () => {
    if (value.length > 0 || tokenDynamic || tokenQuoted) {
      segment.push({ value, dynamic: tokenDynamic, quoted: tokenQuoted });
    }
    value = "";
    tokenDynamic = false;
    tokenQuoted = false;
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
      tokenQuoted = true;
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

function getScriptReference(
  token: Token,
  uncertainties: Set<ScriptEntryUncertainty>,
  extensions: ReadonlySet<string> = SCRIPT_EXTENSIONS,
): string | undefined {
  if (!extensions.has(extensionOf(token.value))) return undefined;
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
    : CMD_EXECUTABLE_EXTENSIONS.has(extension);
}

function isExplicitPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /[\\/]/.test(value);
}

function addPowerShellPathEntry(
  input: ScriptEntryBindingInput,
  token: Token,
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  if (token.dynamic || /[*?]/.test(token.value)) {
    uncertainties.add("computed-path");
    return;
  }

  const extension = extensionOf(token.value);
  if (extension === ".ps1") {
    // Preserve the existing behavior: a literal .ps1 is a definite PowerShell
    // script entry, so Level 3's regular-file snapshot rejects it if missing.
    found.push({ reference: token.value, source: "shell-command" });
    return;
  }

  if (!existsAsFileInput(input, token.value)) {
    // A missing path can appear between approval and launch. Requiring the
    // existing dynamic-code acknowledgement prevents an empty snapshot from
    // looking like a statically understood command.
    uncertainties.add("unverified-execution-target");
    return;
  }

  found.push({ reference: token.value, source: "shell-command" });
  if (!POWERSHELL_ENTRY_EXTENSIONS.has(extension)) {
    // Freeze an existing file conservatively without claiming that PowerShell
    // can execute its file type. Approval remains gated as dynamic code.
    uncertainties.add("unsupported-execution-target");
  }
}

function addPowerShellExecutionTarget(
  input: ScriptEntryBindingInput,
  token: Token,
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  if (token.dynamic || /[*?]/.test(token.value)) {
    uncertainties.add("computed-path");
  } else if (!token.value.trim()) {
    uncertainties.add("unverified-execution-target");
  } else if (isExplicitPath(token.value)) {
    addPowerShellPathEntry(input, token, found, uncertainties);
  } else {
    // Start-Process resolves a bare FilePath through process search rules.
    uncertainties.add("ambiguous-command-search");
  }
}

function addPowerShellStartProcessEntries(
  input: ScriptEntryBindingInput,
  segment: readonly Token[],
  commandIndex: number,
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  const args = segment.slice(commandIndex + 1);
  let target: Token | undefined;
  let argumentListSeen = false;
  const childArgs: Token[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const separator = token.value.search(/[:=]/);
    const optionName = (separator >= 0 ? token.value.slice(0, separator) : token.value).toLowerCase();
    const attachedValue = separator >= 0 ? token.value.slice(separator + 1) : undefined;

    if (optionName.startsWith("-")) {
      if (optionName === "-filepath") {
        const value = attachedValue !== undefined ? { value: attachedValue, dynamic: token.dynamic } : args[index + 1];
        if (!value || (attachedValue === undefined && value.value.startsWith("-"))) {
          uncertainties.add("unverified-execution-target");
        } else {
          if (target) uncertainties.add("unsupported-shell-syntax");
          target = value;
          if (attachedValue === undefined) index += 1;
        }
        continue;
      }

      if (optionName === "-argumentlist") {
        argumentListSeen = true;
        const value = attachedValue !== undefined ? { value: attachedValue, dynamic: token.dynamic } : args[index + 1];
        if (!value || (attachedValue === undefined && value.value.startsWith("-"))) {
          uncertainties.add("unsupported-shell-syntax");
        } else {
          childArgs.push(value);
          if (attachedValue === undefined) index += 1;
        }
        continue;
      }

      if (START_PROCESS_VALUE_OPTIONS.has(optionName)) {
        if (attachedValue === undefined) {
          const value = args[index + 1];
          if (value && !value.value.startsWith("-")) index += 1;
          else uncertainties.add("unsupported-shell-syntax");
        }
        continue;
      }
      if (START_PROCESS_SWITCH_OPTIONS.has(optionName)) continue;

      // Parameter abbreviations and unknown syntax are not parsed as targets.
      uncertainties.add("unsupported-shell-syntax");
      continue;
    }

    if (!target && !argumentListSeen) target = token;
    else childArgs.push(token);
  }

  if (!target) {
    uncertainties.add("unverified-execution-target");
    return;
  }

  addPowerShellExecutionTarget(input, target, found, uncertainties);
  if (isInterpreter(target.value)) {
    addInterpreterArgumentEntries(input, target.value, childArgs, found, uncertainties);
  }
}

function addCmdExecutionTarget(
  input: ScriptEntryBindingInput,
  target: Token,
  args: readonly Token[],
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  if (target.dynamic || /[*?]/.test(target.value)) {
    uncertainties.add("computed-path");
    return;
  }
  if (!target.value.trim()) {
    uncertainties.add("unverified-execution-target");
    return;
  }
  if (!isExplicitPath(target.value)) {
    // A bare name can resolve through the mutable current directory/PATH search.
    uncertainties.add("ambiguous-command-search");
    return;
  }
  if (!existsAsFileInput(input, target.value)) {
    // This also rejects absolute targets outside the selected repository without
    // probing the external path. Level 3 cannot snapshot those files safely.
    uncertainties.add("unverified-execution-target");
    return;
  }

  found.push({ reference: target.value, source: "shell-command" });
  if (!CMD_EXECUTABLE_EXTENSIONS.has(extensionOf(target.value))) {
    uncertainties.add("unsupported-execution-target");
  }
  if (isInterpreter(target.value)) {
    addInterpreterArgumentEntries(input, target.value, args, found, uncertainties);
  }
}

function addCmdStartEntries(
  input: ScriptEntryBindingInput,
  segment: readonly Token[],
  commandIndex: number,
  found: Array<{ reference: string; source: ScriptEntrySource }>,
  uncertainties: Set<ScriptEntryUncertainty>,
): void {
  const args = segment.slice(commandIndex + 1);
  let target: Token | undefined;
  let targetIndex = -1;
  let titleSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const option = token.value.toLowerCase();
    if (!token.quoted && CMD_START_SWITCH_OPTIONS.has(option)) continue;
    if (!token.quoted && CMD_START_VALUE_OPTIONS.has(option)) {
      const value = args[index + 1];
      if (!value || value.value.startsWith("/")) uncertainties.add("unsupported-shell-syntax");
      else index += 1;
      continue;
    }
    if (!token.quoted && option.startsWith("/") && !/^[A-Za-z]:/.test(token.value)) {
      uncertainties.add("unsupported-shell-syntax");
      continue;
    }
    if (!titleSeen && token.quoted) {
      // START treats its first quoted argument as a window title, including "".
      titleSeen = true;
      continue;
    }
    target = token;
    targetIndex = index;
    break;
  }

  if (!target) {
    uncertainties.add("unverified-execution-target");
    return;
  }
  addCmdExecutionTarget(input, target, args.slice(targetIndex + 1), found, uncertainties);
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
    const lower = arg.toLowerCase();
    const option = lower.split("=", 1)[0]!;
    const nodeDynamic = isNode && (
      ["--eval", "--print", "--require", "--import", "--loader", "--experimental-loader", "--test", "--run"].includes(option) ||
      lower === "-e" || lower.startsWith("-e") || lower === "-p" || lower.startsWith("-p") ||
      lower === "-r" || lower.startsWith("-r")
    );
    const pythonDynamic = isPython && (
      option === "-c" || option === "-m" || lower.startsWith("-c") || lower.startsWith("-m")
    );
    if (nodeDynamic || pythonDynamic) {
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

    if (engine === "cmd" && commandValue.toLowerCase() === "call") {
      commandIndex += 1;
      commandToken = segment[commandIndex] ?? commandToken;
      commandValue = commandToken.value;
      commandName = normalizeCommandName(commandValue);
    }

    if (engine === "powershell" && isExplicitPath(commandValue)) {
      addPowerShellPathEntry(input, commandToken, found, uncertainties);
      if (isInterpreter(commandValue)) {
        const interpreterArgs = segment.slice(commandIndex + 1);
        addProgramEntries({
          engine: "program",
          workspaceRoot: input.workspaceRoot,
          cwd: input.cwd,
          executable: commandValue,
          args: interpreterArgs.map((token) => token.value),
        }, found, uncertainties);
        markInterpreterCommandUncertainty(commandValue, interpreterArgs, uncertainties);
      }
      continue;
    }

    if (engine === "cmd" && isExplicitPath(commandValue)) {
      addCmdExecutionTarget(input, commandToken, segment.slice(commandIndex + 1), found, uncertainties);
      continue;
    }

    if (engine === "cmd" && commandValue.toLowerCase() === "start") {
      addCmdStartEntries(input, segment, commandIndex, found, uncertainties);
      continue;
    }

    const directEntry = getScriptReference(commandToken, uncertainties,
      engine === "powershell" ? POWERSHELL_RECOGNIZED_EXTENSIONS : CMD_RECOGNIZED_EXTENSIONS);
    if (directEntry && shellEntryExtensionAllowed(engine, directEntry)) {
      if (!path.isAbsolute(directEntry) && !/[\\/]/.test(directEntry)) {
        if (engine === "cmd" && [".exe", ".com"].includes(extensionOf(directEntry))) {
          uncertainties.add("ambiguous-command-search");
        } else if (engine === "cmd" && existsAsFileInput(input, directEntry)) {
          found.push({ reference: directEntry, source: "shell-command" });
        } else {
          uncertainties.add("ambiguous-command-search");
        }
      } else {
        found.push({ reference: directEntry, source: "shell-command" });
      }
      continue;
    }

    if (engine === "powershell" && directEntry) {
      // A bare unsupported file name may resolve through command search or a
      // shell function; do not treat it as a harmless, statically known input.
      uncertainties.add("ambiguous-command-search");
      continue;
    }

    const builtins = engine === "powershell" ? POWERSHELL_BUILTINS : CMD_BUILTINS;
    if (builtins.has(commandName)) {
      if (engine === "powershell" && commandName === "start-process") {
        addPowerShellStartProcessEntries(input, segment, commandIndex, found, uncertainties);
        continue;
      }
      if ((commandName === "invoke-expression" || commandName === "iex") && segment.length > commandIndex + 1) {
        uncertainties.add("computed-command");
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
