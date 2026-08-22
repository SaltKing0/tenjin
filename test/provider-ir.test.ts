import { describe, test, expect } from "bun:test";
import {
  openAiToolCallToIR,
  irToOpenAiToolCall,
  openAiToolResultToIR,
  irToOpenAiToolResult,
  anthropicToolUseToIR,
  irToAnthropicToolUse,
  anthropicToolResultToIR,
  irToAnthropicToolResult,
  irResultForCall,
  blocksToIR,
  irToBlocks,
  schemaToToolDefinition,
  toolDefinitionToSchema,
  type OpenAiNativeToolCall,
  type AnthropicNativeToolUse,
} from "../src/provider/ir";
import type { ToolCall, ContentBlock } from "../src/provider/types";

describe("OpenAI request/response round-trips to IR and back without loss (B7-1)", () => {
  const native: OpenAiNativeToolCall = {
    id: "call_abc123",
    type: "function",
    function: { name: "write_file", arguments: '{"path":"a.ts","content":"x"}' },
  };

  test("tool call → IR → native preserves id, name and arguments", () => {
    const ir = openAiToolCallToIR("openai", native);
    expect(ir.provider).toBe("openai");
    expect(ir.providerCallId).toBe("call_abc123");
    expect(ir.name).toBe("write_file");
    expect(ir.arguments).toEqual({ path: "a.ts", content: "x" });

    const back = irToOpenAiToolCall(ir);
    expect(back.id).toBe("call_abc123");
    expect(back.function.name).toBe("write_file");
    expect(JSON.parse(back.function.arguments)).toEqual({ path: "a.ts", content: "x" });
    // The raw native payload is preserved on the IR node.
    expect(ir.raw).toEqual(native);
  });

  test("tool result round-trips without loss", () => {
    const nativeRes = { role: "tool" as const, tool_call_id: "call_abc123", content: "Wrote 1 bytes" };
    const ir = openAiToolResultToIR(nativeRes);
    expect(ir.providerCallId).toBe("call_abc123");
    expect(ir.ok).toBe(true);
    expect(ir.content).toBe("Wrote 1 bytes");
    expect(irToOpenAiToolResult(ir)).toEqual(nativeRes);
  });
});

describe("Anthropic request/response round-trips to IR and back without loss (B7-1)", () => {
  const native: AnthropicNativeToolUse = {
    type: "tool_use",
    id: "toolu_xyz",
    name: "read_file",
    input: { path: "a.ts" },
  };

  test("tool_use → IR → native preserves id, name and input", () => {
    const ir = anthropicToolUseToIR("anthropic", native);
    expect(ir.provider).toBe("anthropic");
    expect(ir.providerCallId).toBe("toolu_xyz");
    expect(ir.name).toBe("read_file");
    expect(ir.arguments).toEqual({ path: "a.ts" });

    const back = irToAnthropicToolUse(ir);
    expect(back.id).toBe("toolu_xyz");
    expect(back.name).toBe("read_file");
    expect(back.input).toEqual({ path: "a.ts" });
  });

  test("tool_result round-trips without loss, including error flag", () => {
    const ok = anthropicToolResultToIR({ type: "tool_result", tool_use_id: "toolu_xyz", content: "ok" });
    expect(ok.providerCallId).toBe("toolu_xyz");
    expect(ok.ok).toBe(true);
    expect(irToAnthropicToolResult(ok)).toEqual({ type: "tool_result", tool_use_id: "toolu_xyz", content: "ok" });

    const err = anthropicToolResultToIR({
      type: "tool_result",
      tool_use_id: "toolu_xyz",
      content: "boom",
      is_error: true,
    });
    expect(err.ok).toBe(false);
    const nativeErr = irToAnthropicToolResult(err);
    expect(nativeErr.is_error).toBe(true);
    expect(nativeErr.tool_use_id).toBe("toolu_xyz");
  });
});

