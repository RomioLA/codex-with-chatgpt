import type { ExecutionKind, PackageManager, OutputStream } from "./job-types.js";

const REQUEST_MAGIC = Buffer.from([0x43, 0x32, 0x43, 0x4a, 0x4f, 0x42, 0x31, 0x00]); // C2CJOB1\0
const RESPONSE_MAGIC = Buffer.from([0x43, 0x32, 0x43, 0x4f, 0x55, 0x54, 0x31, 0x00]); // C2COUT1\0
export const HELPER_CANCEL_BYTE = 0x01;
export const MAX_HELPER_STRING_BYTES = 128 * 1024;
export const MAX_HELPER_FRAME_BYTES = 64 * 1024;

const KIND_CODE: Record<ExecutionKind, number> = {
  test: 1,
  build: 2,
  lint: 3,
  typecheck: 4,
  package_script: 5,
};

const MANAGER_CODE: Record<PackageManager, number> = { npm: 1, pnpm: 2 };

export interface HelperRequest {
  packageManager: PackageManager;
  kind: ExecutionKind;
  timeoutSeconds: number;
  cwd: string;
  nodeExecutable: string;
  managerCli: string;
  target: string;
  jobTempDir: string;
}

export interface HelperResultFrame {
  outcome: 0 | 1 | 2 | 3;
  exitCode: number;
  win32Error: number;
}

export type HelperFrame =
  | { type: "stdout"; data: Buffer }
  | { type: "stderr"; data: Buffer }
  | { type: "result"; result: HelperResultFrame };

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HELPER_STRING_BYTES) {
    throw new TypeError("Invalid execution helper string length");
  }
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

export function serializeHelperRequest(request: HelperRequest): Buffer {
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 3600) {
    throw new TypeError("Invalid execution timeout");
  }
  if (request.target.length < 1 || request.target.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.target)) {
    throw new TypeError("Invalid execution target");
  }
  const fixed = Buffer.alloc(4);
  fixed.writeUInt16LE(1, 0); // protocol version
  fixed.writeUInt8(1, 2); // fixed package-script recipe
  fixed.writeUInt8(MANAGER_CODE[request.packageManager], 3);
  const tail = Buffer.alloc(8);
  tail.writeUInt8(KIND_CODE[request.kind], 0);
  tail.writeUInt8(0, 1); // reserved
  tail.writeUInt16LE(0, 2); // reserved
  tail.writeUInt32LE(request.timeoutSeconds, 4);
  return Buffer.concat([
    REQUEST_MAGIC,
    fixed,
    tail,
    encodeString(request.cwd),
    encodeString(request.nodeExecutable),
    encodeString(request.managerCli),
    encodeString(request.target),
    encodeString(request.jobTempDir),
  ]);
}

function isPrefix(buffer: Buffer, expected: Buffer): boolean {
  return buffer.length <= expected.length && buffer.equals(expected.subarray(0, buffer.length));
}

function outputStream(type: number): OutputStream | null {
  if (type === 1) return "stdout";
  if (type === 2) return "stderr";
  return null;
}

/** Incremental, bounded decoder for the native helper's framed output. */
export class HelperOutputDecoder {
  private pending = Buffer.alloc(0);
  private headerSeen = false;
  private resultSeen = false;

  push(chunk: Buffer): HelperFrame[] {
    if (this.resultSeen && chunk.byteLength > 0) throw new Error("HELPER_PROTOCOL_TRAILING_DATA");
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: HelperFrame[] = [];
    if (!this.headerSeen) {
      if (!isPrefix(this.pending, RESPONSE_MAGIC)) throw new Error("HELPER_PROTOCOL_BAD_HEADER");
      if (this.pending.byteLength < RESPONSE_MAGIC.byteLength) return frames;
      this.pending = this.pending.subarray(RESPONSE_MAGIC.byteLength);
      this.headerSeen = true;
    }
    while (this.pending.byteLength >= 5) {
      const type = this.pending.readUInt8(0);
      const length = this.pending.readUInt32LE(1);
      if (length > MAX_HELPER_FRAME_BYTES) throw new Error("HELPER_PROTOCOL_FRAME_TOO_LARGE");
      const frameLength = 5 + length;
      if (this.pending.byteLength < frameLength) break;
      const payload = this.pending.subarray(5, frameLength);
      this.pending = this.pending.subarray(frameLength);
      const stream = outputStream(type);
      if (stream) {
        frames.push({ type: stream, data: Buffer.from(payload) });
      } else if (type === 3) {
        if (this.resultSeen || payload.byteLength !== 9) throw new Error("HELPER_PROTOCOL_BAD_RESULT");
        const outcome = payload.readUInt8(0);
        if (outcome > 3) throw new Error("HELPER_PROTOCOL_BAD_RESULT");
        this.resultSeen = true;
        frames.push({
          type: "result",
          result: {
            outcome: outcome as HelperResultFrame["outcome"],
            exitCode: payload.readUInt32LE(1),
            win32Error: payload.readUInt32LE(5),
          },
        });
        if (this.pending.byteLength > 0) throw new Error("HELPER_PROTOCOL_TRAILING_DATA");
      } else {
        throw new Error("HELPER_PROTOCOL_UNKNOWN_FRAME");
      }
    }
    return frames;
  }

  finish(): void {
    if (!this.headerSeen || !this.resultSeen || this.pending.byteLength > 0) {
      throw new Error("HELPER_PROTOCOL_INCOMPLETE");
    }
  }
}
