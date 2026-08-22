import { describe, test, expect } from "bun:test";
import {
  Tracer,
  buildSpanTree,
  classifyError,
  SpendAggregator,
  type Span,
} from "../src/audit/tracing";
import { TreeBudget } from "../src/agent/budget";

describe("B4-3 trace span tree (mocked 2-step run)", () => {
  test("parent/child ids + durations asserted for a 2-step run", () => {
    let t = 0;
    const tracer = new Tracer(() => t);

    const conv = tracer.startSpan({ kind: "conversation", name: "session-1" });
    t += 10;
    const step1 = tracer.startSpan({ kind: "step", name: "step-1", parentId: conv });
    t += 10;
    const llm1 = tracer.startSpan({ kind: "llm.completion", name: "claude", parentId: step1 });
    t += 20;
    tracer.endSpan(llm1);
    t += 5;
    tracer.endSpan(step1);
    t += 10;
    const step2 = tracer.startSpan({ kind: "step", name: "step-2", parentId: conv });
    const tool = tracer.startSpan({ kind: "tool.execute", name: "bash", parentId: step2 });
    t += 15;
    tracer.endSpan(tool);
    t += 5;
    tracer.endSpan(step2);
    t += 5;
    tracer.endSpan(conv);

    const tree = buildSpanTree(tracer.all());
    expect(tree).toHaveLength(1); // one conversation root
    const root = tree[0]!;
    expect(root.kind).toBe("conversation");
    expect(root.children).toHaveLength(2); // two steps

    const s1 = root.children[0]!;
    const s2 = root.children[1]!;
    expect(s1.kind).toBe("step");
    expect(s1.durationMs).toBe(35); // step1 spans t=10..45
    expect(s1.children).toHaveLength(1);
    expect(s1.children[0]!.kind).toBe("llm.completion");
    expect(s1.children[0]!.durationMs).toBe(20);

    expect(s2.children).toHaveLength(1);
    expect(s2.children[0]!.kind).toBe("tool.execute");
    expect(s2.children[0]!.durationMs).toBe(15);

    // Stable, distinct ids across the tree.
    const ids = tracer.all().map((s: Span) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a span with an unknown parent is treated as a root (never dropped)", () => {
    const tracer = new Tracer();
    const orphan = tracer.startSpan({ kind: "run", name: "orphan", parentId: "does_not_exist" });
    tracer.endSpan(orphan);
    expect(buildSpanTree(tracer.all())).toHaveLength(1);
  });
});

describe("B4-3 structured error classification", () => {
  test("each error classifies into exactly one class + stage tag", () => {
    expect(classifyError(new Error("AbortError: aborted"))).toEqual({ errorClass: "sdk", stage: "request" });
    expect(classifyError(new Error("timeout after 30s"))).toEqual({ errorClass: "sdk", stage: "request" });
    expect(classifyError(new Error("openai api 429: rate limited"))).toEqual({
      errorClass: "provider",
      stage: "response",
    });
    expect(classifyError(new Error("status 500 from server"))).toEqual({
      errorClass: "provider",
      stage: "response",
    });
    expect(classifyError(new Error("fetch failed: ENOTFOUND api.anthropic.com"))).toEqual({
      errorClass: "infra",
      stage: "request",
    });
    expect(classifyError(new Error("ECONNREFUSED"))).toEqual({ errorClass: "infra", stage: "request" });
  });

  test("stream failures get the stream stage with the right class", () => {
    expect(classifyError(new Error("sse stream ended, http 502"))).toEqual({
      errorClass: "provider",
      stage: "stream",
    });
    expect(classifyError(new Error("stream parse error"))).toEqual({ errorClass: "sdk", stage: "stream" });
  });
});

describe("B4-4 whole-tree spend rollup (dedup + TreeBudget)", () => {
  function rec(messageId: string, model = "claude", cost = 1): Parameters<SpendAggregator["record"]>[0] {
    return {
      messageId,
      model,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUSD: cost,
    };
  }

  test("subagent tokens roll into parent budget exactly once (dedup by message id)", () => {
    const agg = new SpendAggregator();
    const tree = new TreeBudget(0, 100);

    // Parent reports a completion; the subagent re-reports the SAME message id.
    const a = agg.record(rec("m1", "claude", 2), tree);
    const b = agg.record(rec("m1", "claude", 2), tree); // duplicate — must be dropped

    expect(a).toEqual({ deduped: false, costAddedUSD: 2 });
    expect(b).toEqual({ deduped: true, costAddedUSD: 0 });
    expect(agg.totals().costUSD).toBe(2); // counted once
    expect(tree.usedUSD).toBe(2); // rolled up once into the parent budget
    expect(agg.messageCount).toBe(1);
  });

  test("distinct messages each roll up; per-model totals aggregate cache read/write", () => {
    const agg = new SpendAggregator();
    agg.record(rec("m1", "claude", 2));
    agg.record(rec("m2", "claude", 3));
    agg.record(rec("m3", "gpt", 6));
    const totals = agg.totals();
    expect(totals.costUSD).toBe(11);
    expect(totals.inputTokens).toBe(30);
    expect(totals.cacheReadTokens).toBe(6);
    expect(agg.messageCount).toBe(3);
    const perModel = agg.perModel();
    expect(perModel).toHaveLength(2);
    expect(perModel[0]!.model).toBe("gpt"); // highest cost first
  });
});

describe("B4-4 routing-decision-id on spans", () => {
  test("routing-decision-id present when a router decision exists, absent otherwise", () => {
    const tracer = new Tracer();
    const routed = tracer.startSpan({
      kind: "llm.completion",
      name: "claude",
      routingDecisionId: "rd_123",
    });
    tracer.endSpan(routed);
    const unrouted = tracer.startSpan({ kind: "llm.completion", name: "claude" });
    tracer.endSpan(unrouted);

    const [r, u] = tracer.all();
    expect(r!.routingDecisionId).toBe("rd_123");
    expect(u!.routingDecisionId).toBeUndefined();

    const tree = buildSpanTree(tracer.all());
    expect(tree[0]!.routingDecisionId).toBe("rd_123");
  });
});
