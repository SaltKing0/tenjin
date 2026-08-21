/**
 * Shared outbound-send helpers for channel adapters (#201).
 *
 * Problem: agent replies longer than a channel's per-message limit were sent as
 * a single `postMessage` call and dropped by the platform (Telegram caps at
 * 4096 chars, Discord at 2000, Slack at ~40k). This module gives every adapter
 * one consistent chunker and a single delivery-failure error type so a failed
 * *send* can be told apart from a failed *handler*.
 */

/**
 * Delivery failure — thrown by adapters when a generated reply could not be
 * handed to the platform. Distinct from a handler/model error so callers can
 * report "answer generated, but delivery failed" instead of a generic error.
 */
export class ChannelSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSendError";
  }
}

/** Split `text` into chunks of at most `maxLen` chars. */
export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    // Prefer breaking on the last newline inside the window so chunks stay on
    // line boundaries; fall back to a hard cut for a single over-long line.
    const nl = rest.lastIndexOf("\n", maxLen);
    const cut = nl > 0 ? nl : maxLen;
    if (cut <= 0) break; // safety: never emit an empty/looping chunk
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
