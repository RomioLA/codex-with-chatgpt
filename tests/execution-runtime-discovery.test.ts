import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PINNED_PNPM_VERSION, resolveTrustedRuntime } from "../src/execution/runtime-discovery.js";
import { makeTmpDir, write } from "./helpers.js";

function fakeNodeRuntime(root: string): string {
  const node = path.join(root, "runtime", "node.exe");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, "node fixture");
  return node;
}

function installPackage(directory: string, name: string, version: string, entry: string, content: string): void {
  write(directory, "package.json", JSON.stringify({ name, version }));
  write(directory, entry, content);
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
    expect(runtime.nodeFileIdentity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    expect(runtime.managerFileIdentity).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    expect(runtime.managerHash).toBe(createHash("sha256").update("npm runtime fixture").digest("hex"));
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

    expect(runtime.managerCli).toBe(path.join(pinnedRoot, "bin", "pnpm.cjs"));
    expect(runtime.managerHash).toBe(createHash("sha256").update("pinned pnpm fixture").digest("hex"));
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
