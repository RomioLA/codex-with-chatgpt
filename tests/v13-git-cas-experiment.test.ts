import { expect, it } from "vitest";
import { git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

it("Git commit-tree pins the reviewed tree/parent and update-ref rejects an external ref advance", () => {
  const root = makeTmpDir("f03-git-cas-model"); makeGitRepo(root);
  const before = git(root, "rev-parse", "HEAD").trim();
  write(root, "approved.txt", "approved\n"); git(root, "add", "approved.txt");
  const reviewedTree = git(root, "write-tree").trim();
  write(root, "outside-index.txt", "external\n"); git(root, "add", "outside-index.txt");
  const pinned = git(root, "commit-tree", reviewedTree, "-p", before, "-m", "pinned candidate").trim();
  expect(git(root, "show", `${pinned}:approved.txt`)).toBe("approved\n");
  expect(() => git(root, "show", `${pinned}:outside-index.txt`)).toThrow();
  const outside = git(root, "commit-tree", git(root, "write-tree").trim(), "-p", before, "-m", "external candidate").trim();
  git(root, "update-ref", "refs/heads/main", outside, before);
  expect(() => git(root, "update-ref", "refs/heads/main", pinned, before)).toThrow();
  expect(git(root, "rev-parse", "HEAD").trim()).toBe(outside);
  expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
  console.log("F03_GIT_CAS_MODEL", JSON.stringify({ reviewedTree, pinnedParent: before, externalHead: outside, compareAndSwapRejected: true }));
});
