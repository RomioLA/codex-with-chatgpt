import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflaredNamedTunnel, type CloudflaredNamedTunnelOptions } from "../src/tunnel/cloudflared-named.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);

  exitEvent(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  closeEvent(code: number | null = this.exitCode, signal: NodeJS.Signals | null = this.signalCode): void {
    this.emit("close", code, signal);
  }

  exit(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exitEvent(code, signal);
    this.closeEvent(code, signal);
  }
}

function makeTunnel(opts: Partial<CloudflaredNamedTunnelOptions> = {}): CloudflaredNamedTunnel {
  return new CloudflaredNamedTunnel({
    tunnelName: "c2c-retry-test",
    hostname: "c2c-demo.example.com",
    binaryOverride: "fake-cloudflared",
    startTimeoutMs: 200,
    startupDeadlineMs: 1_000,
    retryBackoffMs: [10, 20],
    stopWaitMs: 10,
    ...opts,
  });
}

function queueChildren(...children: FakeCloudflaredProcess[]): void {
  let next = 0;
  spawnMock.mockImplementation(() => children[next++] as unknown as ChildProcess);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function useFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "performance"],
  });
}

function transientDns(child: FakeCloudflaredProcess): void {
  child.stderr.write('ERR Failed to resolve edge address: lookup region1.v2.argotunnel.com: no such host\n');
}

