import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { GitWritePlan } from "../git-write/types.js";

/** Fixed internal operation, not a general command runner. Native locks this
 * entry, the plan, Git bundle and Node. Preserve the live index; only advance
 * the explicitly approved ref when its old commit still matches. */
export function runControlledGitCommit(plan: GitWritePlan): number {
  const binding = plan.commitBinding;
  const hex = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
  if (plan.operation.kind !== "commit" || !binding || !hex.test(binding.tree) ||
      binding.parent !== plan.before.head || binding.branch !== plan.before.branch || !binding.branch ||
      !path.isAbsolute(plan.executable) || !path.isAbsolute(plan.repository.canonicalPath)) throw new Error("INVALID_COMMIT_PLAN");
  const at = plan.args.indexOf("commit");
  if (at < 1) throw new Error("INVALID_COMMIT_PLAN");
  const common = plan.args.slice(0, at);
  const run = (args: string[]) => spawnSync(plan.executable, [...common, ...args], {
    cwd: plan.repository.canonicalPath, env: process.env, shell: false, windowsHide: true,
    encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30_000,
  });
  const created = run(["commit-tree", binding.tree, ...(binding.parent ? ["-p", binding.parent] : []), "-m", plan.operation.message]);
  if (created.error || created.status !== 0) { process.stderr.write((created.stderr ?? "COMMIT_TREE_FAILED").slice(0, 65536)); return created.status ?? 1; }
  const commit = created.stdout.trim();
  if (!hex.test(commit)) throw new Error("INVALID_COMMIT_RESULT");
  const updated = run(["update-ref", "--no-deref", "-m", "C2C controlled commit", `refs/heads/${binding.branch}`, commit, binding.parent ?? "0".repeat(commit.length)]);
  if (updated.error || updated.status !== 0) { process.stderr.write((updated.stderr ?? "REF_COMPARE_AND_SWAP_FAILED").slice(0, 65536)); return updated.status ?? 1; }
  process.stdout.write(`C2C_COMMIT:${commit}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2];
    if (!file || !path.isAbsolute(file)) throw new Error("INVALID_COMMIT_PLAN");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("INVALID_COMMIT_PLAN");
    process.exitCode = runControlledGitCommit(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch { process.stderr.write("CONTROLLED_COMMIT_DENIED\n"); process.exitCode = 1; }
}
