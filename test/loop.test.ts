import { describe, test, expect } from "bun:test";
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  StreamCallbacks,
} from "../src/provider/types";
import { runAgentTurn } from "../src/agent/loop";
import type { ChatMessage } from "../src/provider/types";
import { Budget } from "../src/agent/budget";
import { readTool } from "../src/tools/read";

function mockProvider(script: ChatResponse[]): Provider & { requests: ChatRequest[] } {
  let i = 0;
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: ChatRequest, _cb?: StreamCallbacks) {
      requests.push(req);
      const next = script[i++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}

const endTurn = (text: string): ChatResponse => ({
  stopReason: "end_turn",
  content: [{ type: "text", text }],
  usage: { inputTokens: 10, outputTokens: 5 },
});

/** Await a rejected runAgentTurn and return the thrown Error (type-safe). */
async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected runAgentTurn to throw");
}

describe("runAgentTurn", () => {
  const tools = [readTool];
  const base = {
    model: "test-model",
    system: "sys",
    tools,
    maxTokens: 1024,
    cwd: import.meta.dir,
    approve: async () => true,
  };

  test("plain text turn appends assistant message", async () => {
    const provider = mockProvider([endTurn("hi there")]);
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const result = await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });
    expect(result.stopReason).toBe("end_turn");
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi there" }],
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  test("tool_use round trip executes tool and feeds result back", async () => {
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "loop.test.ts" } },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      endTurn("done reading"),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: "read the file" }];
    const events: string[] = [];
    const result = await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (e) => events.push(e.t),
    });

    expect(result.stopReason).toBe("end_turn");
    expect(messages).toHaveLength(4);
    const toolMsg = messages[2];
    if (toolMsg?.role !== "user" || typeof toolMsg.content === "string") {
      throw new Error("expected user tool_result message");
    }
    const block = toolMsg.content[0];
    if (!block) throw new Error("missing tool_result block");
    expect(block.type).toBe("tool_result");
    if (block.type === "tool_result") {
      expect(block.toolUseId).toBe("t1");
      expect(block.isError).toBe(false);
      expect(block.content).toContain("runAgentTurn");
    }
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
  });

  test("declined approval produces error tool_result", async () => {
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t2", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("ok"),
    ]);
    const messages: ChatMessage[] = [];
    await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      approve: async () => false,
    });
    const toolMsg = messages[1];
    if (toolMsg?.role !== "user" || typeof toolMsg.content === "string") {
      throw new Error("expected user tool_result message");
    }
    const block = toolMsg.content[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type === "tool_result") {
      expect(block.isError).toBe(true);
      expect(block.content).toMatch(/declined/i);
    }
  });

  test("unknown tool yields error result without throwing", async () => {
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t3", name: "does_not_exist", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("ok"),
    ]);
    const messages: ChatMessage[] = [];
    await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });
    const toolMsg = messages[1];
    if (toolMsg?.role !== "user" || typeof toolMsg.content === "string") {
      throw new Error("expected user tool_result message");
    }
    const block = toolMsg.content[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type === "tool_result") {
      expect(block.isError).toBe(true);
      expect(block.content).toContain("Unknown tool");
    }
  });

  test("budget cap halts before provider call when already spent", async () => {
    const provider = mockProvider([]);
    const budget = new Budget(5, { inputPerMTok: 1, outputPerMTok: 1 });
    budget.spentUSD = 5;
    const result = await runAgentTurn({
      ...base,
      provider,
      messages: [],
      budget,
    });
    expect(result.stopReason).toBe("budget_exhausted");
    expect(provider.requests).toHaveLength(0);
  });

  test("budget exhausts mid-turn after tool execution", async () => {
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t4", name: "read_file", input: { path: "x.ts" } }],
        usage: { inputTokens: 50_000_000, outputTokens: 0 },
      },
    ]);
    const messages: ChatMessage[] = [];
    const result = await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(10, { inputPerMTok: 1, outputPerMTok: 1 }),
    });
    expect(result.stopReason).toBe("budget_exhausted");
    expect(provider.requests).toHaveLength(1);
  });

  test("context guard compresses oversized tool results and emits compression event", async () => {
    const provider = mockProvider([endTurn("done")]);
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "x", content: "z".repeat(80_000) }],
      },
    ];
    const events: string[] = [];
    const result = await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (e) => events.push(e.t),
      contextGuard: { enabled: true, thresholdRatio: 0.8, windowTokens: 1_000 },
    });
    expect(result.stopReason).toBe("end_turn");
    expect(events).toContain("compression");
    // the tool result sent to the provider was elided to a placeholder
    const sent = provider.requests[0]?.messages;
    expect(sent).toBeDefined();
    const toolMsg = sent?.find((m) => m.role === "user" && Array.isArray(m.content));
    const block = (toolMsg?.content as { type: "tool_result"; content: string }[] | undefined)?.[0];
    expect(block?.type).toBe("tool_result");
    expect(block?.content).toMatch(/^\[elided \d+ tokens\]$/);
  });

  test("context guard disabled emits no compression", async () => {
    const provider = mockProvider([endTurn("done")]);
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      { role: "user", content: [{ type: "tool_result", toolUseId: "x", content: "z".repeat(80_000) }] },
    ];
    const events: string[] = [];
    await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (e) => events.push(e.t),
      contextGuard: { enabled: false, thresholdRatio: 0.8, windowTokens: 1_000 },
    });
    expect(events).not.toContain("compression");
  });

  // --- error-path sweep (#338): provider failures must surface as clean,
  // one-line, human-readable errors — never a raw stack trace / payload. ---

  test("provider Error surfaces as a clean one-line message, no stack", async () => {
    const provider = {
      name: "mock",
      requests: [] as never[],
      async chat() {
        throw new Error("HTTP 500 upstream exploded\n    at Provider.chat (/app/src/provider/factory.ts:12:7)");
      },
    };
    await expect(
      runAgentTurn({
        ...base,
        provider,
        messages: [{ role: "user", content: "hi" }],
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      }),
    ).rejects.toThrow(/HTTP 500 upstream exploded/);
  });

  test("provider error message is collapsed to its first line (no stack leak)", async () => {
    const provider = {
      name: "mock",
      requests: [] as never[],
      async chat() {
        throw new Error("boom\n    at Provider.chat (/app/src/provider/factory.ts:12:7)");
      },
    };
    const err = await captureError(() =>
      runAgentTurn({
        ...base,
        provider,
        messages: [{ role: "user", content: "hi" }],
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      }),
    );
    expect(err.message).toBe("boom");
  });

  test("provider abort surfaces as a clean abort message", async () => {
    const provider = {
      name: "mock",
      requests: [] as never[],
      async chat() {
        const e = new Error("This operation was aborted");
        e.name = "AbortError";
        throw e;
      },
    };
    await expect(
      runAgentTurn({
        ...base,
        provider,
        messages: [{ role: "user", content: "hi" }],
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      }),
    ).rejects.toThrow(/abort/i);
  });

  test("provider non-Error throw (object) never leaks [object Object]", async () => {
    const provider = {
      name: "mock",
      requests: [] as never[],
      async chat() {
        throw { code: 429, body: "rate limit" }; // non-Error value
      },
    };
    const err = await captureError(() =>
      runAgentTurn({
        ...base,
        provider,
        messages: [{ role: "user", content: "hi" }],
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      }),
    );
    expect(err.message).not.toContain("[object Object]");
    expect(err.message.length).toBeGreaterThan(0);
  });

  test("malformed provider response surfaces a clean error, not a TypeError", async () => {
    const provider = {
      name: "mock",
      requests: [] as never[],
      async chat() {
        return { stopReason: "end_turn", content: null, usage: { inputTokens: 0, outputTokens: 0 } } as never;
      },
    };
    const err = await captureError(() =>
      runAgentTurn({
        ...base,
        provider,
        messages: [{ role: "user", content: "hi" }],
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      }),
    );
    expect(err.message).toMatch(/malformed/i);
  });
});
