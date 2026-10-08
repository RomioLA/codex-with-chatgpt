import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runMigration(from: string, stateDir: string, localAppData: string, codexHome: string) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, "state", "migrate", "--from", from, "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      C2C_STATE_DIR: stateDir,
      LOCALAPPDATA: localAppData,
      CODEX_HOME: codexHome,
    },
  });
}

describe("state migration CLI failure handling", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
  });

  it("does not create the destination authority or Codex config when the source is missing", () => {
    const stateParent = makeTmpDir("migration-cli-state-missing-source-dest");
    const stateDir = path.join(stateParent, "state");
    const localAppData = makeTmpDir("migration-cli-state-missing-source-local");
    const codexHome = makeTmpDir("migration-cli-state-missing-source-codex");
    const sourceParent = makeTmpDir("migration-cli-state-missing-source");
    dirs.push(stateParent, localAppData, codexHome, sourceParent);
    const configPath = path.join(codexHome, "config.toml");

    const result = runMigration(path.join(sourceParent, "missing"), stateDir, localAppData, codexHome);

    expect(result.status).toBe(1);
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("does not echo malformed auth JSON secrets or mutate destination authorities", () => {
    const stateParent = makeTmpDir("migration-cli-secret-state-dest");
    const stateDir = path.join(stateParent, "state");
    const localAppData = makeTmpDir("migration-cli-secret-local");
    const codexHome = makeTmpDir("migration-cli-secret-codex");
    const sourceDir = makeTmpDir("migration-cli-secret-source");
    dirs.push(stateParent, localAppData, codexHome, sourceDir);

    const sentinel = "C2C_SECRET_SENTINEL_DO_NOT_ECHO_8f47a2";
    write(sourceDir, "auth/0123456789ab.json", `{"clients":[],"tokens":["${sentinel}"`);
    const configPath = path.join(codexHome, "config.toml");

    const result = runMigration(sourceDir, stateDir, localAppData, codexHome);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).not.toContain(sentinel);
    expect(output).toMatch(/json|syntax|auth/i);
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("does not start migration when the read-only sandbox path preflight detects a file conflict", () => {
    const stateParent = makeTmpDir("migration-cli-preflight-state");
    const stateDir = path.join(stateParent, "state");
    const localAppData = makeTmpDir("migration-cli-preflight-local");
    const codexHomeParent = makeTmpDir("migration-cli-preflight-codex");
    const blockingFile = path.join(codexHomeParent, "blocking-file");
    const codexHome = path.join(blockingFile, "codex-home");
    const sourceDir = makeTmpDir("migration-cli-preflight-source");
    dirs.push(stateParent, localAppData, codexHomeParent, sourceDir);

    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, "keep.txt"), "unchanged");
    write(sourceDir, "auth/0123456789ab.json", JSON.stringify({ clients: [], tokens: ["token"] }));
    fs.writeFileSync(blockingFile, "not a directory");

    const result = runMigration(sourceDir, stateDir, localAppData, codexHome);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      status: string;
      error: string;
      sandbox: { ok: boolean; warning: string };
    };

    expect(result.status).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      status: "MIGRATION_NOT_STARTED",
      sandbox: { ok: false },
    });
    expect(payload.error).toMatch(/config directory path includes a non-directory or symbolic link/i);
    expect(payload.sandbox.warning).toBe(payload.error);
    expect(fs.readdirSync(stateDir)).toEqual(["keep.txt"]);
    expect(fs.readFileSync(path.join(stateDir, "keep.txt"), "utf8")).toBe("unchanged");
    expect(fs.existsSync(path.join(stateDir, ".state-migration-v1.json"))).toBe(false);
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
  });

  it("reports a committed migration as success when updating the sandbox allowlist fails", () => {
    const stateParent = makeTmpDir("migration-cli-committed-state");
    const stateDir = path.join(stateParent, "state");
    const localAppData = makeTmpDir("migration-cli-committed-local");
    const codexHome = path.join(stateDir, ".state-migration-v1.json");
    const sourceDir = makeTmpDir("migration-cli-committed-source");
    dirs.push(stateParent, localAppData, sourceDir);

    const relativePath = path.join("auth", "0123456789ab.json");
    write(sourceDir, relativePath, JSON.stringify({ clients: [], tokens: ["token"] }));

    const result = runMigration(sourceDir, stateDir, localAppData, codexHome);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      status: string;
      destinationRoot: string;
      copied: string[];
      alreadyPresent: string[];
      markerPath: string;
      sandbox: { ok: boolean; warning?: string };
    };
    const migratedFile = path.join(stateDir, relativePath);
    const markerPath = path.join(stateDir, ".state-migration-v1.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      version: number;
      files: Array<{ path: string; sha256: string }>;
    };

    expect(result.status).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      status: "MIGRATION_COMMITTED",
      destinationRoot: stateDir,
      copied: [relativePath],
      alreadyPresent: [],
      markerPath,
      sandbox: { ok: false },
    });
    expect(payload.sandbox.warning).toMatch(/could not update the Codex writable root/i);
    expect(JSON.parse(fs.readFileSync(migratedFile, "utf8"))).toEqual({ clients: [], tokens: ["token"] });
    expect(marker.version).toBe(1);
    expect(marker.files.map((entry) => entry.path)).toEqual([...payload.copied, ...payload.alreadyPresent]);
    expect(fs.existsSync(path.join(codexHome, "config.toml"))).toBe(false);
  });
});
