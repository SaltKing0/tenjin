import type { Provider } from "./types";
import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import { ProviderRegistry } from "./registry";

export function createProvider(config: HarnessConfig): Provider {
  if (config.provider !== "anthropic" && config.provider !== "openai") {
    throw new ConfigError(`provider must be "anthropic" or "openai"`);
  }
  return new ProviderRegistry(
    config.providers?.openai?.baseUrl,
    {
      anthropic: config.providers?.anthropic?.apiKey,
      openai: config.providers?.openai?.apiKey,
    },
    config.retry,
    config.providers?.anthropic?.caching,
    config.providers?.anthropic?.baseUrl,
  ).get(config.provider);
}
