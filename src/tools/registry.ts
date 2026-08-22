import type { ToolSchema } from "../provider/types";
import type { SecurityGuard } from "../security/guard";
import type { TreeBudget } from "../agent/budget";

export interface ToolContext {
  cwd: string;
  guard?: SecurityGuard | null;
  /** #154: the shared delegation-tree budget, threaded to delegation tools so
   * a subagent run inherits the parent's counter. */
  treeBudget?: TreeBudget;
}

export type ToolGroup = "read" | "write";

export interface ToolDef {
  name: string;
  group: ToolGroup;
  description: string;
  inputSchema: ToolSchema["inputSchema"];
  handler(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface DispatchResult {
  ok: boolean;
  output: string;
}

export function schemas(defs: ToolDef[]): ToolSchema[] {
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
}

export function findTool(defs: ToolDef[], name: string): ToolDef | undefined {
  return defs.find((d) => d.name === name);
}

export async function dispatch(
  defs: ToolDef[],
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<DispatchResult> {
  const def = findTool(defs, name);
  if (!def) return { ok: false, output: `Unknown tool: ${name}` };
  const args = (input ?? {}) as Record<string, unknown>;
  const missing = (def.inputSchema.required ?? []).filter(
    (k) => args[k] === undefined || args[k] === null,
  );
  if (missing.length) {
    return { ok: false, output: `Missing required argument(s): ${missing.join(", ")}` };
  }
  if (ctx.guard) {
    const guardResult = ctx.guard.checkTool(name, args, ctx.cwd);
    if (guardResult.blocked) {
      const why = guardResult.pattern
        ? `matches pattern "${guardResult.pattern}"`
        : (guardResult.reason ? `rejected: ${guardResult.reason}` : "rejected by policy");
      ctx.guard.onBlock?.(`${name} blocked (${why}) target="${guardResult.target ?? ""}"`);
      return {
        ok: false,
        output: `Blocked by security policy: ${why}. Ask the user how to proceed.`,
      };
    }
  }
  try {
    return { ok: true, output: await def.handler(args, ctx) };
  } catch (e) {
    return { ok: false, output: cleanToolError(e) };
  }
}

/**
 * #338: a handler exception must surface as a clean, one-line, actionable
 * message — never a raw stack trace or a leaked "[object Object]".
 */
function cleanToolError(e: unknown): string {
  const firstLine = (msg: string) => msg.split("\n")[0]?.trim() ?? "";
  if (e instanceof Error && e.message) return firstLine(e.message) || "Tool execution failed.";
  if (typeof e === "string") return firstLine(e) || "Tool execution failed.";
  // Non-Error thrown value (object, undefined, …): give a generic, actionable
  // message instead of leaking String(object) === "[object Object]".
  return "Tool execution failed.";
}

export function cap(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[output truncated at ${max} chars]`;
}
