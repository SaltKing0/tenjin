export type ProviderName = "anthropic" | "openai";
export type ApprovalMode = "ask" | "allow" | "deny";
/** Model cost tier (B10-1/B10-4). Budget hosts the helper utilities. */
export type ModelTier = "frontier" | "mid" | "budget";

export class ConfigError extends Error {}

export interface PricingOverride {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** `pricing` in config.yaml / providers.yaml. */
export interface PricingConfig {
  /** When both are set, overrides the built-in table for every model. */
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Fallback for models not in the built-in prefix table. */
  default?: PricingOverride;
}

export interface HarnessConfig {
  /** Config-file schema version (see loader.CONFIG_SCHEMA_VERSION). Optional;
   * an absent field is treated as "current" for backwards compatibility;
   * missing/older versions are migrated at load. */
  version?: number;
  provider: ProviderName;
  model: string;
  maxTokens: number;
  budgetUSD: number;
  approval: Record<string, ApprovalMode>;
  /** B13-5 (#437): mode ladder — manual | acceptEdits | auto | dontAsk | bypass.
   *  Higher-level default than `approval`; never widens the T2 law. */
  mode?: {
    ladder?: "manual" | "acceptEdits" | "auto" | "dontAsk" | "bypass";
    /** Env var that must be set for `bypass` to be usable (isolation). */
    bypassEnv?: string;
    /** Tool names that force a human checkpoint even in auto. */
    askRules?: string[];
    /** Extra tool names pre-allowed in auto (routine work). */
    autoAllow?: string[];
  };
  pricing?: PricingConfig;
  providers?: {
    openai?: { baseUrl?: string; apiKey?: string };
    anthropic?: { apiKey?: string; baseUrl?: string; caching?: boolean };
  };
  models?: { default?: string; cheap?: string };
  /** B10-1/B10-4 routing core: task→alias→deployment chains (see router.ts). */
  routing?: RouterConfig;
  /** web_search tool (#345): default-OFF. Requires webSearch.apiKey or BRAVE_API_KEY. */
  webSearch?: {
    enabled?: boolean;
    apiKey?: string;
    /** Endpoint override (tests point this at a local fixture server). */
    endpoint?: string;
  };
  gateway?: unknown;
  security?: {
    blockedPatterns?: string[];
    disabled?: boolean;
    redaction?: boolean;
    workspaceRoot?: string;
    allowedPaths?: string[];
    /** Mask suspected prompt-injection tool output before it reaches the model. */
    paranoid?: boolean;
    /** Domains (or *.sub) that web_fetch may never access. */
    denyDomains?: string[];
    /** #347: deny-list globs for MCP tool names (`mcp__server__tool`). */
    mcpDenyPatterns?: string[];
    /** B12-5 (#431): outbound egress allowlist — deny-by-default for web_fetch
     *  when set. Empty/absent keeps the current deny-list-only behaviour. */
    egress?: { allowlist?: string[] };
  };
  memory?: {
    enabled?: boolean;
    vector?: { enabled?: boolean; model?: string };
    summaries?: { onSessionEnd?: boolean };
    /** Cap on durable takeaways stored per learnings.md file (#204). */
    learnings?: { maxEntries?: number };
  };
  /** Outbound event webhooks (#148): `events.webhooks` list; ntfy (#149): `events.ntfy`. */
  events?: {
    webhooks?: unknown;
    ntfy?: unknown;
  };
  inbox?: InboxConfig;
  retry?: RetryConfig;
  /** Global spend limits (USD) across all scopes — see audit/global-budget.ts. */
  globalBudget?: GlobalBudgetConfig;
  /** #154: global safety-net — max iterations per delegation tree (shared
   * across a parent run and every delegate); 0 = unlimited (default). */
  maxTreeIterations?: number;
  context?: ContextConfig;
  /** MCP stdio servers (default OFF — see tools/mcp.ts). */
  mcp?: McpConfig;
  /** B15-7 (#439): expose Tenjin's own tools/skills to external MCP clients.
   *  DENY-BY-DEFAULT — only names listed here are advertised/callable. */
  mcpServer?: McpServerConfig;
  /** B12-3 (#424): execution-surface switch — local | docker | remote. */
  workspace?: {
    mode?: "local" | "docker" | "remote";
    docker?: {
      image?: string;
      workdir?: string;
      memoryMax?: string;
      cpuQuota?: number;
      user?: string;
    };
    /** Orphan-container TTL for docker workspaces (ms). */
    ttlMs?: number;
  };
}

/** `routing` in config.yaml — B10-1/B10-4 routing core (task→alias→deployment). */
export interface RouterConfig {
  /** Alias (or task) the DEFAULT agent run routes on when routing is enabled.
   *  Absent → the first alias in `aliases`. */
  default?: string;
  /** Named failover chains; the value an alias resolves to. */
  aliases?: Record<string, AliasConfig>;
  /** Deterministic task_id → alias-name table (debuggable, no magic). */
  tasks?: Record<string, string>;
  /** Stickiness TTL in ms: one provider+model pinned per session/task. */
  stickyTtlMs?: number;
  /** Retry attempts on a deployment before failing over to the next (>= 1). */
  retriesPerDeployment?: number;
}

/** A named failover chain: deployments tried in array order. */
export interface AliasConfig {
  deployments: DeploymentConfig[];
}

/** One hop in a failover chain (`routing.aliases.<name>.deployments[]`). */
export interface DeploymentConfig {
  /** Provider id registered in the registry (openai/anthropic or a BYOM factory). */
  provider: string;
  model: string;
  /** Options passthrough to the provider call (e.g. maxTokens). */
  options?: Record<string, unknown>;
  baseUrl?: string;
  /** API key for this deployment (usually omitted → registry/env fallback). */
  key?: string;
  priority?: number;
  tags?: string[];
  tier?: ModelTier;
}

/** `globalBudget` in config.yaml — global spend caps across solo + all bots. */
export interface GlobalBudgetConfig {
  /** Max total spend (USD) for the UTC calendar day across all scopes; 0 = unlimited. */
  dailyUSD?: number;
  /** Max total spend (USD) for the UTC calendar month across all scopes; 0 = unlimited. */
  monthlyUSD?: number;
}

/** `inbox` in config.yaml. 0 disables the corresponding limit. */
export interface InboxConfig {
  ttlDays?: number;
  maxMessages?: number;
}

/** `retry` in config.yaml — provider request retry with exponential backoff. */
export interface RetryConfig {
  /** Master switch; retries are on by default. */
  enabled?: boolean;
  /** Total attempts including the first (>= 1). */
  maxAttempts?: number;
  /** Backoff delay before the first retry, doubling each attempt (ms). */
  initialDelayMs?: number;
  /** Upper bound on the per-attempt backoff (ms). */
  maxDelayMs?: number;
  /** HTTP statuses that trigger a retry (429 or 5xx by default). */
  retryableStatuses?: number[];
}

/** `context` in config.yaml — context-window guard (#101). */
export interface ContextConfig {
  /** Master switch; on by default. */
  enabled?: boolean;
  /** Compress when the estimate exceeds this fraction of the window. Default 0.8. */
  thresholdRatio?: number;
  /** Context window (tokens) for models not in the built-in table or `windows`. */
  defaultWindow?: number;
  /** Per-model context-window override (tokens). */
  windows?: Record<string, number>;
  /** Adaptive staged compaction (B2-3/B2-4). */
  compaction?: {
    enabled?: boolean;
    table?: Record<string, number>;
    keepLast?: number;
    minTurnsBetween?: number;
    archiveDir?: string;
  };
  /** End-of-session consolidation pass (B9-3). */
  consolidation?: {
    enabled?: boolean;
    /** Pressure ratio (0..1) at which the pass fires. Default 0.65. */
    threshold?: number;
    /** Min turns between passes without strictly-higher pressure. Default 5. */
    minTurnsBetween?: number;
    /** Opt-in contradiction check on newly-distilled learnings (IdeaGraph
     *  derived): judges each new learning against active facts and records any
     *  contradiction. Off by default. */
    contradictionCheck?: {
      enabled?: boolean;
      /** Cap on total judge calls (default 4). */
      maxChecks?: number;
      /** Dedicated judge model; defaults to the cheap/helper model. */
      model?: string;
    };
  };
}

/** `mcp` in config.yaml — MCP stdio servers (WPs 3.1+3.2). Default OFF. */
export interface McpConfig {
  servers?: Array<Record<string, unknown>>;
}

/** B15-7 (#439) — expose Tenjin's own tools/skills to external MCP clients.
 *  DENY-BY-DEFAULT: an empty/absent list exposes nothing. */
export interface McpServerConfig {
  /** Allowlisted native tool / skill names advertised to MCP clients. */
  expose?: string[];
}
