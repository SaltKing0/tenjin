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
  provider: ProviderName;
  model: string;
  maxTokens: number;
  budgetUSD: number;
  approval: Record<string, ApprovalMode>;
  pricing?: PricingConfig;
  providers?: {
    openai?: { baseUrl?: string; apiKey?: string };
    anthropic?: { apiKey?: string; caching?: boolean };
  };
  models?: { default?: string; cheap?: string };
  gateway?: unknown;
  security?: {
    blockedPatterns?: string[];
    disabled?: boolean;
    redaction?: boolean;
    workspaceRoot?: string;
    allowedPaths?: string[];
  };
  memory?: {
    enabled?: boolean;
    vector?: { enabled?: boolean; model?: string };
    summaries?: { onSessionEnd?: boolean };
  };
  inbox?: InboxConfig;
  retry?: RetryConfig;
  /** Global spend limits (USD) across all scopes — see audit/global-budget.ts. */
  globalBudget?: GlobalBudgetConfig;
  context?: ContextConfig;
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
