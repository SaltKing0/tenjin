import type { ToolDef } from "./registry";
import type { HarnessConfig } from "../config/types";

/**
 * MCP (Model Context Protocol) stdio skeleton — Roadmap §3 Phase 3 / WPs 3.1+3.2.
 *
 * A thin, dependency-free adapter that speaks newline-framed JSON-RPC 2.0 over a
 * child process's stdio (Bun.spawn) — NO official SDK, so no runtime deps.
 *
 * Default is OFF: an MCP server only runs when a config entry has
 * `enabled: true`. With an empty (or default) config, `createMcpTools` returns
 * [] and boot behavior is byte-identical to pre-MCP main.
 *
 * Per server (config `mcp.servers[]`):
 *   { name, command, args[], env{}, scope: local|project|user, enabled:false }
 *
 * Lifecycle: spawn child -> initialize handshake + capability exchange ->
 * tools/list -> register each remote tool as a ToolDef named
 * `mcp__<server>__<tool>` -> tools/call on use. Each call has a timeout that
 * kills and reaps the child on hang; a malformed JSON-RPC frame is rejected
 * cleanly instead of crashing the harness.
 */

export type McpScope = "local" | "project" | "user";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  /** Environment for the child, with ${VAR}/$VAR expanded from `env`. */
  env?: Record<string, string>;
  scope: McpScope;
  /** Default false — an MCP server only runs when explicitly enabled. */
  enabled: boolean;
}

export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface Pending {
  resolve: (r: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const ENV_VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Expand `${VAR}` / `$VAR` references from `env` (defaults to process.env). */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(ENV_VAR, (whole, a?: string, b?: string) => {
    const key = a ?? b;
    const v = key ? env[key] : undefined;
    return v !== undefined ? v : whole;
  });
}

/** Normalize a raw `mcp.servers[]` value into typed server configs (enabled=false default). */
export function normalizeMcpServers(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const s = item as Record<string, unknown>;
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name || typeof s.command !== "string") continue;
    out.push({
      name,
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: expandEnvMap(s.env, env),
      scope: s.scope === "project" || s.scope === "user" ? s.scope : "local",
      enabled: s.enabled === undefined ? false : Boolean(s.enabled),
    });
  }
  return out;
}

function expandEnvMap(
  raw: unknown,
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = expandEnv(String(v), env);
  }
  return out;
}

function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((b) => {
      if (b && typeof b === "object") {
        const block = b as { type?: string; text?: unknown };
        if (block.type === "text" && typeof block.text === "string") return block.text;
        return String(block.text ?? "");
      }
      return String(b);
    })
    .filter((s) => s !== "")
    .join("\n");
}

/** A single JSON-RPC client bound to one MCP child process. */
export class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private stdin: { write(data: Uint8Array | string): void; flush(): void } | undefined;
  private pumpPromise: Promise<void> | undefined;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private failReason: string | null = null;

  constructor(
    private cfg: McpServerConfig,
    private timeoutMs = 15_000,
  ) {
    this.proc = Bun.spawn([cfg.command, ...(cfg.args ?? [])], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "pipe",
      env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
    });
    // Bun's spawned stdin in "pipe" mode is a FileSink (write/flush), not a
    // web WritableStream — cast to the minimal shape we use.
    this.stdin = this.proc.stdin as unknown as McpClient["stdin"];
    this.pumpPromise = this.pump();
    liveClients.add(this);
  }

  private writeLine(frame: string): void {
    if (!this.stdin) return;
    this.stdin.write(new TextEncoder().encode(frame + "\n"));
    this.stdin.flush();
  }

  /** MCP initialize handshake + capability exchange, then tools/list. */
  async initialize(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tenjin", version: "0.1.0" },
    });
    if (res.error) throw new Error(`MCP initialize failed: ${res.error.message}`);
    this.notify("notifications/initialized", {});
    const list = await this.request("tools/list", {});
    if (list.error) throw new Error(`MCP tools/list failed: ${list.error.message}`);
    const tools = (list.result as { tools?: unknown })?.tools;
    this.tools = Array.isArray(tools) ? (tools as McpToolSpec[]) : [];
  }

  /** Tools advertised by the server (populated after initialize()). */
  tools: McpToolSpec[] = [];

  async callTool(name: string, args: unknown): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`MCP tools/call error: ${res.error.message}`);
    return renderContent((res.result as { content?: unknown })?.content);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    liveClients.delete(this);
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.failAll(new Error("MCP client closed"));
  }

  /** @internal for tests — resolves when the child process is fully reaped. */
  get exited(): Promise<number | null> {
    return this.proc.exited;
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (this.closed) return Promise.reject(new Error(`MCP client closed (${method})`));
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failWith(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine(frame);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeLine(frame);
  }

  private async pump(): Promise<void> {
    const stdout = this.proc.stdout as unknown as ReadableStream<Uint8Array> | undefined;
    const reader = stdout?.getReader();
    if (!reader) return;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.buf += new TextDecoder().decode(value);
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.handleFrame(line);
          if (this.closed) return;
        }
      }
      // EOF: the child exited. If we weren't closed intentionally, fail pending.
      if (!this.closed) this.failWith(new Error("MCP server exited unexpectedly"));
    } catch {
      if (!this.closed) this.failWith(new Error("MCP stdout read failed"));
    }
  }

  private handleFrame(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      this.failWith(new Error(`MCP server sent a malformed JSON-RPC frame: ${line.slice(0, 80)}`));
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
    // Notifications (no id) are ignored.
  }

  private failWith(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    liveClients.delete(this);
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    this.failAll(e);
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}

function truncate(text: string, max = 500): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// Registry of live clients so tests (and a future shutdown hook) can reap the
// child processes instead of leaving orphans behind.
const liveClients = new Set<McpClient>();

/** Kill and reap every live MCP child process (e.g. on shutdown / test teardown). */
export function closeAllMcpClients(): void {
  for (const c of liveClients) c.close();
  liveClients.clear();
}

/**
 * Build ToolDefs for every enabled MCP server in `cfg`. Async because each
 * server's tools/list must be fetched during the handshake. Returns [] (and
 * spawns nothing) for an empty/default config — zero behavior change.
 */
export async function createMcpTools(
  cfg: HarnessConfig,
  opts: { timeoutMs?: number; warn?: (msg: string) => void } = {},
): Promise<ToolDef[]> {
  const servers = normalizeMcpServers(cfg.mcp?.servers);
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const tools: ToolDef[] = [];

  for (const server of servers) {
    if (!server.enabled) continue;
    let client: McpClient;
    try {
      client = new McpClient(server, opts.timeoutMs);
      await client.initialize();
    } catch (e) {
      warn(`[mcp] server "${server.name}" failed to initialize: ${(e as Error).message}`);
      continue;
    }
    for (const t of client.tools) {
      const spec = t.inputSchema ?? {};
      tools.push({
        name: `mcp__${server.name}__${t.name}`,
        group: "write",
        description: truncate(t.description ?? `MCP tool "${t.name}" on server "${server.name}"`),
        inputSchema: {
          type: "object",
          properties: spec.properties ?? {},
          required: spec.required ?? [],
        },
        async handler(args) {
          return client.callTool(t.name, args);
        },
      });
    }
  }
  return tools;
}
