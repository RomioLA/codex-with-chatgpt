import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TrustedCommand } from "./trusted-registry.js";
import type { RepositoryIdentity } from "./repository-identity.js";
import type { FullAccessHelperRequest, GenericCommand, HelperRequest, HelperResultFrame } from "./helper-protocol.js";
import { EXECUTION_HELPER_PROTOCOL_VERSION, HelperOutputDecoder, HELPER_CANCEL_BYTE, serializeFullAccessGitHelperRequest, serializeFullAccessHelperRequest, serializeHelperRequest } from "./helper-protocol.js";
import type { FullAccessCommand, OutputStream } from "./job-types.js";
import { redact } from "../logger/index.js";
import type { ExecutionTempLease } from "./execution-temp.js";
import { resolveTrustedRuntime, type TrustedRuntime } from "./runtime-discovery.js";
import { runExecutionTempCleanup } from "./execution-temp-cleanup.js";

export interface NativeRunnerCallbacks {
  onOutput: (stream: OutputStream, data: Buffer) => void | Promise<void>;
  onDiagnostic?: (message: string) => void;
}

export interface NativeRunnerCompletion {
  result: HelperResultFrame;
  helperExitCode: number | null;
  tempCleanupConfirmed?: boolean;
}

export class NativeRunnerOutputError extends Error {
  constructor(
    cause: unknown,
    readonly helperResult: HelperResultFrame,
    readonly helperExitCode: number | null,
    readonly tempCleanupConfirmed: boolean,
  ) {
    super("OUTPUT_PERSISTENCE_FAILED", { cause });
    this.name = "NativeRunnerOutputError";
  }
}

export interface NativeRunnerHandle {
  completion: Promise<NativeRunnerCompletion>;
  cancel(): void;
  abandon(): void;
}

interface NativeRunnerBaseRequest {
  jobId: string;
  timeoutSeconds: number;
  stateDirectory: string;
  tempLease: ExecutionTempLease;
}

export interface FullAccessNativeLaunch {
  workspaceId: string;
  oauthClientId: string;
  permissionMode: "level2";
  sessionGrantFingerprint: string;
  sessionGrantId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  command: FullAccessCommand;
}

export interface FullAccessGitNativeLaunch {
  oauthClientId: string;
  permissionMode: "level2";
  sessionGrantFingerprint: string;
  sessionGrantId: string;
}

export type NativeRunnerRequest = NativeRunnerBaseRequest & (
  | {
      repository: RepositoryIdentity;
      trustedCommand: TrustedCommand;
      genericCommand?: GenericCommand;
      fullAccessGit?: never;
      fullAccess?: never;
    }
  | {
      repository: RepositoryIdentity;
      trustedCommand: TrustedCommand;
      genericCommand: GenericCommand;
      fullAccessGit: FullAccessGitNativeLaunch;
      fullAccess?: never;
    }
  | {
      repository?: never;
      trustedCommand?: never;
      genericCommand?: never;
      fullAccess: FullAccessNativeLaunch;
    }
);

export type { GenericCommand } from "./helper-protocol.js";

export function resolveExecutionHelperPath(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
  moduleDirectory?: string;
  helperPath?: string;
  launcherPath?: string;
} = {}): string {
  return resolveExecutionArtifacts(options).helperPath;
}

export function resolveExecutionLauncherPath(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
  moduleDirectory?: string;
  helperPath?: string;
  launcherPath?: string;
} = {}): string {
  return resolveExecutionArtifacts(options).launcherPath;
}

interface ExecutionHelperArtifacts {
  helperPath: string;
  launcherPath: string;
}