describe("providerCallId correlation across a simulated 3-turn history (B7-1)", () => {
  test("every result answers its originating call by id, across turns", () => {
    const calls: ToolCall[] = [];
    const results: { call: ToolCall; result: ReturnType<typeof irResultForCall> }[] = [];

    // Simulate three turns, each issuing a tool call that gets a result.
    const turnSpecs: Array<{ providerCallId: string; name: string }> = [
      { providerCallId: "call_1", name: "read_file" },
      { providerCallId: "call_2", name: "grep" },
      { providerCallId: "call_3", name: "write_file" },
    ];
    for (const spec of turnSpecs) {
      const call: ToolCall = {
        provider: "openai",
        providerCallId: spec.providerCallId,
        name: spec.name,
        arguments: {},
      };
      calls.push(call);
      // The result is built from the call, so it MUST carry the same id.
      results.push({ call, result: irResultForCall(call, true, `result of ${spec.name}`) });
    }

    // Correlation: each result's providerCallId equals its originating call's.
    for (const { call, result } of results) {
      expect(result.providerCallId).toBe(call.providerCallId);
    }
    // And the ids are distinct per call (no cross-turn mix-up).
    const ids = results.map((r) => r.result.providerCallId);
    expect(new Set(ids).size).toBe(3);

    // Threading through a ContentBlock[] history entry preserves the ids.
    const history: ContentBlock[] = [];
    for (const { call, result } of results) {
      history.push({ type: "tool_use", id: call.providerCallId, name: call.name, input: call.arguments });
      history.push({ type: "tool_result", toolUseId: result.providerCallId, content: result.content, isError: !result.ok });
    }
    const ir = blocksToIR(history, "openai");
    expect(ir.calls.length).toBe(3);
    expect(ir.results.length).toBe(3);
    for (let i = 0; i < ir.calls.length; i++) {
      expect(ir.results[i]!.providerCallId).toBe(ir.calls[i]!.providerCallId);
      expect(ir.calls[i]!.providerCallId).toBe(turnSpecs[i]!.providerCallId);
    }
    // And back out to blocks, threading the same ids (lossless on the glue).
    const rebuilt = irToBlocks(ir.calls, ir.results);
    const useIds = rebuilt.filter((b) => b.type === "tool_use").map((b) => b.id);
    const resIds = rebuilt
      .filter((b) => b.type === "tool_result")
      .map((b) => b.toolUseId);
    expect(useIds).toEqual(["call_1", "call_2", "call_3"]);
    expect(resIds).toEqual(["call_1", "call_2", "call_3"]);

    // Re-round-tripping the rebuilt history recovers the same calls/results.
    const back = blocksToIR(rebuilt, "openai");
    expect(back.calls.map((c) => c.providerCallId)).toEqual(
      ir.calls.map((c) => c.providerCallId),
    );
    expect(back.results.map((r) => r.providerCallId)).toEqual(
      ir.results.map((r) => r.providerCallId),
    );
  });
});

describe("arguments arrive as OBJECT even from string deltas (B7-1)", () => {
  test("OpenAI string arguments parse to an object", () => {
    const ir = openAiToolCallToIR("openai", {
      id: "c1",
      type: "function",
      function: { name: "f", arguments: '{"k":1,"nested":{"x":true}}' },
    });
    expect(ir.arguments).toEqual({ k: 1, nested: { x: true } });
    expect(typeof ir.arguments).toBe("object");
    expect(Array.isArray(ir.arguments)).toBe(false);
  });

  test("unparsable string delta is boxed into an object (never left a string)", () => {
    const ir = openAiToolCallToIR("openai", {
      id: "c2",
      type: "function",
      function: { name: "f", arguments: "not-json{{{" },
    });
    expect(typeof ir.arguments).toBe("object");
    expect(ir.arguments).toHaveProperty("_unparsed", "not-json{{{");
  });

  test("empty / missing arguments become an empty object", () => {
    const ir = openAiToolCallToIR("openai", {
      id: "c3",
      type: "function",
      function: { name: "f", arguments: "" },
    });
    expect(ir.arguments).toEqual({});
  });

  test("Anthropic non-object input is boxed into an object", () => {
    const ir = anthropicToolUseToIR("anthropic", {
      type: "tool_use",
      id: "t1",
      name: "f",
      input: "a bare string",
    });
    expect(typeof ir.arguments).toBe("object");
    expect(ir.arguments).toHaveProperty("_unparsed", "a bare string");
  });
});

describe("tool definitions (B7-1)", () => {
  test("schemaToToolDefinition adds sideEffect; toolDefinitionToSchema drops it", () => {
    const schema = {
      name: "write_file",
      description: "write a file",
      inputSchema: { type: "object" as const, properties: {} },
    };
    const def = schemaToToolDefinition(schema, true);
    expect(def.sideEffect).toBe(true);
    expect(def.name).toBe("write_file");
    const back = toolDefinitionToSchema(def);
    expect(back).toEqual(schema);
    expect((back as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });
});
