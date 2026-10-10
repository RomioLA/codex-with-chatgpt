import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PINNED_PNPM_VERSION, resolveTrustedRuntime } from "../src/execution/runtime-discovery.js";
import { write } from "./helpers.js";

function makeTmpDir(name: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `c2c-${name}-`)));
}

function fakeNodeRuntime(root: string): string {
  const node = path.join(root, "runtime", "node.exe");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, "node fixture");
  return node;
}

function installPackage(directory: string, name: string, version: string, entry: string, content: string): void {
  write(directory, "package.json", JSON.stringify({ name, version }));
  write(directory, entry, content);
  if (name === "npm") {
    write(directory, "lib/cli.js", "npm lib cli fixture");
    write(directory, "lib/cli/validate-engines.js", "npm validate-engines fixture");
    write(directory, "lib/cli/entry.js", "npm main entry fixture");
    write(directory, "lib/cli/exit-handler.js", "npm exit handler fixture");
    write(directory, "lib/npm.js", "npm core fixture");
  } else if (name === "pnpm") {
    write(directory, "bin/pnpm.mjs", "await import('../dist/pnpm.mjs');");
    write(directory, "dist/pnpm.mjs", "pnpm bundled runtime fixture");
  }
}

describe("trusted npm/pnpm runtime discovery", () => {
  it.skipIf(process.platform !== "win32")("resolves the installed active Node/npm and pinned pnpm without PATH search", () => {
    const npm = resolveTrustedRuntime("npm");
    const pnpm = resolveTrustedRuntime("pnpm");

    expect(npm.nodeExecutable).toBe(fs.realpathSync.native(process.execPath));
    expect(path.relative(path.dirname(npm.nodeExecutable), npm.managerCli).startsWith("..\\")).toBe(false);
    expect(pnpm.managerCli.toLowerCase()).toContain(`\\corepack\\v1\\pnpm\\${PINNED_PNPM_VERSION.toLowerCase()}\\`);
  });

  it("selects npm only under the active Node runtime and returns its fixed file identity", () => {
    const root = makeTmpDir("runtime-discovery-npm");
    const node = fakeNodeRuntime(root);
    const npmRoot = path.join(path.dirname(node), "node_modules", "npm");
    installPackage(npmRoot, "npm", "11.12.1", "bin/npm-cli.js", "npm runtime fixture");

    const runtime = resolveTrustedRuntime("npm", {
      platform: "win32",
      nodeExecutable: node,
      homeDirectory: path.join(root, "home"),
    });

    expect(runtime.nodeExecutable).toBe(fs.realpathSync.native(node));
    expect(runtime.managerCli).toBe(path.join(npmRoot, "bin", "npm-cli.js"));
    expect(runtime.managerLibCli).toBe(path.join(npmRoot, "lib", "cli.js"));
    expect(runtime.managerValidateEngines).toBe(path.join(npmRoot, "lib", "cli", "validate-engines.js"));
    expect(runtime.managerMainEntry).toBe(path.join(npmRoot, "lib", "cli", "entry.js"));
    expect(runtime.managerPackageJson).toBe(path.join(npmRoot, "package.json"));
    expect(runtime.managerExitHandler).toBe(path.join(npmRoot, "lib", "cli", "exit-handler.js"));
    expect(runtime.managerCore).toBe(path.join(npmRoot, "lib", "npm.js"));
    expect(runtime.nodeFileIdentity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    expect(runtime.managerFileIdentity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    expect(runtime.nodeHash).toBe(createHash("sha256").update("node fixture").digest("hex"));
    expect(runtime.managerHash).toBe(createHash("sha256").update("npm runtime fixture").digest("hex"));
    expect(runtime.managerLibCliHash).toBe(createHash("sha256").update("npm lib cli fixture").digest("hex"));
    expect(runtime.managerValidateEnginesHash).toBe(createHash("sha256").update("npm validate-engines fixture").digest("hex"));
    expect(runtime.managerMainEntryHash).toBe(createHash("sha256").update("npm main entry fixture").digest("hex"));
    expect(runtime.managerPackageJsonHash).toBe(createHash("sha256").update(fs.readFileSync(path.join(npmRoot, "package.json"))).digest("hex"));
    expect(runtime.managerExitHandlerHash).toBe(createHash("sha256").update("npm exit handler fixture").digest("hex"));
    expect(runtime.managerCoreHash).toBe(createHash("sha256").update("npm core fixture").digest("hex"));
  });

  it("ignores an unpinned Node-local pnpm and uses only the pinned Corepack layout", () => {
    const root = makeTmpDir("runtime-discovery-pnpm");
    const node = fakeNodeRuntime(root);
    installPackage(path.join(path.dirname(node), "node_modules", "pnpm"), "pnpm", "99.0.0",
      "bin/pnpm.cjs", "untrusted pnpm fixture");
    const home = path.join(root, "home");
    const pinnedRoot = path.join(home, "AppData", "Local", "node", "corepack", "v1", "pnpm", PINNED_PNPM_VERSION);
    installPackage(pinnedRoot, "pnpm", PINNED_PNPM_VERSION, "bin/pnpm.cjs", "pinned pnpm fixture");

    const runtime = resolveTrustedRuntime("pnpm", { platform: "win32", nodeExecutable: node, homeDirectory: home });

    const launcher = path.join(pinnedRoot, "bin", "pnpm.mjs");
    const bundle = path.join(pinnedRoot, "dist", "pnpm.mjs");
    expect(runtime.managerCli).toBe(path.join(pinnedRoot, "bin", "pnpm.cjs"));
    expect(runtime.managerLibCli).toBe(launcher);
    expect(runtime.managerValidateEngines).toBe(bundle);
    expect(runtime.managerMainEntry).toBe(bundle);
    expect(runtime.managerPackageJson).toBe(path.join(pinnedRoot, "package.json"));
    expect(runtime.managerExitHandler).toBe(launcher);
    expect(runtime.managerCore).toBe(bundle);
    expect(runtime.nodeHash).toBe(createHash("sha256").update("node fixture").digest("hex"));
    expect(runtime.managerHash).toBe(createHash("sha256").update("pinned pnpm fixture").digest("hex"));
    expect(runtime.managerLibCliHash).toBe(createHash("sha256").update("await import('../dist/pnpm.mjs');").digest("hex"));
    expect(runtime.managerValidateEnginesHash).toBe(createHash("sha256").update("pnpm bundled runtime fixture").digest("hex"));
    expect(runtime.managerMainEntryHash).toBe(runtime.managerValidateEnginesHash);
    expect(runtime.managerPackageJsonHash).toBe(createHash("sha256").update(fs.readFileSync(path.join(pinnedRoot, "package.json"))).digest("hex"));
    expect(runtime.managerExitHandlerHash).toBe(runtime.managerLibCliHash);
    expect(runtime.managerCoreHash).toBe(runtime.managerValidateEnginesHash);
  });

  it("fails closed when the platform or fixed manager location is unsupported", () => {
    const root = makeTmpDir("runtime-discovery-missing");
    const node = fakeNodeRuntime(root);
    installPackage(path.join(root, "workspace", "node_modules", "npm"), "npm", "11.12.1",
      "bin/npm-cli.js", "workspace npm impostor");
    expect(() => resolveTrustedRuntime("npm", { platform: "linux", nodeExecutable: node })).toThrow("EXECUTABLE_UNAVAILABLE");
    expect(() => resolveTrustedRuntime("npm", { platform: "win32", nodeExecutable: node, homeDirectory: root })).toThrow("EXECUTABLE_UNAVAILABLE");
    expect(() => resolveTrustedRuntime("pnpm", { platform: "win32", nodeExecutable: node, homeDirectory: root })).toThrow("EXECUTABLE_UNAVAILABLE");
  });
});
