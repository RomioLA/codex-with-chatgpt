import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { setPermission } from "../src/permission/store.js";
import { approveGitRepository, previewGitRepositoryApproval, type GitWriteOperation } from "../src/git-write/index.js";
import { makeTmpDir, makeGitRepo, git, write, isolateStateDir } from "./helpers.js";

describe.skipIf(process.platform !== "win32")("V1.3 native Git workflow", () => {
  it("stages, commits, creates and switches branches through the controlled supervisor", async () => {
    isolateStateDir(); const root = makeTmpDir("v13-native-git"); makeGitRepo(root);
    git(root, "config", "user.name", "C2C isolated fixture"); git(root, "config", "user.email", "fixture@c2c.local");
    for (const hook of ["pre-commit", "post-commit", "post-checkout"]) {
      const file = write(root, `.git/hooks/${hook}`, '#!/bin/sh\nprintf executed > "$PWD/hook-marker.txt"\n');
      fs.chmodSync(file, 0o755);
    }
    const workspace = new Workspace(root); setPermission(workspace.id, "level1");
    const policy = { allowedRemotes: [], allowedBranches: ["main", "native-feature"],
      allowedOperations: ["add", "commit", "branch_create", "branch_list", "switch"] as const };
    const inputPolicy = { ...policy, allowedOperations: [...policy.allowedOperations] };
    const preview = previewGitRepositoryApproval(workspace, ".", inputPolicy);
    approveGitRepository(workspace, ".", { ...inputPolicy, localApproval: true }, preview.digest);
    const supervisor = new ExecutionSupervisor(workspace);
    let number = 0;
    async function run(operation: Omit<GitWriteOperation, "expectedHead" | "expectedBranch">) {
      const head = git(root, "rev-parse", "HEAD").trim(); const branch = git(root, "branch", "--show-current").trim();
      const request = { repositoryPath: ".", operation: { ...operation, expectedHead: head, expectedBranch: branch } as GitWriteOperation,
        timeoutSeconds: 30, oauthClientId: "native-git-fixture", scopes: ["git.write"], idempotencyKey: `native-git-operation-${++number}-0123456` };
      const started = supervisor.startGitWrite(request);
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) throw new Error(started.error);
      for (let attempt = 0; attempt < 500; attempt++) {
        const job = supervisor.store.get(started.job.jobId)!;
        if (job.finishedAt) {
          const stderr = supervisor.readOutputForClient(job.jobId, request.oauthClientId, "stderr");
          expect(job.state, JSON.stringify({ failure: job.failureCode, stderr })).toBe("succeeded");
          expect(job.gitResult?.confirmation).not.toBe("unavailable");
          expect(supervisor.startGitWrite(request)).toMatchObject({ ok: true, duplicate: true });
          return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("NATIVE_GIT_COMPLETION_TIMEOUT");
    }
    try {
      write(root, "new-file.txt", "approved Git content\n");
      await run({ kind: "add", paths: ["new-file.txt"] } as Omit<GitWriteOperation, "expectedHead" | "expectedBranch">);
      expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("new-file.txt");
      await run({ kind: "commit", message: "V1.3 isolated native commit" } as Omit<GitWriteOperation, "expectedHead" | "expectedBranch">);
      expect(git(root, "log", "-1", "--format=%s").trim()).toBe("V1.3 isolated native commit");
      await run({ kind: "branch_create", name: "native-feature" } as Omit<GitWriteOperation, "expectedHead" | "expectedBranch">);
      await run({ kind: "branch_list" });
      await run({ kind: "switch", name: "native-feature" } as Omit<GitWriteOperation, "expectedHead" | "expectedBranch">);
      expect(git(root, "branch", "--show-current").trim()).toBe("native-feature");
      expect(fs.existsSync(path.join(root, "hook-marker.txt"))).toBe(false);
    } finally { await supervisor.shutdown(); }
  }, 120_000);
});
