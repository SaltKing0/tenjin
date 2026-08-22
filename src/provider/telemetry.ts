/**
 * Routing telemetry + offline feedback loop (Roadmap §13 B10-5, DR7-3, #433).
 *
 * Routing improves from EVIDENCE, not vibes — only changes that win OFFLINE go
 * online. This module is the measurement + replay half of that law:
 *
 *   1. TELEMETRY — per-call, bucketed: TTFT / inter-token / total latency into
 *      p50/p95 histograms; token + cost counters; error counters keyed by
 *      EXACTLY ONE class AND one stage; quality metrics (task success, tool-call
 *      accuracy, parse-error rate). Every metric carries a routing-decision-id.
 *   2. routing_log — one JSON object per line ({decision uuid, features, chosen
 *      deployment, outcome}) that joins with the per-call metrics by decision id
 *      in the offline pass.
 *   3. OFFLINE REPLAY — score strategies counterfactually
 *      (success + tool-call accuracy - latency - cost - cooldown penalty) and
 *      propose a policy change ONLY when a candidate strictly outperforms the
 *      current strategy.
 *   4. POLICY LAW / DRIFT — flag providers whose real cost diverges from the
 *      price table so only offline-winning changes ship online.
 *
 * Pure and zero-dependency; injectable clocks/scale constants keep tests
 * deterministic. It reuses the routing-decision-id vocabulary established by
 * the #402 router (#413 pre-filter) and #415 tracing.
 */

// ---------------------------------------------------------------------------
// Bucketed latency histograms
// ---------------------------------------------------------------------------

/** Latency bucket boundaries in ms (upper edges), log-ish spacing. */
export const LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000,
];

export interface HistogramSnapshot {
  buckets: number[];
  counts: number[];
  count: number;
}

/**
 * A fixed-boundary histogram. `add(v)` tallies the value into the first bucket
 * whose upper edge is >= v (values past the top edge overflow into the last
 * bucket, so nothing is lost). `percentile(p)` returns the upper edge of the
 * bucket containing the p-th percentile rank — a deterministic estimate from
 * the bucket distribution, standard for p50/p95 observability.
 */
export class Histogram {
  private readonly counts: number[];
  private _count = 0;

  constructor(private readonly buckets: number[] = LATENCY_BUCKETS_MS) {
    this.counts = new Array(buckets.length).fill(0);
  }

  add(value: number): void {
    this._count++;
    let idx = this.buckets.length - 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        idx = i;
        break;
      }
    }
    this.counts[idx] = (this.counts[idx] ?? 0) + 1;
  }

  get count(): number {
    return this._count;
  }

  /** Upper edge of the bucket containing the p-th percentile, or null when empty. */
  percentile(p: number): number | null {
    if (this._count === 0) return null;
    const rank = (p / 100) * this._count;
    let cumulative = 0;
    for (let i = 0; i < this.counts.length; i++) {
      cumulative += this.counts[i]!;
      if (cumulative >= rank) return this.buckets[i]!;
    }
    return this.buckets[this.buckets.length - 1]!;
  }

  snapshot(): HistogramSnapshot {
    return { buckets: [...this.buckets], counts: [...this.counts], count: this._count };
  }
}

// ---------------------------------------------------------------------------
// Error classification — exactly one class AND one stage
// ---------------------------------------------------------------------------

/** B10-5 error classes — coarse buckets for policy, not free-text. */
export type TelemetryErrorClass =
  | "rate_limit_429"
  | "timeout"
  | "auth"
  | "content_policy"
  | "server_5xx"
  | "retryable"
  | "other";

/** Where in the call lifecycle the error happened. */
export type TelemetryStage = "connect" | "first_token" | "stream" | "finalize";

export interface TelemetryError {
  errorClass: TelemetryErrorClass;
  stage: TelemetryStage;
}

export interface ClassifyHint {
  /** Explicit HTTP status, when known (preferred over message sniffing). */
  status?: number;
  /** Explicit lifecycle stage, when the caller knows it. */
  stage?: TelemetryStage;
}

/**
 * Classify an error into EXACTLY ONE class + one stage. An explicit HTTP status
 * wins; otherwise message heuristics. Falls back to "other"/"finalize" so every
 * error still lands in exactly one bucket.
 */
