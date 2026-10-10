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
import type { ExecutionTempOwner } from "./execution-temp.js";
import { resolveTrustedRuntime } from "./runtime-discovery.js";

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
  tempOwner: ExecutionTempOwner;
}

export function resolveExecutionHelperPath(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
  moduleDirectory?: string;
} = {}): string {
  if ((options.platform ?? process.platform) !== "win32" ||
      (options.architecture ?? process.arch) !== "x64") {
    throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  }
  const moduleDirectory = options.moduleDirectory ?? path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(moduleDirectory, "../../build/native/c2c-execution-helper.exe");
  try {
    const absolute = path.resolve(candidate);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const stat = fs.lstatSync(candidate);
    const canonical = fs.realpathSync.native(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        path.basename(canonical).toLowerCase() !== "c2c-execution-helper.exe" ||
        path.resolve(canonical).toLowerCase() !== path.resolve(candidate).toLowerCase()) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    return canonical;
  } catch {
    throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  }
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
    const runtime = resolveTrustedRuntime(request.trustedCommand.packageManager);
    const jobTempDir = request.tempOwner.create(request.jobId);

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
    let input: Buffer;
    let child: ChildProcessWithoutNullStreams;
    try {
      input = serializeHelperRequest({
        packageManager: request.trustedCommand.packageManager,
        kind: request.trustedCommand.kind,
        timeoutSeconds: request.timeoutSeconds,
        cwd: request.repository.canonicalPath,
        gitDirectory: request.repository.gitDirectory,
        gitDirectoryFileIdentity: request.repository.fileIdentities.gitDirectory,
        commonGitDirectory: request.repository.commonGitDirectory,
        commonGitDirectoryFileIdentity: request.repository.fileIdentities.commonGitDirectory,
        nodeExecutable: runtime.nodeExecutable,
        nodeFileIdentity: runtime.nodeFileIdentity,
        managerCli: runtime.managerCli,
        managerFileIdentity: runtime.managerFileIdentity,
        managerHash: runtime.managerHash,
        target: request.trustedCommand.target,
        jobTempDir,
        jobTempFileIdentity: request.tempOwner.fileIdentity(request.jobId),
        repositoryFileIdentity: request.repository.fileIdentities.repository,
        gitEntryFileIdentity: request.repository.fileIdentities.gitEntry,
        gitEntryType: request.repository.gitEntryType,
        gitEntryHash: request.repository.gitEntryHash,
        packageJsonHash: request.trustedCommand.packageJsonHash,
      });
      child = spawnImpl(helperPath, [], {
        cwd: request.repository.canonicalPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      request.tempOwner.cleanup(request.jobId);
      throw new Error("EXECUTION_HELPER_START_FAILED", { cause: error });
    }

    const decoder = new HelperOutputDecoder();
    let frameResult: HelperResultFrame | null = null;
    let protocolError: Error | null = null;
    let diagnostics = "";
    let cancelSent = false;
    let abandoned = false;
    let spawnError: Error | null = null;

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
      child.once("error", (error) => {
        spawnError = new Error("EXECUTION_HELPER_START_FAILED", { cause: error });
      });
      child.once("close", (code) => {
        if (!request.tempOwner.cleanup(request.jobId)) {
          reject(new Error("EXECUTION_TEMP_CLEANUP_FAILED"));
          return;
        }
        if (spawnError) {
          reject(spawnError);
          return;
        }
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
