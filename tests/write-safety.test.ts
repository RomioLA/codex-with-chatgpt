import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
