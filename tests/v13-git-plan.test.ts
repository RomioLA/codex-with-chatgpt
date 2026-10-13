import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { createGitJobPlan, MAX_GIT_JOB_PLANS } from "../src/execution/git-job-plan.js";
import { isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

describe("V1.3 durable Git plan resource limits", () => {
  it("refuses a full plan store before planning and retains every audit file", () => {
    const state = isolateStateDir();
    const root = makeTmpDir("v13-plan-quota"); makeGitRepo(root);
    const workspace = new Workspace(root);
    const directory = path.join(state, "execution", "git-plans", workspace.id);
    fs.mkdirSync(directory, { recursive: true });
    for (let index = 0; index < MAX_GIT_JOB_PLANS; index++) {
      fs.writeFileSync(path.join(directory, `${index.toString().padStart(24, "0")}.json`), "{}");
    }
    expect(() => createGitJobPlan(workspace, ".", { kind: "branch_list", expectedHead: null, expectedBranch: null })).toThrow("GIT_PLAN_STORE_FULL");
    expect(fs.readdirSync(directory)).toHaveLength(MAX_GIT_JOB_PLANS);
  });

  it("never steals an existing creation lock or writes a new plan beside it", () => {
    const state = isolateStateDir();
    const root = makeTmpDir("v13-plan-busy"); makeGitRepo(root);
    const workspace = new Workspace(root);
    const directory = path.join(state, "execution", "git-plans", workspace.id);
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, "plans.lock");
    fs.writeFileSync(lock, "unconfirmed owner");
    expect(() => createGitJobPlan(workspace, ".", { kind: "branch_list", expectedHead: null, expectedBranch: null })).toThrow("GIT_PLAN_STORE_BUSY");
    expect(fs.readFileSync(lock, "utf8")).toBe("unconfirmed owner");
    expect(fs.readdirSync(directory)).toEqual(["plans.lock"]);
  });
});
