import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { stringifyBlockStyle } from "./block-style";
import { resolveModelRef } from "./models";
import { openKeyring, encryptProviders, isEncrypted, decrypt as decryptKey } from "../security/keyring";
import { validateWorkspaceConfig } from "../sandbox/workspace";
import {
  ConfigError,
  type ApprovalMode,
  type ContextConfig,
  type GlobalBudgetConfig,
  type HarnessConfig,
  type InboxConfig,
  type PricingConfig,
  type PricingOverride,
  type ProviderName,
  type RetryConfig,
  type RouterConfig,
} from "./types";

export { ConfigError };
export type { ApprovalMode, ContextConfig, GlobalBudgetConfig, HarnessConfig, PricingConfig, PricingOverride, ProviderName, RouterConfig };

const DEFAULTS: HarnessConfig = {
  provider: "anthropic",
  model: "",
  maxTokens: 8192,
  budgetUSD: 5,
  maxTreeIterations: 0,
  approval: {},
};

/**
 * Current config-file schema version. Bump this whenever the meaning of an
 * existing config.yaml field changes in a way that needs a migration, and add
 * a corresponding step to {@link MIGRATIONS} so older homes are upgraded on
 * boot instead of silently misreading their config.
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * Ordered schema migration steps. `MIGRATIONS[i]` upgrades a config from
 * schema version `i` to `i + 1` by mutating the parsed global config in place.
 * The chain runs from the version observed on the file up to
 * {@link CONFIG_SCHEMA_VERSION}. Steps must be idempotent — they may also run
 * against a hand-edited config that already has the target shape.
 */
export const MIGRATIONS: Array<(cfg: Record<string, unknown>) => void> = [];

/**
 * Apply the migration chain from `fromVersion` to `toVersion` (exclusive of
 * `toVersion`) to a parsed config object. Returns how many steps ran.
 */
export function migrateConfig(
  cfg: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
  steps: Array<(cfg: Record<string, unknown>) => void> = MIGRATIONS,
): { applied: number } {
  let applied = 0;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = steps[v];
    if (step) {
      step(cfg);
      applied++;
    }
  }
  return { applied };
}

/**
 * Read the `version:` field from a parsed global config. Returns the integer
 * version when present and valid, or `null` when the file is unversioned.
 */
