import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { nullLogger } from "../src/logger/index.js";
import { isolateStateDir, makeTmpDir, makeGitRepo, write } from "./helpers.js";

async function until(check: () => boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("BRIDGE_CRASH_FIXTURE_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (["ESRCH", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}

it.skipIf(process.platform !== "win32")("actual Bridge process crash empties Native tree and restart never replays Level 3", async () => {
  const previous = process.env.C2C_STATE_DIR;
  const state = isolateStateDir(); const root = makeTmpDir("v13-bridge-crash"); makeGitRepo(root);
  const ready = path.join(root, "bridge-ready.json");
  write(root, "child.cjs", "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000);");
  write(root, "entry.cjs", "const fs=require('node:fs');fs.appendFileSync('launches.txt','started\\n');fs.writeFileSync('parent.pid',String(process.pid));require('node:child_process').spawn(process.execPath,['child.cjs'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);");
  const moduleUrl = (file: string) => pathToFileURL(path.resolve(`dist/${file}.js`)).href;
  const source = `import fs from 'node:fs';
    import {startBridge} from ${JSON.stringify(moduleUrl("bridge/server"))};
    import {setPermission} from ${JSON.stringify(moduleUrl("permission/store"))};
    import {setLevel3Enabled,createLevel3Request,approveLevel3Request} from ${JSON.stringify(moduleUrl("execution/level3-approval"))};
    const b=await startBridge({workspaceRoot:${JSON.stringify(root)},port:0,persistRuntime:false,authStoreFile:${JSON.stringify(path.join(state,"crash-auth.json"))}});
    const w=b.executionSupervisor.workspace;setPermission(w.id,'level1');setLevel3Enabled(w.id,true,true);
    const r=createLevel3Request(w,'bridge-crash-client',{engine:'program',repositoryPath:'.',executable:process.execPath,args:['entry.cjs'],cwd:'.',materials:['child.cjs'],timeoutSeconds:60});
    approveLevel3Request(w,r.requestId,r.digest,true,{risk:'development'});
    const input={requestId:r.requestId,digest:r.digest,oauthClientId:'bridge-crash-client',scopes:['execution.level3'],idempotencyKey:'bridge-crash-key-0123456789'};
    const result=b.executionSupervisor.startLevel3(input);if(!result.ok)throw new Error(result.error);
    fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({input,jobId:result.job.jobId}),{flag:'wx'});`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, C2C_STATE_DIR: state }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let captured = "";
  const collect = (chunk: Buffer) => { captured = (captured + chunk.toString()).slice(-4096); };
  owner.stdout.on("data", collect); owner.stderr.on("data", collect);
  const closed = new Promise<void>((resolve, reject) => { owner.once("error", reject); owner.once("close", () => resolve()); });
  let restarted: Awaited<ReturnType<typeof startBridge>> | undefined;
  try {
    await until(() => fs.existsSync(ready) || owner.exitCode !== null, 20_000);
    expect(owner.exitCode, captured).toBeNull();
    await until(() => fs.existsSync(path.join(root,"parent.pid")) && fs.existsSync(path.join(root,"child.pid")));
    const pids = ["parent.pid","child.pid"].map(file => Number(fs.readFileSync(path.join(root,file),"utf8")));
    expect(pids.every(alive)).toBe(true);
    const record = JSON.parse(fs.readFileSync(ready,"utf8"));
    owner.kill(); await closed;
    await until(() => pids.every(pid => !alive(pid)));
    restarted = await startBridge({workspaceRoot:root,port:0,persistRuntime:false,logger:nullLogger,authStoreFile:path.join(state,"restart-auth.json")});
    expect(restarted.executionSupervisor.store.get(record.jobId)).toMatchObject({state:"interrupted"});
    const duplicate = restarted.executionSupervisor.startLevel3(record.input);
    expect(duplicate).toMatchObject({ok:true,duplicate:true,job:{jobId:record.jobId,state:"interrupted"}});
    expect(fs.readFileSync(path.join(root,"launches.txt"),"utf8")).toBe("started\n");
    const evidence = {ownerPid:owner.pid,pids,treeEmpty:true,restartedState:"interrupted",replayed:false};
    fs.writeFileSync(path.join(root,"crash-evidence.json"),JSON.stringify(evidence),{flag:"wx"});
    console.log("BRIDGE_CRASH_NATIVE_EVIDENCE",JSON.stringify(evidence));
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { owner.kill(); await closed; }
    await restarted?.close();
    if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR=previous;
  }
}, 60_000);
