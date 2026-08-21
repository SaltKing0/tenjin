import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";
import { ConfigError } from "../config/types";

export interface HttpListenConfig {
  port: number;
  host: string;
  token: string;
  /** Max requests per IP per window on /api/*; 429 beyond this. */
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
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
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

      // Rate-limit /api/* per IP before any auth work, so a brute-force
      // attempt on the token is throttled regardless of success/failure.
      if (url.pathname.startsWith("/api/")) {
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
