import { describe, test, expect } from "bun:test";
import {
  OpenAiStreamAssembler,
  buildRequestBody,
  toOpenAiMessages,
} from "../src/provider/openai";
import type { ChatMessage } from "../src/provider/types";

describe("openai message conversion", () => {
  test("system prompt first, string content mapped", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "hello" }];
    const api = toOpenAiMessages(msgs, "sys");
    expect(api[0]).toEqual({ role: "system", content: "sys" });
    expect(api[1]).toEqual({ role: "user", content: "hello" });
  });

  test("assistant tool_use becomes tool_calls with JSON arguments", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const api = toOpenAiMessages(msgs, "s");
    expect(api[1]).toEqual({
      role: "assistant",
      content: "reading",
      tool_calls: [
        {
          id: "t1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    });
  });

  test("tool_result becomes role:tool message", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: "file data", isError: false }],
      },
    ];
    expect(toOpenAiMessages(msgs, "s")[1]).toEqual({
      role: "tool",
      tool_call_id: "t1",
      content: "file data",
    });
  });

  test("request body carries tools and stream options", () => {
    const body = buildRequestBody({
      model: "gpt-4o",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "glob",
          description: "find files",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
      maxTokens: 512,
    }) as any;
    expect(body.model).toBe("gpt-4o");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("glob");
    expect(body.tool_choice).toBe("auto");
  });
});

describe("openai stream assembler", () => {
  const chunk = (obj: unknown) => JSON.stringify(obj);

  test("text deltas accumulate and emit", () => {
    const a = new OpenAiStreamAssembler();
    const deltas: string[] = [];
    a.onTextDelta = (d) => deltas.push(d);
    a.handle(chunk({ choices: [{ delta: { content: "He" } }] }));
    a.handle(chunk({ choices: [{ delta: { content: "llo" } }] }));
    a.handle(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    a.handle("[DONE]");
    const resp = a.done();
    expect(deltas.join("")).toBe("Hello");
    expect(resp.stopReason).toBe("end_turn");
    expect(resp.content[0]).toEqual({ type: "text", text: "Hello" });
  });

  test("streamed tool call arguments merge across chunks", () => {
    const a = new OpenAiStreamAssembler();
    a.handle(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_9", function: { name: "read_", arguments: "" } },
              ],
            },
          },
        ],
      }),
    );
    a.handle(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "file", arguments: '{"path":"x' } },
              ],
            },
          },
        ],
      }),
    );
    a.handle(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '.ts"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const resp = a.done();
    expect(resp.stopReason).toBe("tool_use");
    expect(resp.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(resp.content[0]).toEqual({
      type: "tool_use",
      id: "call_9",
      name: "read_file",
      input: { path: "x.ts" },
    });
  });

  test("missing usage falls back to zeros without crashing", () => {
    const a = new OpenAiStreamAssembler();
    a.handle(chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    expect(a.done().usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
