import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HelperOutputDecoder } from "../src/execution/helper-protocol.js";
import { resolveExecutionHelperPath } from "../src/execution/native-runner.js";
import { makeTmpDir } from "./helpers.js";

describe("execution helper build and protocol contract", () => {
  it("uses one fixed package-relative helper location and rejects a missing helper", () => {
    const root = makeTmpDir("helper-layout");
    const moduleDirectory = path.join(root, "dist", "execution");
    const helper = path.join(root, "build", "native", "c2c-execution-helper.exe");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.mkdirSync(moduleDirectory, { recursive: true });
    fs.writeFileSync(helper, "fixture helper");

    expect(resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory }))
      .toBe(fs.realpathSync.native(helper));
    expect(() => resolveExecutionHelperPath({ platform: "win32", architecture: "arm64", moduleDirectory }))
      .toThrow("EXECUTION_HELPER_UNAVAILABLE");
    fs.unlinkSync(helper);
    expect(() => resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory }))
      .toThrow("EXECUTION_HELPER_UNAVAILABLE");
  });

  it("rejects a previous helper protocol version instead of falling back", () => {
    const decoder = new HelperOutputDecoder();
    expect(() => decoder.push(Buffer.from([0x43, 0x32, 0x43, 0x4f, 0x55, 0x54, 0x31, 0x00])))
      .toThrow("HELPER_PROTOCOL_BAD_HEADER");
  });

  it("keeps the helper in the default build and package distribution contract", () => {
    const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build?.indexOf("build:execution-helper")).toBeGreaterThanOrEqual(0);
    expect(packageJson.scripts?.build?.indexOf("build:execution-helper"))
      .toBeLessThan(packageJson.scripts?.build?.indexOf("tsc") ?? -1);
    expect(packageJson.scripts?.prepack).toContain("npm run build");
    expect(packageJson.files).toContain("build/native/c2c-execution-helper.exe");
  });
});
