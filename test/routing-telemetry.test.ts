import { describe, test, expect } from "bun:test";
import {
  Histogram,
  LATENCY_BUCKETS_MS,
  classifyTelemetryError,
  RoutingTelemetry,
  joinByDecisionId,
  proposePolicyChange,
  detectDrift,
  type RoutingLogLine,
  type OfflineMetrics,
} from "../src/provider/telemetry";

describe("bucketed histograms", () => {
  test("buckets values by upper edge and tallies counts", () => {
    const h = new Histogram([10, 100, 1000]);
    h.add(5); // bucket upper 10
    h.add(50); // bucket upper 100
    h.add(500); // bucket upper 1000
    expect(h.count).toBe(3);
    expect(h.snapshot().counts).toEqual([1, 1, 1]);
  });

  test("p50/p95 computed on a fixture distribution", () => {
    const h = new Histogram(LATENCY_BUCKETS_MS);
    // 100 values 0..99 ms — uniform, so p50 ≈ 50, p95 ≈ 95.
    for (let i = 0; i < 100; i++) h.add(i);
    const p50 = h.percentile(50)!;
    const p95 = h.percentile(95)!;
    expect(p50).toBeGreaterThanOrEqual(25);
    expect(p50).toBeLessThanOrEqual(50);
    expect(p95).toBeGreaterThanOrEqual(50);
    expect(p95).toBeLessThanOrEqual(100);
  });

  test("percentile on an empty histogram is null", () => {
    const h = new Histogram([10, 100]);
    expect(h.percentile(50)).toBeNull();
  });
});

describe("error classification — exactly one class AND one stage", () => {
  test("HTTP status hints map to a single class + stage", () => {
    expect(classifyTelemetryError(new Error("x"), { status: 429, stage: "stream" })).toEqual({
      errorClass: "rate_limit_429",
      stage: "stream",
    });
    expect(classifyTelemetryError(new Error("x"), { status: 401 })).toEqual({
      errorClass: "auth",
      stage: "finalize",
    });
    expect(classifyTelemetryError(new Error("x"), { status: 503 })).toEqual({
      errorClass: "server_5xx",
      stage: "finalize",
    });
  });

  test("message heuristics classify without a status", () => {
    expect(classifyTelemetryError(new Error("request timed out after 30s")).errorClass).toBe(
      "timeout",
    );
    expect(classifyTelemetryError(new Error("provider api 429: rate limited")).errorClass).toBe(
      "rate_limit_429",
    );
    expect(
      classifyTelemetryError(new Error("authentication failed: invalid api key")).errorClass,
    ).toBe("auth");
    expect(classifyTelemetryError(new Error("content policy violation")).errorClass).toBe(
      "content_policy",
    );
  });

  test("recorded errors are counted once under exactly one class+stage pair", () => {
    const t = new RoutingTelemetry();
    t.recordCall({
      decisionId: "d1",
      deployment: "deploy-a",
      error: new Error("provider api 429: rate limited"),
      status: 429,
      stage: "stream",
    });
    const counts = t.errorCounts();
    expect(t.totalErrors).toBe(1);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({ errorClass: "rate_limit_429", stage: "stream", count: 1 });
  });
});

describe("routing_log + offline join", () => {
  test("each call emits one JSONL routing_log line carrying decision-id + outcome", () => {
    const t = new RoutingTelemetry();
    t.recordCall({
      decisionId: "d1",
      deployment: "deploy-a",
      features: { task_type: "code" },
      ttftMs: 100,
      totalMs: 2000,
      inputTokens: 1000,
      outputTokens: 500,
      costUSD: 0.01,
      success: true,
      toolCallAccuracy: 1,
    });
    const lines = t.logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      decisionId: "d1",
      chosenDeployment: "deploy-a",
      features: { task_type: "code" },
      outcome: { success: true, latencyMs: 2000, costUSD: 0.01, toolCallAccuracy: 1 },
    });

    const jsonl = t.toJSONL();
    const parsed = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].decisionId).toBe("d1");
  });

  test("offline pass joins routing_log lines with metrics by decision-id", () => {
    const t = new RoutingTelemetry();
    t.recordCall({ decisionId: "d1", deployment: "deploy-a", success: true, totalMs: 2000, costUSD: 0.01 });
    t.recordCall({ decisionId: "d2", deployment: "deploy-a", success: true, totalMs: 500, costUSD: 0.002 });

    const metrics: Record<string, OfflineMetrics> = {
      d1: { decisionId: "d1", latencyMs: 2000, costUSD: 0.01, toolCallAccuracy: 1 },
      d2: { decisionId: "d2", latencyMs: 500, costUSD: 0.002, toolCallAccuracy: 0.5 },
    };
    const joined = joinByDecisionId(t.logLines(), metrics);
    const d1 = joined.find((r) => r.line.decisionId === "d1")!;
    expect(d1.metrics?.latencyMs).toBe(2000);
    const d3 = joinByDecisionId(
      [{ decisionId: "d3", features: {}, chosenDeployment: "x", outcome: { success: true } }],
      metrics,
    )[0]!;
    expect(d3.metrics).toBeUndefined();
  });
});

describe("offline replay — counterfactual policy change", () => {
  const currentLines: RoutingLogLine[] = [
    { decisionId: "a", features: {}, chosenDeployment: "current", outcome: { success: false, latencyMs: 20000, costUSD: 1.0, toolCallAccuracy: 0 } },
    { decisionId: "b", features: {}, chosenDeployment: "current", outcome: { success: false, latencyMs: 20000, costUSD: 1.0, toolCallAccuracy: 0 } },
    { decisionId: "c", features: {}, chosenDeployment: "better", outcome: { success: true, latencyMs: 500, costUSD: 0.01, toolCallAccuracy: 1 } },
    { decisionId: "d", features: {}, chosenDeployment: "better", outcome: { success: true, latencyMs: 500, costUSD: 0.01, toolCallAccuracy: 1 } },
  ];

  test("proposes a change only when a candidate outperforms current", () => {
    const res = proposePolicyChange("current", currentLines);
    expect(res.change).toBe(true);
    expect(res.proposedDeployment).toBe("better");
  });

  test("no change when nothing beats the current strategy", () => {
    const lines: RoutingLogLine[] = [
      { decisionId: "a", features: {}, chosenDeployment: "current", outcome: { success: true, latencyMs: 100, costUSD: 0.001, toolCallAccuracy: 1 } },
      { decisionId: "b", features: {}, chosenDeployment: "worse", outcome: { success: false, latencyMs: 5000, costUSD: 0.5, toolCallAccuracy: 0 } },
    ];
    expect(proposePolicyChange("current", lines).change).toBe(false);
  });
});

describe("policy law — drift detection", () => {
  test("flags cost drift against the price table", () => {
    const flags = detectDrift(
      [
        { deployment: "cheap", costUSD: 0.0005, inputTokens: 1000, outputTokens: 1000, avgLatencyMs: 500 },
        { deployment: "pricey", costUSD: 0.05, inputTokens: 1000, outputTokens: 1000, avgLatencyMs: 500 },
      ],
      () => ({ inputPerMTok: 1, outputPerMTok: 4 }),
      { costRatioThreshold: 1.5 },
    );
    const costFlags = flags.filter((f) => f.kind === "cost");
    expect(costFlags.some((f) => f.deployment === "pricey")).toBe(true);
    expect(costFlags.some((f) => f.deployment === "cheap")).toBe(false);
  });
});
