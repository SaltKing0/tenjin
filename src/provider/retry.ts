import type { RetryConfig } from "../config/types";

/**
 * Normalized, self-contained retry settings. `fetchWithRetry` uses this so a
 * provider constructed without any config still retries by default.
 */
export interface RetryPolicy {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  retryableStatuses: number[];
}

/** HTTP status codes worth retrying: rate-limited or transient server-side. */
export const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

export const DEFAULT_RETRY: RetryPolicy = {
  enabled: true,
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  retryableStatuses: DEFAULT_RETRY_STATUSES,
};

/** Fill in any missing field from the defaults without mutating the input. */
export function normalizeRetry(cfg?: RetryConfig): RetryPolicy {
  if (!cfg) return DEFAULT_RETRY;
  return {
    enabled: cfg.enabled ?? DEFAULT_RETRY.enabled,
    maxAttempts: cfg.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
    initialDelayMs: cfg.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
    maxDelayMs: cfg.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    retryableStatuses:
      cfg.retryableStatuses && cfg.retryableStatuses.length > 0
        ? cfg.retryableStatuses
        : DEFAULT_RETRY_STATUSES,
  };
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full-jitter backoff between attempts (B3-9 #371): delay is chosen uniformly
 * from [0, min(initialDelay * 2^(attempt-1), maxDelay)] — the "full jitter"
 * strategy that minimizes expected wait under a rate-limited server and avoids
 * synchronized thundering-herd retries. Base 1000ms, factor 2, cap = maxDelayMs.
 */
export function jitterBackoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = policy.initialDelayMs * Math.pow(2, attempt - 1);
  const cap = Math.min(base, policy.maxDelayMs);
  return Math.floor(Math.random() * (cap + 1));
}

/**
 * Honor the server's own retry signal BEFORE our backoff math (B3-9 #371):
 * a `retry-after` header (seconds or HTTP-date) yields the exact delay to wait.
 * Returns null when no header is present, meaning "use our own backoff".
 */
export function retryAfterDelay(res: Response): number | null {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter === null) return null;
  const secs = Number(retryAfter);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(retryAfter);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * fetch that retries 429 / 5xx / network errors with exponential backoff.
 *
 * - When retry is disabled (or maxAttempts <= 1) this is a plain `fetch`.
 * - A caller abort (`signal`) is never retried — it propagates immediately.
 * - Non-retryable HTTP statuses (e.g. 401/400) return on the first attempt so
 *   the caller can surface the provider's exact error body.
 * - On giving up over a retryable status the final `Response` is returned and
 *   the caller formats its usual "provider api <status>: …" error, so no
 *   behaviour changes downstream.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit | undefined,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<Response> {
  if (!policy.enabled || policy.maxAttempts <= 1) {
    return signal ? fetch(url, { ...init, signal }) : fetch(url, init);
  }

  let attempt = 0;
  let lastNetworkError: unknown = null;
  const doFetch = (): Promise<Response> =>
    signal ? fetch(url, { ...init, signal }) : fetch(url, init);

  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await doFetch();
    } catch (e) {
      // A user-initiated abort must not be masked by a retry loop.
      if (isAbortError(e)) throw e;
      lastNetworkError = e;
      if (attempt < policy.maxAttempts) {
        await sleep(jitterBackoffDelay(attempt, policy));
        continue;
      }
      throw lastNetworkError;
    }

    if (res.ok || !policy.retryableStatuses.includes(res.status)) {
      return res;
    }

    if (attempt < policy.maxAttempts) {
      // Retryable status with attempts left: cancel the stream so the
      // connection can be reused, then back off and retry.
      try {
        res.body?.cancel().catch(() => {});
      } catch {
        /* ignore stream-cancel failure */
      }
      // Honor the server's explicit retry signal before our own backoff math.
      // `x-should-retry: false` means the server wants no retry at all.
      if (res.headers.get("x-should-retry")?.toLowerCase() === "false") {
        return res;
      }
      await sleep(retryAfterDelay(res) ?? jitterBackoffDelay(attempt, policy));
      continue;
    }

    // Out of attempts: return the final response with its body intact so the
    // caller surfaces the provider's exact status + error message.
    return res;
  }
}

/* ------------------------------------------------------------------------- *
 * B3-9 (#371) hardening primitives
 * ------------------------------------------------------------------------- */

