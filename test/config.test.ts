import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  ensureGlobalDir,
  ConfigError,
  tenjinHome,
  memoryEnabled,
  vectorEnabled,
} from "../src/config/loader";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tenjin-home-"));
  project = mkdtempSync(join(tmpdir(), "tenjin-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("ensureGlobalDir creates config and SOUL templates once", () => {
  const first = ensureGlobalDir(home);
  expect(first.created).toBe(true);
  const second = ensureGlobalDir(home);
  expect(second.created).toBe(false);
  const cfg = Bun.file(join(home, "config.yaml"));
  const soul = Bun.file(join(home, "SOUL.md"));
  expect(cfg.size).toBeGreaterThan(0);
  expect(soul.size).toBeGreaterThan(0);
});

test("defaults apply when global config is the untouched template", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    'provider: anthropic\nmodel: "claude-sonnet-4-5"\n',
  );
  const { config } = loadConfig(project, home);
  expect(config.provider).toBe("anthropic");
  expect(config.model).toBe("claude-sonnet-4-5");
  expect(config.maxTokens).toBe(8192);
  expect(config.budgetUSD).toBe(5);
});

test("project config overrides global scalars", () => {
  mkdirSync(join(home), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "provider: anthropic\nmodel: a\nmaxTokens: 1000\nbudgetUSD: 2\n",
  );
  mkdirSync(join(project, ".tenjin"));
  writeFileSync(
    join(project, ".tenjin", "config.yaml"),
    "model: b\nbudgetUSD: 9\n",
  );
  const { config, sources } = loadConfig(project, home);
  expect(config.model).toBe("b");
  expect(config.budgetUSD).toBe(9);
  expect(config.maxTokens).toBe(1000);
  expect(config.provider).toBe("anthropic");
  expect(sources.project).toBe(join(project, ".tenjin", "config.yaml"));
});

test("approval maps merge per-key with project winning", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    "model: m\napproval:\n  read: allow\n  bash: ask\n",
  );
  mkdirSync(join(project, ".tenjin"));
  writeFileSync(
    join(project, ".tenjin", "config.yaml"),
    "approval:\n  bash: deny\n",
  );
  const { config } = loadConfig(project, home);
  expect(config.approval.read).toBe("allow");
  expect(config.approval.bash).toBe("deny");
});

test("missing model throws actionable error", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "provider: anthropic\n");
  expect(() => loadConfig(project, home)).toThrow(ConfigError);
  try {
    loadConfig(project, home);
  } catch (e) {
    expect((e as Error).message).toContain("--model");
  }
});

test("invalid provider rejected", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), 'provider: palm\nmodel: x\n');
  expect(() => loadConfig(project, home)).toThrow(/provider must be/);
});

test("invalid yaml surfaces file path", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "model: [unclosed\n");
  expect(() => loadConfig(project, home)).toThrow(/Invalid YAML/);
});

test("empty project config file contributes nothing", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "model: m\n");
  mkdirSync(join(project, ".tenjin"));
  writeFileSync(join(project, ".tenjin", "config.yaml"), "");
  const { config, sources } = loadConfig(project, home);
  expect(config.model).toBe("m");
  expect(sources.project).toBe(join(project, ".tenjin", "config.yaml"));
});

test("tenjinHome respects TENJIN_HOME env", () => {
  const prev = process.env.TENJIN_HOME;
  process.env.TENJIN_HOME = "/tmp/xyz-home";
  expect(tenjinHome()).toBe("/tmp/xyz-home");
  if (prev === undefined) delete process.env.TENJIN_HOME;
  else process.env.TENJIN_HOME = prev;
});

describe("memory flags", () => {
  const cfg = (over: any) => ({
    provider: "anthropic",
    model: "m",
    maxTokens: 8192,
    budgetUSD: 5,
    approval: {},
    ...over,
  });

  test("memory enabled by default, disabled explicitly", () => {
    expect(memoryEnabled(cfg({}))).toBe(true);
    expect(memoryEnabled(cfg({ memory: { enabled: false } }))).toBe(false);
  });

  test("vector follows memory master switch and its own flag", () => {
    expect(vectorEnabled(cfg({}))).toBe(true);
    expect(vectorEnabled(cfg({ memory: { enabled: false } }))).toBe(false);
    expect(vectorEnabled(cfg({ memory: { enabled: true, vector: { enabled: false } } }))).toBe(
      false,
    );
    expect(vectorEnabled(cfg({ memory: { vector: { enabled: true } } }))).toBe(true);
  });
});
