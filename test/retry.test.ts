import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { fetchWithRetry, normalizeRetry, DEFAULT_RETRY_STATUSES } from "../src/provider/retry";
import type { RetryConfig } from "../src/config/types";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A full policy with tiny delays so tests don't actually sleep. */
function policy(over: Partial<RetryConfig> = {}): ReturnType<typeof normalizeRetry> {
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

describe("normalizeRetry", () => {
  test("undefined config yields the on-by-default policy", () => {
    const p = normalizeRetry();
    expect(p.enabled).toBe(true);
    expect(p.maxAttempts).toBe(3);
    expect(p.retryableStatuses).toEqual([429, 500, 502, 503, 504]);
  });

  test("partial config merges over defaults without mutating them", () => {
    const p = normalizeRetry({ maxAttempts: 5 });
    expect(p.maxAttempts).toBe(5);
    expect(p.enabled).toBe(true); // default preserved
    expect(DEFAULT_RETRY_STATUSES).toContain(429);
  });

  test("empty retryableStatuses list falls back to defaults", () => {
    const p = normalizeRetry({ retryableStatuses: [] });
    expect(p.retryableStatuses).toEqual(DEFAULT_RETRY_STATUSES);
  });
});

describe("fetchWithRetry over a live server", () => {
  test("transient 429 is retried and the call survives", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return calls === 1
          ? new Response("rate limited", { status: 429 })
          : new Response("ok", { status: 200 });
      },
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${server.port}/`, {}, policy());
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("5xx retried until success", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return calls === 3 ? new Response("ok", { status: 200 }) : new Response("boom", { status: 502 });
      },
    });
    try {
      const res = await fetchWithRetry(
        `http://127.0.0.1:${server.port}/`,
        {},
        policy({ maxAttempts: 3 }),
      );
      expect(res.status).toBe(200);
      expect(calls).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test("retry limit exhausted returns the final retryable response", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response("gateway", { status: 503 });
      },
    });
    try {
      const res = await fetchWithRetry(
        `http://127.0.0.1:${server.port}/`,
        {},
        policy({ maxAttempts: 2 }),
      );
      expect(res.status).toBe(503);
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("exhausted retries keep the final response body readable", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("gateway down", { status: 503 }),
    });
    try {
      const res = await fetchWithRetry(
        `http://127.0.0.1:${server.port}/`,
        {},
        policy({ maxAttempts: 2 }),
      );
      // The provider reads res.text() for its error message after giving up.
      expect(await res.text()).toContain("gateway down");
    } finally {
      server.stop(true);
    }
  });

  test("non-retryable status (401) returns immediately, single attempt", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response("denied", { status: 401 });
      },
    });
    try {
      const res = await fetchWithRetry(`http://127.0.0.1:${server.port}/`, {}, policy());
      expect(res.status).toBe(401);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("disabled retry makes a single attempt even on 429", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response("slow", { status: 429 });
      },
    });
    try {
      const res = await fetchWithRetry(
        `http://127.0.0.1:${server.port}/`,
        {},
        policy({ enabled: false }),
      );
      expect(res.status).toBe(429);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("fetchWithRetry network errors", () => {
  test("network error is retried and the call survives", async () => {
    const state = mockFetch(async () => {
      if (state.calls === 1) throw new TypeError("fetch failed");
      return new Response("ok", { status: 200 });
    });
    const res = await fetchWithRetry("http://nope/", {}, policy());
    expect(res.status).toBe(200);
    expect(state.calls).toBe(2);
  });

  test("network error exhausted rethrows the underlying error", async () => {
    const state = mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fetchWithRetry("http://nope/", {}, policy({ maxAttempts: 3 })),
    ).rejects.toThrow("fetch failed");
    expect(state.calls).toBe(3);
  });

  test("a caller abort is never retried", async () => {
    const state = mockFetch(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const controller = new AbortController();
    await expect(
      fetchWithRetry("http://nope/", {}, policy(), controller.signal),
    ).rejects.toThrow();
    expect(state.calls).toBe(1);
  });
});
