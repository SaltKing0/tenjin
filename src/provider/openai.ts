import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Provider,
  StopReason,
  StreamCallbacks,
  ToolSchema,
  Usage,
} from "./types";
import { parseSse } from "./sse";
import { fetchWithRetry, normalizeRetry, type RetryPolicy } from "./retry";
import type { RetryConfig } from "../config/types";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function toOpenAiMessages(
  messages: ChatMessage[],
  system: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const blocks =
      typeof m.content === "string"
        ? ([{ type: "text", text: m.content }] as ContentBlock[])
        : m.content;

    if (m.role === "assistant") {
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls: ApiToolCall[] = blocks
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
        }
      }
      const texts = blocks
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text);
      if (texts.length) {
        out.push({ role: "user", content: texts.join("\n") });
      }
    }
  }
  return out;
}

export function toOpenAiTools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

export function buildRequestBody(req: ChatRequest): Record<string, unknown> {
  return {
    model: req.model,
    messages: toOpenAiMessages(req.messages, req.system),
    ...(req.tools.length ? { tools: toOpenAiTools(req.tools), tool_choice: "auto" } : {}),
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
}

function mapFinish(reason: string | undefined | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

interface CallAccumulator {
  id: string;
  name: string;
  json: string;
}

export class OpenAiStreamAssembler {
  private blocks: ContentBlock[] = [];
  private calls = new Map<number, CallAccumulator>();
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private stopReason: StopReason = "other";
  /** #309: set when the stream's `[DONE]` terminator is seen. */
  private completed = false;
  onTextDelta?: (delta: string) => void;

  /** Whether the `[DONE]` terminator was observed (true completion). */
  get isComplete(): boolean {
    return this.completed;
  }

  handle(data: string): void {
    if (data === "[DONE]") {
      // #309: the stream's completion terminator — a clean EOF without it
      // means the response was truncated, not finished.
      this.completed = true;
      return;
    }
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.usage) {
      this.usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
      this.usage.outputTokens = chunk.usage.completion_tokens ?? 0;
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      this.stopReason = mapFinish(choice.finish_reason);
    }
    const delta = choice.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      let block = this.blocks.find((b) => b.type === "text");
      if (!block) {
        block = { type: "text", text: "" };
        this.blocks.push(block);
      }
      if (block.type === "text") {
        block.text += delta.content;
        this.onTextDelta?.(delta.content);
      }
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        let acc = this.calls.get(tc.index);
        if (!acc) {
          acc = { id: tc.id ?? "", name: "", json: "" };
          this.calls.set(tc.index, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.json += tc.function.arguments;
      }
    }
  }

  done(): ChatResponse {
    const indices = [...this.calls.keys()].sort((a, b) => a - b);
    for (const i of indices) {
      const call = this.calls.get(i);
      if (!call) continue;
      let input: unknown = {};
      if (call.json.trim()) {
        try {
          input = JSON.parse(call.json);
        } catch {
          input = { _unparsed: call.json };
        }
      }
      this.blocks.push({
        type: "tool_use",
        id: call.id || `call_${i}`,
        name: call.name,
        input,
      });
    }
    return { stopReason: this.stopReason, content: this.blocks, usage: this.usage };
  }
}

export class OpenAIProvider implements Provider {
  readonly name = "openai";
  private policy: RetryPolicy;

  constructor(
    private apiKey: string,
    private baseUrl: string = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    retry?: RetryConfig,
  ) {
    this.policy = normalizeRetry(retry);
  }

  async chat(
    req: ChatRequest,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(buildRequestBody(req)),
      },
      this.policy,
      signal,
    );
    if (!res.ok || !res.body) {
      throw new Error(`openai api ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const assembler = new OpenAiStreamAssembler();
    assembler.onTextDelta = callbacks?.onTextDelta;
    for await (const frame of parseSse(res.body, signal)) {
      assembler.handle(frame.data);
    }
    // #309: a clean EOF without `[DONE]` is a truncated response, not a
    // success — fail closed so the partial reply never reaches the agent loop.
    if (!assembler.isComplete) {
      throw new Error("openai stream ended before completion (missing [DONE])");
    }
    return assembler.done();
  }
}
