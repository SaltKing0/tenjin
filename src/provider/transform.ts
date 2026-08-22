/**
 * Provider transform layer (Roadmap §5 B2-7, #412).
 *
 * Builds on the canonical provider IR (#377): the agent loop only ever sees
 * send/receive. This module absorbs provider quirks OUT of the loop and emits
 * ONE UNIFIED CHUNK CONTRACT from every adapter's native stream, so the loop
 * never branches on "is this Anthropic or OpenAI or Mistral".
 *
 *   - QUIRK ABSORPTION: empty/whitespace text filtered; tool-call IDs
 *     normalized to Mistral's 9-char [a-zA-Z0-9] shape (deterministically, so
 *     correlation survives); cache_control gated to real Anthropic endpoints;
 *     generic reasoning effort mapped per provider; provider-specific knobs
 *     pass through verbatim.
 *   - UNIFIED CHUNK CONTRACT: {@link UnifiedChunk} — text-start/delta/end,
 *     reasoning-delta, tool-call, tool-input-delta/end, tool-result,
 *     tool-error, finish, error — emitted identically by every adapter.
 *   - STREAM-RECOVERY: OpenAI arguments-string deltas are buffered and parsed
 *     EXACTLY ONCE at the done/finish event; Anthropic input_json arrives
 *     pre-parsed; content:null is a valid tool turn (no text chunk, tool_call
 *     still emitted).
 *   - CORRELATION: providerCallId always survives end-to-end — a tool-result
 *     answers its originating tool-call by the same normalized id.
 *
 * Native tool-calling remains the only invocation path; this layer only
 * normalizes what arrives on the stream.
 */

/** A canonical chunk emitted identically by every adapter. */
export type UnifiedChunk =
  | { type: "text_start"; id: string }
  | { type: "text_delta"; id: string; text: string }
  | { type: "text_end"; id: string }
  | { type: "reasoning_delta"; id: string; text: string }
  | { type: "tool_call"; id: string; providerCallId: string; name: string }
  | { type: "tool_input_delta"; id: string; delta: string }
  | { type: "tool_input_end"; id: string; providerCallId: string; arguments: Record<string, unknown> }
  | { type: "tool_result"; id: string; providerCallId: string; ok: boolean; content: string }
  | { type: "tool_error"; id: string; providerCallId: string; message: string }
  | { type: "finish"; reason: string }
  | { type: "error"; message: string; kind: string };

