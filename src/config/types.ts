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
    anthropic?: { apiKey?: string };
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
  };
  inbox?: InboxConfig;
  retry?: RetryConfig;
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
