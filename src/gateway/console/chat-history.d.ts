export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export function messageText(ev: { role?: string; content?: unknown }): string;
export function sessionMessages(
  events: Array<{ t?: string; role?: string; content?: unknown }> | null | undefined,
): ChatMessage[];
export function chatRequestBody(text: string, bot: string): { text: string; bot: string };
