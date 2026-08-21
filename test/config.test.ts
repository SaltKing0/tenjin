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
  memorySummariesOnSessionEnd,
  vectorEnabled,
  providersFile,
  writeProvidersYaml,
  type LoadedConfig,
  CONFIG_SCHEMA_VERSION,
  migrateConfig,
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

test("fresh config template is stamped with the current schema version", () => {
  ensureGlobalDir(home);
  const raw = readFileSync(join(home, "config.yaml"), "utf8");
  expect(raw).toContain(`version: ${CONFIG_SCHEMA_VERSION}`);
});

test("fresh config template includes a commented gateway block to enable the web console (#250)", () => {
  ensureGlobalDir(home);
  const raw = readFileSync(join(home, "config.yaml"), "utf8");
  // a new user must be able to discover + enable the console by uncommenting
  expect(raw).toContain("# gateway:");
  expect(raw).toContain("listen:");
});

test("config schema: unversioned legacy config loads as current", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), 'provider: anthropic\nmodel: "m"\n');
  const { config } = loadConfig(project, home);
  expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
});

test("config schema: older explicit version is migrated silently to current", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `version: 0\nprovider: anthropic\nmodel: "m"\nmaxTokens: 4096\n`,
  );
  const { config } = loadConfig(project, home);
  expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
  expect(config.maxTokens).toBe(4096);
});

test("config schema: newer version than supported is clearly rejected", () => {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `version: ${CONFIG_SCHEMA_VERSION + 1}\nprovider: anthropic\nmodel: "m"\n`,
  );
  expect(() => loadConfig(project, home)).toThrow(/newer than this build supports/);
});

test("migrateConfig runs the migration chain in version order", () => {
  const seen: number[] = [];
  const steps: Array<(cfg: Record<string, unknown>) => void> = [
    (c) => {
      seen.push(1);
      c.a = "one";
    },
    (c) => {
      seen.push(2);
      c.b = "two";
    },
    (c) => {
      seen.push(3);
      c.c = "three";
    },
  ];
  const cfg: Record<string, unknown> = {};
  const { applied } = migrateConfig(cfg, 0, 3, steps);
  expect(applied).toBe(3);
  expect(seen).toEqual([1, 2, 3]);
  expect(cfg.a).toBe("one");
  expect(cfg.b).toBe("two");
  expect(cfg.c).toBe("three");
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

  test("memory.learnings.maxEntries is a known field", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\nmemory:\n  learnings:\n    maxEntries: 50\n",
    );
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: unknown) => warns.push(String(msg));
    let parsed: LoadedConfig | undefined;
    try {
      parsed = loadConfig(project, home);
    } finally {
      console.warn = originalWarn;
    }
    expect(parsed?.config.memory?.learnings?.maxEntries).toBe(50);
    expect(warns.some((w) => w.includes("memory.learnings.maxEntries"))).toBe(false);
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

  test("anthropic caching flag is accepted and defaults on when unset", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "providers.yaml"),
      "providers:\n  anthropic:\n    caching: false\n",
    );
    const { config } = loadConfig(project, home, { skipModelCheck: true });
    expect(config.providers?.anthropic?.caching).toBe(false);
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

  test("writeProvidersYaml emits block style and round-trips nested providers (#8)", () => {
    writeProvidersYaml(home, {
      providers: {
        openai: { baseUrl: "https://gateway.example.com/v1", apiKey: "ktest-openai-111" },
        anthropic: { apiKey: "ktest-anthropic-222" },
      },
      models: { default: "openai:gpt-4o-mini" },
      extra: {
        provider: "openai",
        model: "gpt-4o-mini",
        pricing: { default: { inputPerMTok: 1, outputPerMTok: 2 } },
      },
    });
    const raw = readFileSync(providersFile(home), "utf8");
    // Block style: nested mapping keys each on their own indented line.
    expect(raw).toContain("providers:");
    expect(raw).toContain("  openai:");
    expect(raw).toContain("    baseUrl:");
    expect(raw).toContain("    apiKey: ktest-openai-111");
    // Not Bun's flow style — no inline `{...}` mapping on one line.
    expect(raw).not.toContain("{");
    // Round-trip: the nested openai block survives a load unchanged.
    const { config } = loadConfig(project, home);
    expect(config.providers?.openai?.baseUrl).toBe("https://gateway.example.com/v1");
    expect(config.providers?.openai?.apiKey).toBe("ktest-openai-111");
    expect(config.providers?.anthropic?.apiKey).toBe("ktest-anthropic-222");
    expect(config.models?.default).toBe("openai:gpt-4o-mini");
    expect((config.pricing?.default as { inputPerMTok?: number })?.inputPerMTok).toBe(1);
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

describe("memorySummariesOnSessionEnd (#37)", () => {
  test("off by default (opt-in)", () => {
    expect(memorySummariesOnSessionEnd({})).toBe(false);
    expect(memorySummariesOnSessionEnd({ memory: { enabled: true } })).toBe(false);
  });

  test("on only when explicitly enabled and memory stays on", () => {
    expect(
      memorySummariesOnSessionEnd({
        memory: { enabled: true, summaries: { onSessionEnd: true } },
      }),
    ).toBe(true);
    expect(
      memorySummariesOnSessionEnd({
        memory: { enabled: false, summaries: { onSessionEnd: true } },
      }),
    ).toBe(false);
    expect(
      memorySummariesOnSessionEnd({
        memory: { enabled: true, summaries: { onSessionEnd: false } },
      }),
    ).toBe(false);
  });

  test("parses summaries.onSessionEnd from config.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      "model: m\nmemory:\n  enabled: true\n  summaries:\n    onSessionEnd: true\n",
    );
    const { config } = loadConfig(project, home);
    expect(config.memory?.summaries?.onSessionEnd).toBe(true);
    expect(memorySummariesOnSessionEnd(config)).toBe(true);
  });
});

describe("context config (#101)", () => {
  test("loads context settings from config.yaml", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.yaml"),
      [
        "model: m",
        "context:",
        "  enabled: true",
        "  thresholdRatio: 0.5",
        "  defaultWindow: 4000",
        "  windows:",
        "    my-model: 2000",
        "",
      ].join("\n"),
    );
    const { config } = loadConfig(project, home);
    expect(config.context).toEqual({
      enabled: true,
      thresholdRatio: 0.5,
      defaultWindow: 4000,
      windows: { "my-model": 2000 },
    });
  });

  test("rejects thresholdRatio outside (0,1]", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\ncontext:\n  thresholdRatio: 1.5\n");
    expect(() => loadConfig(project, home)).toThrow(/context\.thresholdRatio/);
  });

  test("rejects non-positive defaultWindow", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\ncontext:\n  defaultWindow: 0\n");
    expect(() => loadConfig(project, home)).toThrow(/context\.defaultWindow/);
  });

  test("rejects invalid per-model window tokens", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "model: m\ncontext:\n  windows:\n    m: -5\n");
    expect(() => loadConfig(project, home)).toThrow(/context\.windows\.m/);
  });
});
