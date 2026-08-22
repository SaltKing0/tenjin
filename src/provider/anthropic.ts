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
import { parseSse, type SseFrame } from "./sse";
import { fetchWithRetry, normalizeRetry, type RetryPolicy } from "./retry";
import type { RetryConfig } from "../config/types";

const API_VERSION = "2023-06-01";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

export function toApiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map(blockToApi),
  }));
}

function blockToApi(b: ContentBlock): unknown {
  switch (b.type) {
    case "text":
      return b;
    case "tool_use":
      return b;
    case "tool_result": {
      const out: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: b.toolUseId,
        content: b.content,
      };
      if (b.isError) out.is_error = true;
      return out;
    }
  }
}

function toApiTools(tools: ToolSchema[], caching: boolean): unknown[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(caching && i === tools.length - 1
      ? { cache_control: { type: "ephemeral" } }
      : {}),
  }));
}

export interface RequestOptions {
  /** Emit Anthropic prompt-cache breakpoints on system + last tool (default on). */
  caching?: boolean;
}

export function buildRequestBody(
  req: ChatRequest,
  opts: RequestOptions = {},
): Record<string, unknown> {
  const caching = opts.caching !== false;
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(caching
      ? req.system
        ? { system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }] }
        : {}
      : req.system
        ? { system: req.system }
        : {}),
    messages: toApiMessages(req.messages),
    ...(req.tools.length ? { tools: toApiTools(req.tools, caching) } : {}),
    stream: true,
  };
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "other";
  }
}

type Entry =
  | { kind: "text"; blockIndex: number }
  | { kind: "tool"; blockIndex: number; id: string; name: string; json: string };

export class AnthropicStreamAssembler {
  private blocks: ContentBlock[] = [];
  private entries = new Map<number, Entry>();
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private stopReason: StopReason = "other";
  /** #309: set when the stream's `message_stop` terminator is seen. */
  private completed = false;
  onTextDelta?: (delta: string) => void;

  /** Whether `message_stop` was observed (true completion of the message). */
  get isComplete(): boolean {
    return this.completed;
  }

  handle(frame: SseFrame): void {
    if (frame.event === "error") {
      throw new Error(`anthropic stream error: ${frame.data}`);
    }
    let data: any;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return;
    }
    const type = frame.event ?? data.type;
    switch (type) {
      case "message_start": {
        this.usage.inputTokens = data.message?.usage?.input_tokens ?? 0;
        const u = data.message?.usage;
        if (typeof u?.cache_read_input_tokens === "number")
          this.usage.cacheReadInputTokens = u.cache_read_input_tokens;
        if (typeof u?.cache_creation_input_tokens === "number")
          this.usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
        break;
      }
      case "content_block_start": {
        const cb = data.content_block;
        if (cb?.type === "text") {
          const blockIndex = this.blocks.push({ type: "text", text: "" }) - 1;
          this.entries.set(data.index, { kind: "text", blockIndex });
        } else if (cb?.type === "tool_use") {
          const blockIndex =
            this.blocks.push({
              type: "tool_use",
              id: cb.id,
              name: cb.name,
              input: {},
            }) - 1;
          this.entries.set(data.index, {
            kind: "tool",
            blockIndex,
            id: cb.id,
            name: cb.name,
            json: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const entry = this.entries.get(data.index);
        const delta = data.delta;
        if (!entry || !delta) break;
        if (delta.type === "text_delta" && entry.kind === "text") {
          const block = this.blocks[entry.blockIndex];
          if (block?.type === "text") {
            block.text += delta.text;
            this.onTextDelta?.(delta.text);
          }
        } else if (delta.type === "input_json_delta" && entry.kind === "tool") {
          entry.json += delta.partial_json;
        }
        break;
      }
      case "message_delta":
        if (data.delta?.stop_reason) this.stopReason = mapStop(data.delta.stop_reason);
        if (data.usage?.output_tokens)
          this.usage.outputTokens = data.usage.output_tokens;
        break;
      case "message_stop":
        // #309: the stream's completion terminator — a clean EOF without it
        // means the response was truncated (proxy/gateway cut), not finished.
        this.completed = true;
        break;
    }
  }

  done(): ChatResponse {
    for (const entry of this.entries.values()) {
      if (entry.kind !== "tool") continue;
      const block = this.blocks[entry.blockIndex];
      if (block?.type !== "tool_use") continue;
      block.input = parseJsonLoose(entry.json);
    }
    return { stopReason: this.stopReason, content: this.blocks, usage: this.usage };
  }
}

function parseJsonLoose(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _unparsed: raw };
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private policy: RetryPolicy;
  constructor(
    private apiKey: string,
    private baseUrl: string = process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL,
    retry?: RetryConfig,
    private caching: boolean = true,
  ) {
    this.policy = normalizeRetry(retry);
  }

  async chat(
    req: ChatRequest,
    callbacks?: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const res = await fetchWithRetry(
      `${this.baseUrl.replace(/\/$/, "")}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(buildRequestBody(req, { caching: this.caching })),
      },
      this.policy,
      signal,
    );
    if (!res.ok || !res.body) {
      throw new Error(`anthropic api ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const assembler = new AnthropicStreamAssembler();
    assembler.onTextDelta = callbacks?.onTextDelta;
    for await (const frame of parseSse(res.body, signal)) {
      assembler.handle(frame);
    }
    // #309: a clean EOF without `message_stop` is a truncated response, not a
    // success — fail closed so the partial reply (and its usage accounting)
    // never reaches the agent loop as if it were complete.
    if (!assembler.isComplete) {
      throw new Error("anthropic stream ended before completion (missing message_stop)");
    }
    return assembler.done();
  }
}
