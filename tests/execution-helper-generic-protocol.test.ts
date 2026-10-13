import { describe, expect, it } from "vitest";
import { serializeHelperRequest, type GenericCommand, type HelperRequest } from "../src/execution/helper-protocol.js";

const identity = "1:2";
const hash = "a".repeat(64);

function makeGenericRequest(genericCommand: GenericCommand): HelperRequest {
  return {
    packageManager: "npm",
    kind: "package_script",
    timeoutSeconds: 30,
    cwd: "C:\\repo",
    gitDirectory: "C:\\repo\\.git",
    gitDirectoryFileIdentity: identity,
    commonGitDirectory: "C:\\repo\\.git",
    commonGitDirectoryFileIdentity: identity,
    nodeExecutable: "C:\\node\\node.exe",
    nodeFileIdentity: identity,
    nodeHash: hash,
    managerCli: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
    managerFileIdentity: identity,
    managerHash: hash,
    managerLibCli: "C:\\node\\node_modules\\npm\\lib\\cli.js",
    managerLibCliFileIdentity: identity,
    managerLibCliHash: hash,
    managerValidateEngines: "C:\\node\\node_modules\\npm\\lib\\cli\\validate-engines.js",
    managerValidateEnginesFileIdentity: identity,
    managerValidateEnginesHash: hash,
    managerMainEntry: "C:\\node\\node_modules\\npm\\lib\\cli\\entry.js",
    managerMainEntryFileIdentity: identity,
    managerMainEntryHash: hash,
    managerPackageJson: "C:\\node\\node_modules\\npm\\package.json",
    managerPackageJsonFileIdentity: identity,
    managerPackageJsonHash: hash,
    managerExitHandler: "C:\\node\\node_modules\\npm\\lib\\cli\\exit-handler.js",
    managerExitHandlerFileIdentity: identity,
    managerExitHandlerHash: hash,
    managerCore: "C:\\node\\node_modules\\npm\\lib\\npm.js",
    managerCoreFileIdentity: identity,
    managerCoreHash: hash,
    target: "generic",
    tempRootPath: "C:\\state\\execution-temp",
    tempRootFileIdentity: identity,
    tempWorkspaceId: "workspace_1",
    tempJobId: "job_012345678901234567890123",
    tempNonce: hash,
    tempCreatedAtMs: 123,
    jobTempDir: "C:\\state\\execution-temp\\tmp-job_012345678901234567890123",
    jobTempFileIdentity: identity,
    repositoryFileIdentity: identity,
    gitEntryFileIdentity: identity,
    gitEntryType: "directory",
    gitEntryHash: hash,
    packageJsonHash: genericCommand.approvalManifestHash,
    genericCommand,
  };
}

function readString(buffer: Buffer, offset: { value: number }): string {
  const length = buffer.readUInt32LE(offset.value);
  offset.value += 4;
  const value = buffer.toString("utf8", offset.value, offset.value + length);
  offset.value += length;
  return value;
}

function genericTail(buffer: Buffer) {
  const offset = { value: 20 };
  for (let index = 0; index < 40; index += 1) readString(buffer, offset);
  offset.value += 1; // git entry type
  readString(buffer, offset); // git entry hash
  readString(buffer, offset); // package/approval hash

  const mode = buffer.readUInt8(offset.value);
  offset.value += 1;
  const executable = readString(buffer, offset);
  const executableFileIdentity = readString(buffer, offset);
  const executableHash = readString(buffer, offset);
  const argumentCount = buffer.readUInt32LE(offset.value);
  offset.value += 4;
  const args = Array.from({ length: argumentCount }, () => readString(buffer, offset));
  const commandText = readString(buffer, offset);
  const cwd = readString(buffer, offset);
  const cwdFileIdentity = readString(buffer, offset);
  const approvalManifest = readString(buffer, offset);
  const approvalManifestFileIdentity = readString(buffer, offset);
  const approvalManifestHash = readString(buffer, offset);
  const materialCount = buffer.readUInt32LE(offset.value);
  offset.value += 4;
  const materials = Array.from({ length: materialCount }, () => ({
    path: readString(buffer, offset),
    fileIdentity: readString(buffer, offset),
    hash: readString(buffer, offset),
  }));
  const snapshotCount = buffer.readUInt32LE(offset.value); offset.value += 4;
  const launchSnapshots = Array.from({ length: snapshotCount }, () => ({
    path: readString(buffer, offset), fileIdentity: readString(buffer, offset), hash: readString(buffer, offset),
  }));
  return {
    mode, executable, executableFileIdentity, executableHash, args, commandText,
    cwd, cwdFileIdentity, approvalManifest, approvalManifestFileIdentity,
    approvalManifestHash, materials, ...(launchSnapshots.length ? { launchSnapshots } : {}), end: offset.value,
  };
}

