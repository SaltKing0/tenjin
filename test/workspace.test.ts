import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OpenClaw-style plain-file workspace convention (#459): `tenjin workspace`
 * scaffolds ~/.tenjin/workspace/ with SOUL.md, USER.md, AGENTS.md, MEMORY.md,
 * HEARTBEAT.md and a daily memory/ dir — config + memory as editable files,
 * the same "no black boxes" model OpenClaw and Hermes expose.
 */
const CLI = join(import.meta.dir, "..", "src", "index.ts");
const WORKSPACE_FILES = ["SOUL.md", "USER.md", "AGENTS.md", "MEMORY.md", "HEARTBEAT.md"];

describe("e2e: tenjin workspace (plain-file convention)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tj-ws-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function run(args: string[]): { exitCode: number | null; stdout: string } {
    const proc = Bun.spawnSync(["bun", "run", CLI, ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home },
    });
    return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
  }

  test("init scaffolds the OpenClaw-style workspace files + memory dir", () => {
    const r = run(["workspace", "init"]);
    expect(r.exitCode).toBe(0);
    const dir = join(home, "workspace");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "memory"))).toBe(true);
    for (const f of WORKSPACE_FILES) {
      expect(existsSync(join(dir, f))).toBe(true);
      expect(readFileSync(join(dir, f), "utf8").length).toBeGreaterThan(0);
    }
    // memory/ contains today's daily log
    const today = new Date().toISOString().slice(0, 10);
    expect(existsSync(join(dir, "memory", `${today}.md`))).toBe(true);
    // stdout reports what it created
    expect(r.stdout).toContain("SOUL.md");
  });

  test("init is idempotent — a second run does not overwrite existing files", () => {
    run(["workspace", "init"]);
    const soulPath = join(home, "workspace", "SOUL.md");
    const original = readFileSync(soulPath, "utf8");
    // add a user edit
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").appendFileSync(soulPath, "\n# edited by user\n");
    const r = run(["workspace", "init"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(soulPath, "utf8")).toContain("# edited by user");
  });

  test("init --force overwrites existing files", () => {
    run(["workspace", "init"]);
    const soulPath = join(home, "workspace", "SOUL.md");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("node:fs").writeFileSync(soulPath, "# clobbered");
    run(["workspace", "init", "--force"]);
    expect(readFileSync(soulPath, "utf8")).not.toContain("# clobbered");
  });

  test("bare `workspace` prints a status listing of the files", () => {
    run(["workspace", "init"]);
    const r = run(["workspace"]);
    expect(r.exitCode).toBe(0);
    for (const f of WORKSPACE_FILES) {
      expect(r.stdout).toContain(f);
    }
    expect(r.stdout).toContain("SOUL.md");
  });

  test("bare `workspace` on an uninitialized home lists files as missing", () => {
    const r = run(["workspace"]);
    expect(r.exitCode).toBe(0);
    // still enumerates the convention even when nothing exists yet
    expect(r.stdout).toContain("SOUL.md");
  });
});