export function classifyTelemetryError(err: unknown, hint: ClassifyHint = {}): TelemetryError {
  const stage = hint.stage ?? classifyStage(err);
  if (hint.status !== undefined) {
    return { errorClass: classForStatus(hint.status, err), stage };
  }
  const m = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).toLowerCase();
  if (m.includes("429") || /rate\s*limit/.test(m)) {
    return { errorClass: "rate_limit_429", stage };
  }
  if (m.includes("timeout") || m.includes("abort") || m.includes("timed out")) {
    return { errorClass: "timeout", stage };
  }
  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthor") ||
    m.includes("authentication") ||
    m.includes("invalid api key") ||
    m.includes("api key")
  ) {
    return { errorClass: "auth", stage };
  }
  if (m.includes("content policy") || m.includes("safety") || m.includes("moderation") || m.includes("content_filter")) {
    return { errorClass: "content_policy", stage };
  }
  if (/5\d\d/.test(m)) {
    return { errorClass: "server_5xx", stage };
  }
  if (
    m.includes("fetch failed") ||
    m.includes("enotfound") ||
    m.includes("econnrefused") ||
    m.includes("network") ||
    m.includes("connect")
  ) {
    return { errorClass: "retryable", stage };
  }
  return { errorClass: "other", stage };
}

function classForStatus(status: number, err: unknown): TelemetryErrorClass {
  if (status === 429) return "rate_limit_429";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status < 600) return "server_5xx";
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("content policy") || m.includes("safety") || m.includes("moderation")) {
    return "content_policy";
  }
  return "other";
}

function classifyStage(err: unknown): TelemetryStage {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("stream") || m.includes("sse") || m.includes("chunk")) return "stream";
  if (m.includes("connect") || m.includes("socket") || m.includes("enotfound")) return "connect";
  return "finalize";
}

// ---------------------------------------------------------------------------
// Per-call telemetry accumulator + routing_log
// ---------------------------------------------------------------------------

export interface CallMetrics {
  decisionId: string;
  /** The deployment that served this call, e.g. "provider/model". */
  deployment: string;
  /** Routing features used in the decision (for the offline log). */
  features?: Record<string, unknown>;
  ttftMs?: number;
  interTokenMs?: number;
  totalMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
  success?: boolean;
  toolCallAccuracy?: number;
  parseErrorRate?: number;
  cooldownPenalty?: number;
  error?: unknown;
  status?: number;
  stage?: TelemetryStage;
}

/** One routing_log JSONL line — joinable with metrics by decision id. */
export interface RoutingLogLine {
  decisionId: string;
  features: Record<string, unknown>;
  chosenDeployment: string;
  outcome: {
    success: boolean;
    latencyMs?: number;
    costUSD?: number;
    toolCallAccuracy?: number;
    parseErrorRate?: number;
    cooldownPenalty?: number;
    errorClass?: TelemetryErrorClass;
    stage?: TelemetryStage;
  };
}

interface DeploymentLatency {
  ttft: Histogram;
  interToken: Histogram;
  total: Histogram;
}

interface DeploymentCost {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export interface ErrorCount {
  errorClass: TelemetryErrorClass;
  stage: TelemetryStage;
  count: number;
}

export interface DeploymentSummary {
  deployment: string;
  total: HistogramSnapshot;
  ttft: HistogramSnapshot;
  interToken: HistogramSnapshot;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Accumulates B10-5 telemetry: latency histograms, token/cost counters, error
 * counts keyed by (class, stage), quality signals, and an append-only
 * routing_log that can be serialized to JSONL and replayed offline.
 */
export class RoutingTelemetry {
  private readonly latencies = new Map<string, DeploymentLatency>();
  private readonly costs = new Map<string, DeploymentCost>();
  private readonly _errors = new Map<string, ErrorCount>();
  private readonly log: RoutingLogLine[] = [];

