import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TreeBudget } from "../src/agent/budget";
import { runHeadless } from "../src/agent/headless";
import { validateConfig } from "../src/config/loader";
import type { HarnessConfig } from "../src/config/types";
import type { Provider, ChatResponse, ChatRequest } from "../src/provider/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-treebudget-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Provider that keeps issuing a read_file tool-call so the run burns iterations. */
function alwaysToolCallProvider(calls: { n: number }): Provider {
  return {
    name: "tc",
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      calls.n += 1;
      return {
        stopReason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tc",
            name: "read_file",
            input: { path: "." },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function run(opts: { treeBudget?: TreeBudget; maxTreeIterations?: number } = {}) {
  const calls = { n: 0 };
  return runHeadless({
    provider: alwaysToolCallProvider(calls),
    model: "m",
    soulText: "s",
    cwd: dir,
    message: "do work",
    maxTokens: 512,
    capUSD: 1,
    policy: "read-only",
    treeBudget: opts.treeBudget,
    maxTreeIterations: opts.maxTreeIterations,
  }).then((r) => ({ ...r, calls }));
}

describe("TreeBudget (#154)", () => {
  test("consumeIteration caps iterations across the shared counter", () => {
    const tb = new TreeBudget(3, 0);
    expect(tb.consumeIteration()).toBe(true); // 1
    expect(tb.consumeIteration()).toBe(true); // 2
    expect(tb.consumeIteration()).toBe(true); // 3
    expect(tb.consumeIteration()).toBe(false); // would be 4 > 3
    expect(tb.usedIterations).toBe(4);
    expect(tb.stopped).toBe(true);
  });

  test("addUsd caps USD and marks the tree stopped", () => {
    const tb = new TreeBudget(0, 0.01);
    tb.addUsd(0.006);
    expect(tb.stopped).toBe(false);
    tb.addUsd(0.006);
    expect(tb.stopped).toBe(true);
    expect(tb.usedUSD).toBeCloseTo(0.012);
  });

  test("independent budgets do not share a counter", () => {
    const a = new TreeBudget(1, 0);
    const b = new TreeBudget(1, 0);
    expect(a.consumeIteration()).toBe(true);
    expect(a.consumeIteration()).toBe(false); // a exhausted
    expect(b.consumeIteration()).toBe(true); // b unaffected
    expect(b.stopped).toBe(false);
  });

  test("a cap-less budget just counts and never stops", () => {
    const tb = new TreeBudget(0, 0);
    for (let i = 0; i < 5; i++) expect(tb.consumeIteration()).toBe(true);
    expect(tb.usedIterations).toBe(5);
    expect(tb.stopped).toBe(false);
  });
});

describe("delegation-tree budget in the agent loop (#154)", () => {
  test("a shared budget stops the run with a clear reason once the cap is hit", async () => {
    const tb = new TreeBudget(2, 0);
    const res = await run({ treeBudget: tb });
    expect(res.stopReason).toBe("tree_budget_exceeded");
    // 2 provider calls happened; the 3rd consume tripped the cap.
    expect(res.calls.n).toBe(2);
    expect(tb.stopped).toBe(true);
  });

  test("a second run on the same (stopped) budget halts immediately — the whole chain stops", async () => {
    const tb = new TreeBudget(3, 0);
    await run({ treeBudget: tb }); // consumes up to the cap and stops
    const usedBefore = tb.usedIterations;
    const res = await run({ treeBudget: tb });
    expect(res.stopReason).toBe("tree_budget_exceeded");
    expect(res.calls.n).toBe(0); // no new work started
    expect(tb.usedIterations).toBe(usedBefore); // nothing more consumed
  });

  test("independent roots each seed their own tree and do not share the limit", async () => {
    const a = await run({ maxTreeIterations: 1 });
    const b = await run({ maxTreeIterations: 1 });
    // Both stopped at their own tree cap (1 allowed + 1 trip), independently.
    expect(a.stopReason).toBe("tree_budget_exceeded");
    expect(b.stopReason).toBe("tree_budget_exceeded");
    expect(a.calls.n).toBe(1);
    expect(b.calls.n).toBe(1);
  });

  test("without any cap configured, the run is not tree-limited", async () => {
    // An always-tool-calling run without a tree budget just hits the run's own
    // max iterations; it must NOT report tree_budget_exceeded.
    const res = await run({});
    expect(res.stopReason).not.toBe("tree_budget_exceeded");
  });
});

describe("config: maxTreeIterations safety-net (#154)", () => {
  const cfg = (over: Partial<HarnessConfig>): HarnessConfig =>
    ({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      maxTokens: 8192,
      budgetUSD: 5,
      approval: {},
      ...over,
    }) as HarnessConfig;

  test("accepts a non-negative integer", () => {
    expect(() => validateConfig(cfg({ maxTreeIterations: 0 }))).not.toThrow();
    expect(() => validateConfig(cfg({ maxTreeIterations: 50 }))).not.toThrow();
  });

  test("rejects negative or non-integer values", () => {
    expect(() => validateConfig(cfg({ maxTreeIterations: -1 }))).toThrow(/maxTreeIterations/);
    expect(() => validateConfig(cfg({ maxTreeIterations: 1.5 }))).toThrow(/maxTreeIterations/);
    expect(() => validateConfig(cfg({ maxTreeIterations: "x" as never }))).toThrow(/maxTreeIterations/);
  });
});
