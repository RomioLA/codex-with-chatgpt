import { createHash } from "node:crypto";
import fs from "node:fs";
import { TextDecoder } from "node:util";
import { WorkspaceError } from "./manager.js";

const MAX_FILE_BYTES = 1024 * 1024;

/** Only call with a freshly canonicalized, permission-approved external path. */
export function readExternalText(filePath: string, offset: number, limit: number) {
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new WorkspaceError("FILE_NOT_FOUND", "External file does not exist.");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    const named = fs.lstatSync(filePath);
    if (!stat.isFile() || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) {
      throw new WorkspaceError("NOT_A_FILE", "A stable regular file is required.");
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", "External text files are capped at 1 MiB.");
    }
    // A fixed buffer also bounds files that grow after fstat. Never read the original model path.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_FILE_BYTES) {
      throw new WorkspaceError("FILE_TOO_LARGE", "External text files are capped at 1 MiB.");
    }
    const bytes = buffer.subarray(0, size);
    let text: string;
    try {
      if (bytes.includes(0)) throw new Error("NUL byte");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new WorkspaceError("BINARY_FILE", "Only UTF-8 text files can be returned.");
    }
    const end = Math.min(text.length, offset + limit);
    return {
      path: filePath, sizeBytes: size,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      offset, totalCharacters: text.length, content: text.slice(offset, end),
      hasMore: end < text.length, nextOffset: end < text.length ? end : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}
