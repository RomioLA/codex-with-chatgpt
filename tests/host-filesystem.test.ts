import { beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { HostFilesystem, type HostSensitivePolicy } from "../src/workspace/host-filesystem.js";
import { parseHostPathInput } from "../src/workspace/host-path-input.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, write } from "./helpers.js";

const windows = process.platform === "win32";
let root: string;
let outside: string;
let sibling: string;
let host: HostFilesystem;
let workspace: Workspace;
let directoryLinks: boolean;
let fileLinks: boolean;

function link(target: string, dest: string, type?: fs.symlink.Type): boolean {
  try {
    fs.symlinkSync(target, dest, type);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

beforeAll(() => {
  root = makeTmpDir("host-workspace");
  outside = makeTmpDir("host-external");
  sibling = `${root}-sibling`;
  fs.mkdirSync(sibling);
  write(root, "src/file.ts", "export const value = 1;\n");
  write(root, ".env", "FAKE=fixture\n");
  write(root, ".c2cignore", "private-notes/\n");
  write(root, "private-notes/note.md", "fixture\n");
  write(outside, "ordinary.txt", "fixture\n");
  write(outside, ".env", "FAKE=fixture\n");
  // Real Windows junctions do not require file-symlink privileges. POSIX uses directory symlinks.
  directoryLinks = link(outside, path.join(root, "dir-out"), windows ? "junction" : "dir");
  directoryLinks = link(root, path.join(outside, "dir-in"), windows ? "junction" : "dir") && directoryLinks;
  directoryLinks = link(path.join(root, "src"), path.join(root, "private-notes/public-link"), windows ? "junction" : "dir") && directoryLinks;
  fileLinks = link(path.join(outside, "ordinary.txt"), path.join(root, "file-out.txt"), "file");
  if (fileLinks) {
    link(path.join(outside, ".env"), path.join(outside, "ordinary-alias.txt"), "file");
    link(path.join(outside, "ordinary.txt"), path.join(outside, "credentials.json"), "file");
    link(path.join(outside, "missing.txt"), path.join(root, "dangling.txt"), "file");
  }
  workspace = new Workspace(root);
  host = new HostFilesystem(workspace);
});

// Deliberately retain fixtures in ignored .tooling/test-tmp: no recursive cleanup.
describe("native host path boundary", () => {
  it("classifies ordinary workspace paths and returns immutable structured results", () => {
    expect(host.resolve("src/file.ts")).toMatchObject({
      abs: fs.realpathSync.native(path.join(root, "src/file.ts")), location: "workspace",
      workspaceRelative: "src/file.ts", inputKind: "workspace-relative",
    });
    expect(Object.isFrozen(host.resolve("src/file.ts"))).toBe(true);
  });

  it("classifies explicit external absolute paths", () => {
    const result = host.resolve(path.join(outside, "ordinary.txt"));
    expect(result).toMatchObject({ location: "external", inputKind: "host-absolute" });
    expect(result).not.toHaveProperty("workspaceRelative");
  });

  it("rejects relative traversal instead of silently granting host intent", () => {
    for (const input of ["../ordinary.txt", "src/../../ordinary.txt", "..\\ordinary.txt", "workspace:/../ordinary.txt"]) {
      expect(() => host.resolve(input)).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
    }
    const absolute = path.join(root, "..", path.basename(outside), "ordinary.txt");
    expect(host.resolve(absolute).location).toBe("external");
  });

  it("normalizes contained dot segments and workspace aliases", () => {
    for (const input of ["workspace:/src/file.ts", "WORKSPACE:\\src\\file.ts", "src/../src/file.ts"]) {
      expect(host.resolve(input).workspaceRelative).toBe("src/file.ts");
    }
  });

  it("normalizes separators for relative and native absolute paths", () => {
    expect(host.resolve("src\\file.ts").workspaceRelative).toBe("src/file.ts");
    expect(host.resolve(path.join(root, "src/file.ts").replace(/\\/g, "/")).location).toBe("workspace");
  });

  it("recognizes the workspace root itself", () => {
    for (const input of [root, ".", "", "workspace:/"]) {
      expect(host.resolve(input)).toMatchObject({ location: "workspace", workspaceRelative: "" });
    }
  });

  it("does not confuse a sibling directory sharing the root prefix", () => {
    expect(host.resolve(path.join(sibling, "new.txt")).location).toBe("external");
  });

  it("canonicalizes existing parents before joining multiple nonexistent leaves", () => {
    expect(host.resolve("src/new/sub/file.ts")).toMatchObject({
      location: "workspace", workspaceRelative: "src/new/sub/file.ts",
    });
    expect(host.resolve(path.join(outside, "new/sub/file.ts")).location).toBe("external");
  });

  it("rejects an existing file used as a parent", () => {
    expect(() => host.resolve("src/file.ts/child")).toThrowError(
      expect.objectContaining({ code: "CANONICALIZATION_FAILED" }),
    );
  });

  it("does not swallow access errors as if ancestors were missing", () => {
    const original = fs.lstatSync;
    const failing = path.join(root, "blocked.txt");
    const spy = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, ...args: unknown[]) => {
      if (p === failing) throw Object.assign(new Error("fixture access denial"), { code: "EACCES" });
      return Reflect.apply(original, fs, [p, ...args]);
    }) as typeof fs.lstatSync);
    try {
      expect(() => host.resolve("blocked.txt")).toThrowError(expect.objectContaining({ code: "CANONICALIZATION_FAILED" }));
    } finally { spy.mockRestore(); }
  });

  it("rejects null bytes, whitespace changes and unknown schemes", () => {
    for (const input of ["file\0.txt", " file.txt", "file.txt ", "file:///x", "workspace:src/file.ts", "workspace://src", "workspace:/C:/foo"]) {
      expect(() => host.resolve(input)).toThrow();
    }
  });

  it("fails closed if the initialized workspace root is replaced", () => {
    const disposable = makeTmpDir("host-replaced-root");
    const boundary = new HostFilesystem(new Workspace(disposable));
    fs.renameSync(disposable, `${disposable}-original`);
    fs.mkdirSync(disposable);
    expect(() => boundary.resolve("new.txt")).toThrowError(expect.objectContaining({ code: "WORKSPACE_ROOT_CHANGED" }));
  });
});

