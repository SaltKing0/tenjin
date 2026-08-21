import type { Usage } from "../provider/types";
import type { PricingConfig, PricingOverride } from "../config/loader";

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Conservative fallback so unknown models still consume budget. Override via `pricing.default`. */
export const DEFAULT_PRICING: Pricing = { inputPerMTok: 5, outputPerMTok: 15 };

const PRICING_PREFIXES: Array<[string, Pricing]> = [
  ["claude-opus", { inputPerMTok: 15, outputPerMTok: 75 }],
  ["claude-sonnet", { inputPerMTok: 3, outputPerMTok: 15 }],
  ["claude-haiku", { inputPerMTok: 0.8, outputPerMTok: 4 }],
  ["gpt-4o-mini", { inputPerMTok: 0.15, outputPerMTok: 0.6 }],
  ["gpt-4o", { inputPerMTok: 2.5, outputPerMTok: 10 }],
  ["gpt-4.1-mini", { inputPerMTok: 0.4, outputPerMTok: 1.6 }],
  ["gpt-4.1", { inputPerMTok: 2, outputPerMTok: 8 }],
  ["deepseek-chat", { inputPerMTok: 0.27, outputPerMTok: 1.1 }],
  ["deepseek-reasoner", { inputPerMTok: 0.55, outputPerMTok: 2.19 }],
];

const warnedUnknown = new Set<string>();

export function resetUnknownModelWarnings(): void {
  warnedUnknown.clear();
}

function warnUnknownModel(model: string, used: Pricing): void {
  const key = model.toLowerCase();
  if (warnedUnknown.has(key)) return;
  warnedUnknown.add(key);
  console.warn(
    `budget: unknown model "${model}" — using default pricing $${used.inputPerMTok}/$${used.outputPerMTok} per 1M in/out. Set pricing.default in providers.yaml to configure.`,
  );
}

function asPair(cfg: PricingConfig | undefined): Pricing | undefined {
  if (
    cfg &&
    typeof cfg.inputPerMTok === "number" &&
    typeof cfg.outputPerMTok === "number"
  ) {
    return { inputPerMTok: cfg.inputPerMTok, outputPerMTok: cfg.outputPerMTok };
  }
  return undefined;
}

export function pricingFor(
  model: string,
  override?: PricingOverride,
  defaultPricing?: PricingOverride,
): Pricing {
  if (override) return override;
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING_PREFIXES) {
    if (lower.startsWith(prefix)) return pricing;
  }
  const used = defaultPricing ?? DEFAULT_PRICING;
  warnUnknownModel(model, used);
  return used;
}

/** Build a Budget from harness `pricing` (full override and/or `pricing.default`). */
export function createBudget(capUSD: number, pricing?: PricingConfig): Budget {
  return new Budget(capUSD, asPair(pricing), pricing?.default);
}

export class Budget {
  spentUSD = 0;
  private byModel = new Map<string, number>();

  constructor(
    readonly capUSD: number,
    private pricingOverride?: PricingOverride,
    private defaultPricing?: PricingOverride,
  ) {}

  add(usage: Usage, model: string): number {
    const p = pricingFor(model, this.pricingOverride, this.defaultPricing);
    const inTok = usage.inputTokens ?? 0;
    const outTok = usage.outputTokens ?? 0;
    const cost = (inTok * p.inputPerMTok + outTok * p.outputPerMTok) / 1_000_000;
    this.spentUSD += cost;
    this.byModel.set(model, (this.byModel.get(model) ?? 0) + cost);
    return cost;
  }

  get exhausted(): boolean {
    return this.capUSD > 0 && this.spentUSD >= this.capUSD;
  }

  breakdown(): Array<{ model: string; usd: number }> {
    return [...this.byModel.entries()]
      .map(([model, usd]) => ({ model, usd }))
      .sort((a, b) => b.usd - a.usd);
  }
}

export function formatUSD(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