function resolveExecutionArtifacts(options: {
  platform?: NodeJS.Platform;
  architecture?: string;
  moduleDirectory?: string;
  helperPath?: string;
  launcherPath?: string;
}): ExecutionHelperArtifacts {
  if ((options.platform ?? process.platform) !== "win32" ||
      (options.architecture ?? process.arch) !== "x64") {
    throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  }
  const moduleDirectory = options.moduleDirectory ?? path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDirectory, "../..");
  const expectedHelper = path.resolve(packageRoot, "build/native/c2c-execution-helper.exe");
  const candidateHelper = options.helperPath ? path.resolve(options.helperPath) : expectedHelper;
  const expectedLauncher = path.resolve(packageRoot, "build/native/c2c-execution-launcher.exe");
  const candidateLauncher = options.launcherPath ? path.resolve(options.launcherPath) : expectedLauncher;
  const metadataPath = path.resolve(packageRoot, "dist/execution/c2c-execution-helper-integrity.json");
  try {
    if (candidateHelper.toLowerCase() !== expectedHelper.toLowerCase() ||
        candidateLauncher.toLowerCase() !== expectedLauncher.toLowerCase()) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    for (const file of [metadataPath, candidateHelper, candidateLauncher]) {
      const parsed = path.parse(file);
      let current = parsed.root;
      for (const component of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error("EXECUTION_HELPER_UNAVAILABLE");
      }
    }
    const verifyArtifact = (candidate: string, expected: string, expectedName: string): Buffer => {
      const stat = fs.lstatSync(candidate);
      const canonical = fs.realpathSync.native(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          path.basename(canonical).toLowerCase() !== expectedName.toLowerCase() ||
          path.resolve(canonical).toLowerCase() !== expected.toLowerCase()) {
        throw new Error("EXECUTION_HELPER_UNAVAILABLE");
      }
      const bytes = fs.readFileSync(canonical);
      if (bytes.byteLength < 0x40 || bytes.toString("ascii", 0, 2) !== "MZ") {
        throw new Error("EXECUTION_HELPER_UNAVAILABLE");
      }
      const peOffset = bytes.readUInt32LE(0x3c);
      if (peOffset > bytes.byteLength - 4 || bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
        throw new Error("EXECUTION_HELPER_UNAVAILABLE");
      }
      return bytes;
    };
    const metadataStat = fs.lstatSync(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() ||
        path.resolve(fs.realpathSync.native(metadataPath)).toLowerCase() !== metadataPath.toLowerCase()) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      version?: unknown; protocolVersion?: unknown; helperPath?: unknown; sha256?: unknown;
      launcherPath?: unknown; launcherSha256?: unknown;
    };
    if (metadata.version !== 2 || metadata.protocolVersion !== EXECUTION_HELPER_PROTOCOL_VERSION ||
        metadata.helperPath !== "build/native/c2c-execution-helper.exe" ||
        typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        metadata.launcherPath !== "build/native/c2c-execution-launcher.exe" ||
        typeof metadata.launcherSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.launcherSha256)) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    const helperBytes = verifyArtifact(candidateHelper, expectedHelper, "c2c-execution-helper.exe");
    const launcherBytes = verifyArtifact(candidateLauncher, expectedLauncher, "c2c-execution-launcher.exe");
    if (createHash("sha256").update(helperBytes).digest("hex") !== metadata.sha256 ||
        createHash("sha256").update(launcherBytes).digest("hex") !== metadata.launcherSha256) {
      throw new Error("EXECUTION_HELPER_UNAVAILABLE");
    }
    return { helperPath: expectedHelper, launcherPath: expectedLauncher };
  } catch {
    throw new Error("EXECUTION_HELPER_UNAVAILABLE");
  }
}

/** Only the fixed C2C native helper can be launched by this adapter. */
export class WindowsNativeExecutionRunner {
  constructor(
    private readonly options: {
      helperPath?: string;
      launcherPath?: string;
      moduleDirectory?: string;
      spawnImpl?: typeof spawn;
      runtimeResolver?: typeof resolveTrustedRuntime;
      beforeHelperRequestWrite?: (runtime: TrustedRuntime) => void;
      launcherTestHoldMs?: number;
      launcherEvidence?: (line: string) => void;
      helperBeforeResumeTest?: { releaseFile: string; phase?: "suspended" | "permit"; onSuspended: (line: string) => void };
    } = {}
  ) {}

