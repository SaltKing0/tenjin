import { describe, test, expect } from "bun:test";
import {
  estimateTokens,
  contextWindowTokens,
  resolveContextGuard,
  compressMessages,
} from "../src/session/context";
import type { ChatMessage } from "../src/provider/types";

const text = (role: "user" | "assistant", s: string): ChatMessage => ({ role, content: s });

function toolResultMsg(id: string, output: string): ChatMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", toolUseId: id, content: output }],
  };
}

describe("estimateTokens", () => {
  test("chars/4 heuristic for string content", () => {
    expect(estimateTokens([text("user", "hello world")])).toBe(3); // 11 chars / 4
  });

  test("counts tool_result block content", () => {
    const msg = toolResultMsg("t1", "data".repeat(100)); // 400 chars
    expect(estimateTokens([msg])).toBe(100);
  });

  test("sums across messages", () => {
    const msgs = [text("user", "a".repeat(40)), text("assistant", "b".repeat(40))];
    expect(estimateTokens(msgs)).toBe(20); // 80 chars / 4
  });
});

describe("contextWindowTokens", () => {
  test("uses built-in table for known models", () => {
    expect(contextWindowTokens("claude-sonnet-4-5")).toBe(200_000);
  });

  test("falls back to default for unknown models", () => {
    expect(contextWindowTokens("some-custom-model")).toBe(128_000);
  });

  test("per-model override wins", () => {
    expect(contextWindowTokens("deepseek-chat", { windows: { "deepseek-chat": 32_000 } })).toBe(32_000);
  });

  test("defaultWindow applies to unknown models", () => {
    expect(contextWindowTokens("mystery", { defaultWindow: 9_000 })).toBe(9_000);
  });
});

describe("resolveContextGuard", () => {
  test("defaults: enabled, ratio 0.8, built-in window", () => {
    const g = resolveContextGuard("claude-sonnet-4-5");
    expect(g).toEqual({ enabled: true, thresholdRatio: 0.8, windowTokens: 200_000 });
  });

  test("honors enabled:false", () => {
    expect(resolveContextGuard("m", { enabled: false }).enabled).toBe(false);
  });

  test("honors ratio and window overrides", () => {
    const g = resolveContextGuard("m", { thresholdRatio: 0.5, defaultWindow: 10_000 });
    expect(g.thresholdRatio).toBe(0.5);
    expect(g.windowTokens).toBe(10_000);
  });
});

describe("compressMessages", () => {
  const bigOutput = "x".repeat(800); // 200 tokens

  test("no-op when under budget", () => {
    const msgs = [text("user", "go"), toolResultMsg("t1", "small")];
    const { compressed, elidedTokens, beforeTokens, afterTokens } = compressMessages(msgs, {
      targetTokens: 10_000,
    });
    expect(compressed).toBe(false);
    expect(elidedTokens).toBe(0);
    expect(afterTokens).toBe(beforeTokens);
    // content untouched
    const blocks = msgs[1]?.content as { type: "tool_result"; content: string }[] | undefined;
    expect(blocks?.[0]?.content).toBe("small");
  });

  test("elides oldest tool results to placeholders when over budget", () => {
    const msgs = [
      text("user", "do the task"),
      toolResultMsg("t1", bigOutput),
      toolResultMsg("t2", bigOutput),
      text("assistant", "done"),
    ];
    // target below current size forces elision of the oldest tool result
    const { compressed, elidedTokens, afterTokens } = compressMessages(msgs, {
      targetTokens: 250,
    });
    expect(compressed).toBe(true);
    expect(elidedTokens).toBeGreaterThan(0);
    expect(afterTokens).toBeLessThanOrEqual(250);

    const blocks1 = msgs[1]?.content as { type: "tool_result"; content: string }[] | undefined;
    expect(blocks1?.[0]?.content).toMatch(/^\[elided \d+ tokens\]$/);
    // newest tool result + assistant text preserved
    const blocks2 = msgs[2]?.content as { type: "tool_result"; content: string }[] | undefined;
    expect(blocks2?.[0]?.content).toBe(bigOutput);
  });

  test("does not touch user/assistant text while eliding", () => {
    const msgs = [text("user", "prompt"), toolResultMsg("t1", bigOutput)];
    compressMessages(msgs, { targetTokens: 100 });
    expect(msgs[0]).toEqual(text("user", "prompt"));
  });

  test("elides ALL tool results when even one stays over", () => {
    const msgs = [toolResultMsg("t1", bigOutput), toolResultMsg("t2", bigOutput)];
    const { compressed, elidedTokens } = compressMessages(msgs, { targetTokens: 100 });
    expect(compressed).toBe(true);
    expect(elidedTokens).toBe(400); // both 200-token outputs elided
    const b1 = msgs[0]?.content as { type: "tool_result"; content: string }[] | undefined;
    const b2 = msgs[1]?.content as { type: "tool_result"; content: string }[] | undefined;
    expect(b1?.[0]?.content).toMatch(/^\[elided \d+ tokens\]$/);
    expect(b2?.[0]?.content).toMatch(/^\[elided \d+ tokens\]$/);
  });
});
