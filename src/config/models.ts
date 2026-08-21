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
  if (provider !== "anthropic" && provider !== "openai") {
    throw new ConfigError(
      `unknown provider "${provider}" in model ref "${trimmed}" (supported: anthropic:, openai:)`,
    );
  }
  if (!model) throw new ConfigError(`missing model after ":" in "${trimmed}"`);
  return { provider, model };
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
