import fs from "node:fs";

/** Windows can briefly retain a replaced directory entry. Retry only that
 * transient failure, at most 100ms; never unlink the destination or downgrade
 * an authorization failure to success. Callers keep their transaction locks. */
export function atomicReplace(source: string, destination: string): void {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(source, destination); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 10 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
