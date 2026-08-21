import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/types";

export interface HttpListenConfig {
  port: number;
  host: string;
  token: string;
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
    headers: { "content-type": entry.type },
  });
}

export function startHttpServer(deps: HttpDeps): HttpServerHandle {
  if (!deps.config.token) throw new ConfigError("gateway.listen.token is required");
  const startedAt = Date.now();
  const server = Bun.serve({
    port: deps.config.port,
    hostname: deps.config.host,
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      if (deps.consoleDir && req.method === "GET") {
        const staticResponse = serveStatic(deps.consoleDir, url.pathname);
        if (staticResponse) return staticResponse;
      }

      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${deps.config.token}`) {
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
      if (url.pathname.startsWith("/api/")) {
        if (deps.api) {
          const response = await deps.api(req, url);
          if (response) return response;
        }
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (url.pathname === "/api/chat/stream" && deps.streamChat) {
        const streamed = await deps.streamChat(req);
        return streamed ?? Response.json({ error: "not found" }, { status: 404 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const port = server.port ?? deps.config.port;
  return { port, stop: () => server.stop(true) };
}
