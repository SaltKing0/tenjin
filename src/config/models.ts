import type { HarnessConfig, ProviderName } from "./types";
import { ConfigError } from "./types";

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

export function resolveModelRef(ref: string, fallbackProvider: ProviderName): ModelRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new ConfigError("model reference must not be empty");
  const idx = trimmed.indexOf(":");
  if (idx === -1) return { provider: fallbackProvider, model: trimmed };
  const provider = trimmed.slice(0, idx).trim() as ProviderName;
  const model = trimmed.slice(idx + 1).trim();
  if (!model) throw new ConfigError(`missing model after ":" in "${trimmed}"`);
  // A provider prefix must be a known provider NAME (pure alpha). Anything
  // else before the colon — "deepseek/deepseek-chat:free", "llama3.1:latest" —
  // is part of the model id itself (OpenRouter/Ollama naming), so the whole
  // string is the model under the fallback provider.
  if (/^[a-z]+$/i.test(provider)) {
    if (provider !== "anthropic" && provider !== "openai") {
      throw new ConfigError(
        `unknown provider "${provider}" in model ref "${trimmed}" (supported: anthropic:, openai:)`,
      );
    }
    return { provider, model };
  }
  return { provider: fallbackProvider, model: trimmed };
}

export function defaultModelRef(cfg: HarnessConfig): ModelRef {
  const ref = cfg.models?.default?.trim();
  if (ref) return resolveModelRef(ref, cfg.provider);
  return { provider: cfg.provider, model: cfg.model };
}

export function cheapModelRef(cfg: HarnessConfig): ModelRef | null {
  const ref = cfg.models?.cheap?.trim();
  if (!ref) return null;
  return resolveModelRef(ref, cfg.provider);
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}