export function readConfigVersion(cfg: Partial<HarnessConfig>): number | null {
  const v = cfg.version;
  if (v === undefined || v === null) return null;
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Known config fields and the types they accept. Used to tell a bad type
 * (clear error with dotted path) apart from an unknown field (warning) at
 * load time, before the value can fail deep in a runtime stack.
 *
 * `valueType` marks a "bag" mapping whose keys are dynamic (e.g. approval
 * per tool, provider keys) — only the values' type is checked there.
 */
type TypeName = "string" | "number" | "boolean" | "mapping" | "list" | "null";
interface FieldDef {
  types: TypeName[];
  children?: Record<string, FieldDef>;
  valueType?: TypeName;
}

const SCHEMA: Record<string, FieldDef> = {
  version: { types: ["number"] },
  provider: { types: ["string"] },
  model: { types: ["string"] },
  maxTokens: { types: ["number"] },
  budgetUSD: { types: ["number"] },
  defaultBot: { types: ["string"] },
  maxTreeIterations: { types: ["number"] },
  approval: { types: ["mapping"], valueType: "string" },
  // B13-5 (#437): mode ladder — validated at runtime in security/mode-ladder.ts.
  mode: {
    types: ["mapping"],
    children: {
      ladder: { types: ["string"] },
      bypassEnv: { types: ["string"] },
      askRules: { types: ["list"] },
      autoAllow: { types: ["list"] },
    },
  },
  pricing: {
    types: ["mapping"],
    children: {
      inputPerMTok: { types: ["number"] },
      outputPerMTok: { types: ["number"] },
      default: { types: ["mapping"], valueType: "number" },
    },
  },
  providers: {
    types: ["mapping"],
    children: {
      openai: { types: ["mapping"], valueType: "string" },
      anthropic: {
        types: ["mapping"],
        children: {
          apiKey: { types: ["string"] },
          baseUrl: { types: ["string"] },
          caching: { types: ["boolean"] },
        },
      },
    },
  },
  models: {
    types: ["mapping"],
    children: { default: { types: ["string"] }, cheap: { types: ["string"] } },
  },
  // B10-1/B10-4 routing core: task→alias→deployment chains. Deep-validated in
  // validateRouting (alias values are mappings whose shape is checked there).
  routing: {
    types: ["mapping"],
    children: {
      aliases: { types: ["mapping"], valueType: "mapping" },
      tasks: { types: ["mapping"], valueType: "string" },
      stickyTtlMs: { types: ["number"] },
      retriesPerDeployment: { types: ["number"] },
    },
  },
  // web_search is default-OFF: `webSearch.enabled: true` turns it on.
  webSearch: {
    types: ["mapping"],
    children: {
      enabled: { types: ["boolean"] },
      apiKey: { types: ["string"] },
      endpoint: { types: ["string"] },
    },
  },
  // `gateway` is deep-validated in gateway/config.ts with its own messages.
  gateway: { types: ["mapping"] },
  security: {
    types: ["mapping"],
    children: {
      disabled: { types: ["boolean"] },
      redaction: { types: ["boolean"] },
      workspaceRoot: { types: ["string"] },
      blockedPatterns: { types: ["list"] },
      allowedPaths: { types: ["list"] },
      paranoid: { types: ["boolean"] },
      denyDomains: { types: ["list"] },
      mcpDenyPatterns: { types: ["list"] },
    },
  },
  memory: {
    types: ["mapping"],
    children: {
      enabled: { types: ["boolean"] },
      vector: {
        types: ["mapping"],
        children: {
          enabled: { types: ["boolean"] },
          model: { types: ["string"] },
        },
      },
      summaries: {
        types: ["mapping"],
        children: {
          onSessionEnd: { types: ["boolean"] },
        },
      },
      learnings: {
        types: ["mapping"],
        children: {
          maxEntries: { types: ["number"] },
        },
      },
    },
  },
  events: {
    types: ["mapping"],
    children: {
      webhooks: { types: ["list"] },
      ntfy: { types: ["mapping"] },
    },
  },
  // `inbox` from #64 (yaml TTL/max config); added here so schema-validate
  // (#74) doesn't warn "unknown field inbox".
  inbox: {
    types: ["mapping"],
    children: {
      ttlDays: { types: ["number"] },
      maxMessages: { types: ["number"] },
    },
  },
  // `retry` from #54 (provider request retry + backoff).
  retry: {
    types: ["mapping"],
    children: {
      enabled: { types: ["boolean"] },
      maxAttempts: { types: ["number"] },
      initialDelayMs: { types: ["number"] },
      maxDelayMs: { types: ["number"] },
      retryableStatuses: { types: ["list"] },
    },
  },
  // `globalBudget` from #36 (global spend caps across all scopes).
  globalBudget: {
    types: ["mapping"],
    children: {
      dailyUSD: { types: ["number"] },
      monthlyUSD: { types: ["number"] },
    },
  },
  // `context` from #101 (context-window guard).
  context: {
    types: ["mapping"],
    children: {
      enabled: { types: ["boolean"] },
      thresholdRatio: { types: ["number"] },
      defaultWindow: { types: ["number"] },
      windows: { types: ["mapping"], valueType: "number" },
      compaction: {
        types: ["mapping"],
        children: {
          enabled: { types: ["boolean"] },
          keepLast: { types: ["number"] },
          minTurnsBetween: { types: ["number"] },
          archiveDir: { types: ["string"] },
          table: { types: ["mapping"], valueType: "number" },
        },
      },
      consolidation: {
        types: ["mapping"],
        children: {
          enabled: { types: ["boolean"] },
          threshold: { types: ["number"] },
          minTurnsBetween: { types: ["number"] },
          contradictionCheck: {
            types: ["mapping"],
            children: {
              enabled: { types: ["boolean"] },
              maxChecks: { types: ["number"] },
              model: { types: ["string"] },
            },
          },
        },
      },
    },
  },
  // `mcp` from WPs 3.1+3.2 (MCP stdio servers, default off). Server entries are
  // deep-normalized at runtime in tools/mcp.ts, so only the top-level shape is
  // schema-checked here.
  mcp: {
    types: ["mapping"],
    children: {
      servers: { types: ["list"] },
    },
  },
  // `workspace` from B12-3 (#424): execution-surface switch. Docker image/user
  // etc. are validated/normalized at runtime in sandbox/workspace.ts.
  workspace: {
    types: ["mapping"],
    children: {
      mode: { types: ["string"] },
      docker: {
        types: ["mapping"],
        children: {
          image: { types: ["string"] },
          workdir: { types: ["string"] },
          memoryMax: { types: ["string"] },
          cpuQuota: { types: ["number"] },
          user: { types: ["string"] },
        },
      },
      ttlMs: { types: ["number"] },
    },
  },
};

function configTypeName(v: unknown): TypeName {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  switch (typeof v) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "mapping";
    default:
      return typeof v as TypeName;
  }
}

