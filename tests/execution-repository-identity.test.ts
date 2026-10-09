import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { resolveRepositoryIdentity, RepositoryIdentityError } from "../src/execution/repository-identity.js";
import { makeGitRepo, makeTmpDir } from "./helpers.js";

describe("execution repository identity", () => {
  it("supports nested repositories and rejects a selected junction before canonicalization", () => {
    const root = makeTmpDir("execution-repo-identity");
    makeGitRepo(root);
    const nested = path.join(root, "nested");
    fs.mkdirSync(nested);
    makeGitRepo(nested);
    const workspace = new Workspace(root);

    const parentIdentity = resolveRepositoryIdentity(workspace, ".");
    const nestedIdentity = resolveRepositoryIdentity(workspace, "nested");
    expect(parentIdentity.identity).not.toBe(nestedIdentity.identity);
    expect(nestedIdentity.workspaceRelativePath).toBe("nested");

    const junction = path.join(root, "nested-alias");
    fs.symlinkSync(nested, junction, "junction");
    try {
      resolveRepositoryIdentity(workspace, "nested-alias");
      throw new Error("A reparse point was accepted as an execution repository path.");
    } catch (error) {
      expect(error).toMatchObject({ code: "REPARSE_POINT" });
    }
  });

  it("changes identity when a repository is replaced at the same path", () => {
    const root = makeTmpDir("execution-repo-replaced");
    makeGitRepo(root);
    const originalWorkspace = new Workspace(root);
    const original = resolveRepositoryIdentity(originalWorkspace, ".");

    const moved = `${root}-preserved`;
    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    makeGitRepo(root);
    const replacement = resolveRepositoryIdentity(new Workspace(root), ".");

    expect(replacement.identity).not.toBe(original.identity);
  });

  it("rejects a repository path outside the connected workspace", () => {
    const root = makeTmpDir("execution-repo-escape");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    expect(() => resolveRepositoryIdentity(workspace, "..")).toThrow(RepositoryIdentityError);
  });
});
