import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { runWindowsQuery, WINDOWS_QUERY_SCRIPT } from "../src/host-observation/windows.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
describe("fixed Windows query transport", () => {
  it("keeps hostile input out of interpreter arguments and source", async () => {
    if (process.platform !== "win32") {
      await expect(runWindowsQuery("metadata", {})).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
      return;
    }
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    let received = "";
    const hostile = "C:\\example'; Invoke-Expression 'fixture-secret'; #";
    vi.mocked(execFile).mockImplementation(((executable: string, args: string[], options: object, callback: Function) => {
      expect(executable).toMatch(/pwsh\.exe$/);
      expect(args.join(" ")).not.toContain(hostile);
      expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(WINDOWS_QUERY_SCRIPT);
      expect(WINDOWS_QUERY_SCRIPT).not.toMatch(/Invoke-Expression|ScriptBlock::Create|\biex\b/);
      return { stdin: { on: () => {}, end: (data: string) => {
        received = data; callback(null, '{"owner":null}', "");
      } } };
    }) as any);
    await expect(runWindowsQuery("metadata", { path: hostile, operation: "malicious" })).resolves.toEqual({ owner: null });
    expect(JSON.parse(received)).toEqual({ path: hostile, operation: "metadata" });
  });
  it("does not reflect sensitive subprocess stderr in errors", async () => {
    if (process.platform !== "win32") {
      await expect(runWindowsQuery("context")).rejects.toMatchObject({ code: "NOT_SUPPORTED" }); return;
    }
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.mocked(execFile).mockImplementation(((_exe: string, _args: string[], _options: object, callback: Function) => {
      return { stdin: { on: () => {}, end: () => callback(Object.assign(new Error("fixture-secret"), { killed: true }), "", "fixture-secret") } };
    }) as any);
    try { await runWindowsQuery("context"); throw new Error("expected rejection"); }
    catch (error) { expect(error).toMatchObject({ code: "TIMEOUT" }); expect(String(error)).not.toContain("fixture-secret"); }
  });
});
