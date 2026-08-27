import type { HarnessConfig, ProviderName } from "./types";
import { ConfigError } from "./types";
import { Router } from "./router";

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
  // B10-1/B10-4: when routing is configured, the default run selects its model
  // through the Router (SINGLE-PATH LAW) instead of the static config.
  const routed = routedModelRef(cfg);
  if (routed) return routed;
  const ref = cfg.models?.default?.trim();
  if (ref) return resolveModelRef(ref, cfg.provider);
  return { provider: cfg.provider, model: cfg.model };
}

/**
 * B10-1/B10-4 routing core wiring: resolve the default agent run's model via
 * the Router when `routing` is configured. Returns null when routing is absent
 * (callers fall back to the static config). The deployment's provider+model
 * become the run's provider+model, so pricing / context-window / reporting all
 * stay consistent with the model actually called.
 */
export function routedModelRef(cfg: HarnessConfig): ModelRef | null {
  if (!cfg.routing) return null;
  const names = Object.keys(cfg.routing.aliases ?? {});
  if (names.length === 0) return null;
  const alias = cfg.routing.default ?? names[0]!;
  const router = new Router(cfg.routing);
  const dep = router.select(alias);
  return { provider: dep.provider_id as ProviderName, model: dep.model };
}

export function cheapModelRef(cfg: HarnessConfig): ModelRef | null {
  const ref = cfg.models?.cheap?.trim();
  if (!ref) return null;
  return resolveModelRef(ref, cfg.provider);
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}