interface SourceIssues {
  unknown: string[];
  typeErrors: string[];
}

function walkNode(
  node: Record<string, unknown>,
  path: string,
  defMap: Record<string, FieldDef>,
  issues: SourceIssues,
): void {
  for (const [key, value] of Object.entries(node)) {
    const dot = path ? `${path}.${key}` : key;
    const def = defMap[key];
    if (!def) {
      issues.unknown.push(dot);
      continue;
    }
    const actual = configTypeName(value);
    if (!def.types.includes(actual)) {
      issues.typeErrors.push(
        `${dot}: expected ${def.types.join(" or ")}, found ${actual}`,
      );
      continue;
    }
    if (actual !== "mapping") continue;
    if (def.children) {
      walkNode(value as Record<string, unknown>, dot, def.children, issues);
    } else if (def.valueType) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const av = configTypeName(v);
        if (av !== def.valueType) {
          issues.typeErrors.push(
            `${dot}.${k}: expected ${def.valueType}, found ${av}`,
          );
        }
      }
    }
  }
}

/**
 * Schema-check a single source file. Unknown fields are collected as warnings;
 * wrong-typed known fields surface as type errors prefixed by `file` (and a
 * dotted path), so a bad value points at exactly where it lives.
 */
function inspectSource(
  obj: Record<string, unknown>,
  file: string,
): SourceIssues {
  const issues: SourceIssues = { unknown: [], typeErrors: [] };
  walkNode(obj, "", SCHEMA, issues);
  for (const dot of issues.unknown) {
    console.warn(`[config] ${file}: unknown field "${dot}" ignored`);
  }
  return issues;
}

