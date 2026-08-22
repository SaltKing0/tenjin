/**
 * Observability in the audit trail (Roadmap §7 B4-3/B4-4, #415).
 *
 * One instrumentation pass over the existing audit trail — no new storage,
 * just structure. Two primitives:
 *
 *   - TRACE SPANS: a strict hierarchy conversation → run → step →
 *     llm.completion / tool.execute with stable IDs, parent-child links and
 *     timing, plus structured error classes (infra/SDK/provider) and a stage
 *     tag — no free-text searching. Every span can carry a routing-decision-id
 *     when a router decision exists (B10-5 ready).
 *   - WHOLE-TREE SPEND: per-message/per-model token accounting (incl. cache
 *     read/write), DEDUPED by message id, and rolled up WHOLE-TREE into the
 *     parent TreeBudget so delegation can never hide cost.
 */

import type { TreeBudget } from "../agent/budget";

// ---------------------------------------------------------------------------
// Trace spans
// ---------------------------------------------------------------------------

export type SpanKind = "conversation" | "run" | "step" | "llm.completion" | "tool.execute";

/** Structured error class — never free-text. */
export type ErrorClass = "infra" | "sdk" | "provider";
/** Where in the lifecycle the error happened. */
export type Stage = "request" | "response" | "stream" | "tool";

export interface Span {
  id: string;
  kind: SpanKind;
  name: string;
  parentId?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  errorClass?: ErrorClass;
  stage?: Stage;
  restartReason?: string;
  routingDecisionId?: string;
}

export interface StartSpanOpts {
  kind: SpanKind;
  name: string;
  parentId?: string;
  stage?: Stage;
  restartReason?: string;
  routingDecisionId?: string;
}

/**
 * A tracer that records spans with stable ids and parent-child links. Times are
 * wall-clock ms (injectable `now` for deterministic tests).
 */
export class Tracer {
  private spans: Span[] = [];
  private seq = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  startSpan(opts: StartSpanOpts): string {
    const id = `${opts.kind}_${++this.seq}`;
    this.spans.push({
      id,
      kind: opts.kind,
      name: opts.name,
      parentId: opts.parentId,
      startedAt: this.now(),
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(opts.restartReason ? { restartReason: opts.restartReason } : {}),
      ...(opts.routingDecisionId ? { routingDecisionId: opts.routingDecisionId } : {}),
    });
    return id;
  }

  /** Close a span, computing its duration and attaching error class/stage. */
  endSpan(id: string, err?: { error?: string; errorClass?: ErrorClass; stage?: Stage }): void {
    const s = this.spans.find((x) => x.id === id);
    if (!s) return;
    s.endedAt = this.now();
    s.durationMs = Math.max(0, s.endedAt - s.startedAt);
    if (err?.errorClass) s.errorClass = err.errorClass;
    if (err?.error) s.error = err.error;
    if (err?.stage) s.stage = err.stage;
  }

  all(): Span[] {
    return [...this.spans];
  }
}

/** A span node in the derived span tree (children nested under parents). */
export interface SpanNode {
  id: string;
  kind: SpanKind;
  name: string;
  durationMs?: number;
  errorClass?: ErrorClass;
  stage?: Stage;
  routingDecisionId?: string;
  children: SpanNode[];
}

/**
 * Build the span tree (a forest) from recorded spans: parent-child by
 * parentId, root spans first, children in start order. A span whose parentId
 * references an unknown span is treated as a root (never dropped).
 */
