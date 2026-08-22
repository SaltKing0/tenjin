/**
 * Clean abort semantics (Roadmap §16 B13-2, DR11-3).
 *
 * Abort signals are threaded through every async boundary (repl →
 * runAgentTurn → provider.chat → fetchWithRetry → parseSse). This module owns
 * the small, testable primitives:
 *
 *   - `classifyAbort` / `abortReason`: turn `signal.reason` into a stable
 *     reason tag (user-interrupt vs timeout vs error) so an interrupted turn
 *     can be logged and resumed correctly.
 *   - `markInterrupted`: tag partial streamed text so /resume and /replay can
 *     tell "the turn was cut off here".
 *   - `createChildController`: a per-subtask controller that does NOT poison
 *     the parent turn when aborted, but still receives a parent abort.
 *   - `ForceExitTimer`: a bounded-shutdown failsafe so a hung tool can never
 *     strand the REPL.
 */

export type AbortReason = "user-interrupt" | "timeout" | "error" | "none";

/** Marker appended to streamed text when a turn is interrupted mid-stream. */
export const INTERRUPT_MARKER = "(interrupted)";

/**
 * Classify an abort reason value. Abort sites set `signal.reason`; the REPL
 * Ctrl-C path uses a bare `AbortError` (user), a timeout path uses a
 * `TimeoutError` (timeout), and an error path carries the underlying error.
 */
export function abortReason(reason?: unknown): AbortReason {
  if (reason === undefined || reason === null) return "none";
  if (reason instanceof Error) {
    if (reason.name === "TimeoutError") return "timeout";
    if (reason.name === "AbortError" || reason.name === "AbortSignalAbort") {
      return "user-interrupt";
    }
    return "error";
  }
  const r = reason as { name?: string; kind?: string; code?: string };
  if (r?.name === "TimeoutError" || r?.kind === "timeout" || r?.code === "TIMEOUT" || r?.code === "ETIMEDOUT") {
    return "timeout";
  }
  if (r?.kind === "error") return "error";
  // Any other structured reason is a user interrupt by default.
  return "user-interrupt";
}

/** Classify an AbortSignal's current state (none when not aborted). */
export function classifyAbort(signal: AbortSignal): AbortReason {
  if (!signal.aborted) return "none";
  return abortReason(signal.reason);
}

/**
 * Return a stable Error for an aborted signal, preserving `signal.reason` when
 * it is already an Error (so classification survives the throw).
 */
export function toAbortError(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  if (r && typeof r === "object") {
    const name = (r as { name?: string }).name;
    const e = new Error(name ? String(name) : "aborted");
    e.name = name === "TimeoutError" ? "TimeoutError" : "AbortError";
    return e;
  }
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Tag partial streamed text with the interrupted marker, preserving the text
 * that was already produced. Empty partials still carry the marker so the
 * interruption is visible in the session trail.
 */
export function markInterrupted(partial: string): string {
  const trimmed = (partial ?? "").trimEnd();
  if (!trimmed) return INTERRUPT_MARKER;
  return `${trimmed} ${INTERRUPT_MARKER}`;
}

/**
 * A child AbortController for a subtask/tool call. Aborting the CHILD does not
 * affect the parent (one bad subtask does not poison the turn); a PARENT abort
 * propagates down to the child so the whole tree still stops together.
 */
export function createChildController(parent?: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent) {
    if (parent.aborted) {
      child.abort(parent.reason);
    } else {
      parent.addEventListener("abort", () => child.abort(parent.reason), { once: true });
    }
  }
  return child;
}

/**
 * Bounded graceful-shutdown failsafe: fires `onFire` after `ms` unless cleared
 * first. A hung tool can never strand the REPL indefinitely.
 */
export class ForceExitTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ms: number,
    private readonly onFire: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Arm (or re-arm) the timer. */
  start(): void {
    this.clear();
    const fire = () => {
      this.timer = null;
      this.onFire();
    };
    this.timer = setTimeout(fire, this.ms);
    this.timer.unref?.();
  }

  /** Cancel the failsafe (call on graceful completion). */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get armed(): boolean {
    return this.timer !== null;
  }
}
