import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HelperOutputDecoder } from "../src/execution/helper-protocol.js";
import { resolveExecutionHelperPath, resolveExecutionLauncherPath } from "../src/execution/native-runner.js";
function makeTmpDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function fakePe(): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  return bytes;
}

function writeIntegrityMetadata(root: string, helperBytes: Buffer, launcherBytes = helperBytes): void {
  const metadata = path.join(root, "dist", "execution", "c2c-execution-helper-integrity.json");
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({
    version: 2,
    protocolVersion: 5,
    helperPath: "build/native/c2c-execution-helper.exe",
    sha256: createHash("sha256").update(helperBytes).digest("hex"),
    launcherPath: "build/native/c2c-execution-launcher.exe",
    launcherSha256: createHash("sha256").update(launcherBytes).digest("hex"),
  }));
}

describe("execution helper build and protocol contract", () => {
  it("uses one fixed package-relative helper location and rejects a missing helper", () => {
    const root = makeTmpDir("helper-layout");
    const moduleDirectory = path.join(root, "dist", "execution");
    const helper = path.join(root, "build", "native", "c2c-execution-helper.exe");
    const launcher = path.join(root, "build", "native", "c2c-execution-launcher.exe");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.mkdirSync(moduleDirectory, { recursive: true });
    const helperBytes = fakePe();
    const launcherBytes = fakePe();
    fs.writeFileSync(helper, helperBytes);
    fs.writeFileSync(launcher, launcherBytes);
    writeIntegrityMetadata(root, helperBytes, launcherBytes);

    expect(resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory }))
      .toBe(fs.realpathSync.native(helper));
    expect(resolveExecutionLauncherPath({ platform: "win32", architecture: "x64", moduleDirectory }))
      .toBe(fs.realpathSync.native(launcher));
    expect(() => resolveExecutionHelperPath({ platform: "win32", architecture: "arm64", moduleDirectory }))
      .toThrow("EXECUTION_HELPER_UNAVAILABLE");
    fs.unlinkSync(helper);
    expect(() => resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory }))
      .toThrow("EXECUTION_HELPER_UNAVAILABLE");
  });

  it("rejects a previous helper protocol version instead of falling back", () => {
    const decoder = new HelperOutputDecoder();
    expect(() => decoder.push(Buffer.from([0x43, 0x32, 0x43, 0x4f, 0x55, 0x54, 0x32, 0x00])))
      .toThrow("HELPER_PROTOCOL_BAD_HEADER");
    expect(() => decoder.push(Buffer.from([0x43, 0x32, 0x43, 0x4f, 0x55, 0x54, 0x33, 0x00])))
      .toThrow("HELPER_PROTOCOL_BAD_HEADER");
    expect(() => decoder.push(Buffer.from([0x43, 0x32, 0x43, 0x4f, 0x55, 0x54, 0x34, 0x00])))
      .toThrow("HELPER_PROTOCOL_BAD_HEADER");
  });

  it("rejects helper hash and metadata mismatches", () => {
    const root = makeTmpDir("helper-integrity-mismatch");
    const helper = path.join(root, "build", "native", "c2c-execution-helper.exe");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.mkdirSync(path.join(root, "dist", "execution"), { recursive: true });
    fs.writeFileSync(helper, fakePe());
    fs.writeFileSync(path.join(root, "dist", "execution", "c2c-execution-helper-integrity.json"), JSON.stringify({
      version: 2, protocolVersion: 5, helperPath: "build/native/c2c-execution-helper.exe", sha256: "0".repeat(64),
      launcherPath: "build/native/c2c-execution-launcher.exe",
      launcherSha256: createHash("sha256").update(fakePe()).digest("hex"),
    }));
    fs.writeFileSync(path.join(root, "build", "native", "c2c-execution-launcher.exe"), fakePe());
    let hashMismatchRejected = false;
    try {
      resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory: path.join(root, "dist", "execution") });
    } catch (error) {
      hashMismatchRejected = (error as Error).message === "EXECUTION_HELPER_UNAVAILABLE";
    }
    console.info("HELPER_HASH_MISMATCH_REJECTED", JSON.stringify({ hashMismatchRejected }));
    expect(hashMismatchRejected).toBe(true);
    fs.writeFileSync(path.join(root, "dist", "execution", "c2c-execution-helper-integrity.json"), JSON.stringify({
      version: 2, protocolVersion: 2, helperPath: "build/native/c2c-execution-helper.exe", sha256: "0".repeat(64),
      launcherPath: "build/native/c2c-execution-launcher.exe",
      launcherSha256: createHash("sha256").update(fakePe()).digest("hex"),
    }));
    let metadataMismatchRejected = false;
    try {
      resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory: path.join(root, "dist", "execution") });
    } catch (error) {
      metadataMismatchRejected = (error as Error).message === "EXECUTION_HELPER_UNAVAILABLE";
    }
    console.info("HELPER_METADATA_MISMATCH_REJECTED", JSON.stringify({ metadataMismatchRejected }));
    expect(metadataMismatchRejected).toBe(true);

    fs.writeFileSync(path.join(root, "dist", "execution", "c2c-execution-helper-integrity.json"), JSON.stringify({
      version: 2,
      protocolVersion: 5,
      helperPath: "build/native/c2c-execution-helper.exe",
      sha256: createHash("sha256").update(fakePe()).digest("hex"),
      launcherPath: "build/native/c2c-execution-launcher.exe",
      launcherSha256: "0".repeat(64),
    }));
    let launcherHashMismatchRejected = false;
    try {
      resolveExecutionHelperPath({ platform: "win32", architecture: "x64", moduleDirectory: path.join(root, "dist", "execution") });
    } catch (error) {
      launcherHashMismatchRejected = (error as Error).message === "EXECUTION_HELPER_UNAVAILABLE";
    }
    expect(launcherHashMismatchRejected).toBe(true);
  });

  it("CORRUPT_HELPER_REJECTED even when metadata names the corrupt bytes", () => {
    const root = makeTmpDir("helper-integrity-corrupt");
    const helper = path.join(root, "build", "native", "c2c-execution-helper.exe");
    const launcher = path.join(root, "build", "native", "c2c-execution-launcher.exe");
    const metadata = path.join(root, "dist", "execution", "c2c-execution-helper-integrity.json");
    const corrupt = Buffer.from("not a PE image");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.mkdirSync(path.dirname(metadata), { recursive: true });
    const launcherBytes = fakePe();
    fs.writeFileSync(helper, corrupt);
    fs.writeFileSync(launcher, launcherBytes);
    fs.writeFileSync(metadata, JSON.stringify({
      version: 2,
      protocolVersion: 5,
      helperPath: "build/native/c2c-execution-helper.exe",
      sha256: createHash("sha256").update(corrupt).digest("hex"),
      launcherPath: "build/native/c2c-execution-launcher.exe",
      launcherSha256: createHash("sha256").update(launcherBytes).digest("hex"),
    }));

    let rejected = false;
    try {
      resolveExecutionHelperPath({
        platform: "win32", architecture: "x64", moduleDirectory: path.join(root, "dist", "execution"),
      });
    } catch (error) {
      rejected = (error as Error).message === "EXECUTION_HELPER_UNAVAILABLE";
    }
    console.info("CORRUPT_HELPER_REJECTED", JSON.stringify({ rejected, candidateHash: createHash("sha256").update(corrupt).digest("hex") }));
    expect(rejected).toBe(true);
  });

  it("keeps the helper in the default build and package distribution contract", () => {
    const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.build?.indexOf("build:execution-helper")).toBeGreaterThanOrEqual(0);
    expect(packageJson.scripts?.build?.indexOf("build:execution-helper"))
      .toBeLessThan(packageJson.scripts?.build?.indexOf("build:execution-launcher") ?? -1);
    expect(packageJson.scripts?.build?.indexOf("build:execution-launcher"))
      .toBeLessThan(packageJson.scripts?.build?.indexOf("tsc") ?? -1);
    expect(packageJson.scripts?.prepack).toContain("npm run build");
    expect(packageJson.scripts?.build).toContain("build:helper-metadata");
    expect(packageJson.scripts?.["build:helper-metadata"]).toContain("write-execution-helper-integrity.ps1");
    expect(packageJson.files).toContain("build/native/c2c-execution-helper.exe");
    expect(packageJson.files).toContain("build/native/c2c-execution-launcher.exe");
  });
});
