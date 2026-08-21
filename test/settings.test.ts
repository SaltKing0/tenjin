import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSettings, applySettings, detectModels } from "../src/gateway/settings";
import { loadConfig, providersFile } from "../src/config/loader";
import { ProviderRegistry } from "../src/provider/registry";
import type { HarnessConfig } from "../src/config/types";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-set-"));
  project = mkdtempSync(join(tmpdir(), "tj-set-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

function setup() {
  const { config } = loadConfig(project, home, { skipModelCheck: true });
  const registry = new ProviderRegistry();
  const auditLines: string[] = [];
  const deps = {
    home,
    config,
    registry,
    audit: (detail: string) => auditLines.push(detail),
  };
  return { deps, config, registry, auditLines };
}

describe("getSettings", () => {
  test("reports env-sourced keys masked", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-abcdefghijklmnop";
    const { deps } = setup();
    const s = getSettings(deps);
    expect(s.anthropic.configured).toBe(true);
    expect(s.anthropic.source).toBe("env");
    expect(s.anthropic.masked).toContain("…");
    expect(s.anthropic.masked).not.toContain("abcdefghijklm");
  });

  test("unconfigured provider reports none", () => {
    const { deps } = setup();
    const s = getSettings(deps);
    expect(s.anthropic.configured).toBe(false);
    expect(s.anthropic.source).toBe("none");
    expect(s.openai.masked).toBeNull();
  });

  test("never leaks raw keys", () => {
    process.env.OPENAI_API_KEY = "sk-secret-value-123456";
    const { deps } = setup();
    expect(JSON.stringify(getSettings(deps))).not.toContain("sk-secret-value-123456");
  });
});

describe("applySettings", () => {
  test("saves anthropic key to providers.yaml and applies to registry", () => {
    const { deps, config, registry, auditLines } = setup();
    applySettings(deps, { anthropic: { apiKey: "sk-live-key-9876" } });

    const reloaded = loadConfig(project, home, { skipModelCheck: true }).config;
    expect(reloaded.providers?.anthropic?.apiKey).toBe("sk-live-key-9876");

    // registry now serves anthropic without env key
    process.env.ANTHROPIC_API_KEY = "";
    delete process.env.ANTHROPIC_API_KEY;
    expect(registry.get("anthropic").name).toBe("anthropic");
    expect(auditLines.some((l) => l.includes("providers updated"))).toBe(true);
    void config;
  });

  test("openai baseUrl + key stored together", () => {
    const { deps, config } = setup();
    applySettings(deps, {
      openai: { apiKey: "sk-oai", baseUrl: "https://api.deepseek.com/v1" },
    });
    expect(config.providers?.openai?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(config.providers?.openai?.apiKey).toBe("sk-oai");
  });

  test("models.default normalizes to provider:model and syncs legacy fields", () => {
    const { deps, config } = setup();
    applySettings(deps, { models: { default: "claude-sonnet-4-5" } });
    expect(config.models?.default).toBe("anthropic:claude-sonnet-4-5");
    expect(config.model).toBe("claude-sonnet-4-5");
    expect(config.provider).toBe("anthropic");
  });

  test("invalid model ref rejected without writing", () => {
    const { deps, config } = setup();
    expect(() =>
      applySettings(deps, { models: { default: "palm:x" } }),
    ).toThrow(/unknown provider/);
    expect(config.models?.default).toBeUndefined();
  });

  test("clearing cheap tier works", () => {
    const { deps, config } = setup();
    applySettings(deps, { models: { default: "anthropic:m", cheap: "openai:c" } });
    applySettings(deps, { models: { default: "anthropic:m", cheap: "" } });
    expect(config.models?.cheap).toBeUndefined();
  });
});

describe("detectModels", () => {
  test("openai-compatible /models returns sorted ids", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        if (new URL(req.url).pathname !== "/v1/models") return new Response("nf", { status: 404 });
        if (req.headers.get("authorization") !== "Bearer sk-detect") {
          return new Response("bad auth", { status: 401 });
        }
        return Response.json({
          data: [{ id: "z-model" }, { id: "a-model" }, { id: "m-model" }],
        });
      },
    });
    try {
      const models = await detectModels({
        provider: "openai",
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "sk-detect",
      });
      expect(models).toEqual(["a-model", "m-model", "z-model"]);
    } finally {
      server.stop(true);
    }
  });

  test("anthropic uses x-api-key header", async () => {
    let seenKey = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seenKey = req.headers.get("x-api-key") ?? "";
        return Response.json({ data: [{ id: "claude-x" }] });
      },
    });
    try {
      const models = await detectModels({
        provider: "anthropic",
        baseUrl: `http://localhost:${server.port}/v1`,
        apiKey: "sk-ant-test",
      });
      expect(seenKey).toBe("sk-ant-test");
      expect(models).toEqual(["claude-x"]);
    } finally {
      server.stop(true);
    }
  });

  test("upstream error surfaces message", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("denied", { status: 401 }),
    });
    try {
      await expect(
        detectModels({ provider: "openai", baseUrl: `http://localhost:${server.port}/v1`, apiKey: "bad" }),
      ).rejects.toThrow(/401/);
    } finally {
      server.stop(true);
    }
  });
});
