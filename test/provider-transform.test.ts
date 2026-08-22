import { describe, test, expect } from "bun:test";
import {
  isEmptyText,
  normalizeToolCallId,
  isRealAnthropicEndpoint,
  mapReasoningEffort,
  createChunkTransformer,
  resolveToolCallId,
  type NativeDelta,
} from "../src/provider/transform";

function collect(deltas: NativeDelta[]): ReturnType<ReturnType<typeof createChunkTransformer>["push"]> {
  const t = createChunkTransformer("openai");
  const out: ReturnType<ReturnType<typeof createChunkTransformer>["push"]> = [];
  for (const d of deltas) out.push(...t.push(d));
  return out;
}

describe("B2-7 quirk absorption (fixtures)", () => {
  test("empty/whitespace-only text is filtered (never a text chunk)", () => {
    expect(isEmptyText("   \n  ")).toBe(true);
    expect(isEmptyText("real")).toBe(false);
    const chunks = collect([{ kind: "text_delta", text: "  " }, { kind: "text_delta", text: "hi" }]);
    expect(chunks.filter((c) => c.type === "text_delta")).toHaveLength(1); // only "hi"
    expect(chunks[0]).toEqual({ type: "text_start", id: "text_openai" });
  });

  test("tool-call id normalizes to Mistral's 9-char [a-zA-Z0-9] deterministically", () => {
    // Already-conforming id passes through.
    expect(normalizeToolCallId("abc123XYZ")).toBe("abc123XYZ");
    // Non-conforming id maps to a stable 9-char id.
    const a = normalizeToolCallId("call_very_long_openai_id_42");
    const b = normalizeToolCallId("call_very_long_openai_id_42");
    expect(a).toBe(b); // deterministic
    expect(a).toMatch(/^[a-zA-Z0-9]{9}$/);
  });

  test("cache_control is gated to real Anthropic endpoints", () => {
    expect(isRealAnthropicEndpoint("https://api.anthropic.com/v1")).toBe(true);
    expect(isRealAnthropicEndpoint("https://api.anthropic.com")).toBe(true);
    expect(isRealAnthropicEndpoint("https://openrouter.ai/anthropic/claude")).toBe(false);
    expect(isRealAnthropicEndpoint("")).toBe(false);
  });

  test("generic reasoning effort maps per provider", () => {
    expect(mapReasoningEffort("high", "anthropic")).toEqual({
      thinking: { type: "enabled", budgetTokens: 8192 },
    });
    expect(mapReasoningEffort("low", "openai")).toEqual({ reasoning_effort: "low" });
    expect(mapReasoningEffort("medium", "openai")).toEqual({});
    expect(mapReasoningEffort(undefined, "anthropic")).toEqual({});
  });
});

describe("B2-7 correlation: providerCallId survives end-to-end", () => {
  test("tool_call and tool_input_end share the same normalized providerCallId", () => {
    const rawId = "call_long_anthropic_tool_id";
    const deltas: NativeDelta[] = [
      { kind: "tool_call_start", index: 0, id: rawId, name: "bash" },
      { kind: "tool_input_delta", index: 0, fragment: '{"cmd":' },
      { kind: "tool_input_delta", index: 0, fragment: '"ls"}' },
      { kind: "finish", reason: "tool_calls" },
    ];
    const chunks = collect(deltas);
    const call = chunks.find((c) => c.type === "tool_call");
    const end = chunks.find((c) => c.type === "tool_input_end");
    expect(call).toBeDefined();
    expect(end).toBeDefined();
    if (call?.type === "tool_call" && end?.type === "tool_input_end") {
      expect(call.providerCallId).toBe(end.providerCallId);
      // A result referencing the same raw id resolves to the same providerCallId.
      expect(resolveToolCallId(rawId)).toBe(call.providerCallId);
    } else {
      throw new Error("expected tool_call + tool_input_end chunks");
    }
  });
});

describe("B2-7 arguments-string delta buffering (parse exactly once at done)", () => {
  test("fragments buffer and parse once at finish; tool_input_end carries the object", () => {
    const chunks = collect([
      { kind: "tool_call_start", index: 0, id: "call_1", name: "bash" },
      { kind: "tool_input_delta", index: 0, fragment: '{"a":' },
      { kind: "tool_input_delta", index: 0, fragment: '1,"b":"x"}' },
      { kind: "finish", reason: "tool_calls" },
    ]);
    const ends = chunks.filter((c) => c.type === "tool_input_end");
    expect(ends).toHaveLength(1); // parsed exactly once
    const first = ends[0];
    if (first?.type === "tool_input_end") {
      expect(first.arguments).toEqual({ a: 1, b: "x" });
    }
  });

  test("malformed buffered JSON degrades to _unparsed, still parsed once", () => {
    const chunks = collect([
      { kind: "tool_call_start", index: 0, id: "call_1", name: "bash" },
      { kind: "tool_input_delta", index: 0, fragment: "{not-json" },
      { kind: "finish" },
    ]);
    const end = chunks.find((c) => c.type === "tool_input_end");
    expect(end).toBeDefined();
    if (end?.type === "tool_input_end") {
      expect(end.arguments).toEqual({ _unparsed: "{not-json" });
    }
  });
});

describe("B2-7 content:null is a valid tool turn", () => {
  test("tool_call emits without any text chunk; finish still closes the stream", () => {
    // OpenAI tool turn: delta.content is null/absent, only tool_calls arrive.
    const chunks = collect([
      { kind: "tool_call_start", index: 0, id: "call_1", name: "bash" },
      { kind: "tool_input_delta", index: 0, fragment: '{}' },
      { kind: "finish", reason: "tool_calls" },
    ]);
    expect(chunks.some((c) => c.type === "tool_call")).toBe(true);
    expect(chunks.some((c) => c.type === "text_start")).toBe(false); // no text block
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });
});

describe("B2-7 unified chunk contract (text + reasoning + finish)", () => {
  test("text stream emits start/delta/end and reasoning deltas", () => {
    const t = createChunkTransformer("openai");
    const out = t.push({ kind: "reasoning_delta", text: "think..." });
    expect(out).toEqual([{ type: "reasoning_delta", id: "text_openai", text: "think..." }]);
    const text = t.push({ kind: "text_delta", text: "hello" });
    expect(text[0]).toEqual({ type: "text_start", id: "text_openai" });
    expect(text[1]).toEqual({ type: "text_delta", id: "text_openai", text: "hello" });
    const fin = t.finish();
    expect(fin[0]).toEqual({ type: "text_end", id: "text_openai" });
    expect(fin[1]).toEqual({ type: "finish", reason: "stop" });
  });

  test("error delta surfaces as a classified error chunk", () => {
    const t = createChunkTransformer("openai");
    expect(t.push({ kind: "error", message: "boom" })).toEqual([
      { type: "error", message: "boom", kind: "provider" },
    ]);
  });

  test("anthropic pre-parsed input_json ends the tool input without buffering", () => {
    const t = createChunkTransformer("anthropic");
    t.push({ kind: "tool_call_start", index: 0, id: "abc123XYZ", name: "bash" });
    const end = t.push({ kind: "tool_input_json", index: 0, json: { cmd: "ls" } });
    expect(end[0]).toMatchObject({
      type: "tool_input_end",
      providerCallId: "abc123XYZ",
      arguments: { cmd: "ls" },
    });
  });
});
