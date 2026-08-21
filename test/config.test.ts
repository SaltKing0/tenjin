import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  ensureGlobalDir,
  ConfigError,
  tenjinHome,
  memoryEnabled,
  vectorEnabled,
  providersFile,
  writeProvidersYaml,
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

describe("iss#67 schema validation", () => {
  test("unknown top-level field warns with file, still loads", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\nbogusField: 1\n");
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      const { config } = loadConfig(project, home);
      expect(config.model).toBe("m");
    } finally {
      console.warn = originalWarn;
    }
    expect(
      warns.some((w) => w.includes("unknown field") && w.includes("bogusField") && w.includes("config.yaml")),
    ).toBe(true);
  });

  test("unknown nested field warns with dotted path", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\nmemory:\n  vector:\n    whatev: 1\n",
    );
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    try {
      loadConfig(project, home);
    } finally {
      console.warn = originalWarn;
    }
    expect(warns.some((w) => w.includes("memory.vector.whatev"))).toBe(true);
  });

  test("wrong scalar type reports file + dotted path + expected/found", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\nmaxTokens: \"many\"\n");
    expect(() => loadConfig(project, home)).toThrow(ConfigError);
    try {
      loadConfig(project, home);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("config.yaml");
      expect(msg).toContain("maxTokens: expected number, found string");
    }
  });

  test("wrong nested type reports dotted path", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\nmemory:\n  enabled: \"yes\"\n",
    );
    expect(() => loadConfig(project, home)).toThrow(/memory\.enabled: expected boolean, found string/);
  });

  test("wrong type in project config attributes to that file", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\n");
    mkdirSync(join(project, ".tenjin"));
    writeFileSync(join(project, ".tenjin", "config.yaml"), "budgetUSD: cheap\n");
    expect(() => loadConfig(project, home)).toThrow(ConfigError);
    try {
      loadConfig(project, home);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(".tenjin");
      expect(msg).toContain("budgetUSD: expected number, found string");
    }
  });

  test("broken yaml reports line for unclosed flow collection", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "ok: 1\nmodel: [unclosed\n");
    expect(() => loadConfig(project, home)).toThrow(ConfigError);
    try {
      loadConfig(project, home);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("Invalid YAML");
      expect(msg).toContain("(line 2)");
      expect(msg).toContain("config.yaml");
    }
  });

  test("broken yaml reports line for unterminated quote", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "ok: 1\nmodel: 'oops\n");
    expect(() => loadConfig(project, home)).toThrow(/\(line 2\)/);
  });

  test("boot exits controlled (code 2, no stack trace) on bad scalar type", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "provider: anthropic\nmodel: m\nmaxTokens: \"many\"\n");
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts")],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, TENJIN_HOME: home } },
    );
    const out = proc.stdout?.toString() ?? "";
    expect(proc.exitCode).toBe(2);
    expect(out).toContain("config error:");
    expect(out).toContain("maxTokens: expected number, found string");
    expect(out).not.toContain("    at "); // no raw stack trace
  });

  test("boot exits controlled on broken yaml with line", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: 'oops\n");
    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts")],
      { cwd: join(import.meta.dir, ".."), env: { ...process.env, TENJIN_HOME: home } },
    );
    const out = proc.stdout?.toString() ?? "";
    expect(proc.exitCode).toBe(2);
    expect(out).toContain("Invalid YAML");
    expect(out).not.toContain("    at ");
  });
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

describe("pricing.default", () => {
  test("loads from providers.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\n");
    writeFileSync(
      join(home, "providers.yaml"),
      "pricing:\n  default:\n    inputPerMTok: 4\n    outputPerMTok: 12\n",
    );
    const { config } = loadConfig(project, home);
    expect(config.pricing?.default).toEqual({ inputPerMTok: 4, outputPerMTok: 12 });
  });

  test("full override still loads from config.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\npricing:\n  inputPerMTok: 3\n  outputPerMTok: 15\n",
    );
    const { config } = loadConfig(project, home);
    expect(config.pricing?.inputPerMTok).toBe(3);
    expect(config.pricing?.outputPerMTok).toBe(15);
  });

  test("rejects incomplete default pair", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\npricing:\n  default:\n    inputPerMTok: 4\n",
    );
    expect(() => loadConfig(project, home)).toThrow(/pricing\.default/);
  });

  test("rejects one-sided override", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\npricing:\n  inputPerMTok: 3\n");
    expect(() => loadConfig(project, home)).toThrow(/both inputPerMTok and outputPerMTok/);
  });
});

describe("providers.yaml (console-managed)", () => {
  test("overrides global config, project still wins", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: from-global\n");
    writeFileSync(
      join(home, "providers.yaml"),
      'models:\n  default: openai:from-managed\n',
    );
    const { config } = loadConfig(project, home);
    expect(config.models?.default).toBe("openai:from-managed");
  });

  test("provider api keys flow through merge", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "providers.yaml"),
      'providers:\n  anthropic:\n    apiKey: "sk-test-123"\n',
    );
    const { config } = loadConfig(project, home, { skipModelCheck: true });
    expect(config.providers?.anthropic?.apiKey).toBe("sk-test-123");
  });

  test("writeProvidersYaml writes 0600 with both sections", () => {
    writeProvidersYaml(home, {
      providers: { anthropic: { apiKey: "sk-live" } },
      models: { default: "anthropic:m" },
    });
    const raw = readFileSync(providersFile(home), "utf8");
    expect(raw).toContain("sk-live");
    expect(raw).toContain("Managed by the Tenjin web console");
    const mode = require("node:fs").statSync(providersFile(home)).mode & 0o777;
    expect(mode).toBe(0o600);
    const { config } = loadConfig(project, home);
    expect(config.providers?.anthropic?.apiKey).toBe("sk-live");
    expect(config.models?.default).toBe("anthropic:m");
  });
});

describe("inbox config", () => {
  test("loads ttlDays and maxMessages from config.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\ninbox:\n  ttlDays: 7\n  maxMessages: 50\n",
    );
    const { config } = loadConfig(project, home);
    expect(config.inbox).toEqual({ ttlDays: 7, maxMessages: 50 });
  });

  test("rejects negative ttlDays and maxMessages", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\ninbox:\n  ttlDays: -1\n");
    expect(() => loadConfig(project, home)).toThrow(/inbox\.ttlDays/);

    writeFileSync(join(home, "config.yaml"), "model: m\ninbox:\n  maxMessages: -5\n");
    expect(() => loadConfig(project, home)).toThrow(/inbox\.maxMessages/);
  });
});

describe("retry config", () => {
  test("loads retry settings from config.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      [
        "model: m",
        "retry:",
        "  enabled: true",
        "  maxAttempts: 5",
        "  initialDelayMs: 250",
        "  maxDelayMs: 4000",
        "  retryableStatuses: [429, 503]",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig(project, home);
    expect(config.retry).toEqual({
      enabled: true,
      maxAttempts: 5,
      initialDelayMs: 250,
      maxDelayMs: 4000,
      retryableStatuses: [429, 503],
    });
  });

  test("rejects maxAttempts below 1", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\nretry:\n  maxAttempts: 0\n");
    expect(() => loadConfig(project, home)).toThrow(/retry\.maxAttempts/);
  });

  test("rejects non-integer status codes in retryableStatuses", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\nretry:\n  retryableStatuses: [500, \"x\"]\n",
    );
    expect(() => loadConfig(project, home)).toThrow(/retry\.retryableStatuses/);
  });
});
