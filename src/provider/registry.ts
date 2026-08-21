import { env } from "node:process";
import type { Provider } from "../provider/types";
import { AnthropicProvider } from "../provider/anthropic";
import { OpenAIProvider } from "../provider/openai";
import type { RetryConfig } from "../config/types";
import { ConfigError } from "../config/types";

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
}

/** Values a provider factory may read to construct its provider instance. */
export interface ProviderContext {
  retry?: RetryConfig;
  /** anthropic/openai API keys sourced from config (may be empty for key-less local endpoints). */
  keys: ProviderKeys;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  anthropicCaching?: boolean;
}

/** A named, registered provider constructor — the extension point for third-party providers. */
export interface ProviderFactory {
  readonly name: string;
  create(ctx: ProviderContext): Provider;
}

const anthropicFactory: ProviderFactory = {
  name: "anthropic",
  create(ctx) {
    const apiKey = ctx.keys.anthropic || env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ConfigError(
        "ANTHROPIC_API_KEY is not set (required by an anthropic model tier). Add it to your environment or .env file.",
      );
    }
    const baseUrl = ctx.anthropicBaseUrl || env.ANTHROPIC_BASE_URL || undefined;
    return baseUrl
      ? new AnthropicProvider(apiKey, baseUrl, ctx.retry, ctx.anthropicCaching)
      : new AnthropicProvider(apiKey, undefined, ctx.retry, ctx.anthropicCaching);
  },
};

const openaiFactory: ProviderFactory = {
  name: "openai",
  create(ctx) {
    const apiKey = ctx.keys.openai || env.OPENAI_API_KEY;
    const baseUrl = ctx.openaiBaseUrl || env.OPENAI_BASE_URL || undefined;
    // An OpenAI-compatible local/self-hosted endpoint (Ollama, LM Studio,
    // OpenRouter) needs only a baseUrl and no API key. Without a custom
    // endpoint the key is mandatory.
    if (!apiKey && !baseUrl) {
      throw new ConfigError(
        "OPENAI_API_KEY is not set (required by an openai model tier). Add it to your environment or .env file.",
      );
    }
    const key = apiKey ?? "";
    return baseUrl
      ? new OpenAIProvider(key, baseUrl, ctx.retry)
      : new OpenAIProvider(key, undefined, ctx.retry);
  },
};

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  private factories = new Map<string, ProviderFactory>();
  private openaiBaseUrl?: string;
  private anthropicBaseUrl?: string;
  private keys: ProviderKeys;
  private retry?: RetryConfig;
  private anthropicCaching: boolean;

  constructor(
    openaiBaseUrl?: string,
    keys: ProviderKeys = {},
    retry?: RetryConfig,
    anthropicCaching = true,
    anthropicBaseUrl?: string,
  ) {
    this.openaiBaseUrl = openaiBaseUrl;
    this.keys = { ...keys };
    this.retry = retry;
    this.anthropicCaching = anthropicCaching;
    this.anthropicBaseUrl = anthropicBaseUrl ?? env.ANTHROPIC_BASE_URL;
    this.register(anthropicFactory);
    this.register(openaiFactory);
  }

  setKeys(keys: ProviderKeys): void {
    this.configure({ keys });
  }

  configure(opts: {
    keys?: ProviderKeys;
    openaiBaseUrl?: string;
    anthropicBaseUrl?: string;
  }): void {
    if (opts.keys) this.keys = { ...this.keys, ...opts.keys };
    if (opts.openaiBaseUrl !== undefined) this.openaiBaseUrl = opts.openaiBaseUrl;
    if (opts.anthropicBaseUrl !== undefined) this.anthropicBaseUrl = opts.anthropicBaseUrl;
    this.cache.clear();
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Register (or re-register) a named provider factory — the third-party
   * extension point. The built-in anthropic/openai factories are registered in
   * the constructor; callers may add their own (Ollama, Bedrock, a test fake,
   * …) under any other name.
   */
  register(factory: ProviderFactory): void {
    this.factories.set(factory.name, factory);
    this.cache.delete(factory.name);
  }

  get(name: string): Provider {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const factory = this.factories.get(name);
    if (!factory) {
      throw new ConfigError(
        `unknown provider "${name}" (registered: ${[...this.factories.keys()].join(", ")})`,
      );
    }
    const created = factory.create(this.context());
    this.cache.set(name, created);
    return created;
  }

  private context(): ProviderContext {
    return {
      keys: this.keys,
      retry: this.retry,
      openaiBaseUrl: this.openaiBaseUrl,
      anthropicBaseUrl: this.anthropicBaseUrl,
      anthropicCaching: this.anthropicCaching,
    };
  }
}
