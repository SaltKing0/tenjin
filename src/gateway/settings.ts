import type { HarnessConfig } from "../config/types";
import type { ProviderRegistry, ProviderKeys } from "../provider/registry";
import { writeProvidersYaml } from "../config/loader";
import { resolveModelRef } from "../config/models";
import { ConfigError } from "../config/types";
import { OpenAIProvider } from "../provider/openai";
import { AnthropicProvider } from "../provider/anthropic";
import { Redactor } from "../security/redact";

export interface SettingsDeps {
  home: string;
  config: HarnessConfig;
  registry: ProviderRegistry;
  audit?: (detail: string) => void;
}

function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function getSettings(deps: SettingsDeps) {
  const { config } = deps;
  const anthropicKey = config.providers?.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY;
  const openaiKey = config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY;
  return {
    anthropic: {
      configured: !!anthropicKey,
      masked: maskKey(anthropicKey),
      source: config.providers?.anthropic?.apiKey ? "config" : anthropicKey ? "env" : "none",
      baseUrl: config.providers?.anthropic?.baseUrl ?? null,
    },
    openai: {
      configured: !!openaiKey,
      masked: maskKey(openaiKey),
      source: config.providers?.openai?.apiKey ? "config" : openaiKey ? "env" : "none",
      baseUrl: config.providers?.openai?.baseUrl ?? null,
    },
    models: {
      default: config.models?.default ?? (config.model ? `${config.provider}:${config.model}` : null),
      cheap: config.models?.cheap ?? null,
    },
  };
}

export function applySettings(
  deps: SettingsDeps,
  body: {
    anthropic?: { apiKey?: string; baseUrl?: string } | null;
    openai?: { apiKey?: string; baseUrl?: string } | null;
    models?: { default?: string; cheap?: string };
  },
): void {
  const { config } = deps;

  if (body.anthropic !== undefined) {
    config.providers = config.providers ?? {};
    const next = {
      ...(body.anthropic?.baseUrl ? { baseUrl: body.anthropic.baseUrl } : {}),
      ...(body.anthropic?.apiKey ? { apiKey: body.anthropic.apiKey } : {}),
      // a console save must not drop an existing caching flag
      ...(config.providers.anthropic?.caching !== undefined
        ? { caching: config.providers.anthropic.caching }
        : {}),
    };
    config.providers.anthropic = Object.keys(next).length ? next : undefined;
    if (!config.providers.anthropic) delete config.providers.anthropic;
  }

  if (body.openai !== undefined) {
    config.providers = config.providers ?? {};
    const next = {
      ...(body.openai?.baseUrl ? { baseUrl: body.openai.baseUrl } : {}),
      ...(body.openai?.apiKey ? { apiKey: body.openai.apiKey } : {}),
    };
    config.providers.openai = Object.keys(next).length ? next : undefined;
    if (!config.providers.openai) delete config.providers.openai;
  }

  if (body.models) {
    config.models = config.models ?? {};
    if (body.models.default !== undefined && body.models.default !== "") {
      const ref = resolveModelRef(body.models.default, config.provider);
      config.models.default = `${ref.provider}:${ref.model}`;
      config.model = ref.model;
      config.provider = ref.provider;
    }
    if (body.models.cheap !== undefined) {
      if (body.models.cheap === "") delete config.models.cheap;
      else {
        const ref = resolveModelRef(body.models.cheap, config.provider);
        config.models.cheap = `${ref.provider}:${ref.model}`;
      }
    }
  }

  writeProvidersYaml(deps.home, {
    providers: config.providers,
    models: config.models,
    extra: {
      ...(config.provider ? { provider: config.provider } : {}),
      ...(config.model ? { model: config.model } : {}),
      ...(config.pricing ? { pricing: config.pricing } : {}),
    },
  });

  const keys: ProviderKeys = {
    anthropic: config.providers?.anthropic?.apiKey,
    openai: config.providers?.openai?.apiKey,
  };
  deps.registry.configure({
    keys,
    openaiBaseUrl: config.providers?.openai?.baseUrl,
    anthropicBaseUrl: config.providers?.anthropic?.baseUrl,
  });
  deps.audit?.(
    `providers updated (anthropic:${maskKey(keys.anthropic) ?? "unset"}, openai:${maskKey(keys.openai) ?? "unset"}, default:${config.models?.default ?? config.model})`,
  );
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export const DETECT_TIMEOUT_MS = 10_000;

/**
 * Heuristic for whether a model id is usable as a chat (default) model.
 * Embeds, audio/transcription, image-gen, moderation and known-deprecated
 * ids are excluded from the chat selection. Manual override is available via
 * the free-text model input in the settings panel.
 */
const NON_CHAT_HINTS = [
  "embedding",
  "-embed-",
  "text-embed",
  "ada-002", // OpenAI embedding class
  "text-ada", // deprecated OpenAI embedding generation
  "text-babbage",
  "text-curie",
  "similarity",
  "rerank",
  "re-rank",
  "search-",
  "whisper",
  "-audio",
  "tts",
  "speech",
  "transcri",
  "dall-e",
  "gpt-image",
  "image-",
  "flux-",
  "moderation",
  "safety-",
  "babbage", // legacy embeddings
];

export function isChatModel(id: string): boolean {
  const low = id.toLowerCase();
  return !NON_CHAT_HINTS.some((h) => low.includes(h));
}

/** Model id hints that identify an *embedding* model (subset of #62's chat
 * filter, kept separate so the detect list can group embeddings distinctly
 * while `isChatModel` still reuses the full NON_CHAT_HINTS set). */
const EMBEDDING_HINTS = [
  "embedding",
  "-embed-",
  "text-embed",
  "ada-002",
  "text-ada", // deprecated OpenAI embedding generation
  "text-babbage",
  "text-curie",
  "similarity",
  "rerank",
  "re-rank",
  "search-",
  "babbage", // legacy embeddings
];

/** Classification of a single model id for the detect list (#257): which
 * group it belongs to and whether it is an OpenRouter-style `:free` tier. */
export type ModelGroup = "chat" | "embedding" | "other";

export interface ClassifiedModel {
  id: string;
  group: ModelGroup;
  free: boolean;
}

export function classifyModel(id: string): ClassifiedModel {
  const low = id.toLowerCase();
  const free = low.endsWith(":free");
  let group: ModelGroup;
  if (EMBEDDING_HINTS.some((h) => low.includes(h))) {
    group = "embedding";
  } else if (isChatModel(id)) {
    group = "chat";
  } else {
    group = "other";
  }
  return { id, group, free };
}

/**
 * Classify a raw model-id list into chat / embedding / other groups (#257).
 * Within each group `:free` models are sorted first (so the zero-cost
 * OpenRouter entry points surface), then the rest alphabetically.
 */
export function classifyModels(ids: string[]): ClassifiedModel[] {
  return ids
    .map(classifyModel)
    .sort((a, b) => classifyOrder(a, b));
}

/** Sort comparator: free-tier first within the same group, then by id. */
function classifyOrder(a: ClassifiedModel, b: ClassifiedModel): number {
  if (a.group !== b.group) return a.group < b.group ? -1 : 1;
  if (a.free !== b.free) return a.free ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function classifyIntoGroups(
  ids: string[],
): Record<ModelGroup, ClassifiedModel[]> {
  const groups: Record<ModelGroup, ClassifiedModel[]> = {
    chat: [],
    embedding: [],
    other: [],
  };
  for (const m of classifyModels(ids)) groups[m.group].push(m);
  return groups;
}

export class DetectTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(
      `${provider} /models — request timed out after ${Math.round(timeoutMs / 1000)}s. Check the baseUrl and that the provider is reachable.`,
    );
    this.name = "DetectTimeoutError";
  }
}

