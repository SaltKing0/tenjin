export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: Role;
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ===========================================================================
// B7-1 canonical provider IR (#377)
// ---------------------------------------------------------------------------
// Foundation for the provider transform layer (B2-7). These are the canonical
// shapes every provider's native format is mapped to and from by the adapters
// in src/provider/ir.ts — nothing downstream should touch provider-native tool
// formats directly. `providerCallId` is the glue across OpenAI `tool_calls[]`
// ids and Anthropic `tool_use`/`tool_result` blocks: it is threaded unchanged
// from call → execution → result → history entry.
// ===========================================================================

/** Canonical tool definition (ToolSchema + optional side-effect flag). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Whether the tool mutates external state (a write side effect). */
  sideEffect?: boolean;
}

/** Canonical tool call issued by a provider. Arguments are ALWAYS an object. */
export interface ToolCall {
  /** Provider that issued the call, e.g. "openai" | "anthropic". */
  provider: string;
  /** Provider-native call id (the correlation glue across history). */
  providerCallId: string;
  name: string;
  /** Parsed arguments as an OBJECT (string deltas are parsed by the adapter). */
  arguments: Record<string, unknown>;
  /** Native raw payload, kept for lossless round-trip. */
  raw?: unknown;
}

/** Canonical tool result. Carries the originating call's id for correlation. */
export interface ToolResult {
  /** Exactly the `providerCallId` of the ToolCall this result answers. */
  providerCallId: string;
  ok: boolean;
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache tokens read from the cache (0 when no hit). */
  cacheReadInputTokens?: number;
  /** Anthropic prompt-cache tokens written to the cache on this call. */
  cacheCreationInputTokens?: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens: number;
}

export interface ChatResponse {
  stopReason: StopReason;
  content: ContentBlock[];
  usage: Usage;
}

export interface StreamCallbacks {
  onTextDelta?: (delta: string) => void;
}

export interface Provider {
  readonly name: string;
  chat(req: ChatRequest, callbacks?: StreamCallbacks, signal?: AbortSignal): Promise<ChatResponse>;
}

export function textBlocks(content: string | ContentBlock[]): TextBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.filter((b): b is TextBlock => b.type === "text");
}
