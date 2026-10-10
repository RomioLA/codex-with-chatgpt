import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExecutionTempOwner } from "../src/execution/execution-temp.js";
import { makeTmpDir } from "./helpers.js";

function jobId(value: string): string {
  return value.padEnd(24, "x").slice(0, 24);
}

describe("ExecutionTempOwner", () => {
  it("removes only a marked job directory under its fixed root", () => {
    const stateDirectory = makeTmpDir("execution-temp-owned");
    const owner = new ExecutionTempOwner(stateDirectory, "temp-owner-test");
    const id = jobId("success");
    const temp = owner.create(id);
    expect(owner.fileIdentity(id)).toMatch(/^[a-f0-9]+:[a-f0-9]+$/i);
    fs.writeFileSync(path.join(temp, "private.npmrc"), "private=true");

    expect(owner.cleanup(id)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
    expect(owner.cleanup("../outside")).toBe(false);
  });

  it("reconciles owned stale temp while preserving an unknown directory", () => {
    const stateDirectory = makeTmpDir("execution-temp-restart");
    const owner = new ExecutionTempOwner(stateDirectory, "temp-restart-test");
    const staleId = jobId("stale");
    const stale = owner.create(staleId);
    const unknownId = jobId("unknown");
    const unknown = path.join(owner.root, `tmp-${unknownId}`);
    fs.mkdirSync(unknown);

    expect(owner.reconcileStaleTemps()).toEqual({ removed: 1, skipped: 1 });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(unknown)).toBe(true);
  });

  it("preserves a reparse job path and its external target", () => {
    const stateDirectory = makeTmpDir("execution-temp-job-junction");
    const owner = new ExecutionTempOwner(stateDirectory, "temp-job-junction-test");
    const external = makeTmpDir("execution-temp-job-junction-target");
    const sentinel = path.join(external, "keep.txt");
    fs.writeFileSync(sentinel, "keep");
    const id = jobId("fake-link");
    const link = path.join(owner.root, `tmp-${id}`);
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");

    expect(owner.cleanup(id)).toBe(false);
    expect(() => owner.fileIdentity(id)).toThrow("TEMP_DIRECTORY_INVALID");
    expect(fs.existsSync(link)).toBe(true);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("does not follow a reparse entry outside an owned temp directory", () => {
    const stateDirectory = makeTmpDir("execution-temp-junction");
    const owner = new ExecutionTempOwner(stateDirectory, "temp-junction-test");
    const id = jobId("junction");
    const temp = owner.create(id);
    const external = makeTmpDir("execution-temp-external");
    const sentinel = path.join(external, "keep.txt");
    fs.writeFileSync(sentinel, "keep");

    const link = path.join(temp, "external");
    fs.symlinkSync(external, link, process.platform === "win32" ? "junction" : "dir");
    expect(owner.cleanup(id)).toBe(true);
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("preserves an unmarked temp root instead of claiming it", () => {
    const stateDirectory = makeTmpDir("execution-temp-unowned-root");
    const root = path.join(stateDirectory, "execution-temp");
    fs.mkdirSync(root);
    const unknown = path.join(root, "keep");
    fs.writeFileSync(unknown, "evidence");

    expect(() => new ExecutionTempOwner(stateDirectory, "unowned-root-test")).toThrow("TEMP_ROOT_UNOWNED");
    expect(fs.readFileSync(unknown, "utf8")).toBe("evidence");
  });
});
