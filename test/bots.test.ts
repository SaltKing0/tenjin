import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botBudgetUSD,
  botModelRef,
  botsDir,
  createBot,
  listBots,
  resolveBot,
} from "../src/bots/profile";
import { ConfigError, type HarnessConfig } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-bot-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const globalCfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 8192,
  budgetUSD: 5,
  approval: {},
  ...over,
});

test("createBot scaffolds SOUL and listBots discovers it", () => {
  const dir = createBot(home, "Researcher");
  expect(dir).toBe(join(botsDir(home), "researcher"));
  expect(listBots(home)).toEqual(["researcher"]);

  const profile = resolveBot(home, "researcher");
  expect(profile.name).toBe("researcher");
  expect(profile.soulText).toContain("**researcher**");
  expect(profile.sessionsDir).toContain("sessions");
  expect(profile.memoryDir).toContain("memory");
  expect(profile.inboxDir).toContain("inbox");
});

test("name is sanitized on create", () => {
  createBot(home, "My Cool Bot");
  expect(listBots(home)).toEqual(["my-cool-bot"]);
});

test("duplicate create throws", () => {
  createBot(home, "writer");
  expect(() => createBot(home, "writer")).toThrow(/already exists/);
});

test("custom soul is respected", () => {
  createBot(home, "poet", { soul: "I write verses." });
  expect(resolveBot(home, "poet").soulText).toBe("I write verses.");
});

test("unknown bot error lists available bots", () => {
  createBot(home, "alpha");
  try {
    resolveBot(home, "ghost");
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    expect((e as Error).message).toContain("alpha");
  }
});

test("unknown bot with empty roster hints creation", () => {
  try {
    resolveBot(home, "ghost");
    throw new Error("should have thrown");
  } catch (e) {
    expect((e as Error).message).toContain("tenjin bot new");
  }
});

test("bot config.yaml parses with model pin and budget", () => {
  createBot(home, "pinned");
  writeFileSync(
    join(botsDir(home), "pinned", "config.yaml"),
    'model: "openai:gpt-4o-mini"\nbudgetUSD: 2\n',
  );
  const profile = resolveBot(home, "pinned");
  expect(botModelRef(profile, globalCfg())).toEqual({
    provider: "openai",
    model: "gpt-4o-mini",
  });
  expect(botBudgetUSD(profile, 5)).toBe(2);
});

test("model falls back to global default when unpinned", () => {
  createBot(home, "plain");
  const profile = resolveBot(home, "plain");
  expect(botModelRef(profile, globalCfg())).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
  });
  expect(botBudgetUSD(profile, 5)).toBe(5);
});

test("invalid model ref in bot config rejected at resolve time", () => {
  createBot(home, "badref");
  writeFileSync(join(botsDir(home), "badref", "config.yaml"), 'model: "nope:model"\n');
  expect(() => resolveBot(home, "badref")).toThrow(/unknown provider/);
});

test("invalid budget rejected", () => {
  createBot(home, "badbudget");
  writeFileSync(join(botsDir(home), "badbudget", "config.yaml"), "budgetUSD: -3\n");
  expect(() => resolveBot(home, "badbudget")).toThrow(/budgetUSD/);
});

test("invalid yaml in bot config surfaces path", () => {
  createBot(home, "broken");
  writeFileSync(join(botsDir(home), "broken", "config.yaml"), "model: [unclosed\n");
  expect(() => resolveBot(home, "broken")).toThrow(/invalid YAML.*config\.yaml/s);
});

test("directories without SOUL.md are not bots", () => {
  mkdirSync(join(botsDir(home), "notabot"), { recursive: true });
  expect(listBots(home)).toEqual([]);
});

test("bot config.yaml parses per-bot security + telegram allowlist", () => {
  createBot(home, "locked");
  writeFileSync(
    join(botsDir(home), "locked", "config.yaml"),
    [
      "security:",
      "  policy: read-only",
      "  blockedPatterns:",
      "    - secrets/*",
      "  denyTools:",
      "    - bash",
      "telegram:",
      "  allowedUsers: [42, 99]",
      "",
    ].join("\n"),
  );
  const profile = resolveBot(home, "locked");
  expect(profile.config.security).toEqual({
    policy: "read-only",
    blockedPatterns: ["secrets/*"],
    denyTools: ["bash"],
  });
  expect(profile.config.telegram).toEqual({ allowedUsers: [42, 99] });
});

test("invalid bot security.policy is rejected", () => {
  createBot(home, "badpol");
  writeFileSync(join(botsDir(home), "badpol", "config.yaml"), "security:\n  policy: write-all\n");
  expect(() => resolveBot(home, "badpol")).toThrow(/policy/);
});

test("bot config.yaml parses routines and per-bot heartbeat (#102)", () => {
  createBot(home, "night");
  writeFileSync(
    join(botsDir(home), "night", "config.yaml"),
    [
      "routines:",
      "  - name: digest",
      "    prompt: Summarize overnight activity.",
      "    cron: \"0 2 * * *\"",
      "    policy: full",
      "    timeoutMs: 120000",
      "  - name: ping",
      "    prompt: Ping.",
      "    every: 30m",
      "heartbeat:",
      "  every: 15m",
      "",
    ].join("\n"),
  );
  const profile = resolveBot(home, "night");
  expect(profile.config.routines).toHaveLength(2);
  expect(profile.config.routines?.[0]).toMatchObject({
    name: "digest",
    prompt: "Summarize overnight activity.",
    policy: "full",
    timeoutMs: 120000,
    scheduleSpec: { cron: "0 2 * * *" },
  });
  expect(profile.config.routines?.[1]?.scheduleSpec.every).toBe("30m");
  expect(profile.config.heartbeat).toEqual({ every: "15m" });
});

test("bot routine requires exactly one of every|cron", () => {
  createBot(home, "noop");
  writeFileSync(
    join(botsDir(home), "noop", "config.yaml"),
    "routines:\n  - name: x\n    prompt: p\n",
  );
  expect(() => resolveBot(home, "noop")).toThrow(/exactly one of `every` or `cron`/);
});

test("bot routine rejects invalid schedule", () => {
  createBot(home, "badsched");
  writeFileSync(
    join(botsDir(home), "badsched", "config.yaml"),
    "routines:\n  - name: x\n    prompt: p\n    every: nope\n",
  );
  expect(() => resolveBot(home, "badsched")).toThrow(/invalid interval/);
});

test("bot routine rejects a non-policy value", () => {
  createBot(home, "badpol2");
  writeFileSync(
    join(botsDir(home), "badpol2", "config.yaml"),
    "routines:\n  - name: x\n    prompt: p\n    every: 1m\n    policy: admin\n",
  );
  expect(() => resolveBot(home, "badpol2")).toThrow(/policy/);
});

test("bot routine rejects duplicate names within one bot", () => {
  createBot(home, "dup");
  writeFileSync(
    join(botsDir(home), "dup", "config.yaml"),
    [
      "routines:",
      "  - name: x",
      "    prompt: p",
      "    every: 1m",
      "  - name: x",
      "    prompt: p2",
      "    every: 2m",
      "",
    ].join("\n"),
  );
  expect(() => resolveBot(home, "dup")).toThrow(/duplicate routine/);
});

test("per-bot heartbeat requires an interval", () => {
  createBot(home, "nohb");
  writeFileSync(
    join(botsDir(home), "nohb", "config.yaml"),
    "heartbeat:\n  bot: x\n",
  );
  expect(() => resolveBot(home, "nohb")).toThrow(/heartbeat.*every/);
});