const CONFIG_TEMPLATE = `# Tenjin harness configuration
version: 1                   # config schema version — keep as-is
provider: anthropic        # anthropic | openai (any OpenAI-compatible endpoint)
model: ""                  # REQUIRED, e.g. claude-sonnet-4-5, gpt-4o, deepseek-chat
maxTokens: 8192
budgetUSD: 5               # hard spend cap per session in USD; 0 = unlimited
# maxTreeIterations: 0        # global safety-net: max iterations per delegation tree (parent + all delegates); 0 = unlimited
approval:                  # ask | allow | deny, per tool
  read: allow
  glob: allow
  grep: allow
  write: ask
  edit: ask
  browser: ask
# mode:                     # B13-5 mode ladder (default: manual) — higher-level
#   ladder: manual          #   higher-level than approval; never widens the T2 law.
#                           #   manual | acceptEdits | auto | dontAsk | bypass
#   bypassEnv: STEALTH_ISOLATION   # env var required before bypass is usable
#   askRules: [bash]        # tool names that force a human checkpoint even in auto
  bash: ask
# pricing:
#   default:                 # USD per 1M tokens for models not in the built-in table
#     inputPerMTok: 5
#     outputPerMTok: 15
#   # inputPerMTok: 3        # optional: override ALL models (known and unknown)
#   # outputPerMTok: 15
memory:
  enabled: true             # session summaries + recall (set false to disable)
  vector:
    enabled: true           # semantic recall; needs OPENAI_API_KEY at runtime
    # model: text-embedding-3-small
  # summaries:
  #   onSessionEnd: true     # gateway: summarize a bot's session after each job run (default: off)
# security:
#   redaction: true          # mask secrets (sk-…, AKIA…, keys) in session/audit logs
# inbox:
#   ttlDays: 30              # drop messages older than this on read/write; 0 = never
#   maxMessages: 500         # keep newest N per inbox (read mail dropped first); 0 = unlimited
# models:                   # optional model tiers (provider-prefixed to mix providers)
#   default: anthropic:claude-sonnet-4-5
#   cheap: openai:gpt-4o-mini
# providers:
#   openai:
#     baseUrl: https://api.deepseek.com/v1   # any OpenAI-compatible endpoint.
#                                           #   Local (Ollama/LM Studio): no apiKey needed.
#                                           #   Hosted (OpenRouter/DeepSeek): set OPENAI_API_KEY,
#                                           #   e.g. baseUrl: https://openrouter.ai/api/v1 with
#                                           #   models named "vendor/model" ("meta-llama/llama-3.3-70b:free").
#   anthropic:
#     baseUrl: https://gateway.example/v1   # Anthropic endpoint override (default: api.anthropic.com)
#     caching: false                         # prompt caching (default: on) — off to disable cache_control markers
# retry:                       # provider request retry on 429/5xx/network errors
#   enabled: true              # false disables retries entirely (default: on)
#   maxAttempts: 3             # total attempts including the first
#   initialDelayMs: 500        # backoff before the first retry, doubles each attempt (ms)
#   maxDelayMs: 8000           # upper bound on the per-attempt backoff (ms)
# globalBudget:                # global spend caps (USD) across solo + ALL bots
#   dailyUSD: 2.0              # max total spend per UTC day across all scopes; 0 = unlimited
#   monthlyUSD: 20.0           # max total spend per UTC month across all scopes; 0 = unlimited
# events:                      # outbound notifications on gateway events
#   ntfy:                      # ntfy push (mobile) — zero-auth: the topic URL is the credential
#     topicUrl: https://ntfy.sh/mytopic
#     priority: default        # min | low | default | high | urgent (base priority)
#     priorities:              # per-event override, e.g. failures louder than rest
#       job.failed: urgent
#   webhooks:                  # signed HTTP callbacks (see docs/architecture.md)
#     - url: https://example.com/hook
#       secret: change-me
#       events: [job.failed]   # approval.created | approval.resolved | job.failed | budget.exceeded | task.done
#       retries: 3
# context:                     # context-window guard (chars/4 estimate)
#   enabled: true              # compress old tool results once the estimate nears the limit
#   thresholdRatio: 0.8        # compress when estimate > 80% of the model's context window
#   # defaultWindow: 128000    # context window (tokens) for unknown models
#   # windows:                 # per-model context-window override
#   #   my-model: 32000
# workspace:                   # B12-3 execution surface
#   mode: local                # only production mode today; docker/remote fail closed
# gateway:                     # uncomment to start the HTTP API + web console (see docs/architecture.md)
#   allowWrites: false         # gate write/edit/bash/browser tool calls behind approvals
#   listen:
#     host: 127.0.0.1          # bind address — use 0.0.0.0 only behind a proxy or VPN
#     port: 3000               # console/HTTP API port
#     token: change-me         # bearer token for the console/API — set a real secret
#   channels: [telegram]       # active channel kinds (defaults to each *.enabled channel below)
#   # telegram:
#   #   enabled: true
#   #   defaultBot: mybot
#   #   allowedUsers: []       # REQUIRED: allowlist of Telegram user ids
#   jobs:                      # scheduled prompts to a bot (see docs/architecture.md)
#     - name: daily-digest
#       bot: researcher
#       prompt: "Summarize today's changes."
#       cron: "0 9 * * *"      # or every: "4h"; a schedule: "0 9 * * *" string or
#       tz: Europe/Berlin      #   schedule: {cron: ...} mapping also work
#       postTo: telegram       # optional channel to route the result to
#       timeoutMs: 300000      # optional hard cap per run (ms)
#       policy: full           # optional tool policy (read-only | full)
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

/** web_search is default-OFF: it is only active when webSearch.enabled is true. */
export function webSearchEnabled(cfg: { webSearch?: { enabled?: boolean } }): boolean {
  return cfg.webSearch?.enabled === true;
}

/** research_search is default-OFF: it is only active when research.enabled is true. */
export function researchEnabled(cfg: { research?: { enabled?: boolean } }): boolean {
  return cfg.research?.enabled === true;
}

export function vectorEnabled(cfg: HarnessConfig): boolean {
  return memoryEnabled(cfg) && cfg.memory?.vector?.enabled !== false;
}

/**
 * Whether the gateway should summarize a bot's session after each job run (#37).
 * Opt-in: requires memory to be enabled AND `memory.summaries.onSessionEnd` to
 * be explicitly true, so existing deployments don't gain an extra per-job
 * provider call unless they ask for it.
 */
export function memorySummariesOnSessionEnd(
  cfg: Pick<HarnessConfig, "memory">,
): boolean {
  return cfg.memory?.enabled !== false && cfg.memory?.summaries?.onSessionEnd === true;
}

export function providersFile(home = tenjinHome()): string {
  return join(home, "providers.yaml");
}

export function writeProvidersYaml(
  home: string,
  data: { providers?: unknown; models?: unknown; extra?: Record<string, unknown> },
): void {
  const doc: Record<string, unknown> = { ...(data.extra ?? {}) };
  if (data.providers) {
    // #132: with a keyring initialized, encrypt apiKey values at rest.
    const ring = openKeyring(home);
    doc.providers = ring
      ? encryptProviders(ring, data.providers as Record<string, unknown>)
      : data.providers;
  }
  if (data.models) doc.models = data.models;
  const path = providersFile(home);
  writeFileSync(
    path,
    // #8: block style (multi-line mappings) — Bun's YAML.stringify emits
    // unreadable flow style, so reuse the shared block serializer.
    `# Managed by the Tenjin web console — safe to delete\n${stringifyBlockStyle(doc)}`,
    { mode: 0o600 },
  );
}

