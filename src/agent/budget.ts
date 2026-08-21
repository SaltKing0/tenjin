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

/**
 * A shared budget counter for a delegation tree (#154). One instance is
 * created at the root of a tree (or inherited from the parent run) and every
 * subagent run — however deep — counts its iterations and USD into the SAME
 * object, so a chain of delegations cannot multiply work past a single cap.
 *
 * Caps are optional (`0` = unlimited). `stopped` is sticky: once the iteration
 * or USD cap is crossed, every deeper run in the tree sees it on its next
 * iteration and halts with a clear error instead of starting fresh work.
 */
export class TreeBudget {
  usedIterations = 0;
  usedUSD = 0;
  stopped = false;

  constructor(
    /** Max iterations across the whole tree; 0 = unlimited. */
    readonly maxIterations: number,
    /** Max USD across the whole tree; 0 = unlimited. */
    readonly maxUSD: number,
  ) {}

  /**
   * #184: continue a delegation tree from a persisted snapshot. Across a
   * process boundary the in-memory TreeBudget object is unavailable, so a
   * chain that survives a restart carries its counter on a task's persisted
   * fields (treeUsedIterations / treeMaxIterations / ...). Seed the new
   * budget's used counters from that snapshot so a successor chain keeps
   * counting instead of restarting at 0.
   *
   * Returns `undefined` when the snapshot carries no cap (a cap-less tree is
   * left unbudgeted, matching how an in-process chain with no cap behaves).
   */
  static continueFrom(snapshot: {
    maxIterations?: number;
    usedIterations?: number;
    maxUsd?: number;
    usedUsd?: number;
  }): TreeBudget | undefined {
    const maxIterations = snapshot.maxIterations ?? 0;
    const maxUsd = snapshot.maxUsd ?? 0;
    if (maxIterations <= 0 && maxUsd <= 0) return undefined;
    const tb = new TreeBudget(maxIterations, maxUsd);
    tb.usedIterations = Math.max(0, snapshot.usedIterations ?? 0);
    tb.usedUSD = Math.max(0, snapshot.usedUsd ?? 0);
    // An already-exhausted tree stays stopped so a successor halts immediately
    // (with a clear tree_budget_exceeded) instead of starting fresh work.
    if (
      (tb.hasIterationCap && tb.usedIterations >= tb.maxIterations) ||
      (tb.hasUsdCap && tb.usedUSD >= tb.maxUSD)
    ) {
      tb.stopped = true;
    }
    return tb;
  }

  get hasIterationCap(): boolean {
    return this.maxIterations > 0;
  }

  get hasUsdCap(): boolean {
    return this.maxUSD > 0;
  }

  /** True when either cap is configured. A cap-less budget just counts. */
  get hasCaps(): boolean {
    return this.hasIterationCap || this.hasUsdCap;
  }

  /** What fraction of the caps is used, for status/task reporting. */
  ratio(): { iterations: number; usd: number } {
    return {
      iterations: this.hasIterationCap ? Math.min(1, this.usedIterations / this.maxIterations) : 0,
      usd: this.hasUsdCap ? Math.min(1, this.usedUSD / this.maxUSD) : 0,
    };
  }

  /**
   * Reserve this run's next iteration. Returns true when the run may continue;
   * false when the (possibly already-sticky) tree iteration cap is exhausted,
   * which should stop this run immediately.
   */
  consumeIteration(): boolean {
    if (this.stopped) return false;
    this.usedIterations += 1;
    if (this.hasIterationCap && this.usedIterations > this.maxIterations) {
      this.stopped = true;
      return false;
    }
    return true;
  }

  /** Charge the cost of a just-completed turn against the shared USD cap. */
  addUsd(cost: number): void {
    this.usedUSD += cost;
    if (this.hasUsdCap && this.usedUSD >= this.maxUSD) {
      this.stopped = true;
    }
  }
}