export function buildSpanTree(spans: Span[]): SpanNode[] {
  const byId = new Map<string, Span>();
  for (const s of spans) byId.set(s.id, s);
  const roots: SpanNode[] = [];
  const nodes = new Map<string, SpanNode>();
  for (const s of spans) {
    nodes.set(s.id, {
      id: s.id,
      kind: s.kind,
      name: s.name,
      ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
      ...(s.errorClass ? { errorClass: s.errorClass } : {}),
      ...(s.stage ? { stage: s.stage } : {}),
      ...(s.routingDecisionId ? { routingDecisionId: s.routingDecisionId } : {}),
      children: [],
    });
  }
  for (const s of spans) {
    const node = nodes.get(s.id)!;
    if (s.parentId && byId.has(s.parentId)) {
      nodes.get(s.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Classify an error into EXACTLY ONE class + stage tag (structured, not
 * free-text). Ordered matching: sdk (abort/timeout) → provider (HTTP/status) →
 * infra (connectivity). Every error falls into exactly one bucket.
 */
export function classifyError(
  err: unknown,
): { errorClass: ErrorClass; stage: Stage } {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const m = message.toLowerCase();
  // SDK-level: aborts and timeouts (request phase).
  if (m.includes("abort") || m.includes("timeout")) {
    return { errorClass: "sdk", stage: "request" };
  }
  // Streaming-phase failures (SSE/chunk) — a provider status in a stream is
  // still a provider error, otherwise an SDK stream error.
  if (m.includes("stream") || m.includes("sse") || m.includes("chunk")) {
    if (/(?:status|http)\s*[:=]?\s*[45]\d{2}/.test(m)) {
      return { errorClass: "provider", stage: "stream" };
    }
    return { errorClass: "sdk", stage: "stream" };
  }
  // Provider-level: HTTP status codes / provider rejections (response phase).
  if (/(?:status|http|code)\s*[:=]?\s*[45]\d{2}|[45]\d{2}/.test(m)) {
    return { errorClass: "provider", stage: "response" };
  }
  // Infrastructure: connectivity / DNS / refused.
  if (
    m.includes("fetch failed") ||
    m.includes("enotfound") ||
    m.includes("econnrefused") ||
    m.includes("network")
  ) {
    return { errorClass: "infra", stage: "request" };
  }
  return { errorClass: "infra", stage: "response" };
}

// ---------------------------------------------------------------------------
// Whole-tree spend
// ---------------------------------------------------------------------------

/** One spend record keyed by its message id (dedup unit). */
export interface SpendRecord {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
}

export interface ModelTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
}

/**
 * Whole-tree spend aggregator. Records are DEDUPED by message id so a record
 * reported by both a parent and its subagent (same message id) counts EXACTLY
 * ONCE. Optionally rolls the cost up into a shared TreeBudget so delegation
 * never hides cost from the parent's cap.
 */
export class SpendAggregator {
  private seen = new Set<string>();
  private byModel = new Map<string, ModelTotals>();
  private _costUSD = 0;
  private _inputTokens = 0;
  private _outputTokens = 0;
  private _cacheReadTokens = 0;
  private _cacheWriteTokens = 0;

  /** Record a spend entry. Returns whether it was new (not deduped). */
  record(r: SpendRecord, treeBudget?: TreeBudget): { deduped: boolean; costAddedUSD: number } {
    if (this.seen.has(r.messageId)) return { deduped: true, costAddedUSD: 0 };
    this.seen.add(r.messageId);

    this._inputTokens += r.inputTokens;
    this._outputTokens += r.outputTokens;
    this._cacheReadTokens += r.cacheReadTokens;
    this._cacheWriteTokens += r.cacheWriteTokens;
    this._costUSD += r.costUSD;

    const cur = this.byModel.get(r.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUSD: 0,
    };
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.cacheReadTokens += r.cacheReadTokens;
    cur.cacheWriteTokens += r.cacheWriteTokens;
    cur.costUSD += r.costUSD;
    this.byModel.set(r.model, cur);

    // Whole-tree rollup: subagent spend lands in the shared parent budget.
    if (treeBudget) treeBudget.usedUSD += r.costUSD;

    return { deduped: false, costAddedUSD: r.costUSD };
  }

  totals(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUSD: number } {
    return {
      inputTokens: this._inputTokens,
      outputTokens: this._outputTokens,
      cacheReadTokens: this._cacheReadTokens,
      cacheWriteTokens: this._cacheWriteTokens,
      costUSD: this._costUSD,
    };
  }

  perModel(): Array<{ model: string; totals: ModelTotals }> {
    return [...this.byModel.entries()]
      .map(([model, totals]) => ({ model, totals }))
      .sort((a, b) => b.totals.costUSD - a.totals.costUSD);
  }

  get messageCount(): number {
    return this.seen.size;
  }
}
