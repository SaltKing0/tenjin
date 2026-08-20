import { env } from "node:process";
import type { Provider } from "./types";
import type { HarnessConfig } from "../config/loader";
import { ConfigError } from "../config/loader";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";

export function createProvider(config: HarnessConfig): Provider {
  switch (config.provider) {
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new ConfigError(
          "ANTHROPIC_API_KEY is not set. Add it to your environment or .env file.",
        );
      }
      return new AnthropicProvider(apiKey);
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new ConfigError(
          "OPENAI_API_KEY is not set. Add it to your environment or .env file.",
        );
      }
      const baseUrl =
        config.providers?.openai?.baseUrl || env.OPENAI_BASE_URL || undefined;
      return baseUrl
        ? new OpenAIProvider(apiKey, baseUrl)
        : new OpenAIProvider(apiKey);
    }
    default:
      throw new ConfigError(`Provider "${(config as HarnessConfig).provider}" is not available.`);
  }
}
