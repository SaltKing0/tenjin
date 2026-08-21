import type { HarnessConfig } from "../config/types";
import type { ProviderRegistry, ProviderKeys } from "../provider/registry";
import { writeProvidersYaml } from "../config/loader";
import { resolveModelRef } from "../config/models";
import { ConfigError } from "../config/types";

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
    anthropic?: { apiKey?: string } | null;
    openai?: { apiKey?: string; baseUrl?: string } | null;
    models?: { default?: string; cheap?: string };
  },
): void {
  const { config } = deps;

  if (body.anthropic !== undefined) {
    config.providers = config.providers ?? {};
    config.providers.anthropic = body.anthropic?.apiKey
      ? { apiKey: body.anthropic.apiKey }
      : undefined;
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
  });

  const keys: ProviderKeys = {
    anthropic: config.providers?.anthropic?.apiKey,
    openai: config.providers?.openai?.apiKey,
  };
  deps.registry.setKeys(keys);
  deps.audit?.(
    `providers updated (anthropic:${maskKey(keys.anthropic) ?? "unset"}, openai:${maskKey(keys.openai) ?? "unset"}, default:${config.models?.default ?? config.model})`,
  );
}

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

export async function detectModels(input: {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
}): Promise<string[]> {
  const provider = input.provider.toLowerCase();
  let base: string;
  let url: string;
  let headers: Record<string, string>;

  if (provider === "anthropic") {
    base = (input.baseUrl || ANTHROPIC_DEFAULT_BASE).replace(/\/$/, "");
    url = `${base}/models?limit=100`;
    headers = {
      "x-api-key": input.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    };
  } else if (provider === "openai") {
    base = (input.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/$/, "");
    url = `${base}/models`;
    headers = { authorization: `Bearer ${input.apiKey ?? process.env.OPENAI_API_KEY ?? ""}` };
  } else {
    throw new ConfigError(`unknown provider "${input.provider}"`);
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`${provider} /models ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string");
  return ids.sort();
}