function announceConnection(child: FakeCloudflaredProcess): void {
  child.stderr.write("INF Registered tunnel connection connIndex=0\n");
}

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe("Cloudflared Named Tunnel startup retry", () => {
  it.each(["exhausted", "timeout"] as const)("enforces the production retry defaults through %s", async (outcome) => {
    useFakeTimers();
    const children = Array.from({ length: 6 }, () => new FakeCloudflaredProcess());
    queueChildren(...children);
    const tunnel = new CloudflaredNamedTunnel({
      tunnelName: "c2c-production-defaults-test",
      hostname: "c2c-demo.example.com",
      binaryOverride: "fake-cloudflared",
    });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow(
      outcome === "exhausted" ? "startup exhausted: attempts=6" : "category=timeout"
    );
    await flushMicrotasks();

    for (const [index, delay] of [2_000, 4_000, 8_000, 16_000, 16_000].entries()) {
      transientDns(children[index]!);
      children[index]!.exit(1);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(spawnMock).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnMock).toHaveBeenCalledTimes(index + 2);
    }

    if (outcome === "exhausted") {
      transientDns(children[5]!);
      children[5]!.exit(1);
    } else {
      // The five backoffs consumed 46 seconds of the shared 75-second budget.
      await vi.advanceTimersByTimeAsync(28_999);
      expect(children[5]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(children[5]!.kill).toHaveBeenCalledWith("SIGTERM");
      expect(tunnel.status().detail).toContain("elapsedMs=75000");
      children[5]!.exit(1);
    }
    await rejected;
    expect(spawnMock).toHaveBeenCalledTimes(6);
  });

  it("retries a pre-connection DNS failure once and clears the diagnostic on success", async () => {
    useFakeTimers();
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    queueChildren(first, second);
    const tunnel = makeTunnel({ retryBackoffMs: [10], maxAttempts: 2 });

    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    transientDns(first);
    first.exit(1);
    await flushMicrotasks();

    expect(tunnel.status().detail).toBe(
      "Named tunnel startup retrying: attempts=1; category=dns_unavailable; elapsedMs=0; delayMs=10"
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    announceConnection(second);

    await expect(starting).resolves.toBe("https://c2c-demo.example.com");
    expect(tunnel.status()).toMatchObject({ running: true, processRunning: true, connected: true });
    expect(tunnel.status().detail).toBeUndefined();
  });

  it("keeps scanning stderr between exit and close before classifying the attempt", async () => {
    useFakeTimers();
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    queueChildren(first, second);
    const tunnel = makeTunnel({ retryBackoffMs: [10], maxAttempts: 2 });
    const starting = tunnel.start(48_765);
    await flushMicrotasks();

    first.exitEvent(1);
    await flushMicrotasks();
    expect(tunnel.status()).toMatchObject({ processRunning: false, connected: false, url: null });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    transientDns(first);
    first.closeEvent(1);
    await flushMicrotasks();

    expect(tunnel.status().detail).toContain("category=dns_unavailable");
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    announceConnection(second);
    await expect(starting).resolves.toBe("https://c2c-demo.example.com");
  });

  it.each([
    ["connection refused", "ERR failed to dial edge: dial tcp 198.41.200.1:443: connect: connection refused"],
    ["network unreachable", "ERR failed to reach edge: network is unreachable"],
  ])("retries an explicitly reported network failure (%s)", async (_label, evidence) => {
    useFakeTimers();
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    queueChildren(first, second);
    const tunnel = makeTunnel({ retryBackoffMs: [5], maxAttempts: 2 });
    const starting = tunnel.start(48_765);
    first.stderr.write(`${evidence}\n`);
    first.exit(1);
    await flushMicrotasks();

    expect(tunnel.status().detail).toContain("category=network_unavailable");
    await vi.advanceTimersByTimeAsync(5);
    announceConnection(second);
    await expect(starting).resolves.toBe("https://c2c-demo.example.com");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("never overlaps cloudflared children and exhausts after the configured bounded attempts", async () => {
    useFakeTimers();
    const children = Array.from({ length: 3 }, () => new FakeCloudflaredProcess());
    let live = 0;
    let maximumLive = 0;
    let next = 0;
    spawnMock.mockImplementation(() => {
      const child = children[next++];
      live += 1;
      maximumLive = Math.max(maximumLive, live);
      child.once("exit", () => { live -= 1; });
      return child as unknown as ChildProcess;
    });
    const tunnel = makeTunnel({ retryBackoffMs: [5, 10], maxAttempts: 3 });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow(
      "Named tunnel startup exhausted: attempts=3; category=dns_unavailable; elapsedMs=15"
    );

    for (let attempt = 0; attempt < children.length; attempt += 1) {
      await flushMicrotasks();
      expect(spawnMock).toHaveBeenCalledTimes(attempt + 1);
      transientDns(children[attempt]);
      children[attempt].exit(1);
      await flushMicrotasks();
      if (attempt < children.length - 1) await vi.advanceTimersByTimeAsync([5, 10][attempt]);
    }

    await rejected;
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(maximumLive).toBe(1);
    expect(tunnel.status().detail).toBe(
      "Named tunnel startup exhausted: attempts=3; category=dns_unavailable; elapsedMs=15"
    );
  });

  it("lets permanent credentials evidence dominate mixed DNS evidence", async () => {
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    transientDns(child);
    child.stderr.write("ERR invalid tunnel credentials\n");
    child.exit(1);

    await expect(starting).rejects.toThrow("category=permanent");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tunnel.status().detail).toContain("category=permanent");
    expect(tunnel.status().detail).not.toContain("credentials");
    expect(tunnel.status().detail).not.toContain("region1.v2.argotunnel.com");
  });

  it.each([
    ["invalid configuration", "ERR invalid configuration file"],
    ["YAML parse failure", "ERR error parsing YAML in config file"],
    ["configuration parse failure", "ERR failed to parse config file"],
    ["unknown flag", "ERR unknown flag --unsupported-option"],
    ["HTTP 401", "ERR HTTP 401 Unauthorized"],
    ["HTTP 403", "ERR HTTP 403 Forbidden"],
  ])("lets permanent %s evidence dominate mixed DNS evidence", async (_label, evidence) => {
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    transientDns(child);
    child.stderr.write(`${evidence}\n`);
    child.exit(1);

    await expect(starting).rejects.toThrow("category=permanent");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tunnel.status().detail).toContain("category=permanent");
  });

  it.each([404, 429, 503])("hard-fails unsupported HTTP %s without borrowing earlier DNS evidence", async (status) => {
    const first = new FakeCloudflaredProcess();
    queueChildren(first);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    transientDns(first);
    first.stderr.write(`ERR HTTP ${status} response\n`);
    first.exit(1);
    await expect(starting).rejects.toThrow("category=unknown");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ENOENT", "binary_missing"],
    ["EACCES", "permanent"],
  ] as const)("hard-fails a spawn %s without retry", async (code, category) => {
    spawnMock.mockImplementation(() => {
      throw Object.assign(new Error("secret/path must not escape"), { code });
    });
    const tunnel = makeTunnel();

    await expect(tunnel.start(48_765)).rejects.toThrow(`category=${category}`);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tunnel.status().detail).not.toContain("secret/path");
  });

  it.each([
    ["unclassified exit", "", 1, null],
    ["successful exit code", "DNS", 0, null],
    ["signalled child", "DNS", 1, "SIGTERM"],
    ["lookalike DNS hostname", "lookup api.cloudflare.com.evil: no such host", 1, null],
    ["unrelated host and argotunnel text", "request https://other.example/path?x=argotunnel.com: no such host", 1, null],
  ] as const)("does not retry %s", async (_label, evidence, code, signal) => {
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    if (evidence === "DNS") transientDns(child);
    else if (evidence) child.stderr.write(`ERR ${evidence}\n`);
    child.exit(code, signal);

    await expect(starting).rejects.toThrow("category=unknown");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("connects on the first attempt without waiting and shares concurrent start calls", async () => {
    useFakeTimers();
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel();
    const first = tunnel.start(48_765);
    const concurrent = tunnel.start(48_765);

    expect(concurrent).toBe(first);
    await flushMicrotasks();
    announceConnection(child);

    await expect(first).resolves.toBe("https://c2c-demo.example.com");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(tunnel.status().detail).toBeUndefined();
  });

  it("does not resolve if the child exits immediately after announcing a connection", async () => {
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    announceConnection(child);
    child.exit(1);

    await expect(starting).rejects.toThrow("category=unknown");
    expect(tunnel.status()).toMatchObject({ processRunning: false, connected: false, url: null });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not resolve success if stop wins before the pending start settles", async () => {
    const child = new FakeCloudflaredProcess();
    child.kill.mockImplementation(() => {
      child.exit(0);
      return true;
    });
    queueChildren(child);
    const tunnel = makeTunnel();
    const starting = tunnel.start(48_765);
    announceConnection(child);
    let stopping: Promise<void> | undefined;
    queueMicrotask(() => { stopping = tunnel.stop(); });

    await expect(starting).rejects.toThrow("category=stopped");
    await flushMicrotasks();
    await expect(stopping).resolves.toBeUndefined();
    expect(tunnel.status()).toMatchObject({ processRunning: false, connected: false, url: null });
  });

  it("rejects a connection signal at the monotonic deadline before the timer callback", async () => {
    useFakeTimers();
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel({ startTimeoutMs: 200, startupDeadlineMs: 100, maxAttempts: 1, retryBackoffMs: [] });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow("category=timeout");
    await flushMicrotasks();
    const now = vi.spyOn(globalThis.performance, "now").mockReturnValue(100);

    announceConnection(child);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: false });
    expect(tunnel.status().detail).toContain("elapsedMs=100");
    now.mockRestore();
    child.exit(1);
  });

  it("rechecks the monotonic deadline when committing an earlier connection signal", async () => {
    useFakeTimers();
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel({ startTimeoutMs: 200, startupDeadlineMs: 100, maxAttempts: 1, retryBackoffMs: [] });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow("category=timeout");
    await flushMicrotasks();
    const now = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);

    announceConnection(child);
    queueMicrotask(() => now.mockReturnValue(100));
    await rejected;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: false });
    expect(tunnel.status().detail).toContain("elapsedMs=100");
    now.mockRestore();
    child.exit(1);
  });

  it("clears the pending promise before returning success so a later start is fresh", async () => {
    const firstChild = new FakeCloudflaredProcess();
    const secondChild = new FakeCloudflaredProcess();
    queueChildren(firstChild, secondChild);
    const tunnel = makeTunnel();
    const firstStart = tunnel.start(48_765);
    announceConnection(firstChild);
    await expect(firstStart).resolves.toBe("https://c2c-demo.example.com");
    firstChild.exit(0);

    const secondStart = tunnel.start(48_765);
    expect(secondStart).not.toBe(firstStart);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    announceConnection(secondChild);
    await expect(secondStart).resolves.toBe("https://c2c-demo.example.com");
  });

  it("cancels a pending retry during backoff without spawning again", async () => {
    useFakeTimers();
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel({ retryBackoffMs: [500], maxAttempts: 2 });
    const starting = tunnel.start(48_765);
    await flushMicrotasks();
    transientDns(child);
    child.exit(1);
    await flushMicrotasks();

    await tunnel.stop();
    await expect(starting).rejects.toThrow("category=stopped");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tunnel.status().detail).toContain("startup cancelled");
    expect(tunnel.status().detail).toContain("category=stopped");
  });

  it("blocks another spawn when a timed-out child has not exited after stop", async () => {
    useFakeTimers();
    const child = new FakeCloudflaredProcess();
    queueChildren(child);
    const tunnel = makeTunnel({ startTimeoutMs: 20, startupDeadlineMs: 100, stopWaitMs: 10 });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow("category=timeout");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    await rejected;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: false });
    await expect(tunnel.start(48_765)).rejects.toThrow("category=termination_unconfirmed");
    const stopping = tunnel.stop();
    const stopRejected = expect(stopping).rejects.toThrow("category=termination_unconfirmed");
    await vi.advanceTimersByTimeAsync(10);
    await stopRejected;
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(tunnel.status().detail).toContain("category=termination_unconfirmed");
  });

  it("ignores stale output from an exited child after the next child starts", async () => {
    useFakeTimers();
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    queueChildren(first, second);
    const tunnel = makeTunnel({ startTimeoutMs: 20, startupDeadlineMs: 200, maxAttempts: 1 });
    const firstStart = tunnel.start(48_765);
    const firstRejected = expect(firstStart).rejects.toThrow("category=timeout");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(20);
    await firstRejected;
    first.exit(1);

    const secondStart = tunnel.start(48_765);
    await flushMicrotasks();
    first.stderr.write("INF Registered tunnel connection connIndex=0\n");
    first.exit(1);
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: false, url: null });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    announceConnection(second);

    await expect(secondStart).resolves.toBe("https://c2c-demo.example.com");
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: true });
  });

  it("applies one total deadline across retries and kills the final attempt", async () => {
    useFakeTimers();
    const first = new FakeCloudflaredProcess();
    const second = new FakeCloudflaredProcess();
    queueChildren(first, second);
    const tunnel = makeTunnel({
      startTimeoutMs: 100,
      startupDeadlineMs: 20,
      retryBackoffMs: [5],
      maxAttempts: 2,
    });
    const starting = tunnel.start(48_765);
    const rejected = expect(starting).rejects.toThrow("category=timeout");
    await flushMicrotasks();
    transientDns(first);
    first.exit(1);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5);
    await flushMicrotasks();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15);
    await rejected;

    expect(second.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ processRunning: true, connected: false });
    expect(tunnel.status().detail).toContain("elapsedMs=20");
  });
});
