import { describe, test, expect } from "bun:test";
import { runArena } from "../src/arena";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
} from "../src/provider/types";
import { resolveModelRef } from "../src/config/models";

const endTurn = (text: string, usage = { inputTokens: 100, outputTokens: 10 }): ChatResponse => ({
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  usage,
});

/** Minimal scripted provider; `track` (optional) lets tests assert true concurrency. */
function scriptProvider(
  name: string,
  script: ChatResponse[],
  delayMs = 0,
  track?: { active: number; max: number },
): Provider & { requests: ChatRequest[] } {
  let i = 0;
  const requests: ChatRequest[] = [];
  return {
    name,
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      if (track) {
        track.active++;
        if (track.active > track.max) track.max = track.active;
      }
      try {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        const next = script[i++];
        if (!next) throw new Error("script exhausted");
        return next;
      } finally {
        if (track) track.active--;
      }
    },
  };
}

const refA = resolveModelRef("anthropic:claude-x", "anthropic");
const refB = resolveModelRef("openai:gpt-x", "openai");

const optsFor = (over: Record<string, unknown> = {}) => ({
  entries: [
    { ref: refA, provider: scriptProvider("p1", [endTurn("answer one", { inputTokens: 100, outputTokens: 10 })]) },
    { ref: refB, provider: scriptProvider("p2", [endTurn("answer two", { inputTokens: 200, outputTokens: 20 })]) },
  ],
  message: "hello",
  cwd: process.cwd(),
  maxTokens: 512,
  capUSD: 5,
  ...over,
});

describe("runArena", () => {
  test("runs every entry and reports text, latency, tokens and cost", async () => {
    const r = await runArena(optsFor());
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]!.text).toBe("answer one");
    expect(r.candidates[1]!.text).toBe("answer two");
    for (const c of r.candidates) {
      expect(c.latencyMs).toBeGreaterThanOrEqual(0);
      expect(c.error).toBeUndefined();
    }
    // unknown models fall back to DEFAULT_PRICING 5/15 per 1M tokens
    expect(r.candidates[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(r.candidates[0]!.costUSD).toBeCloseTo((100 * 5 + 10 * 15) / 1_000_000);
    expect(r.candidates[1]!.costUSD).toBeCloseTo((200 * 5 + 20 * 15) / 1_000_000);
  });

  test("sums costs across all runs", async () => {
    const o = optsFor();
    const r = await runArena(o);
    const expected =
      (100 * 5 + 10 * 15 + 200 * 5 + 20 * 15) / 1_000_000;
    expect(r.totalCostUSD).toBeCloseTo(expected);
  });

  test("runs candidates in parallel", async () => {
    const track = { active: 0, max: 0 };
    const o = optsFor({
      entries: [
        { ref: refA, provider: scriptProvider("p1", [endTurn("a")], 30, track) },
        { ref: refB, provider: scriptProvider("p2", [endTurn("b")], 30, track) },
      ],
    });
    await runArena(o);
    expect(track.max).toBe(2);
  });

  test("winner flag marks the chosen candidate", async () => {
    const r = await runArena(optsFor({ winnerIndex: 2 }));
    expect(r.winner).toBe(2);
  });

  test("shared budget halts runs once the combined cap is consumed", async () => {
    // p1 with zero delay exhausts the shared $1 cap on its first turn
    // (500k input * $5/1M = $2.5). p2 is delayed and wants two turns
    // (tool_use -> end_turn); after its first turn the shared budget is
    // spent, so its second turn must be halted without another model call.
    const p1 = scriptProvider("p1", [
      endTurn("expensive", { inputTokens: 500_000, outputTokens: 0 }),
    ]);
    const p2 = scriptProvider("p2", [
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 100, outputTokens: 10 },
      },
      endTurn("second turn"),
    ], 30);
    const r = await runArena({
      entries: [
        { ref: refA, provider: p1 },
        { ref: refB, provider: p2 },
      ],
      message: "hello",
      cwd: process.cwd(),
      maxTokens: 512,
      capUSD: 1,
    });
    // p2 never got its second model call once the shared cap was spent.
    expect(p2.requests).toHaveLength(1);
    expect(r.candidates[1]!.stopReason).toBe("budget_exhausted");
    // p2 only paid for its first turn
    expect(r.candidates[1]!.costUSD).toBeCloseTo((100 * 5 + 10 * 15) / 1_000_000);
    expect(r.totalCostUSD).toBeCloseTo((500_000 * 5) / 1_000_000 + (100 * 5 + 10 * 15) / 1_000_000);
  });
});

describe("arena judge (#152)", () => {
  const judgeText =
    "1. Output 2\n2. Output 1\nJUSTIFICATION: Output 2 is more complete and correct.";

  function judgeProvider(reply = judgeText): Provider & { requests: ChatRequest[] } {
    return scriptProvider("judge", [
      endTurn(reply, { inputTokens: 100, outputTokens: 20 }),
    ]);
  }

  test("ranked outputs are anonymized (no model names) and parsed best-first", async () => {
    const judge = judgeProvider();
    const r = await runArena(
      optsFor({ judge: { provider: judge, model: "judge-1", capUSD: 5 } }),
    );

    expect(r.judge).toBeDefined();
    expect(r.judge?.model).toBe("judge-1");
    expect(r.judge?.error).toBeUndefined();
    // rankings in the order listed: Output 2 best, then Output 1
    expect(r.judge?.ranking).toEqual([2, 1]);

    const prompt = String(judge.requests[0]?.messages[0]?.content ?? "");
    // judge sees the anonymized outputs, keyed by index only
    expect(prompt).toContain("[Output 1]");
    expect(prompt).toContain("[Output 2]");
    expect(prompt).toContain("answer one");
    expect(prompt).toContain("answer two");
    // no model refs leak into the judge
    expect(prompt).not.toContain("claude-x");
    expect(prompt).not.toContain("gpt-x");
  });

  test("judge respects its spend cap and falls back to manual selection", async () => {
    // expensive judge usage vs a tiny cap → budget.exhausted after the call
    const judge = scriptProvider("judge", [
      { stopReason: "end_turn", content: [{ type: "text", text: judgeText }], usage: { inputTokens: 5_000_000, outputTokens: 0 } },
    ]);
    const r = await runArena(
      optsFor({ judge: { provider: judge, model: "judge-1", capUSD: 0.001 } }),
    );

    expect(r.judge?.error).toBe("budget exceeded");
    expect(r.judge?.ranking).toEqual([]);
    expect(r.judge?.justification).toContain("budget cap");
    // arena itself still returns all candidates (manual selection stays possible)
    expect(r.candidates).toHaveLength(2);
  });

  test("a judge that throws falls back to manual selection without failing", async () => {
    const throwing: Provider = {
      name: "broken-judge",
      async chat() {
        throw new Error("judge api down");
      },
    };
    const r = await runArena(
      optsFor({ judge: { provider: throwing, model: "judge-1", capUSD: 5 } }),
    );

    expect(r.judge?.error).toContain("judge api down");
    expect(r.judge?.ranking).toEqual([]);
    expect(r.candidates).toHaveLength(2);
  });
});
