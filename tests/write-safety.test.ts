import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  createFile,
  createDirectory,
  deleteFile,
  editText,
  getWriteAuditPath,
  hashFile,
  moveFile,
  readFileForWrite,
  replaceFile,
  WriteSafetyError,
} from "../src/write/safety.js";

let root: string;
let workspaceId: string;

function testPath(name: string): string {
  return path.join(root, name);
}

function writeFixture(name: string, content: string): string {
  const filePath = testPath(name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function expectCode(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WriteSafetyError);
  expect(caught).toMatchObject({ code });
}

function fixedPowerShellForTest(): string {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe"),
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("A fixed PowerShell installation is required for the Windows ACL test.");
  return executable;
}

function runFixedPowerShell(script: string, env: NodeJS.ProcessEnv): string {
  const result = childProcess.spawnSync(fixedPowerShellForTest(), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`PowerShell ACL fixture failed: ${result.error?.code ?? result.status}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : result.stdout?.toString("utf8").trim() ?? "";
}

function runCrashChild(mode: "partial-temp" | "complete-temp" | "after-publication", filePath: string, content: string, expectedHash: string): number | null {
  const childScript = String.raw`
import fs from 'node:fs';
import childProcess from 'node:child_process';
const originalWrite = fs.writeFileSync.bind(fs);
if (process.env.C2C_CRASH_MODE === 'partial-temp') {
  fs.writeFileSync = ((target, data, ...args) => {
    if (typeof target === 'number') {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      originalWrite(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...args);
      process.exit(86);
    }
    return originalWrite(target, data, ...args);
  });
} else if (process.env.C2C_CRASH_MODE === 'complete-temp') {
  childProcess.spawnSync = () => process.exit(87);
} else {
  fs.appendFileSync = () => process.exit(88);
}
const safety = await import(process.env.C2C_WRITE_MODULE);
safety.replaceFile(process.env.C2C_WRITE_PATH, process.env.C2C_WRITE_CONTENT,
  process.env.C2C_WRITE_HASH, { workspaceId: process.env.C2C_WRITE_WORKSPACE });
process.exit(0);
`;
  const result = childProcess.spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      C2C_CRASH_MODE: mode,
      C2C_WRITE_MODULE: pathToFileURL(path.resolve("src/write/safety.ts")).href,
      C2C_WRITE_PATH: filePath,
      C2C_WRITE_CONTENT: content,
      C2C_WRITE_HASH: expectedHash,
      C2C_WRITE_WORKSPACE: workspaceId,
    },
  });
  if (result.error) throw result.error;
  return result.status;
}

beforeEach(() => {
  // Keep all fixtures and audit output under a unique operating-system temp dir.
  // These tests intentionally do not recursively delete directories.
  root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-write-safety-"));
  workspaceId = `write-test-${path.basename(root)}`;
  vi.stubEnv("C2C_STATE_DIR", path.join(root, "state"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("write safety primitives", () => {
  it("deletes one matching regular file and audits both its old hash and absence", () => {
    const target = writeFixture("delete.txt", "delete fixture");
    const expectedHash = hashFile(target);
    expect(deleteFile(target, expectedHash, { workspaceId })).toEqual({
      path: target, oldHash: expectedHash, newHash: null,
    });
    expect(fs.existsSync(target)).toBe(false);
    const audit = JSON.parse(fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim());
    expect(audit).toMatchObject({ operation: "delete", oldHash: expectedHash, newHash: null, success: true });
  });

  it("refuses stale deletion, missing files, directories and missing hashes", () => {
    const target = writeFixture("stale-delete.txt", "original");
    const expectedHash = hashFile(target);
    fs.writeFileSync(target, "newer");
    expectCode(() => deleteFile(target, expectedHash, { workspaceId }), "STALE_FILE");
    expect(fs.readFileSync(target, "utf8")).toBe("newer");
    expectCode(() => deleteFile(root, expectedHash, { workspaceId }), "NOT_A_FILE");
    expectCode(() => deleteFile(testPath("missing.txt"), expectedHash, { workspaceId }), "FILE_NOT_FOUND");
    expectCode(() => deleteFile(target, undefined as unknown as string), "INVALID_ARGUMENT");
  });

  it("creates and audits one directory, rejecting existing targets and missing parents", () => {
    const target = testPath("explicit-dir");
    expect(createDirectory(target, { workspaceId })).toEqual({ path: target, oldHash: null, newHash: null });
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expectCode(() => createDirectory(target, { workspaceId }), "FILE_ALREADY_EXISTS");
    expectCode(() => createDirectory(testPath("absent/child"), { workspaceId }), "WRITE_FAILED");
    const audits = fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim().split("\n").map(JSON.parse);
    expect(audits[0]).toMatchObject({ operation: "create_directory", success: true });
    expect(audits[1]).toMatchObject({ success: false, errorCode: "FILE_ALREADY_EXISTS" });
  });

  it("produces a stable SHA-256 content hash", () => {
    const filePath = writeFixture("stable.txt", "stable bytes\n");
    const expected = createHash("sha256").update("stable bytes\n").digest("hex");
    expect(hashFile(filePath)).toBe(expected);
    expect(hashFile(filePath)).toBe(hashFile(filePath));
  });

  it("creates a new file and returns its hash", () => {
    const filePath = testPath("created.txt");
    const result = createFile(filePath, "created content", { workspaceId });
    expect(fs.readFileSync(filePath, "utf8")).toBe("created content");
    expect(result.oldHash).toBeNull();
    expect(result.newHash).toBe(hashFile(filePath));
  });

  it("refuses create when the destination already exists", () => {
    const filePath = writeFixture("existing.txt", "keep me");
    expectCode(() => createFile(filePath, "overwrite", { workspaceId }), "FILE_ALREADY_EXISTS");
    expect(fs.readFileSync(filePath, "utf8")).toBe("keep me");
    const audit = fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit.at(-1)).toMatchObject({
      timestamp: expect.any(String),
      operation: "create",
      path: filePath,
      oldHash: hashFile(filePath),
      newHash: null,
      success: false,
      errorCode: "FILE_ALREADY_EXISTS",
    });
    expect(JSON.stringify(audit.at(-1))).not.toContain("keep me");
  });

  it("updates an existing file and returns old and new hashes", () => {
    const filePath = writeFixture("update.txt", "before");
    const oldHash = hashFile(filePath);
    const result = replaceFile(filePath, "after", oldHash, { workspaceId });
    expect(fs.readFileSync(filePath, "utf8")).toBe("after");
    expect(result.oldHash).toBe(oldHash);
    expect(result.newHash).toBe(hashFile(filePath));
    expect(result.newHash).not.toBe(oldHash);
  });

  it.skipIf(process.platform !== "win32")("uses one Windows replacement helper for replace and edit", () => {
    const filePath = writeFixture("windows-replace-edit.txt", "before text");
    const oldHash = hashFile(filePath);
    const helperSpy = vi.spyOn(childProcess, "spawnSync");
    try {
      const replaced = replaceFile(filePath, "after text", oldHash, { workspaceId });
      expect(replaced.newHash).toBe(hashFile(filePath));
      expect(fs.readFileSync(filePath, "utf8")).toBe("after text");
      const snapshot = readFileForWrite(filePath);
      const edited = editText(filePath, "after", "edited", snapshot.contentHash, { workspaceId });
      expect(edited.newHash).toBe(hashFile(filePath));
      expect(fs.readFileSync(filePath, "utf8")).toBe("edited text");
      expect(helperSpy.mock.calls.filter(([, args]) => args?.includes("--atomic-replace"))).toHaveLength(2);
    } finally {
      helperSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("rejects a stale hash before staging a Windows replacement", () => {
    const filePath = writeFixture("retry-stale.txt", "before");
    const oldHash = hashFile(filePath);
    fs.writeFileSync(filePath, "external update", "utf8");
    let caught: unknown;
    try { replaceFile(filePath, "replacement", oldHash, { workspaceId }); }
    catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: "STALE_FILE", details: { expectedHash: oldHash, currentHash: hashFile(filePath) } });
    expect(fs.readFileSync(filePath, "utf8")).toBe("external update");
    expect(fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("revalidates an ordinary editor change after temp preparation and audits STALE_FILE", () => {
    const filePath = writeFixture("editor-race.txt", "before");
    const expectedHash = hashFile(filePath);
    const originalOpen = fs.openSync.bind(fs);
    let changed = false;
    const openSpy = vi.spyOn(fs, "openSync");
    openSpy.mockImplementation((...args) => {
      const fd = originalOpen(...args);
      if (!changed && String(args[0]).includes(".c2c-")) {
        fs.writeFileSync(filePath, "external editor update", "utf8");
        changed = true;
      }
      return fd;
    });
    const helperSpy = vi.spyOn(childProcess, "spawnSync");
    try {
      let caught: unknown;
      try { replaceFile(filePath, "replacement", expectedHash, { workspaceId }); }
      catch (error) { caught = error; }
      expect(changed).toBe(true);
      expect(caught).toMatchObject({
        code: "STALE_FILE",
        details: { stage: "final-validation", currentHash: hashFile(filePath), operationApplied: false },
      });
      expect(helperSpy.mock.calls.filter(([, args]) => args?.includes("--atomic-replace"))).toHaveLength(1);
      expect(fs.readFileSync(filePath, "utf8")).toBe("external editor update");
      expect(fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp"))).toEqual([]);
      const audit = JSON.parse(fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim());
      expect(audit).toMatchObject({ success: false, errorCode: "STALE_FILE", stage: "final-validation" });
    } finally {
      openSpy.mockRestore();
      helperSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("does not replace a read-only Windows target", () => {
    const filePath = writeFixture("read-only.txt", "before");
    fs.chmodSync(filePath, 0o444);
    const expectedHash = hashFile(filePath);
    try {
      let caught: unknown;
      try {
        replaceFile(filePath, "replacement", expectedHash, { workspaceId });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "WRITE_FAILED",
        details: { stage: "preflight-readonly", systemCode: "EACCES", readOnly: true },
      });
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
    } finally {
      fs.chmodSync(filePath, 0o666);
    }
  });

  it.skipIf(process.platform !== "win32")("preserves the existing Windows DACL during atomic replacement", () => {
    const filePath = writeFixture("explicit-dacl.txt", "before");
    const aclScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:C2C_ACL_TARGET
if ($env:C2C_ACL_SETUP -eq '1') {
  $acl = Get-Acl -LiteralPath $target
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new('NT AUTHORITY\SYSTEM', [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
  Set-Acl -LiteralPath $target -AclObject $acl
}
[Console]::Out.WriteLine((Get-Acl -LiteralPath $target).Sddl)
`;
    const before = runFixedPowerShell(aclScript, { C2C_ACL_TARGET: filePath, C2C_ACL_SETUP: "1" });
    try {
      const expectedHash = hashFile(filePath);
      const result = replaceFile(filePath, "after", expectedHash, { workspaceId });
      const after = runFixedPowerShell(aclScript, { C2C_ACL_TARGET: filePath, C2C_ACL_SETUP: "0" });
      expect(result.newHash).toBe(hashFile(filePath));
      expect(after).toBe(before);
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it.skipIf(process.platform !== "win32")("preserves target basic attributes and creation time while updating last-write time", () => {
    const filePath = writeFixture("atomic-basic-metadata.txt", "before");
    const metadataScript = [
      "$ErrorActionPreference = 'Stop'",
      "$target = $env:C2C_METADATA_TARGET",
      "if ($env:C2C_METADATA_SETUP -eq '1') {",
      "  [IO.File]::SetAttributes($target, [IO.FileAttributes]::Archive -bor [IO.FileAttributes]::Hidden -bor [IO.FileAttributes]::NotContentIndexed)",
      "  [IO.File]::SetCreationTimeUtc($target, [DateTime]::new(2019, 2, 3, 4, 5, 6, [DateTimeKind]::Utc))",
      "  [IO.File]::SetLastWriteTimeUtc($target, [DateTime]::new(2018, 2, 3, 4, 5, 6, [DateTimeKind]::Utc))",
      "}",
      "$item = Get-Item -Force -LiteralPath $target",
      "[Console]::Out.WriteLine('{0}|{1}|{2}', [int]$item.Attributes, $item.CreationTimeUtc.ToString('o'), $item.LastWriteTimeUtc.ToString('o'))",
    ].join("\n");
    const before = runFixedPowerShell(metadataScript, { C2C_METADATA_TARGET: filePath, C2C_METADATA_SETUP: "1" });
    try {
      const result = replaceFile(filePath, "after", hashFile(filePath), { workspaceId });
      const after = runFixedPowerShell(metadataScript, { C2C_METADATA_TARGET: filePath, C2C_METADATA_SETUP: "0" });
      const [beforeAttributes, beforeCreationTime, beforeLastWriteTime] = before.split("|");
      const [afterAttributes, afterCreationTime, afterLastWriteTime] = after.split("|");
      expect(result.newHash).toBe(hashFile(filePath));
      expect(afterAttributes).toBe(beforeAttributes);
      expect(afterCreationTime).toBe(beforeCreationTime);
      expect(afterLastWriteTime).not.toBe(beforeLastWriteTime);
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
    } finally {
      runFixedPowerShell("$ErrorActionPreference = 'Stop'; [IO.File]::SetAttributes($env:C2C_METADATA_TARGET, [IO.FileAttributes]::Normal)", {
        C2C_METADATA_TARGET: filePath,
      });
      fs.unlinkSync(filePath);
    }
  });

  it.skipIf(process.platform !== "win32")("preserves existing alternate data streams during atomic replacement", () => {
    const filePath = writeFixture("atomic-streams.txt", "before");
    const streamPath = filePath + ":c2c-atomic-test";
    const streamContent = Buffer.from("retain this alternate stream", "utf8");
    fs.writeFileSync(streamPath, streamContent);
    try {
      const result = replaceFile(filePath, "after", hashFile(filePath), { workspaceId });
      expect(result.newHash).toBe(hashFile(filePath));
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
      expect(fs.readFileSync(streamPath)).toEqual(streamContent);
    } finally {
      fs.unlinkSync(filePath);
    }
  });

  it.skipIf(process.platform !== "win32")("does not bypass a Windows ACL denial or alter the denied target", () => {
    const filePath = writeFixture("acl-denied.txt", "before");
    const setupScript = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:C2C_ACL_TARGET
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::ReadAndExecute, [Security.AccessControl.AccessControlType]::Allow))
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new('NT AUTHORITY\SYSTEM', [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
Set-Acl -LiteralPath $target -AclObject $acl
[Console]::Out.WriteLine((Get-Acl -LiteralPath $target).Sddl)
`;
    const aclBefore = runFixedPowerShell(setupScript, { C2C_ACL_TARGET: filePath });
    const resetAcl = String.raw`$ErrorActionPreference = 'Stop'; icacls.exe $env:C2C_ACL_TARGET /reset | Out-Null`;
    try {
      const expectedHash = hashFile(filePath);
      let caught: unknown;
      try { replaceFile(filePath, "replacement", expectedHash, { workspaceId }); }
      catch (error) { caught = error; }
      const aclAfter = runFixedPowerShell("[Console]::Out.WriteLine((Get-Acl -LiteralPath $env:C2C_ACL_TARGET).Sddl)", { C2C_ACL_TARGET: filePath });
      expect(caught).toMatchObject({ code: "WRITE_FAILED", details: { systemCode: "EACCES", operationApplied: false } });
      expect(aclAfter).toBe(aclBefore);
      expect(fs.readFileSync(filePath, "utf8")).toBe("before");
    } finally {
      runFixedPowerShell(resetAcl, { C2C_ACL_TARGET: filePath });
      fs.unlinkSync(filePath);
    }
  });

  it.skipIf(process.platform !== "win32")("launches one Windows replacement helper and publishes the new bytes", () => {
    const filePath = writeFixture("windows-helper-once.txt", "before");
    const expectedHash = hashFile(filePath);
    const helperSpy = vi.spyOn(childProcess, "spawnSync");
    try {
      expect(replaceFile(filePath, "after", expectedHash, { workspaceId }).newHash)
        .toBe(createHash("sha256").update("after").digest("hex"));
      expect(helperSpy.mock.calls.filter(([, args]) => args?.includes("--atomic-replace"))).toHaveLength(1);
      expect(fs.readFileSync(filePath, "utf8")).toBe("after");
      expect(fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp"))).toEqual([]);
    } finally {
      helperSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("leaves the original intact after a process exits during temp writing", () => {
    const filePath = writeFixture("crash-partial.txt", "complete old bytes");
    const expectedHash = hashFile(filePath);
    const newContent = "complete new bytes";
    const status = runCrashChild("partial-temp", filePath, newContent, expectedHash);
    const leftovers = fs.readdirSync(root).filter((name) => name.startsWith(".crash-partial.txt.c2c-") && name.endsWith(".tmp"));
    try {
      expect(status).toBe(86);
      expect(fs.readFileSync(filePath, "utf8")).toBe("complete old bytes");
      expect(leftovers).toHaveLength(1);
      expect(leftovers[0]).toMatch(/^\.crash-partial\.txt\.c2c-\d+-[0-9a-f-]+\.tmp$/i);
      expect(fs.statSync(path.join(root, leftovers[0]!)).size).toBe(Math.floor(Buffer.byteLength(newContent) / 2));
    } finally {
      for (const leftover of leftovers) fs.unlinkSync(path.join(root, leftover));
    }
  });

  it.skipIf(process.platform !== "win32")("leaves the original intact if a process exits after temp flush and before publication", () => {
    const filePath = writeFixture("crash-complete.txt", "complete old bytes");
    const expectedHash = hashFile(filePath);
    const newContent = "complete new bytes";
    const status = runCrashChild("complete-temp", filePath, newContent, expectedHash);
    const leftovers = fs.readdirSync(root).filter((name) => name.startsWith(".crash-complete.txt.c2c-") && name.endsWith(".tmp"));
    try {
      expect(status).toBe(87);
      expect(fs.readFileSync(filePath, "utf8")).toBe("complete old bytes");
      expect(leftovers).toHaveLength(1);
      expect(fs.readFileSync(path.join(root, leftovers[0]!), "utf8")).toBe(newContent);
    } finally {
      for (const leftover of leftovers) fs.unlinkSync(path.join(root, leftover));
    }
  });

  it.skipIf(process.platform !== "win32")("leaves a complete new file if the process exits after publication before audit", () => {
    const filePath = writeFixture("crash-after-publication.txt", "complete old bytes");
    const expectedHash = hashFile(filePath);
    const status = runCrashChild("after-publication", filePath, "complete new bytes", expectedHash);
    expect(status).toBe(88);
    expect(fs.readFileSync(filePath, "utf8")).toBe("complete new bytes");
    expect(fs.existsSync(getWriteAuditPath(workspaceId))).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".crash-after-publication.txt.c2c-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("lets independent readers observe only complete old or new bytes across 100 replacements", async () => {
    const replacementCount = 100;
    const oldContent = "A".repeat(5 * 1024 * 1024);
    const newContent = "B".repeat(5 * 1024 * 1024);
    const filePath = writeFixture("atomic-visibility.txt", oldContent);
    const readerScript = [
      "const fs = require('node:fs');",
      "const file = process.argv[1];",
      "const length = Number(process.env.C2C_READER_SIZE);",
      "const oldValue = Buffer.alloc(length, process.env.C2C_READER_OLD_CHAR.charCodeAt(0));",
      "const newValue = Buffer.alloc(length, process.env.C2C_READER_NEW_CHAR.charCodeAt(0));",
      "const report = { reads: 0, oldComplete: 0, newComplete: 0, invalid: { enoent: 0, partialLength: 0, mixedContent: 0, empty: 0, accessDenied: 0, sharingViolation: 0, otherError: 0 }, errorCodes: {}, targetPresentAfterEnoent: 0, samples: [] };",
      "let stop = false;",
      "process.stdin.on('data', () => { stop = true; });",
      "process.stdout.write('READY\\n');",
      "function sample() {",
      "  if (stop) { process.stdout.write('DONE:' + JSON.stringify(report) + '\\n'); process.exit(0); }",
      "  try {",
      "    const value = fs.readFileSync(file); report.reads++;",
      "    if (value.length === 0) report.invalid.empty++;",
      "    else if (value.length !== length) report.invalid.partialLength++;",
      "    else if (value.equals(oldValue)) report.oldComplete++;",
      "    else if (value.equals(newValue)) report.newComplete++;",
      "    else report.invalid.mixedContent++;",
      "  } catch (error) {",
      "    const code = String(error && error.code || 'UNKNOWN');",
      "    report.errorCodes[code] = (report.errorCodes[code] || 0) + 1;",
      "    if (code === 'ENOENT' || code === 'ENOTDIR') report.invalid.enoent++;",
      "    else if (code === 'EACCES' || code === 'EPERM') report.invalid.accessDenied++;",
      "    else if (code === 'EBUSY' || code === 'EAGAIN') report.invalid.sharingViolation++;",
      "    else report.invalid.otherError++;",
      "    if (code === 'ENOENT' && fs.existsSync(file)) report.targetPresentAfterEnoent++;",
      "    if (report.samples.length < 16) report.samples.push({ code, errno: error && error.errno, syscall: error && error.syscall });",
      "  }",
      "  setImmediate(sample);",
      "}",
      "sample();",
    ].join("\n");
    const reader = childProcess.spawn(process.execPath, ["-e", readerScript, filePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: { ...process.env, C2C_READER_SIZE: String(Buffer.byteLength(oldContent)), C2C_READER_OLD_CHAR: "A", C2C_READER_NEW_CHAR: "B" },
    });
    let stdout = "";
    let stderr = "";
    reader.stdout?.setEncoding("utf8");
    reader.stderr?.setEncoding("utf8");
    reader.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    reader.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      reader.once("error", reject);
      reader.once("exit", (code) => resolve(code));
    });
    let completedReplacements = 0;
    let currentHash = hashFile(filePath);
    let nextContent = newContent;
    let replacementFailure: Record<string, unknown> | undefined;
    try {
      while (!stdout.includes("READY\n")) await new Promise((resolve) => setTimeout(resolve, 10));
      for (; completedReplacements < replacementCount; completedReplacements++) {
        const result = replaceFile(filePath, nextContent, currentHash, { workspaceId });
        currentHash = result.newHash;
        nextContent = nextContent === newContent ? oldContent : newContent;
      }
    } catch (error) {
      replacementFailure = error instanceof Error
        ? {
          name: error.name,
          code: (error as NodeJS.ErrnoException).code,
          message: error.message,
          ...(error instanceof WriteSafetyError ? { details: error.details } : {}),
        }
        : { value: String(error) };
    } finally {
      reader.stdin?.end("stop");
    }
    const code = await exitPromise;
    const done = stdout.split(/\r?\n/).find((line) => line.startsWith("DONE:"));
    const report = done ? JSON.parse(done.slice("DONE:".length)) as {
      reads: number;
      oldComplete: number;
      newComplete: number;
      invalid: Record<string, number>;
      errorCodes: Record<string, number>;
      targetPresentAfterEnoent: number;
      samples: Array<{ code: string; errno?: number; syscall?: string }>;
    } : undefined;
    const evidence = {
      replacementApi: "SetFileInformationByHandle(FileRenameInfoEx), flags 0x3",
      readerApi: "independent child process fs.readFileSync",
      completedReplacements,
      requestedReplacements: replacementCount,
      oldSizeBytes: Buffer.byteLength(oldContent),
      newSizeBytes: Buffer.byteLength(newContent),
      oldHash: createHash("sha256").update(oldContent).digest("hex"),
      newHash: createHash("sha256").update(newContent).digest("hex"),
      targetExists: fs.existsSync(filePath),
      finalHash: fs.existsSync(filePath) ? hashFile(filePath) : null,
      finalBytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : null,
      replacementFailure,
      reader: report,
    };
    expect(code, JSON.stringify(evidence)).toBe(0);
    expect(stderr, JSON.stringify(evidence)).toBe("");
    expect(report, JSON.stringify(evidence)).toBeDefined();
    expect(report?.reads, JSON.stringify(evidence)).toBeGreaterThan(0);
    expect(completedReplacements, JSON.stringify(evidence)).toBe(replacementCount);
    expect(replacementFailure, JSON.stringify(evidence)).toBeUndefined();
    const invalidCount = Object.values(report?.invalid ?? {}).reduce((total, count) => total + count, 0);
    expect(invalidCount, JSON.stringify(evidence)).toBe(0);
    expect(fs.readFileSync(filePath, "utf8")).toBe(oldContent);
    expect(hashFile(filePath)).toBe(currentHash);
  });
  it.skipIf(process.platform !== "win32")("rejects a rename/swap completed before final publication validation", () => {
    const filePath = writeFixture("rename-swap-destination.txt", "A: checked destination\n");
    const sparePath = writeFixture("rename-swap-spare.txt", "B: spare source\n");
    const replacementPath = writeFixture("rename-swap-replacement.txt", fs.readFileSync(sparePath));
    const backupPath = testPath("rename-swap-moved-A.txt");
    const expectedHash = hashFile(filePath);
    const identityA = fs.statSync(filePath, { bigint: true });
    let swapped = false;
    const originalOpen = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync");
    openSpy.mockImplementation((...args) => {
      const fd = originalOpen(...args);
      if (!swapped && String(args[0]).includes(".c2c-")) {
        fs.renameSync(filePath, backupPath);
        fs.renameSync(replacementPath, filePath);
        swapped = true;
      }
      return fd;
    });
    const helperSpy = vi.spyOn(childProcess, "spawnSync");
    let replaceError: unknown;
    try { replaceFile(filePath, "approved replacement\n", expectedHash, { workspaceId }); }
    catch (error) { replaceError = error; }
    const nativeHelperCalls = helperSpy.mock.calls.filter(([, args]) => args?.includes("--atomic-replace"));
    openSpy.mockRestore();
    helperSpy.mockRestore();

    const identityB = fs.statSync(filePath, { bigint: true });
    const identityBackup = fs.statSync(backupPath, { bigint: true });
    const audit = JSON.parse(fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim()) as Record<string, unknown>;
    const evidence = {
      expectedHash,
      replaceError: replaceError instanceof Error ? { code: (replaceError as WriteSafetyError).code, details: (replaceError as WriteSafetyError).details } : String(replaceError),
      nativeHelperLaunches: nativeHelperCalls.length,
      finalDestination: fs.readFileSync(filePath, "utf8"),
      finalBackup: fs.readFileSync(backupPath, "utf8"),
      finalReplacementExists: fs.existsSync(replacementPath),
      tempFiles: fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp")),
      audit,
    };
    console.info(`[rename-swap-final-validation] ${JSON.stringify(evidence)}`);

    expect(swapped).toBe(true);
    expect(replaceError).toMatchObject({ code: "STALE_FILE", details: { stage: "final-validation", currentHash: hashFile(filePath) } });
    expect(nativeHelperCalls).toHaveLength(1);
    expect(identityB.ino).not.toBe(identityA.ino);
    expect(identityBackup.ino).toBe(identityA.ino);
    expect(fs.readFileSync(filePath, "utf8")).toBe("B: spare source\n");
    expect(fs.readFileSync(backupPath, "utf8")).toBe("A: checked destination\n");
    expect(fs.existsSync(replacementPath)).toBe(false);
    expect(evidence.tempFiles).toEqual([]);
    expect(audit).toMatchObject({ operation: "replace", oldHash: expectedHash, success: false, errorCode: "STALE_FILE", stage: "final-validation" });
  });

  it.skipIf(process.platform !== "win32")("fails closed when an ordinary delete occurs after temp creation", () => {
    const filePath = writeFixture("delete-before-publication.txt", "before");
    const expectedHash = hashFile(filePath);
    const originalOpen = fs.openSync.bind(fs);
    let deleted = false;
    const openSpy = vi.spyOn(fs, "openSync");
    openSpy.mockImplementation((...args) => {
      const fd = originalOpen(...args);
      if (!deleted && String(args[0]).includes(".c2c-")) {
        fs.unlinkSync(filePath);
        deleted = true;
      }
      return fd;
    });
    try {
      let caught: unknown;
      try { replaceFile(filePath, "replacement", expectedHash, { workspaceId }); }
      catch (error) { caught = error; }
      expect(deleted).toBe(true);
      expect(caught).toMatchObject({ code: "WRITE_FAILED", details: { systemCode: "ENOENT", operationApplied: false } });
      expect(fs.existsSync(filePath)).toBe(false);
      expect(fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp"))).toEqual([]);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("reports a failed temporary-file cleanup without changing the target", () => {
    const filePath = writeFixture("cleanup-failure.txt", "before");
    const originalUnlink = fs.unlinkSync.bind(fs);
    const originalOpen = fs.openSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");
    const openSpy = vi.spyOn(fs, "openSync");
    let tempPath: string | undefined;
    let changed = false;
    openSpy.mockImplementation((...args) => {
      const fd = originalOpen(...args);
      if (!changed && String(args[0]).includes(".c2c-")) {
        fs.writeFileSync(filePath, "external update", "utf8");
        changed = true;
      }
      return fd;
    });
    unlinkSpy.mockImplementation((target) => {
      const candidate = path.resolve(String(target));
      if (path.dirname(candidate) === path.resolve(root) && path.basename(candidate).includes(".c2c-") && candidate.endsWith(".tmp")) {
        tempPath = candidate;
        const error = new Error("simulated temp cleanup denial") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalUnlink(target);
    });

    try {
      const expectedHash = hashFile(filePath);
      let caught: unknown;
      try {
        replaceFile(filePath, "replacement", expectedHash, { workspaceId });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "STALE_FILE",
        details: {
          stage: "final-validation",
          currentHash: hashFile(filePath),
          temporaryCleanupCode: "EACCES",
          temporaryFile: expect.any(String),
          temporaryFileLeftover: true,
        },
      });
      expect(changed).toBe(true);
      expect(fs.readFileSync(filePath, "utf8")).toBe("external update");
      expect(tempPath).toBeDefined();
      expect(fs.existsSync(tempPath!)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
      openSpy.mockRestore();
      if (tempPath && fs.existsSync(tempPath)) originalUnlink(tempPath);
    }
  });

  it("rejects an update when the file is stale", () => {
    const filePath = writeFixture("stale.txt", "current");
    const wrongHash = createHash("sha256").update("older").digest("hex");
    expectCode(() => replaceFile(filePath, "replacement", wrongHash, { workspaceId }), "STALE_FILE");
    expect(fs.readFileSync(filePath, "utf8")).toBe("current");
  });

  it("rejects update when the target does not exist", () => {
    const missing = testPath("missing.txt");
    const expectedHash = createHash("sha256").update("anything").digest("hex");
    expectCode(() => replaceFile(missing, "replacement", expectedHash, { workspaceId }), "FILE_NOT_FOUND");
  });

  it("caps replace/edit source files at 10 MiB to bound edit memory", () => {
    const filePath = testPath("over-edit-limit.txt");
    const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
    fs.writeFileSync(filePath, bytes);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    expectCode(() => replaceFile(filePath, "small replacement", expectedHash, { workspaceId }), "FILE_TOO_LARGE");
    expectCode(() => editText(filePath, "a", "b", expectedHash, { workspaceId }), "FILE_TOO_LARGE");
    expect(fs.statSync(filePath).size).toBe(bytes.length);
    expect(fs.readdirSync(root).filter((name) => name.includes(".c2c-") && name.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("measures each Windows replace stage at 1 KiB, 100 KiB, 1 MiB and 5 MiB", () => {
    const sizes = [1024, 100 * 1024, 1024 * 1024, 5 * 1024 * 1024];
    const stages = [
      "preflightMs", "oldHashMs", "newHashMs", "tempWriteMs", "flushMs",
      "finalValidationMs", "atomicReplaceMs", "postVerificationMs", "totalMs",
    ] as const;
    const report = sizes.map((sizeBytes) => {
      const filePath = testPath("performance-" + sizeBytes + ".txt");
      const current = Buffer.alloc(sizeBytes, 0x41);
      fs.writeFileSync(filePath, current);
      let expectedHash = createHash("sha256").update(current).digest("hex");
      const measurements: Record<(typeof stages)[number], number[]> = Object.fromEntries(
        stages.map((stage) => [stage, []]),
      ) as Record<(typeof stages)[number], number[]>;

      for (let run = 0; run < 3; run++) {
        const replacement = Buffer.alloc(sizeBytes, run % 2 === 0 ? 0x42 : 0x41);
        const result = replaceFile(filePath, replacement, expectedHash, { workspaceId });
        expectedHash = result.newHash;
        const records = fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim().split("\n");
        const latest = JSON.parse(records.at(-1)!) as { timingsMs?: Record<string, number> };
        expect(latest.timingsMs).toBeDefined();
        for (const stage of stages) {
          const value = latest.timingsMs?.[stage];
          expect(typeof value).toBe("number");
          expect(Number.isFinite(value)).toBe(true);
          measurements[stage].push(value!);
        }
      }
      expect(hashFile(filePath)).toBe(expectedHash);
      const summary = Object.fromEntries(stages.map((stage) => {
        const sorted = [...measurements[stage]].sort((a, b) => a - b);
        const medianMs = sorted[1]!;
        const maxMs = sorted.at(-1)!;
        return [stage, {
          medianMs: Number(medianMs.toFixed(3)),
          maxMs: Number(maxMs.toFixed(3)),
          slowOutlierMs: maxMs > Math.max(10, medianMs * 2) ? Number(maxMs.toFixed(3)) : null,
        }];
      }));
      return { sizeBytes, runs: 3, stages: summary };
    });
    console.info("[write-performance] " + JSON.stringify(report));
  }, 180_000);

  it("applies a unique text edit with stale-write protection", () => {
    const filePath = writeFixture("edit.txt", "prefix old text suffix");
    const snapshot = readFileForWrite(filePath);
    const result = editText(filePath, "old text", "new text", snapshot.contentHash, { workspaceId });
    expect(fs.readFileSync(filePath, "utf8")).toBe("prefix new text suffix");
    expect(result.oldHash).toBe(snapshot.contentHash);
    expect(result.newHash).toBe(hashFile(filePath));
  });

  it("rejects a text edit when the old text is absent", () => {
    const filePath = writeFixture("missing-text.txt", "present");
    const snapshot = readFileForWrite(filePath);
    expectCode(() => editText(filePath, "absent", "new", snapshot.contentHash, { workspaceId }), "TEXT_NOT_FOUND");
  });

  it("rejects a non-unique text edit by default", () => {
    const filePath = writeFixture("ambiguous.txt", "same and same");
    const snapshot = readFileForWrite(filePath);
    expectCode(() => editText(filePath, "same", "new", snapshot.contentHash, { workspaceId }), "AMBIGUOUS_EDIT");
  });

  it("moves a file and records matching content hashes", () => {
    const source = writeFixture("move-source.txt", "move me");
    const destination = testPath("move-destination.txt");
    const result = moveFile(source, destination, { workspaceId });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(destination, "utf8")).toBe("move me");
    expect(result.source).toBe(source);
    expect(result.destination).toBe(destination);
    expect(result.oldHash).toBe(result.newHash);
    expect(result.newHash).toBe(hashFile(destination));
  });

  it("refuses to move over an existing destination", () => {
    const source = writeFixture("move-source.txt", "source");
    const destination = writeFixture("move-destination.txt", "destination");
    const sourceHash = hashFile(source);
    const destinationHash = hashFile(destination);
    expectCode(() => moveFile(source, destination, { workspaceId }), "DESTINATION_EXISTS");
    expect(fs.readFileSync(source, "utf8")).toBe("source");
    expect(fs.readFileSync(destination, "utf8")).toBe("destination");
    expect(hashFile(source)).toBe(sourceHash);
    expect(hashFile(destination)).toBe(destinationHash);
  });

  it("rejects a move when the source does not exist", () => {
    const source = testPath("missing-move-source.txt");
    const destination = testPath("missing-move-destination.txt");
    expectCode(() => moveFile(source, destination, { workspaceId }), "FILE_NOT_FOUND");
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("rolls back the destination if unlinking the move source fails", () => {
    const source = writeFixture("rollback-source.txt", "keep source");
    const destination = testPath("rollback-destination.txt");
    const sourceHash = hashFile(source);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync");
    unlinkSpy.mockImplementationOnce(() => {
      const error = new Error("simulated source unlink failure") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });

    try {
      let caught: unknown;
      try {
        moveFile(source, destination, { workspaceId });
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        code: "WRITE_FAILED",
        details: { operationApplied: false, systemCode: "EACCES" },
      });
      expect(fs.readFileSync(source, "utf8")).toBe("keep source");
      expect(hashFile(source)).toBe(sourceHash);
      expect(fs.existsSync(destination)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it("appends an audit record with operation and hashes", () => {
    const filePath = testPath("audited.txt");
    const result = createFile(filePath, "audit content", { workspaceId, permissionMode: "1" });
    const audit = fs.readFileSync(getWriteAuditPath(workspaceId), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      operation: "create",
      path: filePath,
      oldHash: null,
      newHash: result.newHash,
      success: true,
      workspaceId,
      permissionMode: "1",
    });
    expect(audit[0].timestamp).toEqual(expect.any(String));
  });

  it("does not put file contents in the audit log", () => {
    const filePath = testPath("private-body.txt");
    createFile(filePath, "SENTINEL_PRIVATE_BODY", { workspaceId });
    const audit = fs.readFileSync(getWriteAuditPath(workspaceId), "utf8");
    expect(audit).not.toContain("SENTINEL_PRIVATE_BODY");
    expect(audit).toContain(hashFile(filePath));
  });

  it("rejects the second writer that uses the first writer's old hash", () => {
    const filePath = writeFixture("race.txt", "initial");
    const firstRead = readFileForWrite(filePath);
    replaceFile(filePath, "writer A", firstRead.contentHash, { workspaceId });
    expectCode(() => replaceFile(filePath, "writer B", firstRead.contentHash, { workspaceId }), "STALE_FILE");
    expect(fs.readFileSync(filePath, "utf8")).toBe("writer A");
  });

  it.skipIf(process.platform !== "win32")("serializes two Windows C2C processes using the same expected hash", async () => {
    const filePath = writeFixture("concurrent-writers.txt", "");
    fs.writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024, 0x41));
    const expectedHash = hashFile(filePath);
    const barrierPath = testPath("concurrent-writers.start");
    const childScript = String.raw`
import fs from 'node:fs';
const safety = await import(process.env.C2C_WRITE_MODULE);
while (!fs.existsSync(process.env.C2C_WRITE_BARRIER)) await new Promise(resolve => setTimeout(resolve, 2));
try {
  const result = safety.replaceFile(process.env.C2C_WRITE_PATH, process.env.C2C_WRITE_CONTENT,
    process.env.C2C_WRITE_HASH, { workspaceId: process.env.C2C_WRITE_WORKSPACE });
  process.stdout.write(JSON.stringify({ outcome: 'success', newHash: result.newHash }));
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: 'error', code: error?.code, systemCode: error?.details?.systemCode }));
}
`;
    const runWriter = (content: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = childProcess.spawn(process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childScript], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            C2C_WRITE_MODULE: pathToFileURL(path.resolve("src/write/safety.ts")).href,
            C2C_WRITE_PATH: filePath,
            C2C_WRITE_CONTENT: content,
            C2C_WRITE_HASH: expectedHash,
            C2C_WRITE_WORKSPACE: workspaceId,
            C2C_WRITE_BARRIER: barrierPath,
          },
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });

    const writers = [runWriter("writer A"), runWriter("writer B")];
    fs.writeFileSync(barrierPath, "go");
    const processes = await Promise.all(writers);
    expect(processes.map(({ code }) => code)).toEqual([0, 0]);
    const outcomes = processes.map(({ stdout, stderr }) => {
      try { return JSON.parse(stdout) as { outcome: string; code?: string; newHash?: string }; }
      catch { throw new Error(`Concurrent writer returned invalid output: ${stdout.slice(0, 400)} ${stderr.slice(0, 400)}`); }
    });
    expect(outcomes.filter(({ outcome }) => outcome === "success")).toHaveLength(1);
    expect(outcomes.filter(({ outcome, code }) => outcome === "error" && code === "STALE_FILE")).toHaveLength(1);
    const winner = outcomes.find(({ outcome }) => outcome === "success")!;
    expect(hashFile(filePath)).toBe(winner.newHash);
  }, 60_000);

  it("reports that a create was applied when its audit record cannot be written", () => {
    const stateBlocker = writeFixture("state-blocker", "not a directory");
    vi.stubEnv("C2C_STATE_DIR", stateBlocker);
    const filePath = testPath("audit-failure-created.txt");

    let caught: unknown;
    try {
      createFile(filePath, "operation applied", { workspaceId });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AUDIT_FAILED",
      details: { operationApplied: true },
    });
    expect(fs.readFileSync(filePath, "utf8")).toBe("operation applied");
  });
});
