import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForBridgeProcessExit } from "../src/process/daemon.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Bridge process shutdown wait", () => {
  it("waits until the acknowledged Bridge PID no longer exists", async () => {
    vi.useFakeTimers();
    let checks = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((() => {
      checks += 1;
      if (checks === 3) throw Object.assign(new Error("process not found"), { code: "ESRCH" });
      return true;
    }) as typeof process.kill);

    const waiting = waitForBridgeProcessExit(12345, 1000);
    await vi.advanceTimersByTimeAsync(200);

    await expect(waiting).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it("fails within a bounded timeout if the old Bridge PID remains alive", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const waiting = waitForBridgeProcessExit(12345, 150);
    const rejected = expect(waiting).rejects.toThrow("refusing to continue restart");
    await vi.advanceTimersByTimeAsync(150);

    await rejected;
    expect(kill).toHaveBeenCalled();
  });
});
