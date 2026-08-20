import { env } from "node:process";
import type { Provider } from "./types";
import type { HarnessConfig } from "../config/loader";
import { ConfigError } from "../config/loader";
import { AnthropicProvider } from "./anthropic";

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
    default:
      throw new ConfigError(`Provider "${config.provider}" is not available yet.`);
  }
}
