export type ProviderName = "anthropic" | "openai";
export type ApprovalMode = "ask" | "allow" | "deny";

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
  pricing?: PricingConfig;
  providers?: {
    openai?: { baseUrl?: string; apiKey?: string };
    anthropic?: { apiKey?: string; baseUrl?: string; caching?: boolean };
  };
  models?: { default?: string; cheap?: string };
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
}

/** `mcp` in config.yaml — MCP stdio servers (WPs 3.1+3.2). Default OFF. */
export interface McpConfig {
  servers?: Array<Record<string, unknown>>;
}
