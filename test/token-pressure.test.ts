import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatResponse, Provider } from "../src/provider/types";
import { runAgentTurn } from "../src/agent/loop";
import { Budget } from "../src/agent/budget";
import {
  TokenPressure,
  DEFAULT_SESSION_KEY,
  sharedTokenPressure,
} from "../src/session/token-pressure";
import { estimateTokens } from "../src/session/context";

function mockProvider(script: ChatResponse[]): Provider {
  let i = 0;
  return {
    name: "mock",
    async chat() {
      const next = script[i++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}

const endTurn = (inputTokens: number): ChatResponse => ({
  stopReason: "end_turn",
  content: [{ type: "text", text: "ok" }],
  usage: { inputTokens, outputTokens: 5 },
});

// A trajectory whose LOCAL estimate (~500 tokens) sits well under an 800-token
// threshold, so only a calibrated (provider-reported) pressure can push it over.
const smallMessages: ChatMessage[] = [
  { role: "user", content: "hi" },
  {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "x", content: "z".repeat(2000) }],
  },
];

describe("TokenPressure", () => {
  test("reported usage overrides the local estimate once available", () => {
    const tp = new TokenPressure();
    tp.record("s", 90_000);
    // Local estimate is tiny; calibrated pressure must win.
    expect(tp.pressureTokens("s", smallMessages)).toBe(90_000);
  });

  test("falls back to the local estimate on the first turn (no report)", () => {
    const tp = new TokenPressure();
    expect(tp.pressureTokens("s", smallMessages)).toBe(estimateTokens(smallMessages));
  });

  test("providers that report nothing (zero usage) cause no behavior change", () => {
    const tp = new TokenPressure();
    tp.record("s", 0);
    tp.record("s", Number.NaN);
    expect(tp.lastReported("s")).toBeUndefined();
    expect(tp.pressureTokens("s", smallMessages)).toBe(estimateTokens(smallMessages));
  });

  test("calibration is keyed per session", () => {
    const tp = new TokenPressure();
    tp.record("session-a", 100);
    expect(tp.lastReported("session-b")).toBeUndefined();
    expect(tp.pressureTokens("session-b", smallMessages)).toBe(estimateTokens(smallMessages));
    expect(tp.pressureTokens("session-a", smallMessages)).toBe(100);
  });

  test("the latest report wins for a session", () => {
    const tp = new TokenPressure();
    tp.record("s", 100);
    tp.record("s", 250);
    expect(tp.lastReported("s")).toBe(250);
    expect(tp.pressureTokens("s", smallMessages)).toBe(250);
  });
});

describe("TokenPressure integration with runAgentTurn", () => {
  const base = {
    model: "test-model",
    system: "sys",
    tools: [] as never[],
    maxTokens: 1024,
    cwd: import.meta.dir,
    approve: async () => true,
    budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    contextGuard: { enabled: true, thresholdRatio: 0.8, windowTokens: 1_000 },
  };

  test("reported usage is recorded for the active session", async () => {
    const tp = new TokenPressure();
    await runAgentTurn({
      ...base,
      provider: mockProvider([endTurn(7_000)]),
      messages: [{ role: "user", content: "hello" }],
      tokenPressure: tp,
      sessionKey: "my-session",
    });
    expect(tp.lastReported("my-session")).toBe(7_000);
    expect(tp.lastReported(DEFAULT_SESSION_KEY)).toBeUndefined();
  });

  test("calibrated pressure drives compaction even when the local estimate is under threshold", async () => {
    const tp = new TokenPressure();
    tp.record("s", 900); // reported real pressure: 900/1000 → stage 4 (summarize)
    const events: string[] = [];
    const provider = mockProvider([endTurn(900)]);
    const messages: ChatMessage[] = smallMessages.map((m) => structuredClone(m));
    const archiveDir = mkdtempSync(join(tmpdir(), "tok-pressure-archive-"));

    try {
      await runAgentTurn({
        ...base,
        provider,
        messages,
        tokenPressure: tp,
        sessionKey: "s",
        archiveDir,
        compaction: { keepLast: 0 }, // force the single tool result to be elided
        onEvent: (e) => events.push(e.t),
      });

      expect(events).toContain("compression");
      // B2-3/B2-4: the old tool result is pointer-replaced (not "[elided N]")
      // and its original content was offloaded non-lossy to the archive.
      const toolMsg = messages.find((m) => Array.isArray(m.content));
      const block = toolMsg?.content as { type: "tool_result"; content: string }[] | undefined;
      expect(block?.[0]?.type).toBe("tool_result");
      expect(block?.[0]?.content).toMatch(/^\[tool result archived → .+\]$/);
      // A stage-4 archive note was injected.
      expect(messages[0]?.content).toContain("Full history archived at");
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  });

  test("no report (first turn) → compression still keyed on the local estimate only", async () => {
    // Fresh store: no reported pressure, so the ~500-token local estimate stays
    // under the 800 target and nothing is compressed.
    const events: string[] = [];
    const provider = mockProvider([endTurn(0)]);
    const messages: ChatMessage[] = smallMessages.map((m) => structuredClone(m));

    await runAgentTurn({
      ...base,
      provider,
      messages,
      onEvent: (e) => events.push(e.t),
    });

    expect(events).not.toContain("compression");
  });

  test("shared store is the default when none is passed", () => {
    expect(sharedTokenPressure).toBeInstanceOf(TokenPressure);
  });
});
