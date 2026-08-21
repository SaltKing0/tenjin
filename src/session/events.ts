import type { ChatMessage, ContentBlock, Role } from "../provider/types";

export interface SessionParent {
  id: string;
  uptoEvent: number;
}

export type SessionEvent =
  | {
      t: "session_start";
      id: string;
      ts: string;
      provider: string;
      model: string;
      parent?: SessionParent;
      bot?: string;
    }
  | { t: "message"; role: Role; content: string | ContentBlock[]; ts: string }
  | { t: "tool_call"; id: string; name: string; input: unknown; ts: string }
  | { t: "tool_result"; id: string; name: string; ok: boolean; output: string; ts: string }
  | {
      t: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      costUSD: number;
      spentUSD: number;
      ts: string;
    }
  | { t: "error"; message: string; ts: string };

export interface EventLogger {
  append(event: SessionEvent): void;
}

export function rebuildMessages(events: SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const e of events) {
    if (e.t === "message") messages.push({ role: e.role, content: e.content });
  }
  return messages;
}

export function sumUsage(events: SessionEvent[]): {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  spentUSD: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let spentUSD = 0;
  for (const e of events) {
    if (e.t !== "usage") continue;
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheReadInputTokens += e.cacheReadInputTokens ?? 0;
    spentUSD = Math.max(spentUSD, e.spentUSD);
  }
  return { inputTokens, outputTokens, cacheReadInputTokens, spentUSD };
}
