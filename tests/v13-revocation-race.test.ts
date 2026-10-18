import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { ExecutionSupervisor } from "../src/execution/supervisor.js";
import { WindowsNativeExecutionRunner } from "../src/execution/native-runner.js";
import { createLevel3Request, setLevel3Enabled, approveLevel3Request, revokeLevel3Request, consumeLevel3Request, resolveConsumedLevel3Request } from "../src/execution/level3-approval.js";
import { setPermission } from "../src/permission/store.js";
import { isolateStateDir, makeTmpDir, makeGitRepo } from "./helpers.js";

const nativeModuleDirectory = process.env.C2C_FULL_ACCESS_NATIVE_TEST_MODULE_DIRECTORY ?? path.resolve("dist", "execution");

describe.skipIf(process.platform !== "win32")("F-02 native pre-launch revocation", () => {
  for (const stage of ["pending", "approved", "consumed"] as const) {
    it(`revocation in ${stage} prevents launch authorization`, () => {
      isolateStateDir(); const root = makeTmpDir(`f02-${stage}`); makeGitRepo(root);
      const workspace = new Workspace(root); setLevel3Enabled(workspace.id, true, true);
      const reviewOnlyExecutable = path.join(root, "review-only-program.exe");
      fs.writeFileSync(reviewOnlyExecutable, "isolated review-only executable fixture\n");
      const request = createLevel3Request(workspace, "f02-stage", { engine: "program", repositoryPath: ".", executable: reviewOnlyExecutable,
        args: ["--version"], cwd: ".", timeoutSeconds: 20, materials: [] });
      if (stage !== "pending") approveLevel3Request(workspace, request.requestId, request.digest, true, { risk: "development" });
      if (stage === "consumed") consumeLevel3Request(workspace, request.requestId, "f02-stage", request.digest);
      expect(revokeLevel3Request(workspace.id, request.requestId, true)).toBe(true);
      expect(() => stage === "consumed" ? resolveConsumedLevel3Request(workspace, request.requestId, "f02-stage", request.digest)
        : consumeLevel3Request(workspace, request.requestId, "f02-stage", request.digest)).toThrow("LEVEL3_REQUEST_NOT_APPROVED");
    });
  }

  for (const { phase, action } of [{phase:"suspended",action:"revoke"},{phase:"permit",action:"revoke"},{phase:"suspended",action:"disable"}] as const) {
    it(`serializes ${action} at Native ${phase} and cancels a running tree`, async () => {
      isolateStateDir(); const root = makeTmpDir(`f02-native-${phase}-${action}`); makeGitRepo(root);
      const workspace = new Workspace(root); setPermission(workspace.id, "level1"); setLevel3Enabled(workspace.id, true, true);
      const marker = path.join(root, "executed.txt"); const release = path.join(root, "gate-release.txt");
      const request = createLevel3Request(workspace, "f02-paused", { engine: "program", repositoryPath: ".", executable: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000)`], cwd: ".", timeoutSeconds: 20, materials: [] });
      approveLevel3Request(workspace, request.requestId, request.digest, true, { risk: "development", allowDynamic: true });
      let gateSeen = false, revoked = false, gateError = "";
      const runner = new WindowsNativeExecutionRunner({ moduleDirectory: nativeModuleDirectory, helperBeforeResumeTest: { releaseFile: release, phase, onSuspended: () => {
        gateSeen = true;
        try { if (action === "disable") { setLevel3Enabled(workspace.id, false, true); revoked = true; } else revoked = revokeLevel3Request(workspace.id, request.requestId, true); } catch (error) { gateError = (error as Error).message; }
        finally { fs.writeFileSync(release, "release"); }
      } } });
      const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
      try {
        const start = supervisor.startLevel3({ requestId: request.requestId, digest: request.digest, oauthClientId: "f02-paused",
          scopes: ["execution.level3"], idempotencyKey: `f02-native-${phase}-0123456789` });
        expect(start.ok).toBe(true); if (!start.ok) throw new Error(start.error);
        for (let attempt = 0; attempt < 1000; attempt++) {
          if (phase === "permit" && fs.existsSync(marker) && !revoked) {
            expect(gateError).toBe("LEVEL3_REVOKE_BUSY");
            revoked = revokeLevel3Request(workspace.id, request.requestId, true);
            supervisor.reconcilePermission();
          }
          const job = supervisor.store.get(start.job.jobId)!;
          if (job.finishedAt) {
            expect(gateSeen).toBe(true); expect(revoked).toBe(true);
            if (phase === "suspended") { expect(gateError).toBe(""); expect(fs.existsSync(marker)).toBe(false); }
            else { expect(fs.existsSync(marker)).toBe(true); expect(job.state).toBe("cancelled"); }
            expect(job.tempOwnership).toBeNull();
            console.log("F02_NATIVE_GATE_EVIDENCE", JSON.stringify({ phase, revoked, gateError, marker: fs.existsSync(marker), state: job.state }));
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error("F02_NATIVE_GATE_TIMEOUT");
      } finally { await supervisor.shutdown(); }
    }, 45_000);
  }
  it("a successful revoke after launch resolution blocks the native command", async () => {
    isolateStateDir(); const root = makeTmpDir("f02-revoke-before-helper"); makeGitRepo(root);
    const workspace = new Workspace(root); setPermission(workspace.id, "level1"); setLevel3Enabled(workspace.id, true, true);
    const marker = path.join(root, "executed-after-revoke.txt");
    const request = createLevel3Request(workspace, "f02-client", { engine: "program", repositoryPath: ".", executable: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`], cwd: ".", timeoutSeconds: 20, materials: [] });
    approveLevel3Request(workspace, request.requestId, request.digest, true, { risk: "development", allowDynamic: true });
    let revoked = false;
    const runner = new WindowsNativeExecutionRunner({ moduleDirectory: nativeModuleDirectory, beforeHelperRequestWrite: () => {
      revoked = revokeLevel3Request(workspace.id, request.requestId, true);
    } });
    const supervisor = new ExecutionSupervisor(workspace, { runner, permissionPollMs: 60_000 });
    try {
      const start = supervisor.startLevel3({ requestId: request.requestId, digest: request.digest, oauthClientId: "f02-client",
        scopes: ["execution.level3"], idempotencyKey: "f02-precise-revocation-00001" });
      expect(start.ok).toBe(true); if (!start.ok) throw new Error(start.error);
      for (let attempt = 0; attempt < 1000; attempt++) {
        const job = supervisor.store.get(start.job.jobId)!;
        if (job.finishedAt) {
          expect(revoked).toBe(true);
          const vulnerable = process.env.C2C_F02_EXPECT_VULNERABLE === "1";
          expect(fs.existsSync(marker)).toBe(vulnerable);
          console.log("F02_PRE_HELPER_EVIDENCE", JSON.stringify({ revoked, marker: fs.existsSync(marker), state: job.state, failureCode: job.failureCode }));
          if (!vulnerable) expect(job.state).not.toBe("succeeded");
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("F02_COMPLETION_TIMEOUT");
    } finally { await supervisor.shutdown(); }
  }, 45_000);
});