/**
 * Decrypt any encrypted `apiKey` values in a parsed providers.yaml (the
 * console-managed secrets file). With no keyring, decrypting is impossible —
 * a clear ConfigError points the user to `tenjin keyring init` or to re-saving
 * the key, instead of silently booting with a garbage key (#132).
 */
function decryptManagedKeys(
  home: string,
  cfg: Partial<HarnessConfig>,
): Partial<HarnessConfig> {
  const providers = cfg.providers;
  if (!providers || typeof providers !== "object") return cfg;
  const ring = openKeyring(home);
  for (const pcfg of Object.values(providers) as Array<Record<string, unknown>>) {
    if (typeof pcfg !== "object" || pcfg === null) continue;
    const apiKey = pcfg?.apiKey;
    if (typeof apiKey !== "string" || !isEncrypted(apiKey)) continue;
    if (!ring) {
      throw new ConfigError(
        `${providersFile(home)} contains an encrypted API key but this machine has no keyring — ` +
          `run \`tenjin keyring init\` here or re-save the key via the console`,
      );
    }
    pcfg.apiKey = decryptKey(ring, apiKey);
  }
  return cfg;
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

/**
 * Best-effort 1-based line estimate for a YAML parse failure. Bun's parser
 * reports no position, so we scan the raw text for the most common breakage —
 * an unterminated quoted scalar or an unclosed flow collection — and fall back
 * to the last non-empty line otherwise.
 */
function locateYamlError(raw: string, message: string): number {
  const lines = raw.split("\n");
  let quote: "'" | '"' | null = null;
  let quoteLine = 0;
  let flowOpenLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      // treat '#' at start or after whitespace as a comment start
      if (ch === "#" && (j === 0 || /\s/.test(line[j - 1] ?? ""))) break;
      if (ch === "'" || ch === '"') {
        if (quote === ch) {
          quote = null;
        } else if (quote === null) {
          quote = ch;
          quoteLine = i + 1;
        }
        continue;
      }
      if (ch === "[" || ch === "{") {
        if (flowOpenLine === 0) flowOpenLine = i + 1;
      }
    }
  }
  if (quote) return quoteLine;
  if (flowOpenLine > 0 && /EOF|token/i.test(message)) return flowOpenLine;
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").trim()) return i + 1;
  }
  return Math.max(1, lines.length);
}

