import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { setPermission } from "../src/permission/store.js";
import { approveGitRepository, previewGitRepositoryApproval } from "../src/git-write/index.js";
import { git, makeGitRepo, makeTmpDir, isolateStateDir } from "./helpers.js";

// Explicit opt-in: the default regression suite stays independent of GitHub.
describe.skipIf(process.env.C2C_V13_NETWORK_TEST !== "1" || process.platform !== "win32")("V1.3 controlled HTTPS fetch", () => {
  it("fetches only the approved frozen branch through the explicitly approved local proxy", async () => {
    isolateStateDir(); const root = makeTmpDir("v13-network-git"); makeGitRepo(root);
    const workspace = new Workspace(root); setPermission(workspace.id, "level1");
    const branch = "codex/c2c-local-v1_2-bounded-execution";
    const url = "https://github.com/RomioLA/codex-with-chatgpt.git";
    git(root, "remote", "add", "origin", url);
    const policy = { allowedRemotes: [{ name: "origin", url }], allowedBranches: [branch],
      allowedOperations: ["fetch" as const], approvedProxy: "http://127.0.0.1:7897" };
    const preview = previewGitRepositoryApproval(workspace, ".", policy);
    approveGitRepository(workspace, ".", { ...policy, localApproval: true }, preview.digest);
    const supervisor = new ExecutionSupervisor(workspace);
    try {
      const started = supervisor.startGitWrite({ repositoryPath: ".", operation: {
        kind: "fetch", remote: "origin", branches: [branch], expectedHead: git(root, "rev-parse", "HEAD").trim(), expectedBranch: "main",
      }, timeoutSeconds: 90, idempotencyKey: "v13-network-fetch-0123456789", oauthClientId: "isolated-network-client", scopes: ["git.write"] });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) throw new Error(started.error);
      for (let attempt = 0; attempt < 1000; attempt++) {
        const job = supervisor.store.get(started.job.jobId)!;
        if (job.finishedAt) {
          const stderr = supervisor.readOutputForClient(job.jobId, "isolated-network-client", "stderr");
          expect(job.state, JSON.stringify({ failure: job.failureCode, stderr })).toBe("succeeded");
          expect(git(root, "rev-parse", `refs/remotes/origin/${branch}`).trim()).toBe("8f46c02b8012c007c80b38d3c552434f5671dfc8");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("NETWORK_FETCH_COMPLETION_TIMEOUT");
    } finally { await supervisor.shutdown(); }
  }, 120_000);
});
