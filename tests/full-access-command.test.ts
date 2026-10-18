import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFullAccessCommand } from "../src/execution/full-access-command.js";

function makeTmpDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

describe.skipIf(process.platform !== "win32")("Full Access executable extension resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves explicit .com files and preserves .exe-before-.com preference", async () => {
    const root = makeTmpDir("full-access-extension-workspace");
    const bin = makeTmpDir("full-access-extension-bin");
    fs.writeFileSync(path.join(bin, "sample.exe"), "MZ test exe", { flag: "wx" });
    fs.writeFileSync(path.join(bin, "sample.com"), "MZ test com", { flag: "wx" });
    vi.stubEnv("PATH", bin);

    const preferred = await resolveFullAccessCommand({
      engine: "program", executable: "sample", args: [], cwd: root,
    }, root);
    expect(path.win32.basename(preferred.executable).toLowerCase()).toBe("sample.exe");

    fs.unlinkSync(path.join(bin, "sample.exe"));
    const fallback = await resolveFullAccessCommand({
      engine: "program", executable: "sample", args: [], cwd: root,
    }, root);
    expect(path.win32.basename(fallback.executable).toLowerCase()).toBe("sample.com");

    const explicit = await resolveFullAccessCommand({
      engine: "program", executable: path.join(bin, "sample.com"), args: [], cwd: root,
    }, root);
    expect(path.win32.basename(explicit.executable).toLowerCase()).toBe("sample.com");
  });

  it.each([".bat", ".cmd", ".ps1", ".dll"]) (
    "rejects explicit %s files before queueing",
    async (extension) => {
      const root = makeTmpDir("full-access-extension-deny");
      const executable = path.join(root, `sample${extension}`);
      fs.writeFileSync(executable, "MZ test file", { flag: "wx" });
      await expect(resolveFullAccessCommand({
        engine: "program", executable, args: [], cwd: root,
      }, root)).rejects.toThrow("PROGRAM_REQUIRES_EXECUTABLE");
    },
  );
});
