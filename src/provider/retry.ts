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
export const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];

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

/** Exponential backoff between attempts: initialDelay * 2^(attempt-1), capped. */
function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const base = policy.initialDelayMs * Math.pow(2, attempt - 1);
  return Math.min(base, policy.maxDelayMs);
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
        await sleep(backoffDelay(attempt, policy));
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
      await sleep(backoffDelay(attempt, policy));
      continue;
    }

    // Out of attempts: return the final response with its body intact so the
    // caller surfaces the provider's exact status + error message.
    return res;
  }
}
