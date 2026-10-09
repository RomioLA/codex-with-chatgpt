import fs from "node:fs";
import { Workspace } from "../../src/workspace/manager.js";
import { approveTrustedCommand } from "../../src/execution/trusted-registry.js";
import { resolveRepositoryIdentity } from "../../src/execution/repository-identity.js";
import { ExecutionSupervisor } from "../../src/execution/supervisor.js";
import { setPermission } from "../../src/permission/store.js";

const [workspaceRoot, stateDirectory, readyFile, errorFile] = process.argv.slice(2);
if (!workspaceRoot || !stateDirectory || !readyFile || !errorFile) {
  throw new Error("Owner harness requires workspace, state, ready, and error paths.");
}
process.env.C2C_STATE_DIR = stateDirectory;

try {
  const workspace = new Workspace(workspaceRoot);
  setPermission(workspace.id, "level1");
  const repository = resolveRepositoryIdentity(workspace, ".");
  approveTrustedCommand({
    workspaceId: workspace.id,
    repositoryIdentity: repository.identity,
    canonicalRepositoryPath: repository.canonicalPath,
    kind: "test",
    target: "test",
    packageManager: "npm",
    localApproval: true,
  });

  const supervisor = new ExecutionSupervisor(workspace);
  const result = supervisor.start({
    repositoryPath: ".",
    kind: "test",
    target: "test",
    timeoutSeconds: 60,
    idempotencyKey: "windows-owner-loss-key-0001",
    oauthClientId: "windows-owner-loss-client",
    scopes: ["execution.run"],
  });
  if (!result.ok || result.job.state !== "running") {
    throw new Error(`Execution did not enter running: ${result.ok ? result.job.failureCode ?? result.job.state : result.error}`);
  }
  fs.writeFileSync(readyFile, result.job.jobId, { flag: "wx" });
  await new Promise<void>(() => undefined);
} catch (error) {
  fs.writeFileSync(errorFile, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
