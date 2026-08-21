import type { ToolPolicy } from "./headless";

/**
 * Effort levels (#142): a human-readable dial that maps onto concrete run
 * limits — maximum iterations, token budget, and (for `low`) a read-only tool
 * policy. `medium` is the baseline, so existing runs are unchanged by default.
 */

export type EffortLevel = "low" | "medium" | "high" | "max";

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "max",
];

/** Baseline per-run iteration cap, matching `runAgentTurn`'s MAX_ITERATIONS. */
export const EFFORT_DEFAULT_MAX_ITERATIONS = 25;

export interface EffortLimits {
  maxIterations: number;
  /** Absolute token cap for the run (scaled from the caller's base maxTokens). */
  maxTokens: number;
  /** Optional forced tool policy; `low` caps every run to read-only. */
  toolPolicy?: ToolPolicy;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string" &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Map an effort level onto concrete runtime limits. Defaults to `medium`. */
export function effortLimits(
  level: EffortLevel | undefined,
  baseMaxTokens: number,
): EffortLimits {
  switch (level) {
    case "low":
      return {
        maxIterations: 3,
        maxTokens: Math.max(1, Math.floor(baseMaxTokens * 0.5)),
        toolPolicy: "read-only",
      };
    case "high":
      return {
        maxIterations: 75,
        maxTokens: baseMaxTokens * 3,
      };
    case "max":
      return {
        maxIterations: 200,
        maxTokens: baseMaxTokens * 6,
      };
    case "medium":
    default:
      return {
        maxIterations: EFFORT_DEFAULT_MAX_ITERATIONS,
        maxTokens: baseMaxTokens,
      };
  }
}
