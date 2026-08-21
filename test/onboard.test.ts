import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard, type OnboardDeps, ONBOARD_ROLES } from "../src/cli/onboard";
import { loadConfig } from "../src/config/loader";
import { listBots, botDir } from "../src/bots/profile";
import { configYamlPath } from "../src/cli/jobs";

let home: string;
let project: string;
const origHome = process.env.TENJIN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-onb-"));
  project = mkdtempSync(join(tmpdir(), "tj-onb-proj-"));
  process.env.TENJIN_HOME = home;
  // a freshly created tenjin home has a config.yaml but no model set
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), "provider: anthropic\nmodel: \"\"\n");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.TENJIN_HOME;
  else process.env.TENJIN_HOME = origHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

function makeDeps(overrides: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    home,
    // default: a reachable openai provider with a small model list
    testProvider: async () => ({ ok: true, provider: "openai", status: 200 }),
    detectModels: async () => ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    ...overrides,
  };
}

describe("runOnboard — non-interactive flags", () => {
  test("configures provider key, default model, and a bot end-to-end", async () => {
    const deps = makeDeps();
    const result = await runOnboard(
      ["--provider", "openai", "--key", "sk-test-xyz", "--model", "gpt-4o-mini", "--bot-name", "writer"],
      deps,
    );
    expect(result).toBe(0);

    // providers.yaml carries the key + default model
    const cfg = loadConfig(project, home, { skipModelCheck: true }).config;
    expect(cfg.providers?.openai?.apiKey).toBe("sk-test-xyz");
    expect(cfg.model).toBe("gpt-4o-mini");

    // a bot was created with a SOUL.md under the requested name
    expect(listBots(home)).toContain("writer");
    const soul = readFileSync(join(botDir(home, "writer"), "SOUL.md"), "utf8");
    expect(soul.length).toBeGreaterThan(0);

    // config.yaml no longer has an empty model (validate passes without skip)
    expect(() => loadConfig(project, home)).not.toThrow();
  });

  test("idempotent: re-run with the same bot name does not duplicate", async () => {
    const deps = makeDeps();
    await runOnboard(
      ["--provider", "openai", "--key", "sk-test-xyz", "--model", "gpt-4o", "--bot-name", "researcher"],
      deps,
    );
    const before = listBots(home).length;
    const second = await runOnboard(
      ["--provider", "openai", "--key", "sk-test-xyz", "--model", "gpt-4o", "--bot-name", "researcher"],
      deps,
    );
    expect(second).toBe(0);
    expect(listBots(home).length).toBe(before);
  });

  test("fails and writes nothing when the provider key is invalid", async () => {
    const deps = makeDeps({
      testProvider: async () => ({ ok: false, provider: "openai", status: 401, error: "401 invalid" }),
    });
    const code = await runOnboard(
      ["--provider", "openai", "--key", "sk-bad", "--model", "gpt-4o", "--bot-name", "writer"],
      deps,
    );
    expect(code).toBe(1);
    // no key persisted, no bot created
    const cfg = loadConfig(project, home, { skipModelCheck: true }).config;
    expect(cfg.providers?.openai?.apiKey).toBeUndefined();
    expect(listBots(home)).not.toContain("writer");
  });

  test("requires --key when no key is configured yet", async () => {
    const code = await runOnboard(["--provider", "openai", "--model", "gpt-4o"], makeDeps());
    expect(code).toBe(2);
  });

  test("uses a role template's SOUL when --role is given", async () => {
    const deps = makeDeps();
    await runOnboard(
      ["--provider", "openai", "--key", "sk-test-xyz", "--model", "gpt-4o", "--bot-name", "coder", "--role", "coder"],
      deps,
    );
    const soul = readFileSync(join(botDir(home, "coder"), "SOUL.md"), "utf8");
    expect(soul.toLowerCase()).toContain("code");
  });

  test("openrouter implies openai-compatible base and passes :free model ids through", async () => {
    let calledWith: Array<{ provider: string; baseUrl?: string; apiKey?: string }> = [];
    const deps = makeDeps({
      detectModels: async (input: { provider: string; baseUrl?: string; apiKey?: string }) => {
        calledWith.push(input);
        return ["deepseek/deepseek-chat:free", "deepseek/deepseek-chat"];
      },
    });
    // no --model: forces the detect path so we exercise the openrouter base
    await runOnboard(
      ["--provider", "openrouter", "--key", "sk-or", "--bot-name", "researcher"],
      deps,
    );
    // an openai-compatible base is implied for openrouter model listing
    expect(calledWith[0]!.baseUrl).toContain("openrouter");
    // the picked :free model id is stored verbatim without prefix-splitting
    const cfg = loadConfig(project, home, { skipModelCheck: true }).config;
    expect(cfg.model).toBe("deepseek/deepseek-chat:free");
    // openrouter persists as an openai-compatible endpoint (baseUrl), not an
    // unknown providers.openrouter key the config loader would warn about
    expect(cfg.providers?.openai?.baseUrl).toContain("openrouter");
    expect(cfg.providers?.openai?.apiKey).toBe("sk-or");
  });
});

describe("ONBOARD_ROLES", () => {
  test("exposes researcher/coder/writer/social/custom templates", () => {
    for (const r of ["researcher", "coder", "writer", "social", "custom"]) {
      expect(ONBOARD_ROLES).toHaveProperty(r);
    }
    expect(ONBOARD_ROLES.writer!.soul.length).toBeGreaterThan(0);
  });
});