function modelsEndpoint(
  provider: string,
  opts: { baseUrl?: string; apiKey?: string; limit?: number },
): { url: string; headers: Record<string, string> } {
  if (provider === "anthropic") {
    const base = (opts.baseUrl || ANTHROPIC_DEFAULT_BASE).replace(/\/$/, "");
    return {
      url: opts.limit ? `${base}/models?limit=${opts.limit}` : `${base}/models`,
      headers: {
        "x-api-key": opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
    };
  }
  if (provider === "openai") {
    const base = (opts.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
    return {
      url: `${base}/models`,
      headers: { authorization: `Bearer ${opts.apiKey ?? process.env.OPENAI_API_KEY ?? ""}` },
    };
  }
  throw new ConfigError(`unknown provider "${provider}"`);
}

export async function detectModels(
  input: {
    provider: string;
    baseUrl?: string;
    apiKey?: string;
  },
  timeoutMs: number = DETECT_TIMEOUT_MS,
  /** #257: when true, include non-chat ids (embeddings, audio, image…) so the
   * detect list can be grouped instead of pre-filtered to chat only. */
  raw = false,
): Promise<string[]> {
  const provider = input.provider.toLowerCase();
  const { url, headers } = modelsEndpoint(provider, {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    limit: 100,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DetectTimeoutError(provider, timeoutMs)), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${provider} /models ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    return raw ? [...new Set(ids)] : ids.filter(isChatModel).sort();
  } finally {
    clearTimeout(timer);
  }
}

/** Result of a provider key health check (never throws for a failed check). */
export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  status?: number;
  error?: string;
}

/**
 * Health check for a single provider. Without `model`, validates the key
 * against the provider's models endpoint without returning the model list.
 * With `model`, makes a minimal real chat request so a public `/models`
 * endpoint cannot produce a false-positive credential result.
 */
export async function testProvider(
  input: {
    provider: string;
    baseUrl?: string;
    apiKey?: string;
    /** When set, perform a minimal real chat request instead of only GET /models. */
    model?: string;
  },
  timeoutMs: number = DETECT_TIMEOUT_MS,
): Promise<ProviderTestResult> {
  const provider = input.provider.toLowerCase();
  const apiKey = input.apiKey ??
    (provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) ?? "";
  const redactor = new Redactor(true, [apiKey]);

  if (input.model) {
    if (provider !== "anthropic" && provider !== "openai") {
      return {
        ok: false,
        provider: input.provider,
        error: redactor.redact(`unknown provider "${input.provider}"`),
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DetectTimeoutError(provider, timeoutMs)),
      timeoutMs,
    );
    try {
      const retry = { enabled: false, maxAttempts: 1 };
      const client = provider === "anthropic"
        ? new AnthropicProvider(apiKey, input.baseUrl, retry, false)
        : new OpenAIProvider(apiKey, input.baseUrl, retry);
      await client.chat(
        {
          model: input.model,
          system: "You are a connectivity check. Reply with the single word: ok",
          messages: [{ role: "user", content: "ping" }],
          tools: [],
          maxTokens: 8,
        },
        undefined,
        controller.signal,
      );
      return { ok: true, provider, status: 200 };
    } catch (e) {
      const error = redactor.redact(e instanceof Error ? e.message : String(e));
      const statusMatch = error.match(/\b(?:api|http)\s+(\d{3})\b/i);
      return {
        ok: false,
        provider,
        ...(statusMatch ? { status: Number(statusMatch[1]) } : {}),
        error,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let url: string;
  let headers: Record<string, string>;
  try {
    ({ url, headers } = modelsEndpoint(provider, {
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
    }));
  } catch (e) {
    return { ok: false, provider: input.provider, error: redactor.redact((e as Error).message) };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DetectTimeoutError(provider, timeoutMs)),
    timeoutMs,
  );
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (res.ok) {
      return { ok: true, provider, status: res.status };
    }
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* body may not be readable */
    }
    return {
      ok: false,
      provider,
      status: res.status,
      error: redactor.redact(`${provider} /models ${res.status}${detail ? `: ${detail}` : ""}`),
    };
  } catch (e) {
    return { ok: false, provider, error: redactor.redact((e as Error).message) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Smoke-test the would-be provider configuration before live-switching:
 * fires a tiny chat completion against the target provider/model using the
 * incoming (new) key + baseUrl. Throws with a message the caller turns into a
 * 400 response; the shared config is left untouched so a dead key can never
 * half-apply. When no custom baseUrl is configured (standard provider
 * endpoints), it applies without a network probe — those are validated on
 * first real use, and probing official APIs on every save would be wasteful.
 */
export async function verifySettingsApply(
  deps: SettingsDeps,
  body: {
    anthropic?: { apiKey?: string } | null;
    openai?: { apiKey?: string; baseUrl?: string } | null;
    models?: { default?: string; cheap?: string };
  },
  timeoutMs: number = DETECT_TIMEOUT_MS,
): Promise<void> {
  const { config } = deps;

  // Determine the target provider + model that applySettings would activate.
  let providerName: "anthropic" | "openai";
  let model: string;
  if (body.models?.default && body.models.default !== "") {
    const ref = resolveModelRef(body.models.default, config.provider);
    providerName = ref.provider;
    model = ref.model;
  } else {
    providerName = config.provider;
    model = config.model;
  }
  if (!model) return;

  // Only probe when a custom endpoint is in play; standard endpoints are
  // validated lazily on first real use (avoid a paid call on every save).
  if (providerName !== "openai") return;
  const baseUrl = body.openai?.baseUrl ?? config.providers?.openai?.baseUrl;
  if (!baseUrl) return;

  const apiKey =
    body.openai?.apiKey ?? config.providers?.openai?.apiKey ?? process.env.OPENAI_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${providerName} smoke-test timed out after ${Math.round(timeoutMs / 1000)}s`)),
    timeoutMs,
  );
  try {
    const provider = new OpenAIProvider(apiKey ?? "", baseUrl, undefined);
    await provider.chat(
      {
        model,
        system: "You are a connectivity check. Reply with the single word: ok",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxTokens: 8,
      },
      undefined,
      controller.signal,
    );
  } catch (e) {
    const msg = (e as Error).message;
    throw new ConfigError(
      `settings apply smoke-test failed for ${providerName}/${model} (${baseUrl}): ${msg}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
