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
}

export interface HttpServerHandle {
  port: number;
  stop(): void;
}

export function startHttpServer(deps: HttpDeps): HttpServerHandle {
  if (!deps.config.token) throw new ConfigError("gateway.listen.token is required");
  const startedAt = Date.now();
  const server = Bun.serve({
    port: deps.config.port,
    hostname: deps.config.host,
    fetch: async (req: Request) => {
      const url = new URL(req.url);
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
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
  const port = server.port ?? deps.config.port;
  return { port, stop: () => server.stop(true) };
}
