import { describe, test, expect } from "bun:test";
import {
  ProviderRegistry,
  type ProviderFactory,
  type ProviderContext,
} from "../src/provider/registry";
import { createProvider } from "../src/provider/factory";
import { ConfigError } from "../src/config/types";
import type { HarnessConfig } from "../src/config/types";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";

const fakeProvider = (name: string): Provider => ({
  name,
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return {
      stopReason: "end_turn",
      content: [{ type: "text", text: name }],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  },
});

describe("ProviderRegistry — registration extension point", () => {
  test("third-party provider is registered and served through the factory mechanism", async () => {
    const reg = new ProviderRegistry();
    let calls = 0;
    let seenCtx: ProviderContext | undefined;
    reg.register({
      name: "acme",
      create(ctx) {
        calls++;
        seenCtx = ctx;
        return fakeProvider("acme");
      },
    });

    const p = reg.get("acme" as never);
    expect(p.name).toBe("acme");
    expect(calls).toBe(1);
    // instance is cached
    expect(reg.get("acme" as never)).toBe(p);
    expect(calls).toBe(1);
    // the factory receives keys/retry context so it can read channels
    expect(seenCtx).toBeDefined();
    expect(seenCtx!.keys).toEqual({});
    expect(await p.chat({ model: "m", system: "s", messages: [], tools: [], maxTokens: 4 })).toMatchObject({
      stopReason: "end_turn",
    });
  });

  test("re-registering a name evicts the cached instance", () => {
    const reg = new ProviderRegistry();
    const mk = (n: string): ProviderFactory => ({
      name: "x",
      create: () => fakeProvider(n),
    });
    reg.register(mk("one"));
    const first = reg.get("x" as never);
    expect(first.name).toBe("one");

    reg.register(mk("two"));
    const second = reg.get("x" as never);
    expect(second.name).toBe("two");
    expect(second).not.toBe(first);
  });

  test("unknown provider name throws a ConfigError instead of returning undefined", () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get("acme" as never)).toThrow(ConfigError);
    try {
      reg.get("acme" as never);
    } catch (e) {
      expect((e as Error).message).toContain("unknown provider");
    }
  });

  test("openai-compatible endpoint (Ollama) boots without an API key when a baseUrl is set", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const reg = new ProviderRegistry("http://localhost:11434/v1");
    expect(() => reg.get("openai")).not.toThrow();
    expect(reg.get("openai").name).toBe("openai");
  });

  test("openai still requires a key when no custom baseUrl is configured", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const reg = new ProviderRegistry();
    expect(() => reg.get("openai")).toThrow(/OPENAI_API_KEY is not set/);
  });

  test("anthropic baseUrl configured on the registry is used for real requests", async () => {
    const reg = new ProviderRegistry(
      undefined,
      { anthropic: "sk-ant" },
      undefined,
      true,
      "https://anthropic-gateway.example/v1",
    );
    delete process.env.ANTHROPIC_BASE_URL;
    let seenUrl = "";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      seenUrl = String(url);
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    try {
      await reg
        .get("anthropic")
        .chat({
          model: "m",
          system: "s",
          messages: [{ role: "user", content: "x" }],
          tools: [],
          maxTokens: 8,
        })
        .catch(() => {});
      expect(seenUrl).toContain("https://anthropic-gateway.example/v1/messages");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("createProvider factory path", () => {
  test("builds an OpenAI-compatible provider from config baseUrl without a key (Ollama/OpenRouter)", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    const config = {
      provider: "openai",
      model: "qwen2.5",
      maxTokens: 512,
      budgetUSD: 1,
      approval: {},
      providers: { openai: { baseUrl: "http://localhost:11434/v1" } },
    } as HarnessConfig;
    const p = createProvider(config);
    expect(p.name).toBe("openai");
  });
});
