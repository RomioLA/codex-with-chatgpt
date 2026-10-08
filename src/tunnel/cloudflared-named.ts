import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { findBinary } from "./detect.js";
import { tunnelProtocolArgs } from "./protocol.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const CONNECTED_RE = /registered tunnel connection/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const DEFAULT_RETRY_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 16_000] as const;
const DEFAULT_STARTUP_DEADLINE_MS = 75_000;
const DEFAULT_STOP_WAIT_MS = 1_000;
const MAX_START_ATTEMPTS = 6;

type StartupStatus = "retrying" | "exhausted" | "failed" | "cancelled";
type StartupCategory =
  | "dns_unavailable"
  | "network_unavailable"
  | "permanent"
  | "unknown"
  | "timeout"
  | "stopped"
  | "binary_missing"
  | "termination_unconfirmed";

interface StartupRun {
  generation: number;
  startedAt: number;
  deadlineAt: number;
  attempts: number;
  cancelled: boolean;
  connectedChild?: ChildRun;
  cancelAttempt?: () => void;
  cancelDelay?: () => void;
}

interface ChildRun {
  child: ChildProcess;
  generation: number;
  connected: boolean;
  acceptConnection: boolean;
  terminal: boolean;
  stopping: boolean;
  exitObserved: boolean;
  transientDns: boolean;
  transientNetwork: boolean;
  permanent: boolean;
  unsupportedHttpFailure: boolean;
  timeoutRequested: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
}

type AttemptResult =
  | { kind: "connected"; url: string; childRun: ChildRun }
  | { kind: "exited"; childRun: ChildRun }
  | { kind: "spawnError"; code: string | null }
  | { kind: "timeout" }
  | { kind: "cancelled" };

export interface CloudflaredNamedTunnelOptions {
  tunnelName: string;
  hostname: string;
  logger?: Logger;
  binaryOverride?: string;
  /** Maximum time for one attempt to establish a connection. */
  startTimeoutMs?: number;
  /** Total startup deadline across all attempts and retry delays. Capped at 75 seconds. */
  startupDeadlineMs?: number;
  /** Delay before each retry. The default allows six total attempts. */
  retryBackoffMs?: readonly number[];
  /** Maximum number of process attempts, capped at six. */
  maxAttempts?: number;
  /** Bounded wait for a SIGTERM'd process to emit exit or close. */
  stopWaitMs?: number;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : null;
}

