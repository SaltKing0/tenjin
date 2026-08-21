export type ProviderName = "anthropic" | "openai";
export type ApprovalMode = "ask" | "allow" | "deny";

export class ConfigError extends Error {}

export interface PricingOverride {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface HarnessConfig {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  budgetUSD: number;
  approval: Record<string, ApprovalMode>;
  pricing?: PricingOverride;
  providers?: { openai?: { baseUrl?: string } };
  models?: { default?: string; cheap?: string };
  memory?: {
    enabled?: boolean;
    vector?: { enabled?: boolean; model?: string };
  };
}
