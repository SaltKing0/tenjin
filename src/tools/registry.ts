import type { ToolSchema } from "../provider/types";
import type { SecurityGuard } from "../security/guard";

export interface ToolContext {
  cwd: string;
  guard?: SecurityGuard | null;
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
    const guardResult = ctx.guard.checkTool(name, args);
    if (guardResult.blocked) {
      ctx.guard.onBlock?.(`${name} blocked by pattern "${guardResult.pattern}" target="${guardResult.target}"`);
      return {
        ok: false,
        output: `Blocked by security policy: matches pattern "${guardResult.pattern}". Ask the user how to proceed.`,
      };
    }
  }
  try {
    return { ok: true, output: await def.handler(args, ctx) };
  } catch (e) {
    return { ok: false, output: String((e as Error)?.message ?? e) };
  }
}

export function cap(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[output truncated at ${max} chars]`;
}
