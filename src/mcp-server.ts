import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

/**
 * MCP server mode (Roadmap §18 B15-7, DR14-T2, #439).
 *
 * The other half of the ecosystem: Tenjin as PROVIDER, not just consumer.
 * The client half (#346/#347) lives in tools/mcp.ts — a hand-rolled,
 * dependency-free, newline-framed JSON-RPC 2.0 dialect over stdio. This module
 * is the matching SERVER: `tenjin mcp-serve` speaks the same dialect so an
 * external MCP client can call Tenjin's own tools/skills.
 *
 *   initialize -> capabilities exchange -> tools/list -> tools/call
 *
 * SECURITY MODEL (deny-by-default like everything else):
 *   - Only tools on the config allowlist (`mcp-server.expose[]`) are
 *     advertised and callable; anything else is invisible AND uncallable.
 *   - Every remote call runs through the SAME guard/approval/budget gates as
 *     local dispatch before the tool handler executes.
 *   - Every result is wrapped as UNTRUSTED data before it leaves the server.
 *
 * The class is pure over stdio — feed it JSON-RPC lines and read the response
 * lines — so the whole protocol is unit-testable without a subprocess.
 */

export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Marker prepended to every remote tool result to flag it as untrusted. */
export const UNTRUSTED_MARKER = "__untrusted__";

/** A tool exposed to MCP clients (subset of a ToolDef, allowlisted). */
export interface McpExposedTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpDispatchResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * The full dispatch path for a remote tool call. The caller wires this to run
 * guard + approval + budget + the tool handler — exactly the local dispatch —
 * and returns a normalized result. The server wraps errors and untrusted
 * output around whatever comes back.
 */
export type McpDispatch = (
  name: string,
  args: Record<string, unknown>,
) => Promise<McpDispatchResult>;

export interface McpServerHooks {
  /** #347-style deny-list check, mirrored from the client path. */
  guard?: { checkMcpTool(name: string): { blocked: boolean } };
  /** Budget gate; a call that cannot consume a unit is refused. */
  budget?: { consume(units?: number): boolean };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}

export class McpServer {
  private readonly exposed: Map<string, McpExposedTool>;

  constructor(
    private readonly dispatch: McpDispatch,
    allowlist: McpExposedTool[],
    private readonly hooks: McpServerHooks = {},
  ) {
    this.exposed = new Map(allowlist.map((t) => [t.name, t]));
  }

  /** The allowlisted tool specs, in insertion order. */
  exposedTools(): McpExposedTool[] {
    return [...this.exposed.values()];
  }

  /**
   * Handle one newline-framed JSON-RPC line. Returns the response line to write
   * to stdout, or null for a notification (which produces no response).
   */
  async handleLine(line: string): Promise<string | null> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.error(-32700, "Parse error", 0);
    }
    if (msg.id === undefined) return null; // notification — no response
    const id = msg.id;

    switch (msg.method) {
      case "initialize":
        return this.reply(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "tenjin", version: "0.1.0" },
        });
      case "tools/list":
        return this.reply(id, { tools: this.exposedTools() });
      case "tools/call":
        return this.handleCall(id, msg.params ?? {});
      default:
        return this.error(-32601, `Method not found: ${msg.method ?? "(none)"}`, id);
    }
  }

  private async handleCall(id: number, params: Record<string, unknown>): Promise<string> {
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    const tool = this.exposed.get(name);
    if (!tool) {
      return this.error(-32602, `Unknown tool "${name}" (not allowlisted)`, id);
    }

    // Gate the remote call exactly like a local one.
    if (this.hooks.guard) {
      const g = this.hooks.guard.checkMcpTool(name);
      if (g.blocked) {
        return this.error(-32602, `Tool "${name}" is denied by security policy`, id);
      }
    }
    if (this.hooks.budget && !this.hooks.budget.consume(1)) {
      return this.error(-32602, "Remote call halted: budget exhausted", id);
    }

    const result = await this.dispatch(name, args);
    if (!result.ok) {
      return this.error(-32603, result.error ?? "Tool execution failed", id);
    }
    return this.reply(id, { content: [{ type: "text", text: wrapUntrusted(result.value) }] });
  }

  private reply(id: number, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  private error(code: number, message: string, id: number): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

/** Render a remote tool result as untrusted text (never trusted as model data). */
export function wrapUntrusted(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return `${UNTRUSTED_MARKER} ${text}`;
}

// ---------------------------------------------------------------------------
// `tenjin mcp-serve` — stdio bridge
// ---------------------------------------------------------------------------

/**
 * Serve an McpServer over stdio (newline-framed JSON-RPC). Reads lines from
 * stdin until EOF, writes responses to stdout. Returns the number of requests
 * served (for tests / logging).
 */
export async function serveMcpStdio(server: McpServer): Promise<number> {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity });
  let served = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const response = await server.handleLine(trimmed);
    if (response !== null) {
      stdout.write(response + "\n");
      served++;
    }
  }
  return served;
}
