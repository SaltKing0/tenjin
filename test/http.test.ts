import { describe, test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import {
  startHttpServer,
  safeEqual,
  buildEventsStream,
  SSE_HIGH_WATER_MARK,
  type HttpListenConfig,
  type HttpServerHandle,
} from "../src/gateway/http";
import { emit, activeSubscriberCount } from "../src/gateway/events";

let handle: HttpServerHandle | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
});

type StartOverrides = Omit<Partial<Parameters<typeof startHttpServer>[0]>, "config"> & {
  config?: Partial<HttpListenConfig>;
};

function start(overrides: StartOverrides = {}) {
  handle = startHttpServer({
    handleMessage: async (text) => `echo:${text}`,
    status: () => ({ jobs: [{ name: "j1", bot: "b", nextDueMs: 123 }] }),
    ...overrides,
    config: {
      port: 0,
      host: "127.0.0.1",
      token: "SECRETTOKEN",
      ...(overrides.config ?? {}),
    },
  });
  return `http://127.0.0.1:${handle.port}`;
}

test("rejects missing bearer token", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(401);
});

test("rejects wrong token", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer WRONG", "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(401);
});

test("POST /message returns handler reply", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: JSON.stringify({ text: "investigate auth" }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { reply?: string };
  expect(data.reply).toBe("echo:investigate auth");
});

test("POST /message validates text", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

test("GET /status returns uptime and jobs", async () => {
  const base = start();
  const res = await fetch(`${base}/status`, {
    headers: { authorization: "Bearer SECRETTOKEN" },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(typeof data.uptimeMs).toBe("number");
  expect(data.jobs[0]?.name).toBe("j1");
});

test("unknown routes 404; invalid json 400", async () => {
  const base = start();
  const notFound = await fetch(`${base}/nope`, {
    headers: { authorization: "Bearer SECRETTOKEN" },
  });
  expect(notFound.status).toBe(404);

  const badJson = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: "{broken",
  });
  expect(badJson.status).toBe(400);
});

test("safeEqual compares in constant time without leaking length", () => {
  expect(safeEqual("SECRETTOKEN", "SECRETTOKEN")).toBe(true);
  expect(safeEqual("SECRETTOKEN", "SECRETTOKEn")).toBe(false);
  expect(safeEqual("abc", "abcd")).toBe(false);
  expect(safeEqual("", "")).toBe(false);
  expect(safeEqual("", "SECRETTOKEN")).toBe(false);
});

test("rejects malformed bearer header", async () => {
  const base = start();
  const noScheme = await fetch(`${base}/status`, {
    headers: { authorization: "SECRETTOKEN" },
  });
  expect(noScheme.status).toBe(401);

  const emptyToken = await fetch(`${base}/status`, {
    headers: { authorization: "Bearer " },
  });
  expect(emptyToken.status).toBe(401);
});

test("rate limit rejects requests beyond the per-IP budget on /api/*", async () => {
  const base = start({ config: { rateLimitMax: 3, rateLimitWindowMs: 60_000 } });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/api/settings`, {
      headers: { authorization: "Bearer SECRETTOKEN" },
    });
    statuses.push(res.status);
  }
  expect(statuses).toEqual([404, 404, 404, 429, 429]);
  const limited = await fetch(`${base}/api/settings`, {
    headers: { authorization: "Bearer SECRETTOKEN" },
  });
  expect(limited.headers.get("retry-after")).toBe("60");
});

test("rate limit applies to non-api authenticated routes like /status", async () => {
  const base = start({ config: { rateLimitMax: 2, rateLimitWindowMs: 60_000 } });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}/status`, {
      headers: { authorization: "Bearer SECRETTOKEN" },
    });
    statuses.push(res.status);
  }
  expect(statuses).toEqual([200, 200, 429, 429]);
});

test("rate limit throttles /message beyond the per-IP budget", async () => {
  const base = start({ config: { rateLimitMax: 3, rateLimitWindowMs: 60_000 } });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
      body: JSON.stringify({ text: `probe-${i}` }),
    });
    statuses.push(res.status);
  }
  expect(statuses).toEqual([200, 200, 200, 429, 429]);

  const limited = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: JSON.stringify({ text: "probe-limit" }),
  });
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
});

test("rate limit throttles unauthenticated brute-force on /message", async () => {
  const base = start({ config: { rateLimitMax: 2, rateLimitWindowMs: 60_000 } });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await fetch(`${base}/message`, {
      method: "POST",
      headers: { authorization: "Bearer WRONG", "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    statuses.push(res.status);
  }
  expect(statuses).toEqual([401, 401, 429, 429]);
});

test("console static files stay unthrottled", async () => {
  const base = start({
    consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
    config: { rateLimitMax: 1, rateLimitWindowMs: 60_000 },
  });
  const first = await fetch(`${base}/console`);
  const second = await fetch(`${base}/console/markdown.js`);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
});

test("console responses carry security headers", async () => {
  const base = start({
    consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
  });
  const res = await fetch(`${base}/console`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  // Console el() sets styles via inline style="" attributes, so style-src must
  // allow 'unsafe-inline' or the UI loses its layout (script-src stays 'self').
  expect(res.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
});

test("console serves the markdown renderer module", async () => {
  const base = start({
    consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
  });
  const res = await fetch(`${base}/console/markdown.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/javascript");
  const body = await res.text();
  expect(body).toContain("export function parseMarkdown");
  expect(body).toContain("export function sanitizeHref");
  expect(body).toContain("export function renderMarkdown");
});

test("SSE closes an unread (zombie) client and removes its listener on queue overflow (#199)", async () => {
  const baseline = activeSubscriberCount();
  // Build a stream but never read from it → zombie consumer. A fromId past
  // every event avoids history replay pre-filling the queue.
  const stream = buildEventsStream(Number.MAX_SAFE_INTEGER);
  const reader = stream.getReader();
  // let start() run and subscribe
  await new Promise((r) => setTimeout(r, 10));
  expect(activeSubscriberCount()).toBe(baseline + 1);

  // overflow the per-connection cap (should stop enqueueing, not grow unbounded)
  for (let i = 0; i < SSE_HIGH_WATER_MARK + 20; i++) emit(`over_${i}`, { n: i });

  // the server actively closed the stream; the buffered amount stays bounded
  let chunks = 0;
  let closed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      closed = true;
      break;
    }
    if (value) chunks += 1;
  }
  expect(closed).toBe(true);
  expect(chunks).toBeLessThanOrEqual(SSE_HIGH_WATER_MARK + 1);

  // the zombie's listener was removed — no leak
  expect(activeSubscriberCount()).toBe(baseline);
});
