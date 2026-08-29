import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ToolDef } from "../src/tools/registry";
import { Redactor } from "../src/security/redact";

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

  test("redacts tool secrets before model context, transcript, and events", async () => {
    const secret = "sk-testsecret123456789";
    const secretTool: ToolDef = {
      name: "emit_secret",
      group: "read",
      description: "test-only secret emitter",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        return `OPENAI_API_KEY=${secret}`;
      },
    };
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "secret-1", name: "emit_secret", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("done"),
    ]);
    const messages: ChatMessage[] = [{ role: "user", content: "read secret" }];
    const eventOutputs: string[] = [];

    await runAgentTurn({
      ...base,
      tools: [secretTool],
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (event) => {
        if (event.t === "tool_result") eventOutputs.push(event.output);
      },
    });

    const providerContext = JSON.stringify(provider.requests[1]?.messages);
    expect(providerContext).not.toContain(secret);
    expect(providerContext).toContain("[REDACTED]");
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(eventOutputs).toEqual(["OPENAI_API_KEY=[REDACTED]"]);
  });

  test("redacts resumed tool results in-place but leaves ordinary user text raw", async () => {
    const secret = "sk-resumedSecret123456789";
    const userText = `please discuss ${secret} exactly`;
    const messages: ChatMessage[] = [
      { role: "user", content: userText },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "old", content: `legacy ${secret}` }],
      },
    ];
    const provider = mockProvider([endTurn("done")]);

    await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });

    expect(provider.requests[0]?.messages[0]?.content).toBe(userText);
    const sentToolMessage = provider.requests[0]?.messages[1];
    if (!sentToolMessage || typeof sentToolMessage.content === "string") {
      throw new Error("expected resumed tool-result message");
    }
    const sentBlock = sentToolMessage.content[0];
    expect(sentBlock?.type).toBe("tool_result");
    if (sentBlock?.type === "tool_result") {
      expect(sentBlock.content).toBe("legacy [REDACTED]");
    }
    const storedToolMessage = messages[1];
    expect(JSON.stringify(storedToolMessage)).not.toContain(secret);
  });

  test("redacts a short browser value reflected in a legacy resumed result", async () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "legacy-browser",
          name: "browser",
          input: { action: "type", url: "https://example.test", selector: "#pin", text: "1234" },
        }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          toolUseId: "legacy-browser",
          content: "page reflected PIN 1234",
        }],
      },
    ];
    const provider = mockProvider([endTurn("done")]);

    await runAgentTurn({
      ...base,
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });

    const visible = JSON.stringify({ messages, request: provider.requests[0] });
    expect(visible).toContain("[REDACTED]");
    expect(visible).not.toContain("1234");
  });

  test("passes the active redactor into ToolContext", async () => {
    const redactor = new Redactor(true, ["opaque-context-secret"]);
    let seen = false;
    const contextTool: ToolDef = {
      name: "context_redactor",
      group: "read",
      description: "observes the tool context",
      inputSchema: { type: "object", properties: {} },
      async handler(_input, ctx) {
        seen = ctx.redactor === redactor;
        return "ok";
      },
    };
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "ctx", name: "context_redactor", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("done"),
    ]);

    await runAgentTurn({
      ...base,
      tools: [contextTool],
      provider,
      redactor,
      messages: [],
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });
    expect(seen).toBe(true);
  });

  test("redacts exact secret literals before the central output cap", async () => {
    const secret = "opaque-secret-crossing-the-output-cap-boundary";
    const prefix = "x".repeat(29_980);
    const longTool: ToolDef = {
      name: "long_secret",
      group: "read",
      description: "emits a long test value",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        return `${prefix}${secret}${"y".repeat(100)}`;
      },
    };
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "long", name: "long_secret", input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("done"),
    ]);
    const events: string[] = [];

    await runAgentTurn({
      ...base,
      tools: [longTool],
      provider,
      redactor: new Redactor(true, [secret]),
      messages: [],
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (event) => {
        if (event.t === "tool_result") events.push(event.output);
      },
    });

    expect(events[0]).toContain("[REDACTED]");
    expect(events[0]).not.toContain(secret.slice(0, 20));
    expect(events[0]).toContain("[output truncated at 30000 chars]");
  });

  test("keeps browser type text raw only for dispatch and sanitizes every visible copy", async () => {
    const typed = 1234; // coerced to a short string by validateToolArgs
    const typedText = String(typed);
    const rawUrl = "https://alice:password@example.test/form?api_token=opaque-query&city=Berlin";
    let handlerInput: Record<string, unknown> | undefined;
    let approvalInput: unknown;
    const browser: ToolDef = {
      name: "browser",
      group: "write",
      description: "test browser boundary",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          url: { type: "string" },
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["action", "url"],
      },
      async handler(input) {
        handlerInput = input;
        return `${"x".repeat(29_980)}${String(input.text)} reflected`;
      },
    };
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [
          { type: "text", text: `I will type ${typedText}` },
          {
            type: "tool_use",
            id: "browser-type",
            name: "browser",
            input: { action: "type", url: rawUrl, selector: "#password", text: typed },
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("done"),
    ]);
    const scriptedChat = provider.chat.bind(provider);
    let providerCall = 0;
    provider.chat = async (request, callbacks, signal) => {
      const response = await scriptedChat(request, undefined, signal);
      if (providerCall++ === 0) callbacks?.onTextDelta?.(`I will type ${typedText}`);
      return response;
    };
    const messages: ChatMessage[] = [];
    const visibleEvents: unknown[] = [];
    const visibleDeltas: string[] = [];

    const turn = await runAgentTurn({
      ...base,
      tools: [browser],
      provider,
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      approve: async (_name, _group, input) => {
        approvalInput = input;
        return true;
      },
      onEvent: (event) => {
        if (event.t === "assistant_message" || event.t === "tool_call" || event.t === "tool_result") {
          visibleEvents.push(event);
        }
      },
      onTextDelta: (delta) => visibleDeltas.push(delta),
    });

    expect(handlerInput?.text).toBe(typedText);
    expect(handlerInput?.url).toBe(rawUrl);
    expect((approvalInput as Record<string, unknown>).text).toBe(typed);
    expect((approvalInput as Record<string, unknown>).url).toBe(rawUrl);
    const visible = JSON.stringify({
      result: turn,
      messages,
      visibleEvents,
      visibleDeltas,
      request: provider.requests[1],
    });
    expect(visible).toContain("[REDACTED]");
    expect(visible).not.toContain(typedText);
    expect(visible).not.toContain("alice");
    expect(visible).not.toContain(":password@");
    expect(visible).not.toContain("opaque-query");
    expect(visible).toContain("city=Berlin");
  });

  test("redaction:false preserves browser type input and reflected output", async () => {
    const typed = "opaque typed value";
    let handlerText = "";
    const browser: ToolDef = {
      name: "browser",
      group: "write",
      description: "test browser opt-out",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string" }, url: { type: "string" }, text: { type: "string" } },
        required: ["action", "url"],
      },
      async handler(input) {
        handlerText = String(input.text);
        return `reflected ${input.text}`;
      },
    };
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "browser-unredacted",
          name: "browser",
          input: { action: "type", url: "https://example.test", text: typed },
        }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      endTurn("done"),
    ]);
    const messages: ChatMessage[] = [];
    const events: unknown[] = [];

    await runAgentTurn({
      ...base,
      tools: [browser],
      provider,
      redactor: new Redactor(false),
      messages,
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
      onEvent: (event) => events.push(event),
    });

    expect(handlerText).toBe(typed);
    expect(JSON.stringify({ messages, events, request: provider.requests[1] })).toContain(typed);
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
    const archivedSecret = "sk-archiveSecret123456789";
    const messages: ChatMessage[] = [
      { role: "user", content: "do it" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "x",
            content: `${archivedSecret}\n${"z".repeat(80_000)}`,
          },
        ],
      },
    ];
    const events: string[] = [];
    const archiveDir = mkdtempSync(join(tmpdir(), "loop-archive-"));
    try {
      const result = await runAgentTurn({
        ...base,
        provider,
        messages,
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
        onEvent: (e) => events.push(e.t),
        contextGuard: { enabled: true, thresholdRatio: 0.8, windowTokens: 1_000 },
        archiveDir,
        compaction: { keepLast: 0 },
      });
      expect(result.stopReason).toBe("end_turn");
      expect(events).toContain("compression");
      // B2-3/B2-4: the tool result sent to the provider was pointer-replaced.
      const sent = provider.requests[0]?.messages;
      expect(sent).toBeDefined();
      const toolMsg = sent?.find((m) => m.role === "user" && Array.isArray(m.content));
      const block = (toolMsg?.content as { type: "tool_result"; content: string }[] | undefined)?.[0];
      expect(block?.type).toBe("tool_result");
      expect(block?.content).toMatch(/^\[tool result archived → .+\]$/);
      const archive = readFileSync(join(archiveDir, "default.md"), "utf8");
      expect(archive).toContain("[REDACTED]");
      expect(archive).not.toContain(archivedSecret);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
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
