/** Read-only Host smoke. Creates only an isolated .tooling fixture and temporary loopback listener.
 * Does not start Bridge/Tunnel, pair, modify environment/state, or acquire OAuth tokens.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { HostObservation } from "../src/host-observation/service.js";
import { Workspace } from "../src/workspace/manager.js";

const workspace = new Workspace(process.cwd());
const host = new HostObservation(workspace);
const fixture = path.join(workspace.root, ".tooling", "host-smoke", String(Date.now()));
fs.mkdirSync(path.join(fixture, "target"), { recursive: true });
fs.writeFileSync(path.join(fixture, "target", "ordinary.txt"), "Host metadata fixture; no secrets.\n");
fs.symlinkSync(path.join(fixture, "target"), path.join(fixture, "junction"), "junction");
const server = net.createServer();
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const port = (server.address() as net.AddressInfo).port;
  const context = await host.context();
  assert(context.fieldStatus.userSid === "AVAILABLE" && context.fieldStatus.sessionId === "AVAILABLE");
  assert(context.fieldStatus.isElevated === "AVAILABLE" && context.fieldStatus.isPackaged === "AVAILABLE");
  const processResult = await host.processes({ pid: process.pid, limit: 5 });
  assert.equal(processResult.processes.length, 1);
  assert(processResult.processes[0].processKey);
  const cloudflared = await host.processes({ name: "cloudflared.exe", limit: 5 });
  const tree = await host.tree({ pid: process.pid, direction: "ancestors", depth: 8, limit: 20,
    processKey: processResult.processes[0].processKey! });
  assert(tree.nodes.length >= 2, "expected real parent-child chain");
  const listeners = await host.listeners({ port, pid: process.pid, protocol: "tcp", limit: 10 });
  assert(listeners.listeners.some(row => row.pid === process.pid && row.localPort === port));
  const network = await host.network();
  assert.equal((network.fieldStatus as Record<string, string>).adapters, "AVAILABLE");
  const dns = await host.dns("example.com");
  assert(dns.addresses.length > 0 && dns.error === null);
  const file = await host.path("package.json");
  const fileAgain = await host.path("package.json");
  assert(file.exists && file.fileId && file.fileId === fileAgain.fileId);
  assert.equal(file.fieldStatus.owner, "AVAILABLE");
  assert.equal(file.fieldStatus.aclSummary, "AVAILABLE");
  const real = await host.path(path.join(fixture, "target"));
  const reparse = await host.path(path.join(fixture, "junction"));
  assert(reparse.reparsePoint && reparse.fileId === real.fileId && reparse.reparseTarget === real.canonicalPath);
  console.log(JSON.stringify({ result: "PASS", capturedAt: new Date().toISOString(),
    host_context: context,
    process_query: { pid: process.pid, processKey: processResult.processes[0].processKey,
      fieldStatus: processResult.processes[0].fieldStatus, cloudflaredCount: cloudflared.processes.length },
    process_tree: { nodes: tree.nodes.map(n => ({ pid: n.process.pid, name: n.process.name, relation: n.relation })),
      partial: tree.partial, missingParent: tree.missingParent },
    network_listeners: listeners,
    network_status: { adapterCount: (network.adapters as unknown[]).length, defaultRoutePresent: network.defaultRoutePresent,
      dnsServerCount: (network.dnsServers as unknown[]).length, fieldStatus: network.fieldStatus, partial: network.partial },
    dns_resolve: dns,
    path_inspect: { fileId: file.fileId, volumeId: file.volumeId, owner: file.owner, fieldStatus: file.fieldStatus,
      reparsePoint: reparse.reparsePoint, targetIdentityMatches: reparse.fileId === real.fileId },
    productionModified: false, productionSystemReadActivated: false }, null, 2));
} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