function parseYamlFile(path: string): Partial<HarnessConfig> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (e) {
    const line = locateYamlError(raw, (e as Error).message);
    throw new ConfigError(
      `Invalid YAML in ${path} (line ${line}): ${(e as Error).message}`,
    );
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object") {
    throw new ConfigError(`Config root must be a mapping: ${path}`);
  }
  return parsed as Partial<HarnessConfig>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursively merge `over` into `base`: plain objects merge key-by-key, every
 * other value (scalars, arrays, null) is replaced by the higher-precedence one.
 * This keeps a project `security.disabled: true` from wiping the global
 * `security.blockedPatterns` — each nested field survives unless an overriding
 * source actually sets it.
 */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return over as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const baseValue = out[key];
    out[key] =
      isPlainObject(baseValue) && isPlainObject(value)
        ? deepMerge(baseValue, value)
        : value;
  }
  return out as T;
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
  const rawManaged = parseYamlFile(managedPath);
  // #132: transparently decrypt any encrypted apiKey values on load.
  const managedCfg = decryptManagedKeys(home, rawManaged);
  const projectCfg = parseYamlFile(projectPath);

  for (const [src, file] of [
    [globalCfg, globalPath],
    [managedCfg, managedPath],
    [projectCfg, projectPath],
  ] as [Partial<HarnessConfig>, string][]) {
    const issues = inspectSource(src as Record<string, unknown>, file);
    if (issues.typeErrors.length > 0) {
      throw new ConfigError(
        issues.typeErrors.map((m) => `${file}: ${m}`).join("\n"),
      );
    }
  }

  // Config schema version (#134): a config explicitly stamped newer than this
  // build supports is rejected (it would be misread), an older one is migrated
  // through the MIGRATIONS chain and warned, and unversioned legacy configs
  // are treated as current so existing homes boot without churn.
  const cfgVersion = readConfigVersion(globalCfg);
  if (cfgVersion !== null && cfgVersion > CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(
      `${globalPath}: config schema version ${cfgVersion} is newer than this build supports (${CONFIG_SCHEMA_VERSION}) — update Tenjin before using this home`,
    );
  }
  if (cfgVersion !== null && cfgVersion < CONFIG_SCHEMA_VERSION) {
    const { applied } = migrateConfig(
      globalCfg as Record<string, unknown>,
      cfgVersion,
      CONFIG_SCHEMA_VERSION,
    );
    console.warn(
      `[config] ${globalPath}: schema v${cfgVersion} → v${CONFIG_SCHEMA_VERSION} (${applied} migration step(s) applied)`,
    );
  }

  const merged: HarnessConfig = deepMerge(
    deepMerge(deepMerge(DEFAULTS, globalCfg), managedCfg),
    projectCfg,
  );
  merged.version = CONFIG_SCHEMA_VERSION;

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
  if (
    cfg.maxTreeIterations !== undefined &&
    (typeof cfg.maxTreeIterations !== "number" || !Number.isInteger(cfg.maxTreeIterations) || cfg.maxTreeIterations < 0)
  ) {
    throw new ConfigError(`maxTreeIterations must be a non-negative integer (0 = unlimited)`);
  }
  validatePricing(cfg.pricing);
  validateInbox(cfg.inbox);
  validateRetry(cfg.retry);
  validateGlobalBudget(cfg.globalBudget);
  validateContext(cfg.context);
  validateRouting(cfg.routing);
  validateWorkspaceConfig(cfg.workspace);
}

