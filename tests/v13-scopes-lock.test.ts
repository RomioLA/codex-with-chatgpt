import { describe, expect, it } from "vitest";
import { AuthStore, DEFAULT_SCOPES, SUPPORTED_SCOPES, filterScopes } from "../src/auth/store.js";
import { acquireRepositoryWriteLock, repositoryWriteKey } from "../src/execution/repository-write-lock.js";
import { resolveRepositoryIdentity } from "../src/execution/repository-identity.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, makeGitRepo, isolateStateDir, git } from "./helpers.js";

describe("V1.3 separate capabilities and repository write authority", () => {
  it("does not grant new scopes to default authorization or refreshed V1.2 tokens", () => {
    isolateStateDir();
    expect(DEFAULT_SCOPES).not.toContain("git.write");
    expect(DEFAULT_SCOPES).not.toContain("execution.level3");
    expect(SUPPORTED_SCOPES).toContain("execution.level3");
    expect(filterScopes(undefined)).not.toContain("git.write");
    expect(filterScopes("git.write execution.level3")).toEqual(["git.write", "execution.level3"]);
    const store = new AuthStore("v13-scopes-fixture");
    const tokens = store.issueTokens({ clientId: "v12-client", scopes: ["execution.run", "offline_access"] });
    const refresh = store.refresh(tokens.refreshToken!, "v12-client");
    expect(refresh.ok).toBe(true);
    if (refresh.ok) expect(refresh.tokens.scopes).toEqual(["execution.run", "offline_access"]);
  });

  it("serializes different worktrees that share metadata and never steals an existing lock", () => {
    isolateStateDir();
    const root = makeTmpDir("v13-lock");
    makeGitRepo(root);
    const second = `${root}-linked`;
    git(root, "worktree", "add", "-b", "linked", second);
    const firstIdentity = resolveRepositoryIdentity(new Workspace(root), ".");
    const secondIdentity = resolveRepositoryIdentity(new Workspace(second), ".");
    expect(repositoryWriteKey(firstIdentity)).toBe(repositoryWriteKey(secondIdentity));
    const release = acquireRepositoryWriteLock(firstIdentity, "job-first");
    expect(() => acquireRepositoryWriteLock(secondIdentity, "job-second")).toThrow("REPOSITORY_BUSY");
    release();
    const releaseSecond = acquireRepositoryWriteLock(secondIdentity, "job-second");
    releaseSecond();
  });
});
