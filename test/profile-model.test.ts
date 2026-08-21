import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot, writeBotModel, resolveBot } from "../src/bots/profile";

describe("bot model pinning (#253)", () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("writeBotModel writes config.yaml with the pinned model", () => {
    home = mkdtempSync(join(tmpdir(), "tj-mdl-"));
    createBot(home, "researcher");

    writeBotModel(home, "researcher", "openai:gpt-4o");

    const cfg = readFileSync(join(home, "bots", "researcher", "config.yaml"), "utf8");
    expect(cfg).toContain("model");
    expect(cfg).toContain("openai:gpt-4o");

    const profile = resolveBot(home, "researcher");
    expect(profile.config.model).toBe("openai:gpt-4o");
  });

  test("writeBotModel preserves existing config fields", () => {
    home = mkdtempSync(join(tmpdir(), "tj-mdl2-"));
    createBot(home, "coder");
    const root = join(home, "bots", "coder");
    writeFileSync(join(root, "config.yaml"), "security:\n  policy: read-only\n");

    writeBotModel(home, "coder", "deepseek-chat");

    const profile = resolveBot(home, "coder");
    expect(profile.config.model).toBe("deepseek-chat");
    expect(profile.config.security?.policy).toBe("read-only");
  });

  test("writeBotModel rejects an unknown bot or blank model", () => {
    home = mkdtempSync(join(tmpdir(), "tj-mdl3-"));
    createBot(home, "writer");
    expect(() => writeBotModel(home, "ghost", "x")).toThrow(/unknown bot/);
    expect(() => writeBotModel(home, "writer", "   ")).toThrow(/model must be/);
  });
});
