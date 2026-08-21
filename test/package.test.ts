import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botsDir, createBot, listBots, resolveBot } from "../src/bots/profile";
import { exportBot, importBot } from "../src/bots/package";
import { ConfigError } from "../src/config/types";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-pkg-"));
  cwd = mkdtempSync(join(tmpdir(), "tj-pkg-cwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

// Helper: build a bot with config + a skill + runtime dirs + a secret-like file.
function buildRichBot(name = "porter"): void {
  createBot(home, name, { soul: `# SOUL — ${name}\n\nI carry things.\n` });
  const root = join(botsDir(home), name);
  writeFileSync(join(root, "config.yaml"), "model: \"openai:gpt-4o-mini\"\nbudgetUSD: 2\n");
  // a bundled skill folder (portable content)
  mkdirSync(join(root, "skills", "pocket"), { recursive: true });
  writeFileSync(join(root, "skills", "pocket", "SKILL.md"), "---\nname: pocket\ndescription: small.\n---\ncarry\n");
  // runtime state that must NOT be exported
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "sessions", "s1.json"), "secret-session");
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "facts.json"), "secret-memory");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "msg.json"), "secret-inbox");
  // runtime task state (user prompts / results) must NOT be exported
  mkdirSync(join(root, "tasks"), { recursive: true });
  writeFileSync(join(root, "tasks", "t1.json"), "secret-task");
  // runtime refine proposals next to a bundled skill must NOT be exported
  mkdirSync(join(root, "skills", "pocket", "refine"), { recursive: true });
  writeFileSync(join(root, "skills", "pocket", "refine", "VERSION-1.md"), "# proposal secret-refine");
}

describe("bot export", () => {
  test("produces a tar.gz and manifests included files", () => {
    buildRichBot();
    const { file, manifest } = exportBot(home, "porter", { cwd });
    expect(existsSync(file)).toBe(true);
    // runtime dirs excluded from manifest
    expect(manifest.some((f) => f.includes("sessions"))).toBe(false);
    expect(manifest.some((f) => f.includes("memory"))).toBe(false);
    expect(manifest.some((f) => f.includes("inbox"))).toBe(false);
    expect(manifest.some((f) => f.includes("tasks"))).toBe(false);
    expect(manifest.some((f) => f.includes("refine"))).toBe(false);
    // portable content included
    expect(manifest).toContain("SOUL.md");
    expect(manifest).toContain("config.yaml");
    expect(manifest.some((f) => f.startsWith("skills/"))).toBe(true);
  });

  test("archive does not leak runtime secret bytes", () => {
    buildRichBot();
    const { file } = exportBot(home, "porter", { cwd });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("secret-session");
    expect(raw).not.toContain("secret-memory");
    expect(raw).not.toContain("secret-inbox");
    expect(raw).not.toContain("secret-task");
    expect(raw).not.toContain("secret-refine");
  });

  test("unknown bot throws ConfigError", () => {
    expect(() => exportBot(home, "ghost", { cwd })).toThrow(ConfigError);
  });
});

describe("bot import", () => {
  test("roundtrip export->import produces a functional bot", () => {
    buildRichBot();
    const { file, name } = exportBot(home, "porter", { cwd });

    // import into a HOME WITHOUT the bot
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg2-"));
    try {
      const res = importBot(home2, file);
      expect(res.name).toBe("porter");
      expect(listBots(home2)).toEqual(["porter"]);
      const profile = resolveBot(home2, "porter");
      expect(profile.soulText).toContain("I carry things.");
      // config carried over & valid
      expect(profile.config.model).toBe("openai:gpt-4o-mini");
      expect(profile.config.budgetUSD).toBe(2);
      // bundled skill present
      expect(existsSync(join(botsDir(home2), "porter", "skills", "pocket", "SKILL.md"))).toBe(true);
      // runtime dirs were NOT restored (they are not part of the package)
      expect(existsSync(join(botsDir(home2), "porter", "sessions"))).toBe(false);
      expect(existsSync(join(botsDir(home2), "porter", "memory"))).toBe(false);
      expect(existsSync(join(botsDir(home2), "porter", "inbox"))).toBe(false);
      expect(existsSync(join(botsDir(home2), "porter", "tasks"))).toBe(false);
      // the bundled skill's SKILL.md imports, but its runtime refine proposal does not
      expect(existsSync(join(botsDir(home2), "porter", "skills", "pocket", "SKILL.md"))).toBe(true);
      expect(existsSync(join(botsDir(home2), "porter", "skills", "pocket", "refine"))).toBe(false);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("name collision gets a suffix instead of overwriting", () => {
    buildRichBot();
    const { file, name } = exportBot(home, "porter", { cwd });
    // bot already exists in this home
    const res = importBot(home, file);
    expect(res.name).not.toBe(name);
    expect(res.name).toMatch(new RegExp(`^${name}-\\d+$`));
    expect(listBots(home)).toContain(res.name);
    // original untouched
    expect(resolveBot(home, name).soulText).toContain("I carry things.");
  });

  test("import validates config and rejects invalid bots", () => {
    createBot(home, "broken");
    writeFileSync(join(botsDir(home), "broken", "config.yaml"), "model: \"nope:model\"\n");
    const { file } = exportBot(home, "broken", { cwd });
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg3-"));
    try {
      expect(() => importBot(home2, file)).toThrow(ConfigError);
      // failed import must not leave a half-created bot
      expect(listBots(home2)).toEqual([]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("import shows what will be created", () => {
    buildRichBot();
    const { file } = exportBot(home, "porter", { cwd });
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg4-"));
    try {
      const res = importBot(home2, file);
      expect(res.files.length).toBeGreaterThan(0);
      expect(res.files).toContain("SOUL.md");
      expect(res.files).toContain("config.yaml");
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("malformed archive throws ConfigError", () => {
    const bad = join(cwd, "bad.tar.gz");
    writeFileSync(bad, "this is not a tarball");
    expect(() => importBot(home, bad)).toThrow();
  });
});

// Build a bot whose config.yaml is exactly `configYaml`, then export a package.
function buildBotWithConfig(name: string, configYaml: string): void {
  createBot(home, name);
  writeFileSync(join(botsDir(home), name, "config.yaml"), configYaml);
}

describe("bot import security warnings (#205)", () => {
  const validModel = 'model: "openai:gpt-4o-mini"\n';

  test("a package that disables the security guard surfaces a warning", () => {
    buildBotWithConfig("frank", validModel + "security:\n  disabled: true\n");
    const { file } = exportBot(home, "frank", { cwd });
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg-sec-"));
    try {
      const res = importBot(home2, file);
      expect(res.securityNote).toBeTruthy();
      expect(res.securityNote).toMatch(/DISABLES.*security guard/i);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("a package that drops default guard globs from blockedPatterns surfaces a warning", () => {
    buildBotWithConfig("frank", validModel + "security:\n  blockedPatterns:\n    - .env\n");
    const { file } = exportBot(home, "frank", { cwd });
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg-sec2-"));
    try {
      const res = importBot(home2, file);
      expect(res.securityNote).toBeTruthy();
      expect(res.securityNote).toMatch(/blockedPatterns/i);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });

  test("a normal package carries no security warning", () => {
    buildBotWithConfig("safe", validModel);
    const { file } = exportBot(home, "safe", { cwd });
    const home2 = mkdtempSync(join(tmpdir(), "tj-pkg-sec3-"));
    try {
      const res = importBot(home2, file);
      expect(res.securityNote).toBeUndefined();
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});
