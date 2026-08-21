import { env } from "node:process";
import type { Provider } from "../provider/types";
import { AnthropicProvider } from "../provider/anthropic";
import { OpenAIProvider } from "../provider/openai";
import { ConfigError, type ProviderName } from "../config/types";

export class ProviderRegistry {
  private cache = new Map<ProviderName, Provider>();

  constructor(private openaiBaseUrl?: string) {}

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
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) {
          throw new ConfigError(
            "ANTHROPIC_API_KEY is not set (required by an anthropic model tier). Add it to your environment or .env file.",
          );
        }
        const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
        return baseUrl
          ? new AnthropicProvider(apiKey, baseUrl)
          : new AnthropicProvider(apiKey);
      }
      case "openai": {
        const apiKey = env.OPENAI_API_KEY;
        if (!apiKey) {
          throw new ConfigError(
            "OPENAI_API_KEY is not set (required by an openai model tier). Add it to your environment or .env file.",
          );
        }
        const baseUrl = this.openaiBaseUrl || env.OPENAI_BASE_URL || undefined;
        return baseUrl
          ? new OpenAIProvider(apiKey, baseUrl)
          : new OpenAIProvider(apiKey);
      }
    }
  }
}
