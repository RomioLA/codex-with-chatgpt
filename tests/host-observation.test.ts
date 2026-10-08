import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ObservationProvider, RawProcess } from "../src/host-observation/types.js";
import { buildProcessTree, normalizeProcess, selectProcesses } from "../src/host-observation/process.js";
import { dnsError, resolveHostname, validateHostname } from "../src/host-observation/network.js";
import { HostObservation } from "../src/host-observation/service.js";
import { inspectPath } from "../src/host-observation/filesystem.js";
import { Workspace } from "../src/workspace/manager.js";
import { hostObservationSchemas } from "../src/mcp/host-observation-tools.js";
import { getStateDir } from "../src/config/paths.js";
import { makeTmpDir, write } from "./helpers.js";

const root = makeTmpDir("host-observation");
const workspace = new Workspace(root);
const time = (n: number) => new Date(n * 1000).toISOString();
const proc = (pid: number, parentPid = 0, start = pid): RawProcess => ({
  pid, parentPid, name: `node${pid}.exe`, exePath: `C:\\safe\\node${pid}.exe`,
  commandLine: "node.exe --token fake-secret --safe good", sessionId: 1, startTime: time(start),
});
const snapshot = [proc(1), proc(2, 1), proc(3, 2), proc(4, 2)];
function provider(overrides: Partial<ObservationProvider> = {}): ObservationProvider {
  const result: ObservationProvider = { context: async () => ({ userName: "fixture", userSid: "S-1-5-21-fixture", sessionId: 1,
    isElevated: false, isPackaged: false, packageIdentity: null }),
  processes: async () => ({ processes: snapshot, truncated: false }),
  listeners: async () => ({ listeners: [
    { protocol: "tcp", localAddress: "127.0.0.1", localPort: 9222, pid: 2, state: "LISTENING" },
    { protocol: "tcp", localAddress: "::1", localPort: 9222, pid: 99, state: "LISTENING" },
    { protocol: "udp", localAddress: "0.0.0.0", localPort: 53, pid: 3, state: null },
  ], truncated: false, fieldStatus: { tcp: "AVAILABLE", udp: "AVAILABLE" } }),
  network: async () => ({ adapters: [{ operationalStatus: "Up", addresses: ["192.0.2.1"] }],
    defaultRoutePresent: true, dnsServers: ["192.0.2.53"], internetReachable: null,
    fieldStatus: { adapters: "AVAILABLE", defaultRoutePresent: "AVAILABLE", dnsServers: "AVAILABLE" } }),
  metadata: async () => ({ owner: "fixture-owner", aclSummary: { protected: false, explicitRuleCount: 1, inheritedRuleCount: 0 },
    attributes: "Archive", fieldStatus: { owner: "AVAILABLE", aclSummary: "AVAILABLE", attributes: "AVAILABLE" } }), ...overrides };
  const getMetadata = result.metadata;
  result.metadata = async absolutePath => {
    const physical = fs.statSync(absolutePath, { bigint: true });
    return { handleIdentity: { fileId: physical.ino.toString(), volumeId: physical.dev.toString() },
      ...await getMetadata(absolutePath) };
  };
  return result;
}
describe("bounded process observation", () => {
  it("selects PID exact, parent, name, exe, session and safe command filters", () => {
    expect(selectProcesses(snapshot, { pid: 2, limit: 10 }).processes.map(p => p.pid)).toEqual([2]);
    expect(selectProcesses(snapshot, { name: "NODE3.EXE", limit: 10 }).processes.map(p => p.pid)).toEqual([3]);
    expect(selectProcesses(snapshot, { parentPid: 2, sessionId: 1, limit: 10 }).processes).toHaveLength(2);
    expect(selectProcesses(snapshot, { exePath: "c:\\SAFE\\node4.exe", limit: 10 }).processes[0].pid).toBe(4);
    expect(selectProcesses(snapshot, { commandContains: "safe good", limit: 10 }).processes).toHaveLength(4);
    expect(selectProcesses(snapshot, { commandContains: "fake-secret", limit: 10 }).processes).toHaveLength(0);
  });
  it("limits and preserves unavailable/access-denied fields", () => {
    const selected = selectProcesses(snapshot, { parentPid: 2, limit: 1 });
    expect(selected.truncated).toBe(true);
    const p = normalizeProcess({ ...proc(1), exePath: null, commandLine: null,
      fieldStatus: { exePath: "ACCESS_DENIED" } });
    expect(p.exePath).toBeNull(); expect(p.fieldStatus.exePath).toBe("ACCESS_DENIED");
    expect(p.fieldStatus.commandLine).toBe("UNAVAILABLE");
    expect(p.processKey).toBe(`1@${time(1)}`);
    expect(normalizeProcess({ ...proc(1), startTime: null }).processKey).toBeNull();
  });
  it("returns missing/exited PID without internal failure", () => {
    expect(selectProcesses([], { pid: 2, limit: 10 }).processExited).toBe(true);
    expect(buildProcessTree([], { pid: 2, direction: "both", depth: 4, limit: 50 }).processExited).toBe(true);
  });
  it("does not report a filtered or truncated missing process as exited", async () => {
    const get = vi.fn(async (filter?: { pid?: number; name?: string }) => ({
      processes: snapshot.filter(p => (filter?.pid === undefined || p.pid === filter.pid) &&
        (filter?.name === undefined || p.name === filter.name)), truncated: false }));
    const result = await new HostObservation(workspace, provider({ processes: get })).processes({ pid: 2, name: "wrong.exe", limit: 50 });
    expect(result.processes).toHaveLength(0); expect(result.processExited).toBe(false);
    expect(get).toHaveBeenCalledWith({ pid: 2 });
    const truncated = new HostObservation(workspace, provider({ processes: async () => ({ processes: [], truncated: true }) }));
    expect((await truncated.tree({ pid: 2, direction: "both", depth: 4, limit: 50 })).processExited).toBeNull();
  });
  it.each(["ancestors", "children", "both"] as const)("builds %s chain", direction => {
    const result = buildProcessTree(snapshot, { pid: 2, direction, depth: 4, limit: 50 });
    expect(result.nodes.map(n => n.process.pid)).toEqual(direction === "ancestors" ? [2, 1] : direction === "children" ? [2, 3, 4] : [2, 1, 3, 4]);
    expect(JSON.stringify(result)).not.toContain("fake-secret");
  });
  it("enforces depth/count and handles missing parent", () => {
    expect(buildProcessTree(snapshot, { pid: 1, direction: "children", depth: 1, limit: 50 }).truncated).toBe(true);
    expect(buildProcessTree(snapshot, { pid: 2, direction: "both", depth: 4, limit: 1 }).nodes).toHaveLength(1);
    expect(buildProcessTree([proc(2, 99)], { pid: 2, direction: "ancestors", depth: 4, limit: 50 }).missingParent).toBe(true);
  });
  it("rejects stale identity, skips reused or unverified parent and avoids cycles", () => {
    expect(() => buildProcessTree(snapshot, { pid: 2, processKey: "2@stale", direction: "both", depth: 4, limit: 50 })).toThrow("PID no longer");
    const result = buildProcessTree([proc(1, 0, 9), proc(2, 1, 2)], { pid: 2, direction: "ancestors", depth: 4, limit: 50 });
    expect(result.nodes).toHaveLength(1); expect(result.issues[0].reason).toBe("PARENT_PID_REUSED");
    expect(buildProcessTree([{ ...proc(1), startTime: null }, proc(2, 1)], { pid: 2, direction: "both", depth: 4, limit: 50 }).partial).toBe(true);
    expect(buildProcessTree([proc(1, 2, 1), proc(2, 1, 1)], { pid: 2, direction: "both", depth: 4, limit: 50 }).nodes).toHaveLength(2);
  });
  it("validates filters, hard limits and injection shaped extra fields", () => {
    expect(hostObservationSchemas.process_query.safeParse({}).success).toBe(false);
    for (const input of [{ pid: -1 }, { pid: 1.5 }, { pid: 1, limit: 201 }, { pid: 1, script: "anything" }]) {
      expect(hostObservationSchemas.process_query.safeParse(input).success).toBe(false);
    }
    expect(hostObservationSchemas.process_tree.safeParse({ pid: 1, depth: 9 }).success).toBe(false);
    expect(hostObservationSchemas.process_query.parse({ pid: 1 }).limit).toBe(50);
  });
});
describe("network diagnostics", () => {
  it("retains IPv4 IPv6 and UDP endpoints when PID exits", async () => {
    const result = await new HostObservation(workspace, provider()).listeners({ limit: 50 });
    expect(result.listeners).toHaveLength(3);
    expect(result.listeners[0].processKey).toBe(`2@${time(2)}`);
    expect(result.listeners[1].localAddress).toBe("::1");
    expect(result.listeners[1].processName).toBeNull(); expect(result.partial).toBe(true);
    expect(result.listeners[0].associationStatus).toBe("SNAPSHOT_UNVERIFIED");
  });
  it("filters and bounds endpoints; process query failure does not drop listener", async () => {
    const result = await new HostObservation(workspace, provider()).listeners({ protocol: "tcp", port: 9222, limit: 1 });
    expect(result.listeners).toHaveLength(1); expect(result.truncated).toBe(true);
    expect((await new HostObservation(workspace, provider()).listeners({ pid: 3, address: "0.0.0.0", limit: 50 })).listeners).toHaveLength(1);
    const denied = provider({ processes: async () => { throw new Error("denied"); } });
    expect((await new HostObservation(workspace, denied).listeners({ limit: 50 })).listeners).toHaveLength(3);
  });
  it.each([
    { operationalStatus: "Up", route: true, dns: ["192.0.2.53"] },
    { operationalStatus: "Disconnected", route: false, dns: [] },
    { operationalStatus: "Up", route: false, dns: [] },
  ])("does not equate adapters with Internet availability: %j", async fixture => {
    const result = await new HostObservation(workspace, provider({ network: async () => ({ adapters: [fixture],
      defaultRoutePresent: fixture.route, dnsServers: fixture.dns, internetReachable: null, fieldStatus: { adapters: "AVAILABLE" } }) })).network();
    expect(result.internetReachable).toBeNull(); expect(result.defaultRoutePresent).toBe(fixture.route);
  });
  it.each(["https://example.com", "x/y", "x:53", "x;whoami", "$(whoami)", "-bad.com", "a..b", "127.0.0.1", "a b", "é.com"])("denies malformed hostname %s", hostname => {
    expect(() => validateHostname(hostname)).toThrow();
  });
  it("maps DNS results and errors without real network traffic", async () => {
    expect(validateHostname("EXAMPLE.com")).toBe("example.com");
    expect(dnsError("ENOTFOUND")).toBe("NOT_FOUND");
    expect(dnsError("EAI_AGAIN")).toBe("TEMPORARY_FAILURE");
    expect(dnsError("ETIMEOUT")).toBe("TIMEOUT");
    expect(dnsError("UNKNOWN")).toBe("SYSTEM_ERROR");
    const resolver = (code?: string) => ({ resolve4: async () => {
      if (code) throw { code }; return ["192.0.2.1"];
    }, resolve6: async () => { throw { code: "ENODATA" }; }, cancel: vi.fn() });
    expect((await resolveHostname("example.com", () => resolver() as any)).addresses).toEqual(["192.0.2.1"]);
    expect((await resolveHostname("example.com", () => resolver("ENOTFOUND") as any)).error).toBe("NOT_FOUND");
    expect((await resolveHostname("example.com", () => resolver("ESERVFAIL") as any)).error).toBe("TEMPORARY_FAILURE");
  });
});
describe("host and filesystem metadata", () => {
  it("reports Host SID/session/elevation/package/architectures and effective state root", async () => {
    const result = await new HostObservation(workspace, provider()).context();
    expect(result.userSid).toBe("S-1-5-21-fixture"); expect(result.sessionId).toBe(1);
    expect(result.isElevated).toBe(false); expect(result.isPackaged).toBe(false);
    expect(result.processArchitecture).toBe(process.arch); expect(result.osArchitecture).toBeTruthy();
    expect(result.effectiveStateRoot).toBe(getStateDir()); expect(result.fieldStatus.packageIdentity).toBe("NOT_SUPPORTED");
  });
  it("inspects file/directory/missing metadata, stable identity and owner/ACL status", async () => {
    write(root, "ordinary.txt", "ordinary file");
    const first = await inspectPath(workspace, "ordinary.txt", provider());
    const second = await inspectPath(workspace, path.join(root, "ordinary.txt"), provider());
    expect(first.exists).toBe(true); expect(first.type).toBe("file");
    expect(first.fileId).toBe(second.fileId); expect(first.volumeId).toBe(second.volumeId);
    expect(first.owner).toBe("fixture-owner"); expect(first.fieldStatus.owner).toBe("AVAILABLE");
    expect(JSON.stringify(first)).not.toContain("ordinary file");
    expect((await inspectPath(workspace, ".", provider())).type).toBe("directory");
    expect((await inspectPath(workspace, "missing.txt", provider())).exists).toBe(false);
  });
  it("keeps ACL denial as null with explicit status", async () => {
    write(root, "denied-acl.txt", "fixture");
    const result = await inspectPath(workspace, "denied-acl.txt", provider({ metadata: async () => ({ owner: null, aclSummary: null,
      fieldStatus: { owner: "ACCESS_DENIED", aclSummary: "ACCESS_DENIED" } }) }));
    expect(result.owner).toBeNull(); expect(result.fieldStatus.owner).toBe("ACCESS_DENIED");
  });
  it.each([".env", ".ssh/id_rsa", ".git", "browser_profile/Default/Login Data", "Credentials/secret", "Vault/a", "test.pem"])("denies sensitive path %s before metadata provider", async requested => {
    const metadata = vi.fn();
    await expect(inspectPath(workspace, requested, provider({ metadata }))).rejects.toMatchObject({ code: "SENSITIVE_PATH_DENIED" });
    expect(metadata).not.toHaveBeenCalled();
  });
  it("denies protected state and sensitive aliases", async () => {
    await expect(inspectPath(workspace, getStateDir(), provider())).rejects.toMatchObject({ code: "SENSITIVE_PATH_DENIED" });
    const sensitive = path.join(root, ".ssh"); fs.mkdirSync(sensitive);
    fs.symlinkSync(sensitive, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(inspectPath(workspace, "alias", provider())).rejects.toMatchObject({ code: "SENSITIVE_PATH_DENIED" });
  });
  it("reports junction target and retains stable physical identity", async () => {
    const target = path.join(root, "target"); fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, "junction"), process.platform === "win32" ? "junction" : "dir");
    const real = await inspectPath(workspace, "target", provider());
    const alias = await inspectPath(workspace, "junction", provider());
    expect(alias.reparsePoint).toBe(true); expect(alias.reparseTarget).toBe(fs.realpathSync.native(target));
    expect(alias.fileId).toBe(real.fileId); expect(alias.fieldStatus.reparseTag).toBe("NOT_SUPPORTED");
  });
  it("reports ordinary hardlink identity and rejects foreign handle metadata after an ABA swap", async () => {
    const ordinary = write(root, "hardlink-original.txt", "fixture");
    const alias = path.join(root, "hardlink-alias.txt"); fs.linkSync(ordinary, alias);
    const first = await inspectPath(workspace, ordinary, provider());
    const second = await inspectPath(workspace, alias, provider());
    expect(first.fileId).toBe(second.fileId); expect(first.hardLinkCount).toBe(2);
    const before = fs.statSync(ordinary, { bigint: true });
    // The named object is unchanged at both stat checks. Foreign metadata has a
    // different handle identity, as in a swap followed by restoration of original inode.
    await expect(inspectPath(workspace, ordinary, provider({ metadata: async () => ({
      owner: "must-not-escape", handleIdentity: { fileId: (before.ino + 1n).toString(), volumeId: before.dev.toString() },
    }) }))).rejects.toMatchObject({ code: "PATH_CHANGED" });
  });
  it("discards metadata on path swaps and maps access denied", async () => {
    const ordinary = write(root, "swap.txt", "first");
    const moved = path.join(root, "moved.txt");
    await expect(inspectPath(workspace, "swap.txt", provider({ metadata: async () => {
      fs.renameSync(ordinary, moved); write(root, "swap.txt", "second"); return {};
    } }))).rejects.toMatchObject({ code: "PATH_CHANGED" });
    const stat = vi.spyOn(fs, "lstatSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    await expect(inspectPath(workspace, "swap.txt", provider())).rejects.toMatchObject({ code: "CANONICALIZATION_FAILED" });
    stat.mockRestore();
  });
});
