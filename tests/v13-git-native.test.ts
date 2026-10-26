import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor, type ExecutionRunner } from "../src/execution/supervisor.js";
import { WindowsNativeExecutionRunner, type NativeRunnerRequest } from "../src/execution/native-runner.js";
import { readCurrentSessionGrant, setPermission } from "../src/permission/store.js";
import { approveGitRepository, previewGitRepositoryApproval, type GitWriteOperation } from "../src/git-write/index.js";
import { makeTmpDir, makeGitRepo, git, write, isolateStateDir } from "./helpers.js";

async function waitForGitJob(supervisor: ExecutionSupervisor, jobId: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const job = supervisor.store.get(jobId);
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("NATIVE_GIT_COMPLETION_TIMEOUT");
}

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

  it("runs a Full Access Git plan through the constrained V8 Native path without repository approval", async () => {
    isolateStateDir();
    const root = makeTmpDir("full-access-native-git");
    makeGitRepo(root);
    write(root, "full-access.txt", "structured Full Access Git material\n");
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level2");
    expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();
    const supervisor = new ExecutionSupervisor(workspace);
    try {
      const started = supervisor.startGitWrite({
        repositoryPath: ".",
        operation: {
          kind: "add",
          paths: ["full-access.txt"],
          expectedHead: git(root, "rev-parse", "HEAD").trim(),
          expectedBranch: git(root, "branch", "--show-current").trim(),
        },
        timeoutSeconds: 30,
        oauthClientId: "full-access-native-git-client",
        scopes: ["git.write"],
        idempotencyKey: "full-access-native-git-add-0123456789",
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      if (!started.ok) throw new Error(started.error);
      expect(started.job.authorization).toMatchObject({ type: "git", source: "full_access" });
      const job = await waitForGitJob(supervisor, started.job.jobId);
      expect(job.state).toBe("succeeded");
      expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("full-access.txt");
    } finally {
      await supervisor.shutdown();
    }
  }, 120_000);

  it("rejects revoked, stale-session and downgraded Full Access Git Native requests before Git changes", async () => {
    const scenarios: Array<"revoked" | "stale_session" | "v7_downgrade" | "material_replaced" | "plan_digest_mismatch"> =
      ["revoked", "stale_session", "v7_downgrade", "material_replaced", "plan_digest_mismatch"];
    for (const scenario of scenarios) {
      isolateStateDir();
      const root = makeTmpDir("full-access-native-git-" + scenario);
      makeGitRepo(root);
      write(root, "blocked.txt", "must not be staged\n");
      const workspace = new Workspace(root);
      setPermission(workspace.id, "level2");
      expect(readCurrentSessionGrant(workspace.id)).not.toBeNull();
      const stateRoot = process.env.C2C_STATE_DIR!;
      const native = new WindowsNativeExecutionRunner();
      const runner: ExecutionRunner = {
        start(request, callbacks) {
          if (!("fullAccessGit" in request) || !request.fullAccessGit || !request.genericCommand) {
            throw new Error("FULL_ACCESS_GIT_NATIVE_REQUEST_MISSING");
          }
          if (scenario === "revoked") {
            setPermission(workspace.id, "level1");
            return native.start(request, callbacks);
          }
          if (scenario === "v7_downgrade") {
            const downgraded = { ...request } as unknown as Record<string, unknown>;
            delete downgraded.fullAccessGit;
            return native.start(downgraded as unknown as NativeRunnerRequest, callbacks);
          }
          if (scenario === "material_replaced") {
            const material = request.genericCommand.materials.find((item) => item.path.toLowerCase().endsWith("blocked.txt"));
            if (!material) throw new Error("FULL_ACCESS_GIT_SOURCE_MATERIAL_MISSING");
            fs.writeFileSync(material.path, "replaced after the plan was created\n");
            return native.start(request, callbacks);
          }
          if (scenario === "plan_digest_mismatch") {
            fs.appendFileSync(request.genericCommand.approvalManifest, " ");
            return native.start(request, callbacks);
          }

          const staleFingerprint = "f".repeat(64);
          const staleGrantId = "e".repeat(64);
          const manifestPath = request.genericCommand.approvalManifest;
          const plan = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
            authorization: { sessionGrantFingerprint: string; sessionGrantId: string };
          };
          plan.authorization.sessionGrantFingerprint = staleFingerprint;
          plan.authorization.sessionGrantId = staleGrantId;
          const manifestBytes = Buffer.from(JSON.stringify(plan));
          fs.writeFileSync(manifestPath, manifestBytes);

          const permissionPath = path.join(stateRoot, "permissions", workspace.id + ".json");
          const permission = JSON.parse(fs.readFileSync(permissionPath, "utf8")) as {
            sessionGrant: { identityFingerprint: string; grantId: string };
          };
          permission.sessionGrant.identityFingerprint = staleFingerprint;
          permission.sessionGrant.grantId = staleGrantId;
          fs.writeFileSync(permissionPath, JSON.stringify(permission));

          return native.start({
            ...request,
            genericCommand: {
              ...request.genericCommand,
              approvalManifestHash: createHash("sha256").update(manifestBytes).digest("hex"),
            },
            fullAccessGit: {
              ...request.fullAccessGit,
              sessionGrantFingerprint: staleFingerprint,
              sessionGrantId: staleGrantId,
            },
          }, callbacks);
        },
      };
      const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
      try {
        const started = supervisor.startGitWrite({
          repositoryPath: ".",
          operation: {
            kind: "add",
            paths: ["blocked.txt"],
            expectedHead: git(root, "rev-parse", "HEAD").trim(),
            expectedBranch: git(root, "branch", "--show-current").trim(),
          },
          timeoutSeconds: 30,
          oauthClientId: "full-access-native-git-" + scenario,
          scopes: ["git.write"],
          idempotencyKey: "full-access-native-git-" + scenario + "-0123456789",
        });
        expect(started.ok, JSON.stringify(started)).toBe(true);
        if (!started.ok) throw new Error(started.error);
        const job = await waitForGitJob(supervisor, started.job.jobId);
        expect(job.state).not.toBe("succeeded");
        expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("");
      } finally {
        await supervisor.shutdown();
        setPermission(workspace.id, "level2");
      }
    }
  }, 240_000);

  it("reuses one Full Access Grant across isolated worktrees and keeps Level1 approvals per worktree", async () => {
    isolateStateDir();
    const root = makeTmpDir("full-access-worktree-git");
    makeGitRepo(root);
    const linkedDirectory = path.join(root, "worktrees", "linked-feature");
    fs.mkdirSync(path.dirname(linkedDirectory), { recursive: true });
    git(root, "worktree", "add", "-b", "linked-feature", linkedDirectory);
    const workspace = new Workspace(root);
    setPermission(workspace.id, "level2");
    const supervisor = new ExecutionSupervisor(workspace);
    try {
      write(root, "main-only.txt", "main worktree material\n");
      write(linkedDirectory, "linked-only.txt", "linked worktree material\n");

      const mainStarted = supervisor.startGitWrite({
        repositoryPath: ".",
        operation: { kind: "add", paths: ["main-only.txt"],
          expectedHead: git(root, "rev-parse", "HEAD").trim(),
          expectedBranch: git(root, "branch", "--show-current").trim() },
        timeoutSeconds: 30, oauthClientId: "worktree-full-access-client", scopes: ["git.write"],
        idempotencyKey: "worktree-main-full-access-add-0123456",
      });
      expect(mainStarted.ok, JSON.stringify(mainStarted)).toBe(true);
      if (!mainStarted.ok) throw new Error(mainStarted.error);
      const mainAuthorization = mainStarted.job.authorization;
      expect(mainAuthorization).toMatchObject({ type: "git", source: "full_access" });
      expect((await waitForGitJob(supervisor, mainStarted.job.jobId)).state).toBe("succeeded");

      const linkedStarted = supervisor.startGitWrite({
        repositoryPath: "worktrees/linked-feature",
        operation: { kind: "add", paths: ["linked-only.txt"],
          expectedHead: git(linkedDirectory, "rev-parse", "HEAD").trim(),
          expectedBranch: git(linkedDirectory, "branch", "--show-current").trim() },
        timeoutSeconds: 30, oauthClientId: "worktree-full-access-client", scopes: ["git.write"],
        idempotencyKey: "worktree-linked-full-access-add-0123456",
      });
      expect(linkedStarted.ok, JSON.stringify(linkedStarted)).toBe(true);
      if (!linkedStarted.ok) throw new Error(linkedStarted.error);
      expect(linkedStarted.job.repositoryIdentity).not.toBe(mainStarted.job.repositoryIdentity);
      expect(linkedStarted.job.authorization).toMatchObject({
        type: "git",
        source: "full_access",
        sessionGrantFingerprint: mainAuthorization?.type === "git" && mainAuthorization.source === "full_access"
          ? mainAuthorization.sessionGrantFingerprint : "",
        sessionGrantId: mainAuthorization?.type === "git" && mainAuthorization.source === "full_access"
          ? mainAuthorization.sessionGrantId : "",
      });
      expect((await waitForGitJob(supervisor, linkedStarted.job.jobId)).state).toBe("succeeded");
      expect(git(root, "diff", "--cached", "--name-only").trim()).toBe("main-only.txt");
      expect(git(linkedDirectory, "diff", "--cached", "--name-only").trim()).toBe("linked-only.txt");

      setPermission(workspace.id, "level1");
      const mainPolicy = { allowedOperations: ["add" as const], allowedBranches: ["main"], allowedRemotes: [] };
      const mainPreview = previewGitRepositoryApproval(workspace, ".", mainPolicy);
      approveGitRepository(workspace, ".", { ...mainPolicy, localApproval: true }, mainPreview.digest);
      write(linkedDirectory, "level1-linked.txt", "requires its own worktree approval\n");
      const linkedOperation = { kind: "add" as const, paths: ["level1-linked.txt"],
        expectedHead: git(linkedDirectory, "rev-parse", "HEAD").trim(),
        expectedBranch: git(linkedDirectory, "branch", "--show-current").trim() };
      const linkedInput = { repositoryPath: "worktrees/linked-feature", operation: linkedOperation,
        timeoutSeconds: 30, oauthClientId: "worktree-level1-client", scopes: ["git.write"],
        idempotencyKey: "worktree-linked-level1-denied-0123456" };
      expect(supervisor.startGitWrite(linkedInput)).toMatchObject({ ok: false, error: "NOT_APPROVED" });

      const linkedPolicy = { allowedOperations: ["add" as const], allowedBranches: ["linked-feature"], allowedRemotes: [] };
      const linkedPreview = previewGitRepositoryApproval(workspace, "worktrees/linked-feature", linkedPolicy);
      approveGitRepository(workspace, "worktrees/linked-feature",
        { ...linkedPolicy, localApproval: true }, linkedPreview.digest);
      const approved = supervisor.startGitWrite({ ...linkedInput,
        idempotencyKey: "worktree-linked-level1-approved-0123456" });
      expect(approved.ok, JSON.stringify(approved)).toBe(true);
      if (!approved.ok) throw new Error(approved.error);
      expect(approved.job.authorization).toMatchObject({ type: "git", source: "repository_approval" });
      expect((await waitForGitJob(supervisor, approved.job.jobId)).state).toBe("succeeded");
    } finally {
      await supervisor.shutdown();
      setPermission(workspace.id, "level2");
    }
  }, 240_000);
});