function validateRatePair(pair: unknown, label: string): void {
  if (typeof pair !== "object" || pair === null) {
    throw new ConfigError(`${label} must be a mapping with inputPerMTok and outputPerMTok`);
  }
  const obj = pair as Record<string, unknown>;
  if (typeof obj.inputPerMTok !== "number" || obj.inputPerMTok < 0) {
    throw new ConfigError(`${label}.inputPerMTok must be a number >= 0`);
  }
  if (typeof obj.outputPerMTok !== "number" || obj.outputPerMTok < 0) {
    throw new ConfigError(`${label}.outputPerMTok must be a number >= 0`);
  }
}

function validateRouting(routing: RouterConfig | undefined): void {
  if (routing === undefined) return;
  if (typeof routing !== "object" || routing === null) {
    throw new ConfigError(`routing must be a mapping`);
  }
  if (routing.stickyTtlMs !== undefined && (typeof routing.stickyTtlMs !== "number" || routing.stickyTtlMs < 0)) {
    throw new ConfigError(`routing.stickyTtlMs must be a number >= 0`);
  }
  if (
    routing.retriesPerDeployment !== undefined &&
    (typeof routing.retriesPerDeployment !== "number" ||
      !Number.isInteger(routing.retriesPerDeployment) ||
      routing.retriesPerDeployment < 1)
  ) {
    throw new ConfigError(`routing.retriesPerDeployment must be an integer >= 1`);
  }
  for (const [alias, chain] of Object.entries(routing.aliases ?? {})) {
    if (typeof chain !== "object" || chain === null || !Array.isArray(chain.deployments)) {
      throw new ConfigError(`routing.aliases.${alias} must be a mapping with a deployments list`);
    }
    if (chain.deployments.length === 0) {
      throw new ConfigError(`routing.aliases.${alias}.deployments must not be empty`);
    }
    chain.deployments.forEach((dep, i) => {
      const path = `routing.aliases.${alias}.deployments[${i}]`;
      if (typeof dep !== "object" || dep === null) {
        throw new ConfigError(`${path} must be a mapping`);
      }
      if (typeof dep.provider !== "string" || dep.provider.length === 0) {
        throw new ConfigError(`${path}.provider must be a non-empty string`);
      }
      if (typeof dep.model !== "string" || dep.model.length === 0) {
        throw new ConfigError(`${path}.model must be a non-empty string`);
      }
    });
  }
  if (routing.default !== undefined) {
    if (typeof routing.default !== "string" || routing.default.length === 0) {
      throw new ConfigError(`routing.default must be a non-empty alias name`);
    }
    const aliasNames = new Set(Object.keys(routing.aliases ?? {}));
    if (!aliasNames.has(routing.default)) {
      throw new ConfigError(
        `routing.default "${routing.default}" must name an existing alias (aliases: ${[...aliasNames].join(", ") || "none"})`,
      );
    }
  }
  for (const [task, alias] of Object.entries(routing.tasks ?? {})) {
    if (typeof alias !== "string" || alias.length === 0) {
      throw new ConfigError(`routing.tasks.${task} must be a non-empty alias string`);
    }
  }
}

function validateInbox(inbox: InboxConfig | undefined): void {
  if (inbox === undefined) return;
  if (typeof inbox !== "object" || inbox === null) {
    throw new ConfigError(`inbox must be a mapping`);
  }
  if (inbox.ttlDays !== undefined && (typeof inbox.ttlDays !== "number" || inbox.ttlDays < 0)) {
    throw new ConfigError(`inbox.ttlDays must be a number >= 0 (0 = never expire)`);
  }
  if (
    inbox.maxMessages !== undefined &&
    (typeof inbox.maxMessages !== "number" || inbox.maxMessages < 0 || !Number.isInteger(inbox.maxMessages))
  ) {
    throw new ConfigError(`inbox.maxMessages must be an integer >= 0 (0 = unlimited)`);
  }
}

