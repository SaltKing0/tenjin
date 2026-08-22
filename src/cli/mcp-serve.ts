import { McpServer, serveMcpStdio, type McpExposedTool, type McpDispatch } from "../mcp-server";
import { dispatch } from "../tools/registry";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/types";

/**
 * `tenjin mcp-serve` — expose Tenjin's own tools/skills to external MCP
 * clients (Roadmap §18 B15-7, #439).
 *
 * DENY-BY-DEFAULT: only tools listed in `mcp-server.expose[]` are advertised
 * and callable. Every remote call runs through the SAME dispatch path as a
 * local call (`dispatch()` in tools/registry.ts: argument validation + guard),
 * and every result is wrapped as untrusted data by the McpServer.
 */

export interface McpServeDeps {
  config: HarnessConfig;
  tools: ToolDef[];
  /** Local dispatch context (carries guard + cwd). */
  ctx: { guard?: unknown; cwd?: string };
}

export async function mcpServeCommand(_args: string[], deps: McpServeDeps): Promise<number> {
  const expose = deps.config.mcpServer?.expose ?? [];
  const exposedTools = deps.tools.filter((t) => expose.includes(t.name));

  // Allowlisted tool specs advertised to the client.
  const allowlist: McpExposedTool[] = exposedTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as McpExposedTool["inputSchema"],
  }));

  // Remote calls ride the same full dispatch (validation + guard) as local.
  const mcDispatch: McpDispatch = async (name, toolArgs) => {
    const res = await dispatch(deps.tools, name, toolArgs, deps.ctx as never);
    return res.ok ? { ok: true, value: res.output } : { ok: false, error: res.output };
  };

  // Defense-in-depth guard hook on the server itself.
  const guard = deps.ctx.guard as
    | { checkMcpTool?(name: string): { blocked: boolean } }
    | undefined;

  const server = new McpServer(mcDispatch, allowlist, {
    guard: guard?.checkMcpTool
      ? { checkMcpTool: (name: string) => guard.checkMcpTool!(name) }
      : undefined,
  });

  await serveMcpStdio(server);
  return 0;
}
