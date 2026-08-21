import type { Provider, Usage } from "./provider/types";
import { formatModelRef, type ModelRef } from "./config/models";
import type { PricingConfig } from "./config/loader";
import { createBudget } from "./agent/budget";
import { runHeadless, type HeadlessOptions } from "./agent/headless";

/** One parallel contender: a resolved model reference bound to a provider instance. */
export interface ArenaEntry {
  ref: ModelRef;
  provider: Provider;
}

export interface ArenaCandidate {
  ref: ModelRef;
  text: string;
  stopReason: string;
  latencyMs: number;
  costUSD: number;
  usage: Usage;
  error?: string;
}

export interface ArenaOptions {
  entries: ArenaEntry[];
  message: string;
  soulText?: string;
  cwd: string;
  maxTokens: number;
  /** Shared spend cap across all parallel runs (summed). */
  capUSD: number;
  pricing?: PricingConfig;
  policy?: HeadlessOptions["policy"];
  /** 1-based index of the entry to mark as winner. */
  winnerIndex?: number;
}

export interface ArenaResult {
  candidates: ArenaCandidate[];
  totalCostUSD: number;
  /** 1-based index into candidates, when a winner was requested. */
  winner?: number;
}

/**
 * Race the same prompt through several models in parallel (one headless run per
 * entry). All runs draw from a single shared Budget, so `capUSD` bounds the sum
 * of every run, not each run individually. A per-entry failure is captured as
 * `error` rather than rejecting the whole arena.
 */
export async function runArena(opts: ArenaOptions): Promise<ArenaResult> {
  if (opts.entries.length === 0) {
    throw new Error("arena needs at least one model (--models)");
  }
  const budget = createBudget(opts.capUSD, opts.pricing);

  const candidates = await Promise.all(
    opts.entries.map(async (entry): Promise<ArenaCandidate> => {
      const started = performance.now();
      try {
        const res = await runHeadless({
          provider: entry.provider,
          model: entry.ref.model,
          soulText: opts.soulText ?? "",
          cwd: opts.cwd,
          message: opts.message,
          maxTokens: opts.maxTokens,
          capUSD: opts.capUSD,
          pricing: opts.pricing,
          budget,
          policy: opts.policy,
        });
        return {
          ref: entry.ref,
          text: res.text,
          stopReason: res.stopReason,
          latencyMs: performance.now() - started,
          costUSD: res.costUSD,
          usage: res.usage,
        };
      } catch (e) {
        return {
          ref: entry.ref,
          text: "",
          stopReason: "error",
          latencyMs: performance.now() - started,
          costUSD: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          error: (e as Error).message,
        };
      }
    }),
  );

  const totalCostUSD = candidates.reduce((sum, c) => sum + c.costUSD, 0);
  const winner =
    opts.winnerIndex !== undefined &&
    opts.winnerIndex >= 1 &&
    opts.winnerIndex <= candidates.length
      ? opts.winnerIndex
      : undefined;
  return { candidates, totalCostUSD, ...(winner ? { winner } : {}) };
}

/** Plain-text arena report: one block per model with a compact summary line. */
export function renderArena(result: ArenaResult, prompt: string): string {
  const lines: string[] = [`Arena — "${prompt}"`, ""];
  result.candidates.forEach((c, i) => {
    const tag = result.winner === i + 1 ? "  ✓ winner" : "";
    const mark = c.error ? "  ✗ error" : "";
    lines.push(
      `[${i + 1}] ${formatModelRef(c.ref)}${tag}${mark}`,
    );
    if (c.error) {
      lines.push(`    failed: ${c.error}`);
    } else {
      lines.push(
        `    ${c.stopReason} · ${c.latencyMs.toFixed(0)} ms · ${c.usage.inputTokens} in / ${c.usage.outputTokens} out · $${c.costUSD.toFixed(4)}`,
      );
      lines.push(`    ${c.text}`);
    }
    lines.push("");
  });
  lines.push(`Total cost: $${result.totalCostUSD.toFixed(4)}`);
  return lines.join("\n");
}