function validateRetry(retry: RetryConfig | undefined): void {
  if (retry === undefined) return;
  if (typeof retry !== "object" || retry === null) {
    throw new ConfigError(`retry must be a mapping`);
  }
  if (retry.enabled !== undefined && typeof retry.enabled !== "boolean") {
    throw new ConfigError(`retry.enabled must be a boolean`);
  }
  if (
    retry.maxAttempts !== undefined &&
    (typeof retry.maxAttempts !== "number" || retry.maxAttempts < 1 || !Number.isInteger(retry.maxAttempts))
  ) {
    throw new ConfigError(`retry.maxAttempts must be an integer >= 1`);
  }
  if (retry.initialDelayMs !== undefined && (typeof retry.initialDelayMs !== "number" || retry.initialDelayMs < 0)) {
    throw new ConfigError(`retry.initialDelayMs must be a number >= 0`);
  }
  if (retry.maxDelayMs !== undefined && (typeof retry.maxDelayMs !== "number" || retry.maxDelayMs < 0)) {
    throw new ConfigError(`retry.maxDelayMs must be a number >= 0`);
  }
  if (retry.retryableStatuses !== undefined) {
    if (
      !Array.isArray(retry.retryableStatuses) ||
      retry.retryableStatuses.some(
        (s) => typeof s !== "number" || !Number.isInteger(s) || s < 100 || s > 599,
      )
    ) {
      throw new ConfigError(`retry.retryableStatuses must be a list of HTTP status codes (100-599)`);
    }
  }
}

function validateGlobalBudget(budget: GlobalBudgetConfig | undefined): void {
  if (budget === undefined) return;
  if (typeof budget !== "object" || budget === null) {
    throw new ConfigError(`globalBudget must be a mapping`);
  }
  if (budget.dailyUSD !== undefined && (typeof budget.dailyUSD !== "number" || budget.dailyUSD < 0)) {
    throw new ConfigError(`globalBudget.dailyUSD must be a number >= 0 (0 = unlimited)`);
  }
  if (budget.monthlyUSD !== undefined && (typeof budget.monthlyUSD !== "number" || budget.monthlyUSD < 0)) {
    throw new ConfigError(`globalBudget.monthlyUSD must be a number >= 0 (0 = unlimited)`);
  }
}

function validateContext(context: ContextConfig | undefined): void {
  if (context === undefined) return;
  if (typeof context !== "object" || context === null) {
    throw new ConfigError(`context must be a mapping`);
  }
  if (
    context.thresholdRatio !== undefined &&
    (typeof context.thresholdRatio !== "number" ||
      context.thresholdRatio <= 0 ||
      context.thresholdRatio > 1)
  ) {
    throw new ConfigError(`context.thresholdRatio must be a number in (0, 1]`);
  }
  if (
    context.defaultWindow !== undefined &&
    (typeof context.defaultWindow !== "number" || context.defaultWindow < 1)
  ) {
    throw new ConfigError(`context.defaultWindow must be a number >= 1`);
  }
  if (context.windows !== undefined) {
    if (typeof context.windows !== "object" || context.windows === null) {
      throw new ConfigError(`context.windows must be a mapping of model -> window tokens`);
    }
    for (const [model, tokens] of Object.entries(context.windows)) {
      if (typeof tokens !== "number" || tokens < 1) {
        throw new ConfigError(`context.windows.${model} must be a number >= 1`);
      }
    }
  }
}

function validatePricing(pricing: PricingConfig | undefined): void {
  if (pricing === undefined) return;
  if (typeof pricing !== "object" || pricing === null) {
    throw new ConfigError(`pricing must be a mapping`);
  }
  const hasIn = pricing.inputPerMTok !== undefined;
  const hasOut = pricing.outputPerMTok !== undefined;
  if (hasIn !== hasOut) {
    throw new ConfigError(`pricing requires both inputPerMTok and outputPerMTok`);
  }
  if (hasIn) {
    validateRatePair(
      { inputPerMTok: pricing.inputPerMTok, outputPerMTok: pricing.outputPerMTok },
      "pricing",
    );
  }
  if (pricing.default !== undefined) {
    validateRatePair(pricing.default, "pricing.default");
  }
}
