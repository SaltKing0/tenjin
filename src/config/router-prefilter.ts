/**
 * Heuristic routing pre-filter (Roadmap §13 B10-2, #413).
 *
 * A cheap, deterministic, debuggable decision layer that runs BEFORE any model
 * call — no extra LLM round-trip for the obvious cases. It evaluates pure
 * signals in a fixed order and, when exactly one fires, returns a tier hint the
 * Router uses to pick a deployment:
 *
 *   1. has_images            → multimodal-capable tier (frontier)
 *   2. context size > threshold → larger-window deployment (frontier)
 *   3. tool-heavy turn       → Mid tier (registered tool count / schema bytes)
 *   4. task-type keywords    → tier hints (code/review/summarize/chat)
 *
 * AMBIGUOUS cases fall THROUGH to later classification (B10-6): the pre-filter
 * never guesses. If no signal fires the decision is `null` and downstream
 * routing decides. Every decision is logged with its triggering signal and a
 * stable routing-decision-id so it can join traces (B10-5 ready).
 *
 * The module is PURE: it never constructs or calls a provider — the "no
 * provider call during pre-filter" guarantee is structural.
 */

import type { ModelTier } from "./types";

export type PreFilterSignal = "images" | "context" | "tools" | "task-type";

export interface PreFilterInput {
  has_images?: boolean;
  contextTokens?: number;
  toolCount?: number;
  toolSchemaBytes?: number;
  taskType?: string;
}

export interface PreFilterThresholds {
  /** Context tokens above this → larger-window (frontier). Default 200_000. */
  contextTokens?: number;
  /** Registered tool count at/above this → Mid tier. Default 12. */
  toolCount?: number;
  /** Tool schema bytes at/above this → Mid tier. Default 40_000. */
  toolSchemaBytes?: number;
}

export interface PreFilterDecision {
  tier: ModelTier;
  signal: PreFilterSignal;
}

export interface PreFilterResult {
  /** The fired signal decision, or null when everything fell through. */
  decision: PreFilterDecision | null;
  /** Per-signal evaluation, in evaluation order (for debugging / the log). */
  evaluations: Array<{ signal: PreFilterSignal; tier: ModelTier | null }>;
}

export const DEFAULT_PREFILTER_THRESHOLDS: Required<PreFilterThresholds> = {
  contextTokens: 200_000,
  toolCount: 12,
  toolSchemaBytes: 40_000,
};

/** Task-type keyword → tier hints (first match wins, deterministic order). */
const TASK_TIER_HINTS: Array<[RegExp, ModelTier]> = [
  [/code|refactor|implement|debug\b|fix\b/i, "frontier"],
  [/review|audit|inspect|test\b/i, "mid"],
  [/summar|compact|condense/i, "budget"],
  [/chat|draft|title|label/i, "budget"],
];

/** Multimodal-capable tier for image-bearing turns. */
const IMAGE_TIER: ModelTier = "frontier";
/** Larger-window deployment for oversized contexts. */
const CONTEXT_TIER: ModelTier = "frontier";
/** Mid tier for tool-heavy turns. */
const TOOL_TIER: ModelTier = "mid";

export function evaluatePreFilter(
  input: PreFilterInput,
  thresholds: PreFilterThresholds = {},
): PreFilterResult {
  const t = { ...DEFAULT_PREFILTER_THRESHOLDS, ...thresholds };
  const evaluations: PreFilterResult["evaluations"] = [];

  const fire = (signal: PreFilterSignal, tier: ModelTier): PreFilterResult => {
    evaluations.push({ signal, tier });
    return { decision: { tier, signal }, evaluations };
  };
  const fallThrough = (signal: PreFilterSignal): void => {
    evaluations.push({ signal, tier: null });
  };

  // 1. Image-bearing turn → multimodal tier.
  if (input.has_images) return fire("images", IMAGE_TIER);
  fallThrough("images");

  // 2. Oversized context → larger-window deployment.
  if ((input.contextTokens ?? 0) > t.contextTokens) return fire("context", CONTEXT_TIER);
  fallThrough("context");

  // 3. Tool-heavy turn → Mid tier.
  const toolHeavy =
    (input.toolCount ?? 0) >= t.toolCount || (input.toolSchemaBytes ?? 0) >= t.toolSchemaBytes;
  if (toolHeavy) return fire("tools", TOOL_TIER);
  fallThrough("tools");

  // 4. Task-type keyword → tier hint.
  const taskType = input.taskType?.trim().toLowerCase();
  if (taskType) {
    for (const [re, tier] of TASK_TIER_HINTS) {
      if (re.test(taskType)) return fire("task-type", tier);
    }
  }
  fallThrough("task-type");

  return { decision: null, evaluations };
}

/** A decision-log entry that can join traces (B10-5 ready). */
export interface RoutingDecisionLogEntry {
  routing_decision_id: string;
  alias: string;
  signal: PreFilterSignal | null;
  tier: ModelTier | null;
  task_id?: string;
  session_id?: string;
  at: string;
}

/**
 * Build a stable, joinable decision-log entry. `routing_decision_id` is
 * deterministic per (alias, task/session, sequence) so downstream spans can
 * correlate on it without a global registry.
 */
export function buildDecisionLogEntry(opts: {
  routing_decision_id: string;
  alias: string;
  decision: PreFilterDecision | null;
  task_id?: string;
  session_id?: string;
  at?: string;
}): RoutingDecisionLogEntry {
  return {
    routing_decision_id: opts.routing_decision_id,
    alias: opts.alias,
    signal: opts.decision?.signal ?? null,
    tier: opts.decision?.tier ?? null,
    task_id: opts.task_id,
    session_id: opts.session_id,
    at: opts.at ?? new Date().toISOString(),
  };
}
