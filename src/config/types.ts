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
}

/** `inbox` in config.yaml. 0 disables the corresponding limit. */
export interface InboxConfig {
  ttlDays?: number;
  maxMessages?: number;
}