  recordCall(m: CallMetrics): void {
    const latency = this.latencyFor(m.deployment);
    if (m.ttftMs !== undefined) latency.ttft.add(m.ttftMs);
    if (m.interTokenMs !== undefined) latency.interToken.add(m.interTokenMs);
    if (m.totalMs !== undefined) latency.total.add(m.totalMs);

    if ((m.inputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0 || (m.costUSD ?? 0) > 0) {
      const cost = this.costs.get(m.deployment) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      cost.inputTokens += m.inputTokens ?? 0;
      cost.outputTokens += m.outputTokens ?? 0;
      cost.costUSD += m.costUSD ?? 0;
      this.costs.set(m.deployment, cost);
    }

    const success = m.success ?? m.error === undefined;
    if (!success) {
      const { errorClass, stage } = classifyTelemetryError(m.error ?? new Error("unknown"), {
        status: m.status,
        stage: m.stage,
      });
      const key = `${errorClass}\u0000${stage}`;
      const cur = this._errors.get(key) ?? { errorClass, stage, count: 0 };
      cur.count++;
      this._errors.set(key, cur);
    }

    this.log.push({
      decisionId: m.decisionId,
      features: m.features ?? {},
      chosenDeployment: m.deployment,
      outcome: {
        success,
        ...(m.totalMs !== undefined ? { latencyMs: m.totalMs } : {}),
        ...(m.costUSD !== undefined ? { costUSD: m.costUSD } : {}),
        ...(m.toolCallAccuracy !== undefined ? { toolCallAccuracy: m.toolCallAccuracy } : {}),
        ...(m.parseErrorRate !== undefined ? { parseErrorRate: m.parseErrorRate } : {}),
        ...(m.cooldownPenalty !== undefined ? { cooldownPenalty: m.cooldownPenalty } : {}),
        ...(!success
          ? {
              errorClass: classifyTelemetryError(m.error ?? new Error("unknown"), {
                status: m.status,
                stage: m.stage,
              }).errorClass,
            }
          : {}),
      },
    });
  }

  /** Error counts, one entry per distinct (class, stage) pair — never double-counted. */
  errorCounts(): ErrorCount[] {
    return [...this._errors.values()].sort((a, b) => b.count - a.count);
  }

  get totalErrors(): number {
    let n = 0;
    for (const e of this._errors.values()) n += e.count;
    return n;
  }

  logLines(): RoutingLogLine[] {
    return [...this.log];
  }

  /** Serialize the routing_log as JSONL — one JSON object per line. */
  toJSONL(): string {
    return this.log.map((l) => JSON.stringify(l)).join("\n") + (this.log.length > 0 ? "\n" : "");
  }

  /** Snapshot a deployment's latency histograms + cost counters. */
  summaryFor(deployment: string): DeploymentSummary | null {
    const lat = this.latencies.get(deployment);
    if (!lat) return null;
    const cost = this.costs.get(deployment) ?? { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    return {
      deployment,
      total: lat.total.snapshot(),
      ttft: lat.ttft.snapshot(),
      interToken: lat.interToken.snapshot(),
      costUSD: cost.costUSD,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
    };
  }

  private latencyFor(deployment: string): DeploymentLatency {
    let l = this.latencies.get(deployment);
    if (!l) {
      l = { ttft: new Histogram(), interToken: new Histogram(), total: new Histogram() };
      this.latencies.set(deployment, l);
    }
    return l;
  }
}

// ---------------------------------------------------------------------------
// Offline pass — join + counterfactual replay
// ---------------------------------------------------------------------------

/** Per-decision metrics from an independent store, joined by decision id. */
export interface OfflineMetrics {
  decisionId: string;
  latencyMs?: number;
  costUSD?: number;
  toolCallAccuracy?: number;
  cooldownPenalty?: number;
}

export interface JoinedRow {
  line: RoutingLogLine;
  metrics?: OfflineMetrics;
}

/** Join routing_log lines with a metrics map by decision id (left join). */
export function joinByDecisionId(
  log: RoutingLogLine[],
  metrics: Record<string, OfflineMetrics>,
): JoinedRow[] {
  return log.map((line) => {
    const m = metrics[line.decisionId];
    return m ? { line, metrics: m } : { line };
  });
}

/** Scale constants for normalizing penalties into 0..1 before scoring. */
export const LATENCY_SCALE_MS = 10_000;
export const COST_SCALE_USD = 1.0;

/**
 * Score one strategy across all decisions that chose it (mean of per-decision
 * scores). Per the issue: success + tool-call accuracy − latency − cost −
 * cooldown penalty, all normalized so a higher score is better.
 */
export function scoreStrategy(
  deployment: string,
  lines: RoutingLogLine[],
): { deployment: string; score: number; decisions: number } | null {
  const own = lines.filter((l) => l.chosenDeployment === deployment);
  if (own.length === 0) return null;
  let total = 0;
  for (const l of own) {
    const o = l.outcome;
    const success = o.success ? 1 : 0;
    const accuracy = o.toolCallAccuracy ?? 0;
    const latencyPenalty = Math.min(1, (o.latencyMs ?? 0) / LATENCY_SCALE_MS);
    const costPenalty = Math.min(1, (o.costUSD ?? 0) / COST_SCALE_USD);
    const cooldown = o.cooldownPenalty ?? 0;
    total += success + accuracy - latencyPenalty - costPenalty - cooldown;
  }
  return { deployment, score: total / own.length, decisions: own.length };
}

export interface PolicyProposal {
  change: boolean;
  current: { deployment: string; score: number; decisions: number } | null;
  best: { deployment: string; score: number; decisions: number } | null;
  proposedDeployment?: string;
}

/**
 * OFFLINE-ONLY policy replay. Scores every deployment seen in the log and
 * proposes switching to a candidate ONLY when it strictly outperforms the
 * current strategy. Never proposes a change that merely ties — evidence must
 * be unambiguous.
 */
export function proposePolicyChange(
  currentDeployment: string,
  lines: RoutingLogLine[],
): PolicyProposal {
  const deployments = new Set(lines.map((l) => l.chosenDeployment));
  const scored = new Map<string, NonNullable<ReturnType<typeof scoreStrategy>>>();
  for (const d of deployments) {
    const s = scoreStrategy(d, lines);
    if (s) scored.set(d, s);
  }
  const current = scored.get(currentDeployment) ?? null;
  let best: NonNullable<ReturnType<typeof scoreStrategy>> | null = null;
  for (const s of scored.values()) {
    if (!best || s.score > best.score) best = s;
  }
  const change = !!best && !!current && best.deployment !== currentDeployment && best.score > current.score;
  return {
    change,
    current,
    best,
    ...(change ? { proposedDeployment: best!.deployment } : {}),
  };
}

// ---------------------------------------------------------------------------
// Policy law — drift detection against the price table
// ---------------------------------------------------------------------------

export interface DriftObservation {
  deployment: string;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  avgLatencyMs: number;
}

export interface DriftFlag {
  deployment: string;
  kind: "cost" | "latency";
  expected: number;
  observed: number;
  ratio: number;
}

export interface DriftOptions {
  costRatioThreshold?: number;
  latencyRatioThreshold?: number;
  /** Expected per-model pricing (per 1M tokens); undefined = unknown model. */
  expectedCostPerMTok?: (deployment: string) => { inputPerMTok: number; outputPerMTok: number } | undefined;
  /** Expected average latency per deployment; undefined = skip latency check. */
  expectedLatencyMs?: (deployment: string) => number | undefined;
}

/**
 * POLICY LAW: flag providers whose REAL cost/latency diverges from the price
 * table. Real effective cost-per-1M is derived from observed token+cost and
 * compared to the expected weighted price; a ratio above the threshold is a
 * drift flag. Latency drift is flagged against an expected value when one is
 * supplied. Only such evidence may justify an online routing change.
 */
export function detectDrift(
  observations: DriftObservation[],
  pricing?: DriftOptions["expectedCostPerMTok"],
  opts: DriftOptions = {},
): DriftFlag[] {
  const costThreshold = opts.costRatioThreshold ?? 1.5;
  const latencyThreshold = opts.latencyRatioThreshold ?? 1.5;
  const expectedCost = opts.expectedCostPerMTok ?? pricing;
  const flags: DriftFlag[] = [];
  for (const o of observations) {
    const toks = o.inputTokens + o.outputTokens;
    if (toks > 0 && expectedCost) {
      const p = expectedCost(o.deployment);
      if (p) {
        const expectedPerMTok = (o.inputTokens * p.inputPerMTok + o.outputTokens * p.outputPerMTok) / toks;
        const observedPerMTok = (o.costUSD * 1_000_000) / toks;
        if (observedPerMTok > 0 && observedPerMTok / expectedPerMTok > costThreshold) {
          flags.push({
            deployment: o.deployment,
            kind: "cost",
            expected: expectedPerMTok,
            observed: observedPerMTok,
            ratio: observedPerMTok / expectedPerMTok,
          });
        }
      }
    }
    if (opts.expectedLatencyMs) {
      const expected = opts.expectedLatencyMs(o.deployment);
      if (expected !== undefined && o.avgLatencyMs > 0 && o.avgLatencyMs / expected > latencyThreshold) {
        flags.push({
          deployment: o.deployment,
          kind: "latency",
          expected,
          observed: o.avgLatencyMs,
          ratio: o.avgLatencyMs / expected,
        });
      }
    }
  }
  return flags;
}
