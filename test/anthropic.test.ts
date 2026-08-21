import { describe, test, expect } from "bun:test";
import { parseSse } from "../src/provider/sse";
import {
  AnthropicStreamAssembler,
  buildRequestBody,
  toApiMessages,
} from "../src/provider/anthropic";
import type { ChatMessage, ToolSchema } from "../src/provider/types";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(frames: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const f of parseSse(streamFrom(frames))) out.push(f.data);
  return out;
}

describe("sse parser", () => {
  test("parses split chunks and multi-line data", async () => {
    const datas = await collect([
      'event: message_start\ndata: {"a":1}\n\ndata: line1\ndata: line2\n\n',
      'event: message_stop\ndata: {"b":2',
      "}\n\n",
    ]);
    expect(datas).toEqual(['{"a":1}', "line1\nline2", '{"b":2}']);
  });

  test("ignores comments and keepalives", async () => {
    const datas = await collect([": ping\n\n", 'data: {"ok":true}\n\n']);
    expect(datas).toEqual(['{"ok":true}']);
  });
});

describe("anthropic request building", () => {
  const tools: ToolSchema[] = [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];

  test("string content becomes text block; tool results map fields", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "using tool" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "contents", isError: true }],
      },
    ];
    const api = toApiMessages(messages) as any[];
    expect(api[0].content).toEqual([{ type: "text", text: "hello" }]);
    expect(api[1].content[1]).toEqual({ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } });
    expect(api[2].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "t1",
      content: "contents",
      is_error: true,
    });
  });

  test("body includes system (cached), tools, stream flag by default", () => {
    const body = buildRequestBody({
      model: "claude-sonnet-4-5",
      system: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
      maxTokens: 1024,
    }) as any;
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
    expect(body.tools[0].input_schema.type).toBe("object");
  });

  test("caching on adds cache_control to system and last tool", () => {
    const body = buildRequestBody(
      {
        model: "claude-sonnet-4-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          { name: "a", description: "A", inputSchema: { type: "object", properties: {} } },
          { name: "b", description: "B", inputSchema: { type: "object", properties: {} } },
        ],
        maxTokens: 100,
      },
      { caching: true },
    ) as any;
    expect(body.system).toEqual([
      { type: "text", text: "sys", cache_control: { type: "ephemeral" } },
    ]);
    // Only the last tool carries the breakpoint.
    expect(body.tools[0].cache_control).toBeUndefined();
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  test("caching off leaves system as string and no cache_control", () => {
    const body = buildRequestBody(
      {
        model: "claude-sonnet-4-5",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools,
        maxTokens: 100,
      },
      { caching: false },
    ) as any;
    expect(body.system).toBe("sys");
    expect(body.tools[0].cache_control).toBeUndefined();
  });
});

describe("anthropic stream assembler", () => {
  function frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  test("assembles text, tool_use json, usage, stop reason", () => {
    const a = new AnthropicStreamAssembler();
    const deltas: string[] = [];
    a.onTextDelta = (d) => deltas.push(d);
    a.handle({ event: "message_start", data: JSON.stringify({ message: { usage: { input_tokens: 100 } } }) });
    a.handle({ event: "content_block_start", data: JSON.stringify({ index: 0, content_block: { type: "text" } }) });
    a.handle({ event: "content_block_delta", data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "Hel" } }) });
    a.handle({ event: "content_block_delta", data: JSON.stringify({ index: 0, delta: { type: "text_delta", text: "lo" } }) });
    a.handle({ event: "content_block_start", data: JSON.stringify({ index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } }) });
    a.handle({ event: "content_block_delta", data: JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } }) });
    a.handle({ event: "content_block_delta", data: JSON.stringify({ index: 1, delta: { type: "input_json_delta", partial_json: 'th":"f.ts"}' } }) });
    a.handle({ event: "message_delta", data: JSON.stringify({ delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }) });

    const resp = a.done();
    expect(deltas.join("")).toBe("Hello");
    expect(resp.usage).toEqual({ inputTokens: 100, outputTokens: 42 });
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.content[0]).toEqual({ type: "text", text: "Hello" });
    expect(resp.content[1]).toEqual({
      type: "tool_use",
      id: "tu_1",
      name: "read_file",
      input: { path: "f.ts" },
    });
  });

  test("parses prompt-cache read/creation tokens from message_start", () => {
    const a = new AnthropicStreamAssembler();
    a.handle({
      event: "message_start",
      data: JSON.stringify({
        message: {
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 400,
            cache_read_input_tokens: 100,
          },
        },
      }),
    });
    a.handle({ event: "message_delta", data: JSON.stringify({ usage: { output_tokens: 7 } }) });
    const resp = a.done();
    expect(resp.usage).toEqual({
      inputTokens: 500,
      outputTokens: 7,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 400,
    });
  });

  test("empty tool json becomes empty object", () => {
    const a = new AnthropicStreamAssembler();
    a.handle({ event: "content_block_start", data: JSON.stringify({ index: 0, content_block: { type: "tool_use", id: "x", name: "noop" } }) });
    const resp = a.done();
    expect((resp.content[0] as any).input).toEqual({});
  });

  test("error event throws", () => {
    const a = new AnthropicStreamAssembler();
    expect(() =>
      a.handle({ event: "error", data: JSON.stringify({ error: { message: "boom" } }) }),
    ).toThrow(/boom/);
  });
});
