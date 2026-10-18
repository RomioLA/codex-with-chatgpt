import { describe, expect, it } from "vitest";
import { serializeFullAccessHelperRequest, type FullAccessHelperRequest } from "../src/execution/helper-protocol.js";
import type { FullAccessCommand } from "../src/execution/job-types.js";

const identity = "1:2";
const hash = "a".repeat(64);

function makeRequest(command: FullAccessCommand): FullAccessHelperRequest {
  return {
    timeoutSeconds: 45,
    workspaceId: "workspace_123",
    jobId: "job_012345678901234567890123",
    oauthClientId: "full-access-test-client",
    permissionMode: "level2",
    sessionGrantFingerprint: hash,
    sessionGrantId: "d".repeat(64),
    idempotencyKeyHash: "b".repeat(64),
    requestHash: "c".repeat(64),
    command,
    tempRootPath: "C:\\state\\execution-jobs\\workspace_123\\execution-temp",
    tempRootFileIdentity: identity,
    tempNonce: "d".repeat(64),
    tempCreatedAtMs: 123,
    jobTempDir: "C:\\state\\execution-jobs\\workspace_123\\execution-temp\\tmp-job_012345678901234567890123",
    jobTempFileIdentity: identity,
  };
}

function readString(buffer: Buffer, offset: { value: number }): string {
  const length = buffer.readUInt32LE(offset.value);
  offset.value += 4;
  const value = buffer.toString("utf8", offset.value, offset.value + length);
  offset.value += length;
  return value;
}

function parsedHostRequest(buffer: Buffer) {
  const offset = { value: 20 };
  const context = Array.from({ length: 8 }, () => readString(buffer, offset));
  const mode = buffer.readUInt8(offset.value++);
  const executable = readString(buffer, offset);
  const executableIdentity = readString(buffer, offset);
  const executableHash = readString(buffer, offset);
  const argumentCount = buffer.readUInt32LE(offset.value);
  offset.value += 4;
  const args = Array.from({ length: argumentCount }, () => readString(buffer, offset));
  const command = readString(buffer, offset);
  const cwd = readString(buffer, offset);
  const cwdIdentity = readString(buffer, offset);
  const temp = Array.from({ length: 6 }, () => readString(buffer, offset));
  return { context, mode, executable, executableIdentity, executableHash, args, command, cwd, cwdIdentity, temp, end: offset.value };
}

describe("Full Access Native Helper protocol v7", () => {
  it.each([
    ["program", 1, { engine: "program", executable: "C:\\tools\\node.exe", executableFileIdentity: identity, executableHash: hash, args: ["", "two words"], cwd: "C:\\outside\\work", cwdFileIdentity: identity } as const],
    ["cmd", 2, { engine: "cmd", executable: "C:\\Windows\\System32\\cmd.exe", executableFileIdentity: identity, executableHash: hash, command: "echo cmd-ok", cwd: "C:\\outside\\work", cwdFileIdentity: identity } as const],
    ["powershell", 3, { engine: "powershell", executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", executableFileIdentity: identity, executableHash: hash, command: "Write-Output powershell-ok", cwd: "C:\\outside\\work", cwdFileIdentity: identity } as const],
  ] as const)("encodes the host context and %s command without repository fields", (_engine, expectedMode, command) => {
    const encoded = serializeFullAccessHelperRequest(makeRequest(command));
    expect(encoded.subarray(0, 8).toString("ascii")).toBe("C2CJOB7\0");
    expect(encoded.readUInt16LE(8)).toBe(7);
    expect(encoded.readUInt8(10)).toBe(3);
    expect(encoded.readUInt8(11)).toBe(0);
    expect(encoded.readUInt8(12)).toBe(0);
    expect(encoded.readUInt32LE(16)).toBe(45);
    const parsed = parsedHostRequest(encoded);
    expect(parsed).toMatchObject({
      context: ["workspace_123", "job_012345678901234567890123", "full-access-test-client", "level2", hash, "d".repeat(64), "b".repeat(64), "c".repeat(64)],
      mode: expectedMode,
      executable: command.executable,
      executableIdentity: identity,
      executableHash: hash,
      args: command.engine === "program" ? ["", "two words"] : [],
      command: command.engine === "program" ? "" : command.command,
      cwd: "C:\\outside\\work",
      cwdIdentity: identity,
      temp: [
        "C:\\state\\execution-jobs\\workspace_123\\execution-temp",
        identity,
        "d".repeat(64),
        "123",
        "C:\\state\\execution-jobs\\workspace_123\\execution-temp\\tmp-job_012345678901234567890123",
        identity,
      ],
      end: encoded.length,
    });
  });

  it("rejects approval modes and malformed host material", () => {
    const valid = makeRequest({
      engine: "program", executable: "C:\\tools\\node.exe", executableFileIdentity: identity,
      executableHash: hash, args: [], cwd: "C:\\outside\\work", cwdFileIdentity: identity,
    });
    expect(() => serializeFullAccessHelperRequest({ ...valid, permissionMode: "level1" } as unknown as FullAccessHelperRequest)).toThrow();
    expect(() => serializeFullAccessHelperRequest({
      ...valid,
      command: { ...valid.command, executableHash: "bad" } as FullAccessCommand,
    })).toThrow("Invalid Full Access launch material");
  });
});
