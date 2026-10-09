import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TrustedCommand } from "./trusted-registry.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import type { HelperRequest, HelperResultFrame } from "./helper-protocol.js";
import { HelperOutputDecoder, HELPER_CANCEL_BYTE, serializeHelperRequest } from "./helper-protocol.js";
import type { OutputStream } from "./job-types.js";
import { redact } from "../logger/index.js";

export interface NativeRunnerCallbacks {
  onOutput: (stream: OutputStream, data: Buffer) => void;
  onDiagnostic?: (message: string) => void;
}

export interface NativeRunnerCompletion {
  result: HelperResultFrame;
  helperExitCode: number | null;
}

export interface NativeRunnerHandle {
  completion: Promise<NativeRunnerCompletion>;
  cancel(): void;
  abandon(): void;
}

export interface NativeRunnerRequest {
  jobId: string;
  repository: RepositoryIdentity;
  trustedCommand: TrustedCommand;
  timeoutSeconds: number;
  stateDirectory: string;
}

function helperCandidates(): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDirectory, "../../build/native/c2c-execution-helper.exe"),
    path.resolve(moduleDirectory, "../../../build/native/c2c-execution-helper.exe"),
  ];
}

export function resolveExecutionHelperPath(): string {
  if (process.platform !== "win32") throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  for (const candidate of helperCandidates()) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const canonical = fs.realpathSync.native(candidate);
      if (path.basename(canonical).toLowerCase() !== "c2c-execution-helper.exe") continue;
      return canonical;
    } catch {
      /* try the other fixed package-relative location */
    }
  }
  throw new Error("EXECUTION_HELPER_UNAVAILABLE");
}

function fixedNodeTools(packageManager: "npm" | "pnpm"): { nodeExecutable: string; managerCli: string } {
  if (process.platform !== "win32") throw new Error("EXECUTABLE_UNAVAILABLE");
  const nodeExecutable = fs.realpathSync.native(process.execPath);
  if (path.basename(nodeExecutable).toLowerCase() !== "node.exe") throw new Error("EXECUTABLE_UNAVAILABLE");
  const nodeDirectory = path.dirname(nodeExecutable);
  const managerCli = packageManager === "npm"
    ? path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js")
    : path.join(nodeDirectory, "node_modules", "pnpm", "bin", "pnpm.cjs");
  let canonicalCli: string;
  try {
    const stat = fs.lstatSync(managerCli);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    canonicalCli = fs.realpathSync.native(managerCli);
  } catch {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  const relative = path.relative(nodeDirectory, canonicalCli);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  if (path.basename(canonicalCli).toLowerCase() !== (packageManager === "npm" ? "npm-cli.js" : "pnpm.cjs")) {
    throw new Error("EXECUTABLE_UNAVAILABLE");
  }
  return { nodeExecutable, managerCli: canonicalCli };
}

function makeJobTempDir(stateDirectory: string, jobId: string): string {
  const directory = path.join(stateDirectory, `tmp-${jobId}`);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("TEMP_DIRECTORY_INVALID");
  }
  return fs.realpathSync.native(directory);
}

/** Only the fixed C2C native helper can be launched by this adapter. */
export class WindowsNativeExecutionRunner {
  constructor(
    private readonly options: {
      helperPath?: string;
      spawnImpl?: typeof spawn;
    } = {}
  ) {}

  start(request: NativeRunnerRequest, callbacks: NativeRunnerCallbacks): NativeRunnerHandle {
    const helperPath = this.options.helperPath ?? resolveExecutionHelperPath();
    const { nodeExecutable, managerCli } = fixedNodeTools(request.trustedCommand.packageManager);
    const jobTempDir = makeJobTempDir(request.stateDirectory, request.jobId);
    const input = serializeHelperRequest({
      packageManager: request.trustedCommand.packageManager,
      kind: request.trustedCommand.kind,
      timeoutSeconds: request.timeoutSeconds,
      cwd: request.repository.canonicalPath,
      nodeExecutable,
      managerCli,
      target: request.trustedCommand.target,
      jobTempDir,
    });

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const systemDirectory = path.join(systemRoot, "System32");
    const env: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: systemDirectory,
      ComSpec: path.join(systemDirectory, "cmd.exe"),
      TEMP: jobTempDir,
      TMP: jobTempDir,
    };
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(helperPath, [], {
        cwd: request.repository.canonicalPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new Error("EXECUTION_HELPER_START_FAILED", { cause: error });
    }

    const decoder = new HelperOutputDecoder();
    let frameResult: HelperResultFrame | null = null;
    let protocolError: Error | null = null;
    let diagnostics = "";
    let cancelSent = false;
    let abandoned = false;

    const completion = new Promise<NativeRunnerCompletion>((resolve, reject) => {
      child.stdout.on("data", (data: Buffer) => {
        if (protocolError) return;
        try {
          for (const frame of decoder.push(Buffer.from(data))) {
            if (frame.type === "stdout" || frame.type === "stderr") callbacks.onOutput(frame.type, frame.data);
            else frameResult = frame.result;
          }
        } catch (error) {
          protocolError = error instanceof Error ? error : new Error("HELPER_PROTOCOL_INVALID");
          abandoned = true;
          child.stdin.destroy(); // EOF asks the helper to clean up its owned Job.
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        diagnostics = (diagnostics + Buffer.from(data).toString("utf8")).slice(-4096);
      });
      child.once("error", (error) => reject(new Error("EXECUTION_HELPER_START_FAILED", { cause: error })));
      child.once("close", (code) => {
        if (protocolError) {
          reject(new Error("EXECUTION_HELPER_PROTOCOL_FAILED", { cause: protocolError }));
          return;
        }
        try {
          decoder.finish();
        } catch (error) {
          const message = diagnostics ? `: ${redact(diagnostics).slice(-512)}` : "";
          reject(new Error(`EXECUTION_HELPER_UNCONFIRMED${message}`, { cause: error }));
          return;
        }
        if (!frameResult) {
          reject(new Error("EXECUTION_HELPER_RESULT_MISSING"));
          return;
        }
        if (diagnostics) callbacks.onDiagnostic?.(redact(diagnostics).slice(-512));
        resolve({ result: frameResult, helperExitCode: code });
      });
    });

    child.stdin.on("error", () => {
      /* A close/error during teardown is reported by the helper result channel. */
    });
    try {
      child.stdin.write(input);
    } catch (error) {
      child.stdin.destroy();
      throw new Error("EXECUTION_HELPER_PROTOCOL_WRITE_FAILED", { cause: error });
    }

    return {
      completion,
      cancel: () => {
        if (cancelSent || abandoned || child.stdin.destroyed) return;
        cancelSent = true;
        child.stdin.write(Buffer.from([HELPER_CANCEL_BYTE]));
      },
      abandon: () => {
        if (abandoned) return;
        abandoned = true;
        child.stdin.destroy();
      },
    };
  }
}
