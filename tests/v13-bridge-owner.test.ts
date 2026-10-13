import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { nullLogger } from "../src/logger/index.js";
import { isolateStateDir, makeTmpDir, makeGitRepo } from "./helpers.js";

it("F-07 rejects a second OS Bridge owner before opening the shared Job Store", async () => {
  const state = isolateStateDir(); const root = makeTmpDir("f07-two-processes"); makeGitRepo(root);
  const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, logger: nullLogger,
    authStoreFile: path.join(state, "first-auth.json") });
  const jobs = path.join(bridge.executionSupervisor.store.directory, "jobs.json");
  bridge.executionSupervisor.store.prepareCapacity();
  const before = fs.readFileSync(jobs);
  const module = pathToFileURL(path.resolve("dist/bridge/server.js")).href;
  const source = `import {startBridge} from ${JSON.stringify(module)};
    try { const b=await startBridge({workspaceRoot:${JSON.stringify(root)},port:0,persistRuntime:false,authStoreFile:${JSON.stringify(path.join(state,"second-auth.json"))}});
      await b.close(); console.log('UNEXPECTED_SECOND_OWNER'); process.exitCode=2;
    } catch(e) { console.log('OWNER_DENIED:'+e.message); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, C2C_STATE_DIR: state }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let captured = "";
  const collect = (chunk: Buffer) => { captured += chunk.toString("utf8"); if (captured.length > 8192) child.kill(); };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  const timeout = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(code, captured).toBe(0);
    expect(captured).toContain("OWNER_DENIED:");
    expect(captured).not.toContain("UNEXPECTED_SECOND_OWNER");
    expect(fs.readFileSync(jobs).equals(before)).toBe(true);
    console.log("F07_OWNER_EVIDENCE", JSON.stringify({ childPid: child.pid, denied: true, jobStoreUnchanged: true }));
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); await bridge.close(); }
}, 30_000);
