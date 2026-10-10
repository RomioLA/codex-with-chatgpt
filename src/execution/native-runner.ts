import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TrustedCommand } from "./trusted-registry.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import type { HelperRequest, HelperResultFrame } from "./helper-protocol.js";
import { HelperOutputDecoder, HELPER_CANCEL_BYTE, serializeHelperRequest } from "./helper-protocol.js";
import type { OutputStream } from "./job-types.js";
import { redact } from "../logger/index.js";
import type { ExecutionTempLease } from "./execution-temp.js";
import { resolveTrustedRuntime, type TrustedRuntime } from "./runtime-discovery.js";
import { runExecutionTempCleanup } from "./execution-temp-cleanup.js";

export interface NativeRunnerCallbacks {
  onOutput: (stream: OutputStream, data: Buffer) => void;
  onDiagnostic?: (message: string) => void;
}

export interface NativeRunnerCompletion {
  result: HelperResultFrame;
  helperExitCode: number | null;
  tempCleanupConfirmed?: boolean;
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
  tempLease: ExecutionTempLease;
}

export function resolveExecutionHelperPath(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
  moduleDirectory?: string;
  helperPath?: string;
} = {}): string {
  if ((options.platform ?? process.platform) !== "win32" ||
      (options.architecture ?? process.arch) !== "x64") {
    throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  }
  const moduleDirectory = options.moduleDirectory ?? path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDirectory, "../..");
  const expectedHelper = path.resolve(packageRoot, "build/native/c2c-execution-helper.exe");
  const candidate = options.helperPath ? path.resolve(options.helperPath) : expectedHelper;
  const metadataPath = path.resolve(packageRoot, "dist/execution/c2c-execution-helper-integrity.json");
  try {
    const absolute = path.resolve(candidate);
    if (absolute.toLowerCase() !== expectedHelper.toLowerCase()) throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    for (const file of [metadataPath, absolute]) {
      const parsed = path.parse(file);
      let current = parsed.root;
      for (const component of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("EXECUTION_HELPER_UNAVAILABLE");
      }
    }
    const stat = fs.lstatSync(candidate);
    const canonical = fs.realpathSync.native(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        path.basename(canonical).toLowerCase() !== "c2c-execution-helper.exe" ||
        path.resolve(canonical).toLowerCase() !== expectedHelper.toLowerCase()) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() ||
        path.resolve(fs.realpathSync.native(metadataPath)).toLowerCase() !== metadataPath.toLowerCase()) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      version?: unknown; protocolVersion?: unknown; helperPath?: unknown; sha256?: unknown;
    };
    if (metadata.version !== 1 || metadata.protocolVersion !== 5 ||
        metadata.helperPath !== "build/native/c2c-execution-helper.exe" ||
        typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const bytes = fs.readFileSync(canonical);
    if (bytes.byteLength < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const peOffset = bytes.readUInt32LE(0x3c);
    if (peOffset > bytes.byteLength - 4 || bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0" ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.sha256) {
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
      moduleDirectory?: string;
      spawnImpl?: typeof spawn;
      runtimeResolver?: typeof resolveTrustedRuntime;
      beforeHelperRequestWrite?: (runtime: TrustedRuntime) => void;
    } = {}
  ) {}

  start(request: NativeRunnerRequest, callbacks: NativeRunnerCallbacks): NativeRunnerHandle {
    const helperPath = resolveExecutionHelperPath({
      helperPath: this.options.helperPath,
      moduleDirectory: this.options.moduleDirectory,
    });
    const runtime = (this.options.runtimeResolver ?? resolveTrustedRuntime)(request.trustedCommand.packageManager);
    const jobTempDir = request.tempLease.directoryPath;
    const stateRoot = path.resolve(request.tempLease.rootPath, "..", "..", "..");
    const expectedTempRoot = path.join(stateRoot, "execution-jobs", request.tempLease.workspaceId, "execution-temp");
    if (path.resolve(request.tempLease.rootPath).toLowerCase() !== path.resolve(expectedTempRoot).toLowerCase()) {
      throw new Error("EXECUTION_TEMP_OWNERSHIP_INVALID");
    }

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const systemDirectory = path.join(systemRoot, "System32");
    const env: NodeJS.ProcessEnv = {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: systemDirectory,
      ComSpec: path.join(systemDirectory, "cmd.exe"),
      C2C_STATE_DIR: stateRoot,
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
        nodeHash: runtime.nodeHash,
        managerCli: runtime.managerCli,
        managerFileIdentity: runtime.managerFileIdentity,
        managerHash: runtime.managerHash,
        managerLibCli: runtime.managerLibCli,
        managerLibCliFileIdentity: runtime.managerLibCliFileIdentity,
        managerLibCliHash: runtime.managerLibCliHash,
        managerValidateEngines: runtime.managerValidateEngines,
        managerValidateEnginesFileIdentity: runtime.managerValidateEnginesFileIdentity,
        managerValidateEnginesHash: runtime.managerValidateEnginesHash,
        managerMainEntry: runtime.managerMainEntry,
        managerMainEntryFileIdentity: runtime.managerMainEntryFileIdentity,
        managerMainEntryHash: runtime.managerMainEntryHash,
        managerPackageJson: runtime.managerPackageJson,
        managerPackageJsonFileIdentity: runtime.managerPackageJsonFileIdentity,
        managerPackageJsonHash: runtime.managerPackageJsonHash,
        managerExitHandler: runtime.managerExitHandler,
        managerExitHandlerFileIdentity: runtime.managerExitHandlerFileIdentity,
        managerExitHandlerHash: runtime.managerExitHandlerHash,
        managerCore: runtime.managerCore,
        managerCoreFileIdentity: runtime.managerCoreFileIdentity,
        managerCoreHash: runtime.managerCoreHash,
        target: request.trustedCommand.target,
        tempRootPath: request.tempLease.rootPath,
        tempRootFileIdentity: request.tempLease.rootFileIdentity,
        tempWorkspaceId: request.tempLease.workspaceId,
        tempJobId: request.tempLease.jobId,
        tempNonce: request.tempLease.nonce,
        tempCreatedAtMs: request.tempLease.createdAtMs,
        jobTempDir,
        jobTempFileIdentity: request.tempLease.directoryFileIdentity,
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
      try {
        this.options.beforeHelperRequestWrite?.(runtime);
      } catch (error) {
        child.stdin.destroy();
        throw error;
      }
    } catch (error) {
      try {
        runExecutionTempCleanup(request.tempLease, request.stateDirectory,
          (message) => callbacks.onDiagnostic?.(redact(message).slice(-512)));
      } catch {
        /* Keep the persisted ownership record for a later identity-checked recovery. */
      }
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
        if (!runExecutionTempCleanup(request.tempLease, request.stateDirectory,
          (message) => callbacks.onDiagnostic?.(redact(message).slice(-512)))) {
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
        if (diagnostics || frameResult.outcome === 3) {
          const resultDiagnostic = `helper outcome=${frameResult.outcome}; win32Error=${frameResult.win32Error}; ` +
            `exitCode=${frameResult.exitCode}`;
          callbacks.onDiagnostic?.(redact([diagnostics, resultDiagnostic].filter(Boolean).join("\n")).slice(-512));
        }
        resolve({ result: frameResult, helperExitCode: code, tempCleanupConfirmed: true });
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
