import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot } from "../src/bots/profile";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

/**
 * #241: `tenjin forget --all` must also remove a bot's tasks/ and inbox/
 * (the most user-visible content — user prompts + results, and messages),
 * not just sessions/ and memory/.
 */
describe("e2e: tenjin forget data deletion", () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  function runForget(args: string[]): { exitCode: number | null; stdout: string } {
    const proc = Bun.spawnSync(
      ["bun", "run", CLI, "forget", ...args],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, TENJIN_HOME: home },
      },
    );
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
    };
  }

  test("--all wipes sessions, memory, inbox AND tasks; audit lists all areas", () => {
    home = mkdtempSync(join(tmpdir(), "tj-forget-"));
    createBot(home, "researcher");

    // seed runtime state in every area that must be wiped
    for (const area of ["sessions", "memory", "inbox", "tasks"]) {
      mkdirSync(join(home, "bots", "researcher", area), { recursive: true });
      writeFileSync(join(home, "bots", "researcher", area, "payload.txt"), "sensitive");
    }
    // a nested file inside tasks too, to prove recursive removal
    mkdirSync(join(home, "bots", "researcher", "tasks", "nested"), { recursive: true });
    writeFileSync(join(home, "bots", "researcher", "tasks", "nested", "x.json"), "{}");

    const res = runForget(["--bot", "researcher", "--all", "--yes"]);
    expect(res.exitCode).toBe(0);

    const root = join(home, "bots", "researcher");
    for (const area of ["sessions", "memory", "inbox", "tasks"]) {
      expect(existsSync(join(root, area))).toBe(false);
    }
    // SOUL.md must survive
    expect(existsSync(join(root, "SOUL.md"))).toBe(true);

    // audit event lists every deleted area
    const audit = readFileSync(join(home, "audit.jsonl"), "utf8");
    expect(audit).toContain('"kind":"data_delete"');
    for (const area of ["sessions", "memory", "inbox", "tasks"]) {
      expect(audit).toContain(area);
    }
  });

  test("--inbox and --tasks remove only those areas", () => {
    home = mkdtempSync(join(tmpdir(), "tj-forget-"));
    createBot(home, "researcher");
    const root = join(home, "bots", "researcher");
    for (const area of ["sessions", "memory", "inbox", "tasks"]) {
      mkdirSync(join(root, area), { recursive: true });
      writeFileSync(join(root, area, "payload.txt"), "sensitive");
    }

    const res = runForget(["--bot", "researcher", "--inbox", "--tasks", "--yes"]);
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(root, "inbox"))).toBe(false);
    expect(existsSync(join(root, "tasks"))).toBe(false);
    // untouched
    expect(existsSync(join(root, "sessions"))).toBe(true);
    expect(existsSync(join(root, "memory"))).toBe(true);
  });

  test("nothing selected still errors", () => {
    home = mkdtempSync(join(tmpdir(), "tj-forget-"));
    createBot(home, "researcher");
    const res = runForget(["--bot", "researcher", "--yes"]);
    expect(res.exitCode).toBe(2);
  });
});
