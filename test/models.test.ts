import { describe, test, expect, afterEach } from "bun:test";
import {
  resolveModelRef,
  defaultModelRef,
  cheapModelRef,
  formatModelRef,
} from "../src/config/models";
import { ProviderRegistry } from "../src/provider/registry";
import { ConfigError } from "../src/config/types";
import type { HarnessConfig } from "../src/config/types";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 8192,
  budgetUSD: 5,
  approval: {},
  ...over,
});

describe("resolveModelRef", () => {
  test("bare string inherits fallback provider", () => {
    expect(resolveModelRef("gpt-4o-mini", "openai")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(resolveModelRef("claude-haiku", "anthropic")).toEqual({
      provider: "anthropic",
      model: "claude-haiku",
    });
  });

  test("provider prefix crosses providers", () => {
    expect(resolveModelRef("openai:gpt-4o-mini", "anthropic")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
    expect(resolveModelRef("anthropic:claude-opus-4", "openai")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4",
    });
  });

  test("whitespace is tolerated", () => {
    expect(resolveModelRef("  openai: gpt-4o  ", "anthropic").model).toBe("gpt-4o");
  });

  test("unknown provider rejected with supported list", () => {
    expect(() => resolveModelRef("palm:gemini", "anthropic")).toThrow(
      ConfigError,
    );
    try {
      resolveModelRef("palm:gemini", "anthropic");
    } catch (e) {
      expect((e as Error).message).toContain("anthropic:, openai:");
    }
  });

  test("missing model after colon rejected", () => {
    expect(() => resolveModelRef("openai:", "anthropic")).toThrow(/missing model/);
  });

  test("model ids containing colons stay whole (OpenRouter :free, Ollama tags)", () => {
    // Unprefixed ids whose colon is part of the model name must NOT be parsed
    // as a provider prefix — they resolve under the fallback provider.
    expect(resolveModelRef("deepseek/deepseek-chat-v3.1:free", "openai")).toEqual({
      provider: "openai",
      model: "deepseek/deepseek-chat-v3.1:free",
    });
    expect(resolveModelRef("llama3.1:latest", "openai")).toEqual({
      provider: "openai",
      model: "llama3.1:latest",
    });
    expect(resolveModelRef("meta-llama/llama-3.3-70b-instruct", "openai")).toEqual({
      provider: "openai",
      model: "meta-llama/llama-3.3-70b-instruct",
    });
  });

  test("empty ref rejected", () => {
    expect(() => resolveModelRef("", "anthropic")).toThrow(/empty/);
    expect(() => resolveModelRef("   ", "anthropic")).toThrow(/empty/);
  });
});

describe("tier resolution", () => {
  test("default falls back to provider+model fields", () => {
    expect(defaultModelRef(cfg())).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
  });

  test("models.default overrides the legacy fields", () => {
    const c = cfg({ models: { default: "openai:gpt-4o" } });
    expect(defaultModelRef(c)).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  test("cheap returns null when unset or blank", () => {
    expect(cheapModelRef(cfg())).toBeNull();
    expect(cheapModelRef(cfg({ models: { cheap: "" } }))).toBeNull();
  });

  test("cheap resolves when set", () => {
    const c = cfg({ models: { cheap: "openai:gpt-4o-mini" } });
    expect(cheapModelRef(c)).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  test("formatModelRef round-trips", () => {
    expect(formatModelRef({ provider: "openai", model: "gpt-4o" })).toBe(
      "openai:gpt-4o",
    );
  });
});

describe("ProviderRegistry", () => {
  const saved = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  afterEach(() => {
    if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
  });

  test("missing key throws at get() time naming the tier need", () => {
    delete process.env.ANTHROPIC_API_KEY;
    const reg = new ProviderRegistry();
    expect(() => reg.get("anthropic")).toThrow(/ANTHROPIC_API_KEY is not set.*tier/s);
  });

  test("lazy: unused provider never demands its key", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    delete process.env.OPENAI_API_KEY;
    const reg = new ProviderRegistry();
    expect(reg.get("anthropic").name).toBe("anthropic");
  });

  test("instances are cached per provider", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    const reg = new ProviderRegistry();
    expect(reg.get("anthropic")).toBe(reg.get("anthropic"));
    expect(reg.get("openai")).toBe(reg.get("openai"));
    expect(reg.get("anthropic")).not.toBe(reg.get("openai"));
  });

  test("registry passes configured openai baseUrl", async () => {
    process.env.OPENAI_API_KEY = "k";
    delete process.env.OPENAI_BASE_URL;
    let calledUrl = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      calledUrl = String(url);
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      const reg = new ProviderRegistry("http://custom-base/v1");
      await reg
        .get("openai")
        .chat({
          model: "m",
          system: "s",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          maxTokens: 16,
        })
        .catch(() => {});
      expect(calledUrl).toContain("http://custom-base/v1/chat/completions");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
