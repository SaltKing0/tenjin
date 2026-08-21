import { env } from "node:process";
import type { Provider } from "../provider/types";
import { AnthropicProvider } from "../provider/anthropic";
import { OpenAIProvider } from "../provider/openai";
import type { RetryConfig } from "../config/types";
import { ConfigError, type ProviderName } from "../config/types";

export interface ProviderKeys {
  anthropic?: string;
  openai?: string;
}

export class ProviderRegistry {
  private cache = new Map<ProviderName, Provider>();
  private keys: ProviderKeys;

  constructor(
    private openaiBaseUrl?: string,
    keys: ProviderKeys = {},
    private retry?: RetryConfig,
    private anthropicCaching = true,
  ) {
    this.keys = { ...keys };
  }

  setKeys(keys: ProviderKeys): void {
    this.configure({ keys });
  }

  configure(opts: { keys?: ProviderKeys; openaiBaseUrl?: string }): void {
    if (opts.keys) this.keys = { ...this.keys, ...opts.keys };
    if (opts.openaiBaseUrl !== undefined) this.openaiBaseUrl = opts.openaiBaseUrl;
    this.cache.clear();
  }

  clear(): void {
    this.cache.clear();
  }

  get(name: ProviderName): Provider {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const created = this.create(name);
    this.cache.set(name, created);
    return created;
  }

  private create(name: ProviderName): Provider {
    switch (name) {
      case "anthropic": {
        const apiKey = this.keys.anthropic || env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new ConfigError(
            "ANTHROPIC_API_KEY is not set (required by an anthropic model tier). Add it to your environment or .env file.",
          );
        }
        const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
        return baseUrl
          ? new AnthropicProvider(apiKey, baseUrl, this.retry, this.anthropicCaching)
          : new AnthropicProvider(apiKey, undefined, this.retry, this.anthropicCaching);
      }
      case "openai": {
        const apiKey = this.keys.openai || env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new ConfigError(
            "OPENAI_API_KEY is not set (required by an openai model tier). Add it to your environment or .env file.",
          );
        }
        const baseUrl = this.openaiBaseUrl || env.OPENAI_BASE_URL || undefined;
        return baseUrl
          ? new OpenAIProvider(apiKey, baseUrl, this.retry)
          : new OpenAIProvider(apiKey, undefined, this.retry);
      }
    }
  }
}