/** A provider-native delta event, normalized only into a tagged union. */
export type NativeDelta =
  | { kind: "text_delta"; text: string }
  | { kind: "reasoning_delta"; text: string }
  | { kind: "tool_call_start"; index: number; id?: string; name?: string }
  /** OpenAI: partial JSON `function.arguments` string, buffered until done. */
  | { kind: "tool_input_delta"; index: number; fragment: string }
  /** Anthropic: `input_json_delta` already coalesced into a JSON value. */
  | { kind: "tool_input_json"; index: number; json: unknown }
  | { kind: "finish"; reason?: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Quirk helpers (pure)
// ---------------------------------------------------------------------------

/** True for empty or whitespace-only text (Anthropic/OpenAI reject those). */
export function isEmptyText(text: string): boolean {
  return text.trim().length === 0;
}

const TOOL_ID_RE = /^[a-zA-Z0-9]{9}$/;

/** Deterministic 9-char [a-zA-Z0-9] tool-call id (Mistral's requirement).
 *  An id that already conforms is returned unchanged; otherwise a stable
 *  FNV-1a-derived id is produced so the SAME raw id always normalizes to the
 *  SAME providerCallId — correlation survives end to end. */
export function normalizeToolCallId(rawId: string): string {
  if (TOOL_ID_RE.test(rawId)) return rawId;
  let h = 2166136261;
  const s = rawId || "toolcall";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 9 chars from a 36-char alphabet, seeded by the hash.
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  let x = h >>> 0;
  for (let i = 0; i < 9; i++) {
    out += ALPHABET[x % ALPHABET.length];
    x = Math.imul(x, 1664525) + 1013904223;
    x = x >>> 0;
  }
  return out;
}

/** True only for a genuine Anthropic endpoint (cache_control is Anthropic-only).
 *  A proxy (e.g. openrouter.ai/anthropic/...) is NOT a real Anthropic endpoint. */
export function isRealAnthropicEndpoint(baseUrl: string): boolean {
  const u = (baseUrl || "").toLowerCase();
  return u.includes("anthropic.com");
}

/** Map a generic reasoning-effort (low/medium/high) to provider knobs. */
export function mapReasoningEffort(
  effort: "low" | "medium" | "high" | undefined,
  provider: "anthropic" | "openai",
): Record<string, unknown> {
  if (effort === undefined || effort === "medium") return {};
  if (provider === "anthropic") {
    const budgetTokens = effort === "high" ? 8192 : 1024;
    return { thinking: { type: "enabled", budgetTokens } };
  }
  // openai
  return { reasoning_effort: effort };
}

// ---------------------------------------------------------------------------
// Streaming transformer
// ---------------------------------------------------------------------------

export interface ChunkTransformer {
  push(d: NativeDelta): UnifiedChunk[];
  /** Flush remaining buffers (parse buffered args exactly once) and close. */
  finish(): UnifiedChunk[];
}

interface ToolAcc {
  index: number;
  providerCallId: string;
  name: string;
  argsBuf: string;       // OpenAI: accumulated JSON string fragments
  parsed?: Record<string, unknown>; // set once at done
  ended: boolean;
}

const EMPTY_ARGS: Record<string, unknown> = {};

/** Parse a buffered JSON arguments string exactly once. Malformed → {_unparsed}. */
function parseArgsOnce(buf: string): Record<string, unknown> {
  const t = buf.trim();
  if (!t) return EMPTY_ARGS;
  try {
    const p: unknown = JSON.parse(t);
    if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
    return { _unparsed: t };
  } catch {
    return { _unparsed: t };
  }
}

/**
 * Create a stateful transformer for a provider's native stream. Emits the
 * unified chunk contract; applies text filtering, tool-id normalization, and
 * the OpenAI args-string buffering rule.
 */
export function createChunkTransformer(provider: string): ChunkTransformer {
  const textId = `text_${provider}`;
  let textOpen = false;
  const tools = new Map<number, ToolAcc>();

  const openText = (out: UnifiedChunk[]): void => {
    if (!textOpen) {
      out.push({ type: "text_start", id: textId });
      textOpen = true;
    }
  };

  return {
    push(d: NativeDelta): UnifiedChunk[] {
      const out: UnifiedChunk[] = [];
      switch (d.kind) {
        case "text_delta": {
          // Quirk: empty/whitespace-only text is dropped (never a text chunk).
          if (isEmptyText(d.text)) return out;
          openText(out);
          out.push({ type: "text_delta", id: textId, text: d.text });
          return out;
        }
        case "reasoning_delta": {
          out.push({ type: "reasoning_delta", id: textId, text: d.text });
          return out;
        }
        case "tool_call_start": {
          const providerCallId = normalizeToolCallId(d.id ?? "");
          tools.set(d.index, {
            index: d.index,
            providerCallId,
            name: d.name ?? "",
            argsBuf: "",
            ended: false,
          });
          out.push({ type: "tool_call", id: `tc_${d.index}`, providerCallId, name: d.name ?? "" });
          return out;
        }
        case "tool_input_delta": {
          // OpenAI: buffer the string fragment; do NOT parse until done.
          const acc = tools.get(d.index);
          if (acc) acc.argsBuf += d.fragment;
          return out;
        }
        case "tool_input_json": {
          // Anthropic: pre-parsed value → end the tool input immediately.
          const acc = tools.get(d.index);
          if (!acc) return out;
          acc.parsed =
            d.json && typeof d.json === "object" && !Array.isArray(d.json)
              ? (d.json as Record<string, unknown>)
              : { _unparsed: d.json };
          acc.ended = true;
          out.push({
            type: "tool_input_end",
            id: `tc_${d.index}`,
            providerCallId: acc.providerCallId,
            arguments: acc.parsed,
          });
          return out;
        }
        case "finish": {
          // content:null tool turns emit the tool_call but never a text block.
          if (textOpen) out.push({ type: "text_end", id: textId });
          // Parse each still-buffered OpenAI args string EXACTLY once at done.
          for (const acc of tools.values()) {
            if (acc.ended) continue;
            acc.parsed = parseArgsOnce(acc.argsBuf);
            acc.ended = true;
            out.push({
              type: "tool_input_end",
              id: `tc_${acc.index}`,
              providerCallId: acc.providerCallId,
              arguments: acc.parsed,
            });
          }
          out.push({ type: "finish", reason: d.reason ?? "stop" });
          return out;
        }
        case "error": {
          return [{ type: "error", message: d.message, kind: "provider" }];
        }
      }
    },
    finish(): UnifiedChunk[] {
      return this.push({ kind: "finish", reason: "stop" });
    },
  };
}

/** Resolve a tool result / error's raw provider id to its canonical providerCallId. */
export function resolveToolCallId(rawId: string): string {
  return normalizeToolCallId(rawId);
}