function command(mode: GenericCommand["mode"], extras: Partial<GenericCommand> = {}): GenericCommand {
  return {
    mode,
    executable: mode === "cmd" ? "C:\\Windows\\System32\\cmd.exe" : "C:\\tools\\runner.exe",
    executableFileIdentity: identity,
    executableHash: hash,
    args: [],
    ...(mode === "direct" ? {} : { commandText: "echo \"approved\"" }),
    cwd: "C:\\repo\\packages\\app",
    cwdFileIdentity: identity,
    approvalManifest: "C:\\state\\approvals\\approval.json",
    approvalManifestFileIdentity: identity,
    approvalManifestHash: hash,
    materials: [{ path: "C:\\repo\\scripts\\run.js", fileIdentity: identity, hash }],
    ...extras,
  };
}

describe("generic helper request protocol", () => {
  it("adds a recipe 2 tail with direct argv, identity-bound manifest, and materials", () => {
    const genericCommand = command("direct", {
      args: ["", "two words", "quote\"and\\tail"],
    });
    const request = serializeHelperRequest(makeGenericRequest(genericCommand));
    const parsed = genericTail(request);

    expect(request.readUInt8(10)).toBe(2);
    expect(parsed).toMatchObject({
      mode: 1,
      executable: genericCommand.executable,
      executableFileIdentity: identity,
      executableHash: hash,
      args: genericCommand.args,
      commandText: "",
      cwd: genericCommand.cwd,
      approvalManifest: genericCommand.approvalManifest,
      approvalManifestHash: hash,
      materials: genericCommand.materials,
      end: request.length,
    });
  });

  it.each([
    ["cmd", 2, "echo \"approved\""],
    ["powershell", 3, "echo \"approved\""],
  ] as const)("encodes %s command text separately from argv", (mode, expectedMode, commandText) => {
    const genericCommand = command(mode);
    const parsed = genericTail(serializeHelperRequest(makeGenericRequest(genericCommand)));
    expect(parsed.mode).toBe(expectedMode);
    expect(parsed.args).toEqual([]);
    expect(parsed.commandText).toBe(commandText);
  });

  it("rejects shell argv mixing and a manifest hash mismatch", () => {
    expect(() => serializeHelperRequest(makeGenericRequest(command("cmd", { args: ["extra"] }))))
      .toThrow("Invalid generic command mode");
    const invalid = makeGenericRequest(command("direct"));
    invalid.packageJsonHash = "b".repeat(64);
    expect(() => serializeHelperRequest(invalid)).toThrow("Generic approval manifest hash mismatch");
  });

  it("rejects embedded NUL in generic paths, argv, and shell text while preserving empty argv", () => {
    const invalidCommands: GenericCommand[] = [
      command("direct", { executable: "C:\\tools\\bad\0.exe" }),
      command("direct", { args: ["bad\0arg"] }),
      command("cmd", { commandText: "echo\0bad" }),
      command("direct", { cwd: "C:\\repo\0evil" }),
      command("direct", { approvalManifest: "C:\\state\0evil" }),
      command("direct", {
        materials: [{ path: "C:\\repo\0evil", fileIdentity: identity, hash }],
      }),
    ];

    for (const invalid of invalidCommands) {
      expect(() => serializeHelperRequest(makeGenericRequest(invalid)))
        .toThrow("Invalid execution helper string length");
    }

    expect(() => serializeHelperRequest(makeGenericRequest(command("direct", { args: [""] }))))
      .not.toThrow();
  });
});
