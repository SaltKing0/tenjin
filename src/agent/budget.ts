import type { Usage } from "../provider/types";
import type { PricingOverride } from "../config/loader";

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

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

export function pricingFor(model: string, override?: PricingOverride): Pricing {
  if (override) return override;
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING_PREFIXES) {
    if (lower.startsWith(prefix)) return pricing;
  }
  return { inputPerMTok: 0, outputPerMTok: 0 };
}

export class Budget {
  spentUSD = 0;
  private byModel = new Map<string, number>();

  constructor(
    readonly capUSD: number,
    private pricingOverride?: PricingOverride,
  ) {}

  add(usage: Usage, model: string): number {
    const p = pricingFor(model, this.pricingOverride);
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
