import type { ChatMessage } from "../provider/types";
import { estimateTokens } from "./context";

/** Calibration key used when a run does not identify its active session. */
export const DEFAULT_SESSION_KEY = "default";

/**
 * Token calibration (#354): the provider's API-reported input-token count
 * (`usage.prompt_tokens`, surfaced as `usage.inputTokens`) is the real context
 * pressure the model actually saw — it includes the preamble, system prompt
 * and tool schemas injected server-side, which the local chars/4 heuristic
 * cannot see. Local counting therefore underestimates real pressure and any
 * compaction keyed on it triggers too late.
 *
 * After every completion we record the provider-reported input-token count,
 * keyed to the active session, and context-pressure decisions prefer it over
 * the local estimate once a report exists. This is the calibrated input B2-3's
 * adaptive compaction consumes as its pressure basis.
 */
export class TokenPressure {
  private readonly reported = new Map<string, number>();

  /**
   * Record the provider-reported input-token count for a session. Counts that
   * are absent/zero (a provider that reports no usage) are ignored so they
   * never override the local estimate — no behavior change for such providers.
   */
  record(sessionKey: string, inputTokens: number): void {
    if (Number.isFinite(inputTokens) && inputTokens > 0) {
      this.reported.set(sessionKey, inputTokens);
    }
  }

  /** The last provider-reported input-token count for a session, if any. */
  lastReported(sessionKey: string): number | undefined {
    return this.reported.get(sessionKey);
  }

  /**
   * Context pressure in tokens for a session: prefers the last provider-
   * reported input-token count; falls back to the local estimate only when no
   * report exists yet (the first turn, or a provider that reports nothing).
   */
  pressureTokens(sessionKey: string, messages: ChatMessage[]): number {
    const reported = this.reported.get(sessionKey);
    if (reported !== undefined && reported > 0) return reported;
    return estimateTokens(messages);
  }
}

/**
 * Shared in-process store so calibration persists across runs of the same
 * session (a resumed session re-enters `runAgentTurn` with the same key).
 */
export const sharedTokenPressure = new TokenPressure();