/**
 * Error classes by LAYER/TRANSIENCY (B3-9 #371), not by status code alone.
 * PARSE errors never retry (the same request fails identically) and instead
 * produce corrective feedback; TOOL-EXEC errors are returned as structured
 * data the model reads like any tool result; RATE-LIMIT / NETWORK / TIMEOUT
 * are transient and retried; other 4xx are permanent.
 */
export type RetryAction = "corrective" | "structured-result" | "retry" | "give-up";

export interface RetryDecision {
  retry: boolean;
  action: RetryAction;
  /** Human/audit message describing the decision. */
  message?: string;
}

/** A malformed provider payload — retrying can never fix it. */
export class ParseError extends Error {}

/** A tool-execution failure — surfaced as data, not re-issued. */
export class ToolExecError extends Error {}

/**
 * Classify an error/status into a retry decision. Pure and testable; call sites
 * (provider layer / loop) map the decision onto their own behaviour.
 */
export function classifyError(e: unknown, status?: number): RetryDecision {
  if (e instanceof ParseError) {
    return { retry: false, action: "corrective", message: e.message };
  }
  if (e instanceof ToolExecError) {
    return { retry: false, action: "structured-result", message: e.message };
  }
  if (isAbortError(e)) {
    return { retry: false, action: "give-up", message: "aborted" };
  }
  if (status !== undefined) {
    if (status === 429 || (status >= 500 && status < 600)) {
      return { retry: true, action: "retry" };
    }
    if (status >= 400 && status < 500) {
      return { retry: false, action: "give-up", message: `http ${status}` };
    }
    return { retry: true, action: "retry" };
  }
  // Network / timeout errors are transient.
  return { retry: true, action: "retry" };
}

/**
 * Wall-clock + idle timeout policy (B3-9 #371 item 4). `wallClockMs` caps the
 * total run; `idleMs` treats ~5s without progress as a hung (transient)
 * connection. Callers call {@link touch} on every chunk of progress.
 */
export interface TimeoutOptions {
  wallClockMs?: number;
  idleMs?: number;
}

export class TimeoutTracker {
  private readonly wallClockMs: number;
  private readonly idleMs: number;
  private readonly startedAt: number;
  private idleDeadline: number;

  constructor(opts: TimeoutOptions, private readonly now: () => number = Date.now) {
    this.wallClockMs = opts.wallClockMs ?? Infinity;
    this.idleMs = opts.idleMs ?? Infinity;
    this.startedAt = this.now();
    this.idleDeadline = this.startedAt + this.idleMs;
  }

  /** Milliseconds of wall-clock budget remaining (> 0 while not timed out). */
  get wallClockRemaining(): number {
    return Math.max(0, this.startedAt + this.wallClockMs - this.now());
  }

  /** Milliseconds since the last touch() (idle time). */
  get idleElapsed(): number {
    return this.now() - (this.idleDeadline - this.idleMs);
  }

  get wallClockTimedOut(): boolean {
    return this.wallClockRemaining <= 0;
  }

  get idleTimedOut(): boolean {
    return this.now() >= this.idleDeadline;
  }

  /** Record progress; resets the idle timer. */
  touch(): void {
    this.idleDeadline = this.now() + this.idleMs;
  }
}

/**
 * Mid-response failure rule (B3-9 #371 item 5): once a turn has produced
 * completed tool calls, an aborted/errored response must NOT be re-issued —
 * the results are kept and the turn continues. Only a failure with zero
 * completed calls is eligible for re-issue.
 */
export function handleMidResponseFailure<T>(
  completedResults: T[],
  failure: unknown,
): { results: T[]; reissue: boolean; failure: unknown } {
  return {
    results: completedResults,
    reissue: completedResults.length === 0,
    failure,
  };
}

export type BreakerState = "closed" | "open" | "half-open";

/**
 * Circuit breaker (B3-9 #371 item 6): after `threshold` consecutive failures
 * the circuit opens and rejects requests; after `resetMs` it allows a single
 * half-open probe, which either succeeds (closes) or fails (reopens).
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold = 5,
    private readonly resetMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    if (this.failures < this.threshold) return "closed";
    return this.now() - this.openedAt >= this.resetMs ? "half-open" : "open";
  }

  /** Whether a request may proceed now. Half-open allows exactly one probe. */
  allowRequest(): boolean {
    return this.state !== "open";
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures === this.threshold) this.openedAt = this.now();
  }
}
