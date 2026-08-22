import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  fetchWithRetry,
  normalizeRetry,
  jitterBackoffDelay,
  retryAfterDelay,
  TimeoutTracker,
  classifyError,
  ParseError,
  ToolExecError,
  CircuitBreaker,
  handleMidResponseFailure,
} from "../src/provider/retry";

/**
 * B3-9 (#371): retry & idempotency hardening — transiency classes, full-jitter
 * backoff, Retry-After/x-should-retry honoring, timeout policy, mid-response
 * no-reissue rule, and a circuit breaker.
 */

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function policy(over: Partial<ReturnType<typeof normalizeRetry>> = {}): ReturnType<typeof normalizeRetry> {
  return { ...normalizeRetry(), initialDelayMs: 0, maxDelayMs: 0, ...over };
}

function mockFetch(
  impl: (url: string | URL, init?: RequestInit) => Promise<Response>,
): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    state.calls++;
    return impl(url, init);
  }) as typeof fetch;
  return state;
}

describe("error classification", () => {
  test("parse error produces a corrective message and is never retried", () => {
    const d = classifyError(new ParseError("invalid JSON in provider payload"));
    expect(d.retry).toBe(false);
    expect(d.action).toBe("corrective");
    expect(d.message).toContain("invalid JSON");
  });

  test("tool-exec error is returned as structured data, not retried", () => {
    const d = classifyError(new ToolExecError("ls: no such file"));
    expect(d.retry).toBe(false);
    expect(d.action).toBe("structured-result");
  });

  test("rate-limit status is transient and retried", () => {
    expect(classifyError(undefined, 429).retry).toBe(true);
    expect(classifyError(undefined, 429).action).toBe("retry");
  });

  test("permanent 4xx (400) is never retried", () => {
    const d = classifyError(undefined, 400);
    expect(d.retry).toBe(false);
    expect(d.action).toBe("give-up");
  });

  test("network error is transient and retried", () => {
    const d = classifyError(new TypeError("fetch failed"));
    expect(d.retry).toBe(true);
  });
});

describe("full-jitter backoff", () => {
  test("delay stays within the jitter window [0, cap]", () => {
    const p = policy({ initialDelayMs: 1000, maxDelayMs: 2000 });
    // attempt 2 -> base = 1000*2 = 2000, capped at 2000 -> window [0,2000]
    for (let i = 0; i < 500; i++) {
      const d = jitterBackoffDelay(2, p);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(2000);
    }
  });

  test("jitter spreads across the window (not a fixed backoff)", () => {
    const p = policy({ initialDelayMs: 1000, maxDelayMs: 4000 });
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(jitterBackoffDelay(3, p));
    // Full jitter should produce more than a couple of distinct delays.
    expect(seen.size).toBeGreaterThan(2);
  });

  test("jitter is capped at maxDelayMs even for large attempts", () => {
    const p = policy({ initialDelayMs: 1000, maxDelayMs: 4000 });
    expect(jitterBackoffDelay(20, p)).toBeLessThanOrEqual(4000);
  });
});

describe("Retry-After / x-should-retry headers", () => {
  test("retry-after seconds are honored as a delay", () => {
    const res = new Response("", { status: 429, headers: { "retry-after": "2" } });
    expect(retryAfterDelay(res)).toBe(2000);
  });

  test("no retry header yields null (use own backoff)", () => {
    const res = new Response("", { status: 429 });
    expect(retryAfterDelay(res)).toBeNull();
  });

  test("x-should-retry: false suppresses retry entirely (single attempt)", async () => {
    const state = mockFetch(async () => new Response("no", { status: 429, headers: { "x-should-retry": "false" } }));
    const res = await fetchWithRetry("http://nope/", {}, policy({ maxAttempts: 5 }));
    expect(res.status).toBe(429);
    expect(state.calls).toBe(1);
  });

  test("429 with retry-after:0 still retries (header beats own backoff)", async () => {
    const state = mockFetch(async () => {
      if (state.calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0", "x-should-retry": "true" } });
      return new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry("http://nope/", {}, policy({ maxAttempts: 3, initialDelayMs: 5000 }));
    expect(res.status).toBe(200);
    expect(state.calls).toBe(2);
  });

  test("400 is never retried even with attempts left", async () => {
    const state = mockFetch(async () => new Response("bad", { status: 400 }));
    const res = await fetchWithRetry("http://nope/", {}, policy({ maxAttempts: 3 }));
    expect(res.status).toBe(400);
    expect(state.calls).toBe(1);
  });
});

describe("timeout policy", () => {
  test("idle timeout fires while the wall clock remains", () => {
    let t = 1000;
    const tracker = new TimeoutTracker({ wallClockMs: 60_000, idleMs: 5_000 }, () => t);
    // t=1000: idleDeadline=6000, wallClock deadline=61000.
    expect(tracker.wallClockRemaining).toBeGreaterThan(0);
    expect(tracker.idleTimedOut).toBe(false);
    t = 7_000; // past idle, well inside wall clock
    expect(tracker.idleTimedOut).toBe(true);
    expect(tracker.wallClockTimedOut).toBe(false);
  });

  test("touch() resets the idle timeout", () => {
    let t = 1000;
    const tracker = new TimeoutTracker({ wallClockMs: 60_000, idleMs: 5_000 }, () => t);
    t = 7_000;
    expect(tracker.idleTimedOut).toBe(true);
    tracker.touch(); // idleDeadline = 7000+5000 = 12000
    expect(tracker.idleTimedOut).toBe(false);
  });

  test("wall clock timeout fires after the cap", () => {
    let t = 0;
    const tracker = new TimeoutTracker({ wallClockMs: 5_000, idleMs: 100_000 }, () => t);
    expect(tracker.wallClockTimedOut).toBe(false);
    t = 6_000;
    expect(tracker.wallClockTimedOut).toBe(true);
  });
});

describe("mid-response no-reissue rule", () => {
  test("completed tool calls are kept and not re-issued", () => {
    const results = [{ id: "t1", output: "done" }, { id: "t2", output: "ok" }];
    const r = handleMidResponseFailure(results, new Error("stream aborted"));
    expect(r.reissue).toBe(false);
    expect(r.results).toEqual(results);
    expect(r.failure).toBeInstanceOf(Error);
  });

  test("failure before any completed tool call may re-issue", () => {
    const r = handleMidResponseFailure([], new Error("stream aborted"));
    expect(r.reissue).toBe(true);
  });
});

describe("circuit breaker", () => {
  test("opens after the failure threshold", () => {
    const cb = new CircuitBreaker(5);
    expect(cb.state).toBe("closed");
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.allowRequest()).toBe(false);
  });

  test("half-open probe recovers on success", () => {
    let t = 0;
    const cb = new CircuitBreaker(2, 100, () => t);
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.allowRequest()).toBe(false); // inside the reset window
    t = 150; // advance past the reset window
    expect(cb.state).toBe("half-open");
    expect(cb.allowRequest()).toBe(true); // one probe is allowed
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.allowRequest()).toBe(true);
  });
});
