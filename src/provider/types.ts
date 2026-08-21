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
