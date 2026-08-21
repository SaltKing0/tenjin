import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { resolveModelRef } from "./models";
import {
  ConfigError,
  type ApprovalMode,
  type HarnessConfig,
  type PricingOverride,
  type ProviderName,
} from "./types";

export { ConfigError };
export type { ApprovalMode, HarnessConfig, PricingOverride, ProviderName };

const DEFAULTS: HarnessConfig = {
  provider: "anthropic",
  model: "",
  maxTokens: 8192,
  budgetUSD: 5,
  approval: {},
};

const CONFIG_TEMPLATE = `# Tenjin harness configuration
provider: anthropic        # anthropic | openai (any OpenAI-compatible endpoint)
model: ""                  # REQUIRED, e.g. claude-sonnet-4-5, gpt-4o, deepseek-chat
maxTokens: 8192
budgetUSD: 5               # hard spend cap per session in USD; 0 = unlimited
approval:                  # ask | allow | deny, per tool
  read: allow
  glob: allow
  grep: allow
  write: ask
  edit: ask
  bash: ask
# pricing:                  # optional override, USD per million tokens
#   inputPerMTok: 3
#   outputPerMTok: 15
memory:
  enabled: true             # session summaries + recall (set false to disable)
  vector:
    enabled: true           # semantic recall; needs OPENAI_API_KEY at runtime
    # model: text-embedding-3-small
# security:
#   redaction: true          # mask secrets (sk-…, AKIA…, keys) in session/audit logs
# models:                   # optional model tiers (provider-prefixed to mix providers)
#   default: anthropic:claude-sonnet-4-5
#   cheap: openai:gpt-4o-mini
# providers:
#   openai:
#     baseUrl: https://api.deepseek.com/v1   # any OpenAI-compatible endpoint
`;

const SOUL_TEMPLATE = `# SOUL

You are **Tenjin** — a precise, pragmatic coding agent.

- Prefer working code over abstract advice.
- Be brief. Show, don't tell.
- Never invent APIs; verify against the actual code.
- Leave code cleaner than you found it.
`;

export function tenjinHome(): string {
  return process.env.TENJIN_HOME
    ? resolve(process.env.TENJIN_HOME)
    : join(homedir(), ".tenjin");
}

export function sessionsDir(home = tenjinHome()): string {
  return join(home, "sessions");
}

export function memoryDir(home = tenjinHome()): string {
  return join(home, "memory");
}

export function memoryEnabled(cfg: HarnessConfig): boolean {
  return cfg.memory?.enabled !== false;
}

export function vectorEnabled(cfg: HarnessConfig): boolean {
  return memoryEnabled(cfg) && cfg.memory?.vector?.enabled !== false;
}

export function providersFile(home = tenjinHome()): string {
  return join(home, "providers.yaml");
}

export function writeProvidersYaml(
  home: string,
  data: { providers?: unknown; models?: unknown; extra?: Record<string, unknown> },
): void {
  const doc: Record<string, unknown> = { ...(data.extra ?? {}) };
  if (data.providers) doc.providers = data.providers;
  if (data.models) doc.models = data.models;
  const path = providersFile(home);
  writeFileSync(
    path,
    `# Managed by the Tenjin web console — safe to delete\n${YAML.stringify(doc)}`,
    { mode: 0o600 },
  );
}

export function ensureGlobalDir(home = tenjinHome()): { created: boolean } {
  mkdirSync(join(home, "sessions"), { recursive: true });
  const cfgPath = join(home, "config.yaml");
  const soulPath = join(home, "SOUL.md");
  const created = !existsSync(cfgPath) && !existsSync(soulPath);
  if (!existsSync(cfgPath)) writeFileSync(cfgPath, CONFIG_TEMPLATE);
  if (!existsSync(soulPath)) writeFileSync(soulPath, SOUL_TEMPLATE);
  return { created };
}

function parseYamlFile(path: string): Partial<HarnessConfig> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    throw new ConfigError(`Invalid YAML in ${path}: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object") {
    throw new ConfigError(`Config root must be a mapping: ${path}`);
  }
  return parsed as Partial<HarnessConfig>;
}

function mergeApproval(
  base: Record<string, ApprovalMode>,
  over: Partial<HarnessConfig>,
): Record<string, ApprovalMode> {
  return over.approval ? { ...base, ...over.approval } : base;
}

export interface LoadedConfig {
  config: HarnessConfig;
  sources: { global: string; project: string | null };
}

export function loadConfig(
  projectDir: string,
  home = tenjinHome(),
  opts: { skipModelCheck?: boolean } = {},
): LoadedConfig {
  const globalPath = join(home, "config.yaml");
  const managedPath = providersFile(home);
  const projectPath = join(projectDir, ".tenjin", "config.yaml");

  const globalCfg = parseYamlFile(globalPath);
  const managedCfg = parseYamlFile(managedPath);
  const projectCfg = parseYamlFile(projectPath);

  const merged: HarnessConfig = {
    ...DEFAULTS,
    ...globalCfg,
    ...managedCfg,
    ...projectCfg,
    approval: mergeApproval(mergeApproval(DEFAULTS.approval, globalCfg), projectCfg),
  };

  validate(merged, globalPath, opts.skipModelCheck ?? false);

  return {
    config: merged,
    sources: {
      global: globalPath,
      project: existsSync(projectPath) ? projectPath : null,
    },
  };
}

export function validateConfig(cfg: HarnessConfig): void {
  validate(cfg, "", false);
}

function validate(cfg: HarnessConfig, globalPath: string, skipModelCheck: boolean): void {
  if (cfg.provider !== "anthropic" && cfg.provider !== "openai") {
    throw new ConfigError(
      `provider must be "anthropic" or "openai", got "${cfg.provider}"`,
    );
  }
  const hasLegacyModel = !!cfg.model && typeof cfg.model === "string";
  const hasTierModel = !!cfg.models?.default?.trim();
  if (!skipModelCheck && !hasLegacyModel && !hasTierModel) {
    throw new ConfigError(
      `No model configured. Set \`model\` in ${globalPath} or pass --model.\n` +
        `Examples: claude-sonnet-4-5, gpt-4o, deepseek-chat`,
    );
  }
  const defaultRef = cfg.models?.default?.trim();
  if (defaultRef) resolveModelRef(defaultRef, cfg.provider);
  const cheapRef = cfg.models?.cheap?.trim();
  if (cheapRef) resolveModelRef(cheapRef, cfg.provider);
  if (typeof cfg.maxTokens !== "number" || cfg.maxTokens < 256) {
    throw new ConfigError(`maxTokens must be a number >= 256`);
  }
  if (typeof cfg.budgetUSD !== "number" || cfg.budgetUSD < 0) {
    throw new ConfigError(`budgetUSD must be a number >= 0 (0 = unlimited)`);
  }
}
