import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { ConfigError } from "../config/types";
import { subscribe, historySince, formatEvent, type GatewayEvent } from "./events";

export interface HttpListenConfig {
  port: number;
  host: string;
  token: string;
  /** Max requests per IP per window on authenticated routes; 429 beyond this. */
  rateLimitMax?: number;
  /** Rate-limit window in ms. */
  rateLimitWindowMs?: number;
}

export interface HttpDeps {
  config: HttpListenConfig;
  handleMessage: (text: string) => Promise<string | null>;
  status: () => Record<string, unknown>;
  log?: (line: string) => void;
  api?: (req: Request, url: URL) => Promise<Response | null>;
  streamChat?: (req: Request) => Promise<Response | null>;
  /** GET /api/health body (uptimeMs is added by the server itself). */
  health?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** GET /metrics Prometheus text output. */
  metrics?: () => string;
  consoleDir?: string;
}

export interface HttpServerHandle {
  port: number;
  stop(): void;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console": { file: "index.html", type: "text/html; charset=utf-8" },
  "/console/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/console/markdown.js": { file: "markdown.js", type: "application/javascript; charset=utf-8" },
  "/console/empty-state.js": { file: "empty-state.js", type: "application/javascript; charset=utf-8" },
  "/console/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

function serveStatic(consoleDir: string, pathname: string): Response | null {
  const entry = STATIC_FILES[pathname];
  if (!entry) return null;
  const path = join(consoleDir, entry.file);
  if (!existsSync(path)) return null;
  return new Response(readFileSync(path), {
    headers: {
      "content-type": entry.type,
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Constant-time string comparison. Both inputs are hashed with SHA-256
 * first so the comparison never leaks the token length, then compared
 * with timingSafeEqual.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

const DEFAULT_RATE_LIMIT_MAX = 120;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_SWEEP_THRESHOLD = 2048;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimiter {
  /** Returns true when the request is over the limit and should be rejected. */
  limited(ip: string): boolean;
  /** Drop expired entries once the map grows past a threshold. */
  sweep(): void;
}

function createRateLimiter(max: number, windowMs: number): RateLimiter {
  const store = new Map<string, RateLimitEntry>();
  return {
    limited(ip: string): boolean {
      const now = Date.now();
      const entry = store.get(ip);
      if (!entry || now >= entry.resetAt) {
        store.set(ip, { count: 1, resetAt: now + windowMs });
        return false;
      }
      entry.count += 1;
      return entry.count > max;
    },
    sweep(): void {
      if (store.size < RATE_LIMIT_SWEEP_THRESHOLD) return;
      const now = Date.now();
      for (const [ip, entry] of store) {
        if (now >= entry.resetAt) store.delete(ip);
      }
    },
  };
}

/** Security headers applied to console (static) responses. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export function startHttpServer(deps: HttpDeps): HttpServerHandle {
  if (!deps.config.token) throw new ConfigError("gateway.listen.token is required");
  const startedAt = Date.now();
  const rateLimitMax = deps.config.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
  const rateLimitWindowMs = deps.config.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
  const rateLimiter = createRateLimiter(rateLimitMax, rateLimitWindowMs);
  const server = Bun.serve({
    port: deps.config.port,
    hostname: deps.config.host,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      if (deps.consoleDir && req.method === "GET") {
        const staticResponse = serveStatic(deps.consoleDir, url.pathname);
        if (staticResponse) return staticResponse;
      }

      // Rate-limit every authenticated route per IP before any auth work, so a
      // brute-force attempt on the token is throttled regardless of success or
      // failure — on /message, /status, /metrics and /api/* alike. Static
      // console files above are public and are not throttled.
      rateLimiter.sweep();
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (rateLimiter.limited(ip)) {
        return Response.json(
          { error: "too many requests" },
          {
            status: 429,
            headers: { "retry-after": String(Math.ceil(rateLimitWindowMs / 1000)) },
          },
        );
      }

      const auth = req.headers.get("authorization");
      const provided = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!safeEqual(provided, deps.config.token)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/status") {
        return Response.json({
          uptimeMs: Date.now() - startedAt,
          ...deps.status(),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        if (!deps.health) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({
          uptimeMs: Date.now() - startedAt,
          ...(await deps.health()),
        });
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        if (!deps.metrics) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return new Response(deps.metrics(), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/message") {
        let body: { text?: unknown };
        try {
          body = (await req.json()) as { text?: unknown };
        } catch {
          return Response.json({ error: "invalid json" }, { status: 400 });
        }
        if (typeof body.text !== "string" || !body.text.trim()) {
          return Response.json({ error: "text is required" }, { status: 400 });
        }
        try {
          const reply = await deps.handleMessage(body.text);
          return Response.json({ reply });
        } catch (e) {
          deps.log?.(`http handler error: ${(e as Error).message}`);
          return Response.json({ error: "handler failed" }, { status: 500 });
        }
      }
      if (url.pathname === "/api/chat/stream" && deps.streamChat) {
        const streamed = await deps.streamChat(req);
        return streamed ?? Response.json({ error: "not found" }, { status: 404 });
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        try {
          const header = req.headers.get("last-event-id");
          const fromId =
            header && header.trim() !== "" ? Number(header) || 0 : Number.MAX_SAFE_INTEGER;
          return eventsStream(fromId);
        } catch (err) {
          return new Response(`events error: ${(err as Error).message}`, { status: 500 });
        }
      }
      if (url.pathname.startsWith("/api/")) {
        if (deps.api) {
          const response = await deps.api(req, url);
          if (response) return response;
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const port = server.port ?? deps.config.port;
  return { port, stop: () => server.stop(true) };
}

/**
 * SSE per-connection queue cap. Past this a client that isn't draining the
 * stream is treated as dead or too slow and is actively closed (#199) instead
 * of letting the internal queue grow unbounded.
 */
export const SSE_HIGH_WATER_MARK = 64;
const SSE_HEARTBEAT_MS = 3000;

/**
 * Build the SSE event stream. The subscriber, heartbeat and backpressure live
 * here so the zombie-client behaviour is testable without a real socket.
 */
export function buildEventsStream(fromId: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        let closed = false;
        let unsub: (() => void) | null = null;
        let hb: ReturnType<typeof setInterval> | null = null;
        cleanup = () => {
          if (closed) return;
          closed = true;
          unsub?.();
          unsub = null;
          if (hb) clearInterval(hb);
          hb = null;
        };
        const enqueueOrClose = (payload: string): void => {
          if (closed) return;
          // #199: backpressure — a consumer that isn't draining the queue is
          // dead or too slow; close it instead of letting the buffer grow
          // unbounded (the active close also drops the subscriber).
          if (c.desiredSize != null && c.desiredSize <= 0) {
            cleanup?.();
            try {
              c.close();
            } catch {
              /* stream already closed */
            }
            return;
          }
          try {
            c.enqueue(encoder.encode(payload));
          } catch {
            // Non-cancel enqueue failure — don't swallow it and leak the
            // subscriber/interval; clean up.
            cleanup?.();
          }
        };
        const send = (e: GatewayEvent) => enqueueOrClose(formatEvent(e));
        for (const e of historySince(fromId)) send(e);
        unsub = subscribe(send);
        hb = setInterval(() => enqueueOrClose(": ping\n\n"), SSE_HEARTBEAT_MS);
      },
      cancel() {
        cleanup?.();
      },
    },
    { highWaterMark: SSE_HIGH_WATER_MARK },
  );
}

function eventsStream(fromId: number): Response {
  return new Response(buildEventsStream(fromId), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