  start(request: NativeRunnerRequest, callbacks: NativeRunnerCallbacks): NativeRunnerHandle {
    const launcherPath = resolveExecutionLauncherPath({
      helperPath: this.options.helperPath,
      launcherPath: this.options.launcherPath,
      moduleDirectory: this.options.moduleDirectory,
    });
    const fullAccess = "fullAccess" in request ? request.fullAccess : undefined;
    const fullAccessGit = "fullAccessGit" in request ? request.fullAccessGit : undefined;
    const legacyRequest = fullAccess ? undefined : request as NativeRunnerBaseRequest & {
      repository: RepositoryIdentity;
      trustedCommand: TrustedCommand;
      genericCommand?: GenericCommand;
      fullAccessGit?: FullAccessGitNativeLaunch;
    };
    const runtime = legacyRequest
      ? (this.options.runtimeResolver ?? resolveTrustedRuntime)(legacyRequest.trustedCommand.packageManager)
      : undefined;
    const jobTempDir = request.tempLease.directoryPath;
    const stateRoot = path.resolve(request.tempLease.rootPath, "..", "..", "..");
    const expectedTempRoot = path.join(stateRoot, "execution-jobs", request.tempLease.workspaceId, "execution-temp");
    if (path.resolve(request.tempLease.rootPath).toLowerCase() !== path.resolve(expectedTempRoot).toLowerCase()) {
      throw new Error("EXECUTION_TEMP_OWNERSHIP_INVALID");
    }

    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    const systemDirectory = path.join(systemRoot, "System32");
    const env: NodeJS.ProcessEnv = fullAccess ? {
      ...process.env,
      C2C_STATE_DIR: stateRoot,
    } : {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: systemDirectory,
      ComSpec: path.join(systemDirectory, "cmd.exe"),
      C2C_STATE_DIR: stateRoot,
      TEMP: jobTempDir,
      TMP: jobTempDir,
    };
    if (this.options.launcherTestHoldMs !== undefined) {
      const holdMs = Math.max(0, Math.min(3000, Math.trunc(this.options.launcherTestHoldMs)));
      env.C2C_EXECUTION_LAUNCHER_TEST_EVIDENCE = "1";
      env.C2C_EXECUTION_LAUNCHER_TEST_HOLD_MS = String(holdMs);
    }
    if (this.options.helperBeforeResumeTest) {
      env.C2C_EXECUTION_HELPER_TEST_RELEASE = path.resolve(this.options.helperBeforeResumeTest.releaseFile);
      env.C2C_EXECUTION_HELPER_TEST_PHASE = this.options.helperBeforeResumeTest.phase ?? "suspended";
    }
    const spawnImpl = this.options.spawnImpl ?? spawn;
    let input: Buffer;
    let child: ChildProcessWithoutNullStreams;
    try {
      if (fullAccess) {
        const helperRequest: FullAccessHelperRequest = {
          timeoutSeconds: request.timeoutSeconds,
          workspaceId: fullAccess.workspaceId,
          jobId: request.jobId,
          oauthClientId: fullAccess.oauthClientId,
          permissionMode: fullAccess.permissionMode,
          sessionGrantFingerprint: fullAccess.sessionGrantFingerprint,
          sessionGrantId: fullAccess.sessionGrantId,
          idempotencyKeyHash: fullAccess.idempotencyKeyHash,
          requestHash: fullAccess.requestHash,
          command: fullAccess.command,
          tempRootPath: request.tempLease.rootPath,
          tempRootFileIdentity: request.tempLease.rootFileIdentity,
          tempNonce: request.tempLease.nonce,
          tempCreatedAtMs: request.tempLease.createdAtMs,
          jobTempDir,
          jobTempFileIdentity: request.tempLease.directoryFileIdentity,
        };
        input = serializeFullAccessHelperRequest(helperRequest);
      } else {
      const legacy = legacyRequest!;
      const trusted = legacy.trustedCommand;
      const repository = legacy.repository;
      const trustedRuntime = runtime!;
      const helperRequest: HelperRequest = {
        packageManager: trusted.packageManager,
        kind: trusted.kind,
        timeoutSeconds: request.timeoutSeconds,
        cwd: repository.canonicalPath,
        gitDirectory: repository.gitDirectory,
        gitDirectoryFileIdentity: repository.fileIdentities.gitDirectory,
        commonGitDirectory: repository.commonGitDirectory,
        commonGitDirectoryFileIdentity: repository.fileIdentities.commonGitDirectory,
        nodeExecutable: trustedRuntime.nodeExecutable,
        nodeFileIdentity: trustedRuntime.nodeFileIdentity,
        nodeHash: trustedRuntime.nodeHash,
        managerCli: trustedRuntime.managerCli,
        managerFileIdentity: trustedRuntime.managerFileIdentity,
        managerHash: trustedRuntime.managerHash,
        managerLibCli: trustedRuntime.managerLibCli,
        managerLibCliFileIdentity: trustedRuntime.managerLibCliFileIdentity,
        managerLibCliHash: trustedRuntime.managerLibCliHash,
        managerValidateEngines: trustedRuntime.managerValidateEngines,
        managerValidateEnginesFileIdentity: trustedRuntime.managerValidateEnginesFileIdentity,
        managerValidateEnginesHash: trustedRuntime.managerValidateEnginesHash,
        managerMainEntry: trustedRuntime.managerMainEntry,
        managerMainEntryFileIdentity: trustedRuntime.managerMainEntryFileIdentity,
        managerMainEntryHash: trustedRuntime.managerMainEntryHash,
        managerPackageJson: trustedRuntime.managerPackageJson,
        managerPackageJsonFileIdentity: trustedRuntime.managerPackageJsonFileIdentity,
        managerPackageJsonHash: trustedRuntime.managerPackageJsonHash,
        managerExitHandler: trustedRuntime.managerExitHandler,
        managerExitHandlerFileIdentity: trustedRuntime.managerExitHandlerFileIdentity,
        managerExitHandlerHash: trustedRuntime.managerExitHandlerHash,
        managerCore: trustedRuntime.managerCore,
        managerCoreFileIdentity: trustedRuntime.managerCoreFileIdentity,
        managerCoreHash: trustedRuntime.managerCoreHash,
        target: trusted.target,
        tempRootPath: request.tempLease.rootPath,
        tempRootFileIdentity: request.tempLease.rootFileIdentity,
        tempWorkspaceId: request.tempLease.workspaceId,
        tempJobId: request.tempLease.jobId,
        tempNonce: request.tempLease.nonce,
        tempCreatedAtMs: request.tempLease.createdAtMs,
        jobTempDir,
        jobTempFileIdentity: request.tempLease.directoryFileIdentity,
        repositoryFileIdentity: repository.fileIdentities.repository,
        gitEntryFileIdentity: repository.fileIdentities.gitEntry,
        gitEntryType: repository.gitEntryType,
        gitEntryHash: repository.gitEntryHash,
        packageJsonHash: legacy.genericCommand?.approvalManifestHash ?? trusted.packageJsonHash,
        genericCommand: legacy.genericCommand,
      };
      if (fullAccessGit && !legacy.genericCommand) throw new Error("FULL_ACCESS_GIT_PLAN_REQUIRED");
      input = fullAccessGit
        ? serializeFullAccessGitHelperRequest({
            ...helperRequest,
            genericCommand: legacy.genericCommand!,
            oauthClientId: fullAccessGit.oauthClientId,
            permissionMode: fullAccessGit.permissionMode,
            sessionGrantFingerprint: fullAccessGit.sessionGrantFingerprint,
            sessionGrantId: fullAccessGit.sessionGrantId,
          })
        : serializeHelperRequest(helperRequest);
      }
      child = spawnImpl(launcherPath, [], {
        cwd: path.dirname(launcherPath),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      }) as ChildProcessWithoutNullStreams;
      try {
        if (runtime) this.options.beforeHelperRequestWrite?.(runtime);
      } catch (error) {
        child.stdin.destroy();
        throw error;
      }
    } catch (error) {
      try {
        runExecutionTempCleanup(request.tempLease, request.stateDirectory,
          (message) => callbacks.onDiagnostic?.(redact(message).slice(-512)), launcherPath);
      } catch {
        /* Keep the persisted ownership record for a later identity-checked recovery. */
      }
      throw new Error("EXECUTION_HELPER_START_FAILED", { cause: error });
    }

    const decoder = new HelperOutputDecoder(EXECUTION_HELPER_PROTOCOL_VERSION);
    let frameResult: HelperResultFrame | null = null;
    let protocolError: Error | null = null;
    let outputError: Error | null = null;
    let stdoutError: Error | null = null;
    let diagnostics = "";
    let cancelSent = false;
    let abandoned = false;
    let spawnError: Error | null = null;
    let launcherEvidencePending = "";

    const stdoutPump = (async () => {
      try {
        for await (const data of child.stdout) {
          if (protocolError) continue;
          let frames;
          try {
            frames = decoder.push(Buffer.from(data));
          } catch (error) {
            protocolError = error instanceof Error ? error : new Error("HELPER_PROTOCOL_INVALID");
            abandoned = true;
            child.stdin.destroy(); // EOF asks the helper to clean up its owned Job.
            continue;
          }
          for (const frame of frames) {
            if (frame.type === "stdout" || frame.type === "stderr") {
              if (abandoned || outputError) continue;
              try {
                await callbacks.onOutput(frame.type, frame.data);
              } catch (error) {
                outputError = error instanceof Error ? error : new Error("OUTPUT_PERSISTENCE_FAILED", { cause: error });
                abandoned = true;
                child.stdin.destroy(); // Stop accepting more work and let the helper clean up.
              }
            } else {
              frameResult = frame.result;
            }
          }
        }
      } catch (error) {
        stdoutError = error instanceof Error ? error : new Error("EXECUTION_HELPER_STDOUT_FAILED", { cause: error });
        abandoned = true;
        child.stdin.destroy();
      }
    })();

    const completion = new Promise<NativeRunnerCompletion>((resolve, reject) => {
      child.stderr.on("data", (data: Buffer) => {
        const chunk = Buffer.from(data).toString("utf8");
        diagnostics = (diagnostics + chunk).slice(-4096);
        if (this.options.launcherEvidence || this.options.helperBeforeResumeTest) {
          launcherEvidencePending += chunk;
          const lines = launcherEvidencePending.split(/\r?\n/);
          launcherEvidencePending = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("C2C_EXECUTION_LAUNCHER_EVIDENCE:")) this.options.launcherEvidence?.(line);
            if (line.startsWith("C2C_EXECUTION_HELPER_SUSPENDED:")) this.options.helperBeforeResumeTest?.onSuspended(line);
          }
        }
      });
      child.once("error", (error) => {
        spawnError = new Error("EXECUTION_HELPER_START_FAILED", { cause: error });
      });
      child.once("close", (code) => {
        void stdoutPump.then(() => {
          if (!runExecutionTempCleanup(request.tempLease, request.stateDirectory,
            (message) => callbacks.onDiagnostic?.(redact(message).slice(-512)), launcherPath)) {
            reject(new Error("EXECUTION_TEMP_CLEANUP_FAILED"));
            return;
          }
          if (spawnError) {
            reject(spawnError);
            return;
          }
          if (stdoutError) {
            reject(new Error("EXECUTION_HELPER_STDOUT_FAILED", { cause: stdoutError }));
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
          if (outputError) {
            reject(new NativeRunnerOutputError(outputError, frameResult, code, true));
            return;
          }
          if (diagnostics || frameResult.outcome === 3) {
            const resultDiagnostic = `helper outcome=${frameResult.outcome}; win32Error=${frameResult.win32Error}; ` +
              `exitCode=${frameResult.exitCode}`;
            callbacks.onDiagnostic?.(redact([diagnostics, resultDiagnostic].filter(Boolean).join("\n")).slice(-512));
          }
          resolve({ result: frameResult, helperExitCode: code, tempCleanupConfirmed: true });
        }).catch(reject);
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
