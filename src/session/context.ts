import type { ChatMessage, ContentBlock } from "../provider/types";

/**
 * Context-window guard (#101): estimate how many tokens the current trajectory
 * will occupy, and before it can blow a model's context window, elide the
 * OLDER tool-result outputs into short placeholders so the run survives.
 *
 * The estimate intentionally uses the standard chars/4 heuristic — cheap and
 * deterministic (no external tokenizer), good enough to catch runaway growth
 * before the provider returns a 413 / context_length error.
 */

export const DEFAULT_CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_THRESHOLD_RATIO = 0.8;

/**
 * Built-in context-window size (input+output, in tokens) for well-known models.
 * Anything unknown falls back to {@link DEFAULT_CONTEXT_WINDOW} unless the user
 * overrides it in config (`context.windows.<model>` / `context.defaultWindow`).
 */
const KNOWN_CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-5": 200_000,
  "claude-3-5-sonnet-latest": 200_000,
  "claude-3-5-haiku-latest": 200_000,
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1": 1_047_576,
  // Common open/compatible endpoints
  "deepseek-chat": 64_000,
  "deepseek-reasoner": 128_000,
};

/** `context` block in config.yaml. */
export interface ContextConfig {
  /** Master switch; the guard is on by default. */
  enabled?: boolean;
  /** Compress when the estimate exceeds this fraction of the window. Default 0.8. */
  thresholdRatio?: number;
  /** Context window (tokens) for models not in the built-in table or `windows`. */
  defaultWindow?: number;
  /** Per-model context-window override (tokens). */
  windows?: Record<string, number>;
}

/** Resolved guard settings used for a single trajectory before a call. */
export interface ContextGuardConfig {
  enabled: boolean;
  thresholdRatio: number;
  windowTokens: number;
}

export function resolveContextGuard(
  model: string,
  cfg?: ContextConfig,
): ContextGuardConfig {
  return {
    enabled: cfg?.enabled !== false,
    thresholdRatio: cfg?.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    windowTokens: contextWindowTokens(model, cfg),
  };
}

export function contextWindowTokens(model: string, cfg?: ContextConfig): number {
  const explicit = cfg?.windows?.[model];
  if (explicit !== undefined) return explicit;
  const known = KNOWN_CONTEXT_WINDOWS[model];
  if (known !== undefined) return known;
  return cfg?.defaultWindow ?? DEFAULT_CONTEXT_WINDOW;
}

function tokenEstimate(chars: number, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.ceil(chars / charsPerToken);
}

function contentChars(content: string | ContentBlock[]): number {
  if (typeof content === "string") return content.length;
  let n = 0;
  for (const b of content) {
    if (b.type === "text") n += b.text.length;
    else if (b.type === "tool_use") n += JSON.stringify(b.input ?? {}).length;
    else if (b.type === "tool_result") n += b.content.length;
  }
  return n;
}

function contentTokens(content: string | ContentBlock[], charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  return tokenEstimate(contentChars(content), charsPerToken);
}

/** Total estimated tokens across a message array (chars/4 heuristic). */
export function estimateTokens(
  messages: ChatMessage[],
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number {
  let chars = 0;
  for (const m of messages) chars += contentChars(m.content);
  return tokenEstimate(chars, charsPerToken);
}

export interface CompressResult {
  /** Whether any tool-result content was replaced with a placeholder. */
  compressed: boolean;
  /** Number of tokens removed by elision (estimate delta). */
  elidedTokens: number;
  /** Estimated tokens before compression. */
  beforeTokens: number;
  /** Estimated tokens after compression. */
  afterTokens: number;
}

/**
 * Elide the OLDEST tool-result block contents to `[elided N tokens]`
 * placeholders until the trajectory fits within `targetTokens`. The most
 * recent messages (and the opening user prompt / assistant summaries) are left
 * untouched, so the agent keeps the conversation context it still needs.
 *
 * Mutates the passed message array in place (replacing block contents), so the
 * caller's reference stays valid and the session log sees the compression too.
 * Returns a no-op result when already under budget.
 */
export function compressMessages(
  messages: ChatMessage[],
  opts: { targetTokens: number; pressureTokens?: number },
): CompressResult {
  const beforeTokens = estimateTokens(messages);
  // #354: the pressure basis may be the provider-reported input-token count
  // (calibrated), which includes server-side preamble/schemas the local
  // estimate cannot see. When available it drives both the trigger and how
  // much must be freed; the local estimate stays the fallback so existing
  // behavior (and the reported before/after token counts) is unchanged.
  const pressure = opts.pressureTokens ?? beforeTokens;
  if (pressure <= opts.targetTokens) {
    return { compressed: false, elidedTokens: 0, beforeTokens, afterTokens: beforeTokens };
  }

  let need = pressure - opts.targetTokens; // tokens to free
  let elidedTokens = 0;
  const placeholder = (tokens: number) => `[elided ${tokens} tokens]`;

  // Oldest-first so recent tool outputs and the tail of the conversation survive.
  for (const m of messages) {
    if (need <= 0) break;
    if (!Array.isArray(m.content)) continue;
    let over = 0;
    for (const b of m.content) over += b.type === "tool_result" ? b.content.length : 0;
    // Skip messages with no tool results (user text, assistant blocks).
    if (over === 0) continue;
    for (const b of m.content) {
      if (need <= 0) break;
      if (b.type !== "tool_result") continue;
      const tokens = contentTokens([b]);
      b.content = placeholder(tokens);
      elidedTokens += tokens;
      // Eliding a block frees only (tokens - placeholderTokens): the
      // `[elided N tokens]` placeholder still occupies a few tokens, so
      // crediting the full block value can stop the loop while the trajectory
      // is still over target (#312).
      need -= tokens - contentTokens(b.content);
    }
  }

  const afterTokens = estimateTokens(messages);
  const compressed = elidedTokens > 0 && afterTokens < beforeTokens;
  return { compressed, elidedTokens, beforeTokens, afterTokens };
}