describe("real symlink and junction boundaries", () => {
  it("classifies an absolute file symlink escape and keeps Workspace containment", (context) => {
    if (!fileLinks) context.skip();
    expect(host.resolve(path.join(root, "file-out.txt")).location).toBe("external");
    expect(() => host.resolve("file-out.txt")).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
    expect(() => workspace.resolve("file-out.txt")).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
  });

  it("uses native realpath for directory links/junctions and nonexistent leaves", (context) => {
    if (!directoryLinks) context.skip();
    for (const leaf of ["ordinary.txt", "not-yet/new.txt"]) {
      expect(host.resolve(path.join(root, "dir-out", leaf))).toMatchObject({
        location: "external", abs: path.join(outside, leaf),
      });
      expect(() => host.resolve(`dir-out/${leaf}`)).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
      expect(() => workspace.resolve(`dir-out/${leaf}`)).toThrowError(expect.objectContaining({ code: "PATH_OUTSIDE_WORKSPACE" }));
    }
  });

  it("classifies an external link into the workspace while permanently denying its deletion", (context) => {
    if (!directoryLinks) context.skip();
    const alias = path.join(outside, "dir-in/src/file.ts");
    expect(host.resolve(alias).location).toBe("workspace");
    expect(host.checkOperation(alias, "delete")).toMatchObject({ decision: "deny", code: "EXTERNAL_DELETE_PERMANENTLY_DENIED" });
  });

  it("rejects dangling links rather than appending a fabricated safe leaf", (context) => {
    if (!fileLinks) context.skip();
    expect(() => host.resolve("dangling.txt")).toThrowError(expect.objectContaining({ code: "CANONICALIZATION_FAILED" }));
  });

  it("checks both sensitive target names and sensitive alias names", (context) => {
    if (!fileLinks) context.skip();
    for (const leaf of ["ordinary-alias.txt", "credentials.json"]) {
      expect(() => host.resolve(path.join(outside, leaf))).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }));
    }
  });

  it("preserves workspace custom sensitivity through an external alias", (context) => {
    if (!directoryLinks) context.skip();
    expect(() => host.resolve(path.join(outside, "dir-in/private-notes/note.md"))).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
    );
  });
});