function classifyLogLine(line: string): {
  transientDns: boolean;
  transientNetwork: boolean;
  permanent: boolean;
  unsupportedHttpFailure: boolean;
} {
  const permanent =
    /\b(?:unauthorized|forbidden|authentication failed|failed to authenticate|not authorized|permission denied|access denied|invalid credentials|invalid tunnel credentials|credentials file.*(?:invalid|missing|unreadable)|(?:invalid|malformed|missing).{0,80}(?:tunnel (?:id|name|uuid)|origin cert|cert\.pem)|(?:unknown|unrecognized) flag|flag provided but not defined|invalid value for flag|missing required (?:argument|flag)|no such tunnel|tunnel (?:does not exist|not found))\b/i.test(line) ||
    /\b(?:invalid|malformed)\s+(?:configuration|config)(?:\s+file)?\b|\b(?:error parsing|failed to parse)\s+(?:yaml|config(?:uration)?)(?:\s+in\s+(?:the\s+)?config(?:uration)?\s+file|\s+file)?\b/i.test(line) ||
    /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:status\s+)?(?:401|403)\b/i.test(line) ||
    /(?:unable to|failed to) (?:load|read|open|find|parse).{0,100}(?:credentials?|origin cert|cert\.pem|tunnel (?:id|name|uuid))/i.test(line);

  const knownCloudflareHost =
    "(?:api\\.cloudflare\\.com|update\\.argotunnel\\.com|region[1-4]\\.v2\\.argotunnel\\.com|_us-v2-origintunneld\\._tcp\\.argotunnel\\.com)";
  const transientDns =
    new RegExp(`\\blookup\\s+${knownCloudflareHost}(?=[:\\s]|$)`, "i").test(line) &&
    /\b(?:no such host|temporary failure in name resolution|server misbehaving|i\/o timeout|context deadline exceeded|timed out|timeout)\b/i.test(line);

  const explicitNetworkError =
    /\b(?:network is unreachable|no route to host)\b/i.test(line) && /\b(?:dial|connect|edge)\b/i.test(line);
  const dialTcpFailure =
    /\bdial tcp\b[^\r\n]{0,240}\bconnect:\s*(?:connection refused|connection reset by peer|i\/o timeout|operation timed out|network is unreachable)\b/i.test(line);
  const transientNetwork = explicitNetworkError || dialTcpFailure;
  // An HTTP response is separate evidence from DNS/transport failure. Only
  // the explicitly recognized authentication responses are classified above;
  // other HTTP failures must not borrow an earlier DNS warning to get retries.
  const unsupportedHttpFailure = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:status\s+)?[45]\d{2}\b/i.test(line);

  return { transientDns, transientNetwork, permanent, unsupportedHttpFailure };
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and its DNS route are provisioned once with cloudflared.
 * This provider only starts and monitors the connector process, so the public
 * URL remains stable across bridge restarts.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private readonly tunnelName: string;
  private readonly hostname: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly startTimeoutMs: number;
  private readonly startupDeadlineMs: number;
  private readonly retryBackoffMs: readonly number[];
  private readonly maxAttempts: number;
  private readonly stopWaitMs: number;
  private child: ChildProcess | null = null;
  private childRun: ChildRun | null = null;
  private connected = false;
  private lastError: string | null = null;
  private generation = 0;
  private startupRun: StartupRun | null = null;
  private pendingStart: Promise<string> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    const tunnelName = opts.tunnelName.trim();
    if (!tunnelName || tunnelName.length > 128) {
      throw new Error("Named tunnel name must be between 1 and 128 characters");
    }
    this.tunnelName = tunnelName;
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;

    const startTimeoutMs = opts.startTimeoutMs ?? 45_000;
    if (!Number.isFinite(startTimeoutMs) || startTimeoutMs <= 0) {
      throw new Error("Named tunnel start timeout must be a positive number");
    }
    this.startTimeoutMs = startTimeoutMs;

    const startupDeadlineMs = opts.startupDeadlineMs ?? DEFAULT_STARTUP_DEADLINE_MS;
    if (
      !Number.isFinite(startupDeadlineMs) ||
      startupDeadlineMs <= 0 ||
      startupDeadlineMs > DEFAULT_STARTUP_DEADLINE_MS
    ) {
      throw new Error("Named tunnel startup deadline must be between 1 and 75000 milliseconds");
    }
    this.startupDeadlineMs = startupDeadlineMs;

    const retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    if (retryBackoffMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new Error("Named tunnel retry delays must be non-negative numbers");
    }
    const maxAttempts = opts.maxAttempts ?? (opts.retryBackoffMs ? retryBackoffMs.length + 1 : MAX_START_ATTEMPTS);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_START_ATTEMPTS) {
      throw new Error("Named tunnel maximum attempts must be between 1 and 6");
    }
    if (retryBackoffMs.length < maxAttempts - 1) {
      throw new Error("Named tunnel retry delays must cover every retry attempt");
    }
    this.maxAttempts = maxAttempts;
    this.retryBackoffMs = retryBackoffMs.slice(0, maxAttempts - 1);

    const stopWaitMs = opts.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
    if (!Number.isFinite(stopWaitMs) || stopWaitMs < 0 || stopWaitMs > 1_000) {
      throw new Error("Named tunnel stop wait must be between 0 and 1000 milliseconds");
    }
    this.stopWaitMs = stopWaitMs;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  private formatDiagnostic(
    status: StartupStatus,
    attempts: number,
    category: StartupCategory,
    startedAt: number,
    delayMs?: number
  ): string {
    const elapsedMs = Math.max(0, Math.floor(globalThis.performance.now() - startedAt));
    const delay = delayMs === undefined ? "" : `; delayMs=${Math.max(0, Math.floor(delayMs))}`;
    return `Named tunnel startup ${status}: attempts=${attempts}; category=${category}; elapsedMs=${elapsedMs}${delay}`;
  }

  private setDiagnostic(
    status: StartupStatus,
    attempts: number,
    category: StartupCategory,
    startedAt: number,
    delayMs?: number
  ): string {
    this.lastError = this.formatDiagnostic(status, attempts, category, startedAt, delayMs);
    return this.lastError;
  }

  private fail(
    run: StartupRun,
    status: Exclude<StartupStatus, "retrying">,
    attempts: number,
    category: StartupCategory
  ): never {
    throw new Error(this.setDiagnostic(status, attempts, category, run.startedAt));
  }

  private expireAttempt(
    run: StartupRun,
    attempt: number,
    childRun: ChildRun,
    beforeKill?: () => void
  ): string {
    const detail = this.setDiagnostic("failed", attempt, "timeout", run.startedAt);
    childRun.acceptConnection = false;
    childRun.connected = false;
    if (this.childRun === childRun) this.connected = false;
    beforeKill?.();
    if (!childRun.timeoutRequested && !childRun.terminal && !childRun.exitObserved) {
      childRun.timeoutRequested = true;
      try {
        childRun.child.kill("SIGTERM");
      } catch {
        // Keep the child reference until close confirms termination.
      }
    }
    return detail;
  }

  private ensureActive(run: StartupRun): void {
    if (run.cancelled || run.generation !== this.generation) {
      throw new Error(this.lastError ?? this.formatDiagnostic("cancelled", run.attempts, "stopped", run.startedAt));
    }
  }

  private successfulConnectionError(run: StartupRun, attempt: number): Error | null {
    if (run.cancelled || run.generation !== this.generation) {
      return new Error(this.formatDiagnostic("cancelled", run.attempts, "stopped", run.startedAt));
    }

    const childRun = run.connectedChild;
    if (globalThis.performance.now() >= run.deadlineAt) {
      const detail = childRun && this.childRun === childRun
        ? this.expireAttempt(run, attempt, childRun)
        : this.setDiagnostic("failed", attempt, "timeout", run.startedAt);
      return new Error(detail);
    }

    if (
      !childRun ||
      this.childRun !== childRun ||
      childRun.generation !== run.generation ||
      childRun.terminal ||
      childRun.exitObserved ||
      !childRun.connected
    ) {
      return new Error(this.setDiagnostic("failed", attempt, "unknown", run.startedAt));
    }
    return null;
  }

  start(localPort: number): Promise<string> {
    if (this.pendingStart) return this.pendingStart;
    if (this.stopPromise) {
      const detail = this.setDiagnostic("cancelled", 0, "stopped", globalThis.performance.now());
      return Promise.reject(new Error(detail));
    }
    if (this.childRun && !this.childRun.terminal) {
      if (this.childRun.connected && this.connected) return Promise.resolve(this.publicUrl());
      const detail = this.setDiagnostic("failed", 0, "termination_unconfirmed", globalThis.performance.now());
      return Promise.reject(new Error(detail));
    }

    const generation = ++this.generation;
    const startedAt = globalThis.performance.now();
    const run: StartupRun = {
      generation,
      startedAt,
      deadlineAt: startedAt + this.startupDeadlineMs,
      attempts: 0,
      cancelled: false,
    };
    this.startupRun = run;
    this.lastError = null;
    this.connected = false;

    let resolveTracked!: (url: string) => void;
    let rejectTracked!: (error: unknown) => void;
    const tracked = new Promise<string>((resolve, reject) => {
      resolveTracked = resolve;
      rejectTracked = reject;
    });
    this.pendingStart = tracked;
    void this.runStartup(run, localPort)
      .then(
        (url) => {
          const finish = (): void => {
            if (this.startupRun === run) this.startupRun = null;
            if (this.pendingStart === tracked) this.pendingStart = null;
          };
          const error = this.successfulConnectionError(run, run.attempts);
          finish();
          if (error) rejectTracked(error);
          else resolveTracked(url);
        },
        (error: unknown) => {
          if (this.startupRun === run) this.startupRun = null;
          if (this.pendingStart === tracked) this.pendingStart = null;
          rejectTracked(error);
        }
      );
    return tracked;
  }

  private async runStartup(run: StartupRun, localPort: number): Promise<string> {
    this.ensureActive(run);
    const bin = this.binary();
    if (!bin) this.fail(run, "failed", 0, "binary_missing");

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.ensureActive(run);
      const remainingMs = run.deadlineAt - globalThis.performance.now();
      if (remainingMs <= 0) this.fail(run, "failed", run.attempts, "timeout");
      if (this.childRun && !this.childRun.terminal) {
        this.fail(run, "failed", run.attempts, "termination_unconfirmed");
      }

      run.attempts = attempt;
      const timeoutMs = Math.min(this.startTimeoutMs, remainingMs);
      const result = await this.startChildAttempt(run, bin, localPort, attempt, timeoutMs);
      if (run.cancelled) {
        this.ensureActive(run);
        this.fail(run, "cancelled", attempt, "stopped");
      }
      if (result.kind === "cancelled") this.fail(run, "cancelled", attempt, "stopped");
      if (result.kind === "connected") {
        const error = this.successfulConnectionError(run, attempt);
        if (error) throw error;
        this.lastError = null;
        return result.url;
      }
      if (result.kind === "timeout") this.fail(run, "failed", attempt, "timeout");
      if (result.kind === "spawnError") {
        const category = result.code === "ENOENT" ? "binary_missing" : result.code === "EACCES" ? "permanent" : "unknown";
        this.fail(run, "failed", attempt, category);
      }

      const failureClass = result.kind === "exited"
        ? this.failureCategory(result.childRun)
        : "unknown";

      if (failureClass === "permanent") this.fail(run, "failed", attempt, "permanent");
      if (failureClass !== "dns_unavailable" && failureClass !== "network_unavailable") {
        this.fail(run, "failed", attempt, "unknown");
      }
      if (attempt >= this.maxAttempts) this.fail(run, "exhausted", attempt, failureClass);

      const delayMs = this.retryBackoffMs[attempt - 1];
      const remainingBeforeDelay = run.deadlineAt - globalThis.performance.now();
      if (remainingBeforeDelay <= 0 || delayMs >= remainingBeforeDelay) {
        this.fail(run, "failed", attempt, "timeout");
      }
      this.setDiagnostic("retrying", attempt, failureClass, run.startedAt, delayMs);
      const elapsedDelay = await this.waitForRetryDelay(run, delayMs);
      if (!elapsedDelay) {
        this.ensureActive(run);
        this.fail(run, "failed", attempt, "timeout");
      }
      this.ensureActive(run);
      if (globalThis.performance.now() >= run.deadlineAt) this.fail(run, "failed", attempt, "timeout");
    }

    this.fail(run, "failed", run.attempts, "unknown");
  }

  private failureCategory(childRun: ChildRun): "dns_unavailable" | "network_unavailable" | "permanent" | "unknown" {
    if (childRun.permanent) return "permanent";
    if (childRun.unsupportedHttpFailure) return "unknown";
    if (!childRun.exitObserved || childRun.exitCode !== 1 || childRun.signalCode !== null) return "unknown";
    if (childRun.transientDns) return "dns_unavailable";
    if (childRun.transientNetwork) return "network_unavailable";
    return "unknown";
  }

  private startChildAttempt(
    run: StartupRun,
    bin: string,
    localPort: number,
    attempt: number,
    timeoutMs: number
  ): Promise<AttemptResult> {
    let child: ChildProcess;
    try {
      child = spawn(
        bin,
        [
          "tunnel",
          "--no-autoupdate",
          "--url",
          `http://127.0.0.1:${localPort}`,
          ...tunnelProtocolArgs(),
          "run",
          this.tunnelName,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );
    } catch (error) {
      return Promise.resolve({ kind: "spawnError", code: errorCode(error) });
    }

    let resolveTerminal!: () => void;
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const childRun: ChildRun = {
      child,
      generation: run.generation,
      connected: false,
      acceptConnection: true,
      terminal: false,
      stopping: false,
      exitObserved: false,
      transientDns: false,
      transientNetwork: false,
      permanent: false,
      unsupportedHttpFailure: false,
      timeoutRequested: false,
      exitCode: null,
      signalCode: null,
      terminalPromise,
      resolveTerminal,
    };
    this.child = child;
    this.childRun = childRun;
    this.connected = false;

    return new Promise<AttemptResult>((resolve) => {
      let settled = false;
      const finish = (result: AttemptResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (run.cancelAttempt === cancel) run.cancelAttempt = undefined;
        if (result.kind !== "connected") childRun.acceptConnection = false;
        resolve(result);
      };
      const cancel = (): void => finish({ kind: "cancelled" });
      const timeout = setTimeout(() => {
        if (run.cancelled || run.generation !== this.generation) {
          finish({ kind: "cancelled" });
          return;
        }
        this.expireAttempt(run, attempt, childRun, () => finish({ kind: "timeout" }));
      }, timeoutMs);
      run.cancelAttempt = cancel;

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (childRun.terminal || this.childRun !== childRun || run.cancelled) return;
          const classification = classifyLogLine(line);
          childRun.transientDns ||= classification.transientDns;
          childRun.transientNetwork ||= classification.transientNetwork;
          childRun.permanent ||= classification.permanent;
          childRun.unsupportedHttpFailure ||= classification.unsupportedHttpFailure;

          if (
            CONNECTED_RE.test(line) &&
            childRun.acceptConnection &&
            !childRun.connected &&
            this.generation === run.generation
          ) {
            if (globalThis.performance.now() >= run.deadlineAt) {
              this.expireAttempt(run, attempt, childRun, () => finish({ kind: "timeout" }));
              return;
            }
            childRun.connected = true;
            run.connectedChild = childRun;
            this.connected = true;
            this.lastError = null;
            const url = this.publicUrl();
            this.logger.info(`Named tunnel established: ${url}`);
            finish({ kind: "connected", url, childRun });
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      const markTerminal = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (childRun.terminal) return;
        childRun.terminal = true;
        childRun.exitCode = code;
        childRun.signalCode = signal;
        childRun.resolveTerminal();
        if (this.childRun === childRun) {
          this.childRun = null;
          this.child = null;
          this.connected = false;
          if (childRun.stopping) this.lastError = null;
        }
      };

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (childRun.terminal || settled) return;
        const code = errorCode(error);
        finish({ kind: "spawnError", code });
      });
      child.on("exit", (code, signal) => {
        childRun.exitObserved = true;
        childRun.exitCode = code;
        childRun.signalCode = signal;
        childRun.acceptConnection = false;
        childRun.connected = false;
        if (this.childRun === childRun) this.connected = false;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
      });
      child.on("close", (code, signal) => {
        const wasStarting = !childRun.connected;
        markTerminal(code, signal);
        if (wasStarting) finish({ kind: "exited", childRun });
      });
    });
  }

  private waitForRetryDelay(run: StartupRun, delayMs: number): Promise<boolean> {
    if (run.cancelled || run.generation !== this.generation) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (elapsed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (run.cancelDelay === cancel) run.cancelDelay = undefined;
        resolve(elapsed);
      };
      const cancel = (): void => finish(false);
      const timeout = setTimeout(() => finish(true), delayMs);
      run.cancelDelay = cancel;
    });
  }

  private async waitForChildTermination(childRun: ChildRun, timeoutMs: number): Promise<boolean> {
    if (childRun.terminal) return true;
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const terminated = childRun.terminalPromise.then(() => true as const);
    const result = await Promise.race([terminated, timedOut]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    let tracked!: Promise<void>;
    tracked = this.stopInternal().finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  private async stopInternal(): Promise<void> {
    const run = this.startupRun;
    ++this.generation;
    this.connected = false;
    if (run) {
      run.cancelled = true;
      this.setDiagnostic("cancelled", run.attempts, "stopped", run.startedAt);
      run.cancelDelay?.();
      run.cancelAttempt?.();
    }

    const pending = this.pendingStart;
    if (pending) await pending.catch(() => undefined);

    const childRun = this.childRun;
    if (!childRun || childRun.terminal) return;
    childRun.acceptConnection = false;
    childRun.stopping = true;
    if (!childRun.exitObserved) {
      try {
        childRun.child.kill("SIGTERM");
      } catch {
        // A bounded wait below determines whether another process may start.
      }
    }
    const terminated = await this.waitForChildTermination(childRun, this.stopWaitMs);
    if (!terminated && this.childRun === childRun) {
      const startedAt = run?.startedAt ?? globalThis.performance.now();
      const detail = this.setDiagnostic("failed", run?.attempts ?? 0, "termination_unconfirmed", startedAt);
      throw new Error(detail);
    }
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    const processRunning = this.childRun !== null && !this.childRun.terminal && !this.childRun.exitObserved;
    return {
      running: processRunning && this.connected,
      url: this.connected && processRunning ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
      processRunning,
      connected: this.connected && processRunning,
    };
  }

  getPublicUrl(): string | null {
    return this.connected && this.childRun && !this.childRun.terminal && !this.childRun.exitObserved
      ? this.publicUrl()
      : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const processRunning = this.childRun !== null && !this.childRun.terminal && !this.childRun.exitObserved;
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !processRunning) problems.push("named tunnel process not running");
    if (processRunning && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: processRunning && this.connected,
      url: this.connected && processRunning ? this.publicUrl() : null,
      problems,
    };
  }
}
