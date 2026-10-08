import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { migratePersistentState } from "../src/config/state-migration.js";
import { makeTmpDir, write } from "./helpers.js";

const authId = "0123456789ab";
const permissionId = "abcdef012345";

function validAuth(secret = "fixture"): string {
  return JSON.stringify({ clients: [], tokens: [{ token: secret }] });
}

function createSource(name: string): string {
  const source = makeTmpDir(name);
  write(source, "auth/" + authId + ".json", validAuth());
  return source;
}

function makeDirectoryLink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (["EPERM", "EACCES", "ENOTSUP"].includes(code)) return false;
    throw error;
  }
}

function replaceDirectoryWithLink(directory: string, target: string, parkedPath: string): boolean {
  try {
    fs.renameSync(directory, parkedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (["EPERM", "EACCES", "ENOTSUP", "EBUSY"].includes(code)) return false;
    throw error;
  }
  try {
    if (makeDirectoryLink(target, directory)) return true;
    fs.renameSync(parkedPath, directory);
    return false;
  } catch (error) {
    if (!fs.existsSync(directory) && fs.existsSync(parkedPath)) fs.renameSync(parkedPath, directory);
    throw error;
  }
}

describe("state migration transaction and physical paths", () => {
  it("preflights later conflicts before importing earlier auth state", () => {
    const source = createSource("state-migration-late-conflict-source");
    write(source, "permissions/" + permissionId + ".json", JSON.stringify({ grant: "source" }));
    const destinationParent = makeTmpDir("state-migration-late-conflict-dest-parent");
    const destination = path.join(destinationParent, "authority");
    write(destination, "permissions/" + permissionId + ".json", JSON.stringify({ grant: "existing" }));
    const conflictPath = path.join(destination, "permissions", permissionId + ".json");
    const before = fs.readFileSync(conflictPath, "utf8");

    expect(() => migratePersistentState(source, destination)).toThrow(/overwrite different state/i);
    expect(fs.existsSync(path.join(destination, "auth", authId + ".json"))).toBe(false);
    expect(fs.readFileSync(conflictPath, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(destination, ".state-migration-v1.json"))).toBe(false);
  });

  it("keeps staged auth out of a missing destination when staging a later file fails", () => {
    const source = createSource("state-migration-staging-failure-source");
    write(source, "permissions/" + permissionId + ".json", JSON.stringify({ grant: "fixture" }));
    const destinationParent = makeTmpDir("state-migration-staging-failure-dest-parent");
    const destination = path.join(destinationParent, "authority");
    const originalWrite = fs.writeFileSync;
    let authWasStaged = false;

    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const result = (originalWrite as (...callArgs: unknown[]) => void)(file, ...args);
      if (typeof file === "string" && file.includes(".c2c-state-migration-")) {
        if (file.endsWith(path.join("auth", authId + ".json"))) authWasStaged = true;
        if (file.endsWith(path.join("permissions", permissionId + ".json")) && authWasStaged) {
          throw new Error("injected staging failure after partial staged write");
        }
      }
      return result;
    }) as typeof fs.writeFileSync);

    try {
      expect(() => migratePersistentState(source, destination)).toThrow(/migration failed/i);
      expect(authWasStaged).toBe(true);
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.readdirSync(destinationParent).some((name) => name.startsWith(".c2c-state-migration-"))).toBe(false);
    } finally {
      writeSpy.mockRestore();
    }
  });
  it("rejects a destination parent junction without modifying the source", (context) => {
    const source = createSource("state-migration-destination-junction-source");
    const sourceAuth = path.join(source, "auth", authId + ".json");
    const sourceBefore = fs.readFileSync(sourceAuth);
    const outside = makeTmpDir("state-migration-destination-junction-outside");
    const junctionParent = path.join(makeTmpDir("state-migration-destination-junction-holder"), "redirect");
    if (!makeDirectoryLink(outside, junctionParent)) return context.skip();
    const destination = path.join(junctionParent, "missing", "authority");

    expect(() => migratePersistentState(source, destination)).toThrow(/junction|physical|destination/i);
    expect(fs.existsSync(path.join(outside, "authority"))).toBe(false);
    expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
  });

  it("fails closed when auth parent changes to a junction immediately before open across repeated rounds", (context) => {
    const originalOpen = fs.openSync;
    for (const round of [1, 2]) {
      const source = createSource(`state-migration-open-race-before-open-${round}-source`);
      const sourceAuth = path.join(source, "auth", authId + ".json");
      const sourceBefore = fs.readFileSync(sourceAuth);
      const destinationParent = makeTmpDir(`state-migration-open-race-before-open-${round}-parent`);
      const destination = path.join(destinationParent, "authority");
      const outside = makeTmpDir(`state-migration-open-race-before-open-${round}-outside`);
      const outsideAuth = path.join(outside, "auth");
      fs.mkdirSync(outsideAuth);
      const parked = path.join(destinationParent, "auth-original");
      const destinationAuthFile = path.resolve(destination, "auth", authId + ".json");
      let injected = false;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        const targetPath = typeof target === "string" ? path.resolve(target) : "";
        const matchesDestination = process.platform === "win32"
          ? targetPath.toLowerCase() === destinationAuthFile.toLowerCase()
          : targetPath === destinationAuthFile;
        if (matchesDestination && !injected) {
          injected = replaceDirectoryWithLink(path.dirname(target as string), outsideAuth, parked);
        }
        return originalOpen(target, flags, mode);
      }) as typeof fs.openSync);

      let failure: unknown;
      try {
        migratePersistentState(source, destination);
      } catch (error) {
        failure = error;
      } finally {
        openSpy.mockRestore();
      }
      if (!injected) return context.skip("The test filesystem could not replace the destination auth directory with a junction.");
      expect(failure).toBeInstanceOf(Error);
      expect(failure instanceof Error ? failure.message : String(failure)).toMatch(/rollback could not be verified/i);
      expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
      expect(fs.readdirSync(outsideAuth)).toEqual([]);
      expect(fs.existsSync(path.join(outsideAuth, authId + ".json"))).toBe(false);
      expect(fs.existsSync(path.join(outside, ".state-migration-v1.json"))).toBe(false);
      expect(fs.existsSync(path.join(parked, authId + ".json"))).toBe(false);
    }
  });

  it("removes a raced create redirected into the source authority", (context) => {
    const source = createSource("state-migration-source-race-source");
    const sourceAuth = path.join(source, "auth", authId + ".json");
    const sourceBefore = fs.readFileSync(sourceAuth);
    const sourceRedirect = path.join(source, "permissions");
    fs.mkdirSync(sourceRedirect);
    const destinationParent = makeTmpDir("state-migration-source-race-parent");
    const destination = path.join(destinationParent, "authority");
    const parked = path.join(destinationParent, "auth-original");
    const destinationAuthFile = path.resolve(destination, "auth", authId + ".json");
    const originalOpen = fs.openSync;
    let injected = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const targetPath = typeof target === "string" ? path.resolve(target) : "";
      const matchesDestination = process.platform === "win32"
        ? targetPath.toLowerCase() === destinationAuthFile.toLowerCase()
        : targetPath === destinationAuthFile;
      if (matchesDestination && !injected) {
        injected = replaceDirectoryWithLink(path.dirname(target as string), sourceRedirect, parked);
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync);

    let failure: unknown;
    try {
      migratePersistentState(source, destination);
    } catch (error) {
      failure = error;
    } finally {
      openSpy.mockRestore();
    }
    if (!injected) return context.skip("The test filesystem could not replace the destination auth directory with a source junction.");
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : String(failure)).toMatch(/rollback could not be verified/i);
    expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
    expect(fs.readdirSync(sourceRedirect)).toEqual([]);
    expect(fs.existsSync(path.join(sourceRedirect, authId + ".json"))).toBe(false);
    expect(fs.existsSync(path.join(destination, ".state-migration-v1.json"))).toBe(false);
  });

  it("detects a junction replacement after open before writing bytes", (context) => {
    const source = createSource("state-migration-open-race-after-open-source");
    const sourceAuth = path.join(source, "auth", authId + ".json");
    const sourceBefore = fs.readFileSync(sourceAuth);
    const destinationParent = makeTmpDir("state-migration-open-race-after-open-parent");
    const destination = path.join(destinationParent, "authority");
    const outside = makeTmpDir("state-migration-open-race-after-open-outside");
    const outsideAuth = path.join(outside, "auth");
    fs.mkdirSync(outsideAuth);
    const parked = path.join(destinationParent, "auth-original");
    const destinationAuthFile = path.resolve(destination, "auth", authId + ".json");
    const originalOpen = fs.openSync;
    let injected = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const targetPath = typeof target === "string" ? path.resolve(target) : "";
      const matchesDestination = process.platform === "win32"
        ? targetPath.toLowerCase() === destinationAuthFile.toLowerCase()
        : targetPath === destinationAuthFile;
      const fd = originalOpen(target, flags, mode);
      if (matchesDestination && !injected) {
        injected = replaceDirectoryWithLink(path.dirname(target as string), outsideAuth, parked);
      }
      return fd;
    }) as typeof fs.openSync);

    let failure: unknown;
    try {
      migratePersistentState(source, destination);
    } catch (error) {
      failure = error;
    } finally {
      openSpy.mockRestore();
    }
    if (!injected) return context.skip("The test filesystem could not replace the opened auth directory with a junction.");
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : String(failure)).toMatch(/rollback could not be verified/i);
    expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
    expect(fs.readdirSync(outsideAuth)).toEqual([]);
    expect(fs.existsSync(path.join(outsideAuth, authId + ".json"))).toBe(false);
    expect(fs.existsSync(path.join(outside, ".state-migration-v1.json"))).toBe(false);
    const strandedAuth = path.join(parked, authId + ".json");
    expect(fs.existsSync(strandedAuth)).toBe(true);
    expect(fs.statSync(strandedAuth).size).toBe(0);
  });

  it("preserves an external same-name auth sentinel when rollback parent changes to a junction", (context) => {
    const source = createSource("state-migration-marker-junction-source");
    const sourceAuth = path.join(source, "auth", authId + ".json");
    const sourceBefore = fs.readFileSync(sourceAuth);
    const destinationParent = makeTmpDir("state-migration-marker-junction-parent");
    const destination = path.join(destinationParent, "authority");
    const outside = makeTmpDir("state-migration-marker-junction-outside");
    const outsideAuth = path.join(outside, "auth");
    const sentinelAuth = write(outside, path.join("auth", authId + ".json"), validAuth("outside sentinel"));
    const authSentinelBefore = fs.readFileSync(sentinelAuth);
    const parkedAuth = path.join(destinationParent, "auth-original");
    const markerPath = path.join(destination, ".state-migration-v1.json");
    const originalOpen = fs.openSync;
    let injected = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const targetPath = typeof target === "string" ? path.resolve(target) : "";
      const matchesMarker = process.platform === "win32"
        ? targetPath.toLowerCase() === markerPath.toLowerCase()
        : targetPath === markerPath;
      if (matchesMarker && !injected) {
        injected = replaceDirectoryWithLink(path.join(destination, "auth"), outsideAuth, parkedAuth);
        if (!injected) throw new Error("Test filesystem could not replace auth parent with a junction.");
        throw new Error("Injected marker open failure after auth parent junction replacement.");
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync);

    let failure: unknown;
    try {
      migratePersistentState(source, destination);
    } catch (error) {
      failure = error;
    } finally {
      openSpy.mockRestore();
    }
    if (!injected) return context.skip("The test filesystem could not replace the destination auth directory with a junction.");
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : String(failure)).toMatch(/rollback could not be verified/i);
    expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
    expect(fs.readFileSync(sentinelAuth)).toEqual(authSentinelBefore);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(path.join(parkedAuth, authId + ".json"), "utf8")).toBe(validAuth());
  });

  it("rejects source and destination physical aliases without changing either side", (context) => {
    const source = createSource("state-migration-physical-alias-source");
    const sourceAuth = path.join(source, "auth", authId + ".json");
    const sourceBefore = fs.readFileSync(sourceAuth);
    const aliasParent = makeTmpDir("state-migration-physical-alias-parent");
    const alias = path.join(aliasParent, "source-alias");
    if (!makeDirectoryLink(source, alias)) return context.skip();

    expect(() => migratePersistentState(source, alias)).toThrow(/junction|destination/i);
    expect(fs.readFileSync(sourceAuth)).toEqual(sourceBefore);
    expect(fs.existsSync(path.join(source, ".state-migration-v1.json"))).toBe(false);
  });

  it("does not leak malformed secret-bearing JSON through migration errors", () => {
    const source = makeTmpDir("state-migration-malformed-secret-source");
    const destinationParent = makeTmpDir("state-migration-malformed-secret-dest-parent");
    const destination = path.join(destinationParent, "authority");
    const sentinel = "C2C_MIGRATION_SECRET_SENTINEL_43de9a";
    write(source, "auth/" + authId + ".json", "{\"clients\":[],\"tokens\":[\"" + sentinel);

    let message = "";
    try {
      migratePersistentState(source, destination);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/json|auth|syntax/i);
    expect(message).not.toContain(sentinel);
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rolls back committed auth when marker creation fails", () => {
    const source = createSource("state-migration-marker-failure-source");
    const destinationParent = makeTmpDir("state-migration-marker-failure-dest-parent");
    const destination = path.join(destinationParent, "authority");
    const originalOpen = fs.openSync;
    let authWasCommitted = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation(((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (typeof target === "string" && target.endsWith(".state-migration-v1.json")) {
        throw new Error("injected marker commit failure");
      }
      const fd = originalOpen(target, flags, mode);
      if (typeof target === "string" && target.endsWith(path.join("auth", authId + ".json"))) {
        authWasCommitted = true;
      }
      return fd;
    }) as typeof fs.openSync);

    try {
      expect(() => migratePersistentState(source, destination)).toThrow(/restored/i);
      expect(authWasCommitted).toBe(true);
      expect(fs.existsSync(path.join(destination, "auth", authId + ".json"))).toBe(false);
      expect(fs.existsSync(path.join(destination, ".state-migration-v1.json"))).toBe(false);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("does not create the destination authority when source preflight fails", () => {
    const sourceParent = makeTmpDir("state-migration-invalid-source-parent");
    const missingSource = path.join(sourceParent, "missing");
    const destinationParent = makeTmpDir("state-migration-invalid-source-dest-parent");
    const destination = path.join(destinationParent, "authority");

    expect(() => migratePersistentState(missingSource, destination)).toThrow(/source|physical/i);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