describe("mandatory sensitivity and operation seams", () => {
  it.each([".env", ".ENV.production", "server.key", "cert.pem", "id_ed25519", "credentials.json", "service-account-prod.json", "secrets.json", ".aws/credentials", ".ssh", "nested/.ssh/config", ".cloudflared/token.json", ".c2c-secrets-prod"])(
    "denies sensitive external path %s, including nonexistent targets", (leaf) => {
      expect(() => host.resolve(path.join(outside, leaf))).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }));
    },
  );

  it("retains the .env.example exception", () => {
    expect(host.resolve(path.join(outside, ".env.example")).location).toBe("external");
  });

  it("retains workspace sensitivity and .c2cignore", () => {
    for (const leaf of [".env", "private-notes/note.md"]) {
      expect(() => host.resolve(leaf)).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }));
    }
  });

  it("provides volume-relative policy context and additive guards that cannot disable defaults", () => {
    const seen: string[] = [];
    const policy: HostSensitivePolicy = { isSensitive(target) {
      expect(path.isAbsolute(target.rootRelative)).toBe(false);
      seen.push(target.rootRelative);
      return target.rootRelative.endsWith("tokens.json");
    } };
    const guarded = new HostFilesystem(workspace, policy);
    expect(() => guarded.resolve(path.join(outside, "tokens.json"))).toThrowError(
      expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(() => new HostFilesystem(workspace, { isSensitive: () => false }).resolve(path.join(outside, ".env"))).toThrow();
  });

  it("permanently denies external delete for ordinary and sensitive targets", () => {
    for (const leaf of ["ordinary.txt", "missing.txt", ".env"]) {
      expect(host.checkOperation(path.join(outside, leaf), "delete")).toMatchObject({
        decision: "deny", operation: "delete", code: "EXTERNAL_DELETE_PERMANENTLY_DENIED",
      });
    }
  });

  it("never grants read, write or workspace delete permission", () => {
    expect(host.checkOperation(path.join(outside, "ordinary.txt"), "read").decision).toBe("requires-permission");
    expect(host.checkOperation(path.join(outside, "new.txt"), "write").decision).toBe("requires-permission");
    expect(host.checkOperation("src/file.ts", "delete").decision).toBe("requires-permission");
    expect(() => host.checkOperation("src/file.ts", "execute" as "read")).toThrowError(expect.objectContaining({ code: "INVALID_OPERATION" }));
  });
});

describe("Windows syntax (pure parser, independent of host OS)", () => {
  const winRoot = "C:\\Repo\\Project";
  it.each(["C:\\foo\\bar.txt", "C:/foo/bar.txt", "c:/foo/../bar.txt"])("accepts explicit host absolute path %s", (input) => {
    expect(parseHostPathInput(input, winRoot, "win32").inputKind).toBe("host-absolute");
  });
  it("normalizes Windows separators, dot segments and workspace intent", () => {
    expect(parseHostPathInput("workspace:/src/../file.ts", winRoot, "win32")).toEqual({
      abs: "C:\\Repo\\Project\\file.ts", inputKind: "workspace-relative",
    });
  });
  it.each(["C:relative.txt", "/foo", "\\foo", "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\foo", "\\\\.\\PhysicalDrive0",
    "file.txt:secret", "NUL", "con.txt", "COM1", "lpt².txt", "CONIN$", "name.", "name ", "bad?.txt", "workspace:/C:/foo"])(
    "rejects ambiguous or unsupported Windows path %s", (input) => {
      expect(() => parseHostPathInput(input, winRoot, "win32")).toThrow();
    },
  );
});

describe.skipIf(!windows)("actual Windows filesystem semantics", () => {
  it("does not mistake uppercase workspace aliases for external delete targets", () => {
    expect(host.checkOperation(path.join(root, "src/file.ts").toUpperCase(), "delete").decision).toBe("requires-permission");
  });
  it("guards custom-sensitive junction aliases even when the root spelling changes case", (context) => {
    if (!directoryLinks) context.skip();
    const alias = path.join(root, "private-notes/public-link/file.ts").toUpperCase();
    expect(() => host.resolve(alias)).toThrowError(expect.objectContaining({ code: "ACCESS_DENIED_SENSITIVE_FILE" }));
  });
  it("canonicalizes drive-letter and existing-directory casing, also for a nonexistent leaf", () => {
    for (const input of [root.toUpperCase(), `${root[0].toLowerCase()}${root.slice(1)}`, path.join(root.toUpperCase(), "SRC/new.ts")]) {
      expect(host.resolve(input).location).toBe("workspace");
    }
  });
  it("classifies an external drive-letter path using Windows separators", () => {
    expect(host.resolve(path.join(outside, "ordinary.txt").replace(/\\/g, "/")).location).toBe("external");
  });
});

describe.skipIf(windows)("actual POSIX host semantics", () => {
  it("does not reinterpret Windows drive paths as workspace filenames", () => {
    expect(() => host.resolve("C:/foo/bar.txt")).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_PATH_FORMAT" }));
  });
  it("retains distinct sibling directory case on a case-sensitive filesystem", (context) => {
    const otherCase = root.toUpperCase();
    if (fs.existsSync(otherCase)) context.skip(); // e.g. default macOS volume
    expect(host.resolve(otherCase).location).toBe("external");
  });
});
