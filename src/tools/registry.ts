import type { ToolSchema } from "../provider/types";
import type { SecurityGuard } from "../security/guard";
import type { TreeBudget } from "../agent/budget";

export interface ToolContext {
  cwd: string;
  guard?: SecurityGuard | null;
  /** #154: the shared delegation-tree budget, threaded to delegation tools so
   * a subagent run inherits the parent's counter. */
  treeBudget?: TreeBudget;
  /** Optional audit hook threaded from the agent loop. Multi-file write tools
   * (e.g. apply_patch) use it to emit one write_exec entry per touched file. */
  audit?: (kind: "write_exec", detail: string, correlationId?: string) => void;
  /** Shared correlation id forwarded with tool-emitted audit events. */
  correlationId?: string;
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

export function schemas(
  defs: ToolDef[],
  opts: { include?: string[]; exclude?: string[] } = {},
): ToolSchema[] {
  let list = defs;
  if (opts.include && opts.include.length) {
    const keep = new Set(opts.include);
    list = list.filter((d) => keep.has(d.name));
  }
  if (opts.exclude && opts.exclude.length) {
    const drop = new Set(opts.exclude);
    list = list.filter((d) => !drop.has(d.name));
  }
  return list.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));
}

export function findTool(defs: ToolDef[], name: string): ToolDef | undefined {
  return defs.find((d) => d.name === name);
}

/**
 * B7-6: validate & coerce a tool call's arguments against its input schema
 * BEFORE any handler runs, so a malformed call never executes. Returns the
 * coerced args on success, or a corrective error message on failure.
 *
 * - required: missing arguments are rejected.
 * - type: string/number/boolean are coerced where unambiguous; an incoercible
 *   value (object for string, non-numeric string for number, …) is rejected.
 * - enum: a property carrying an `enum` array must receive one of those values.
 */
export function validateToolArgs(
  def: ToolDef,
  input: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; output: string } {
  const args = (input ?? {}) as Record<string, unknown>;
  const schema = def.inputSchema;
  const props = (schema.properties ?? {}) as Record<string, { type?: string; enum?: unknown[] }>;

  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      return { ok: false, output: `Missing required argument(s): ${key}` };
    }
  }

  // Start from a copy of the raw args so undeclared keys pass through untouched;
  // only schema-declared keys are validated/coerced below.
  const coerced: Record<string, unknown> = { ...args };
  for (const key of Object.keys(props)) {
    if (args[key] === undefined || args[key] === null) continue;
    const spec = props[key]!;
    let value = args[key];
    if (spec.type === "string") {
      if (typeof value === "object") {
        return { ok: false, output: `Argument "${key}" must be a string (got an object)` };
      }
      value = String(value);
    } else if (spec.type === "number") {
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          return { ok: false, output: `Argument "${key}" must be a finite number` };
        }
      } else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        value = Number(value);
      } else {
        return { ok: false, output: `Argument "${key}" must be a number (got ${describe(value)})` };
      }
    } else if (spec.type === "boolean") {
      if (typeof value === "boolean") {
        // keep
      } else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      } else {
        return { ok: false, output: `Argument "${key}" must be a boolean (got ${describe(value)})` };
      }
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return {
        ok: false,
        output: `Argument "${key}" must be one of: ${spec.enum.map((e) => JSON.stringify(e)).join(", ")} (got ${JSON.stringify(value)})`,
      };
    }
    coerced[key] = value;
  }
  return { ok: true, args: coerced };
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return typeof value;
}

/** Minimal edit-distance suggestion for a mistyped tool name (max 3 edits). */
function suggest(name: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = 4; // only within 3 edits
  for (const c of candidates) {
    const d = levenshtein(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m]![n]!;
}

export async function dispatch(
  defs: ToolDef[],
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<DispatchResult> {
  const def = findTool(defs, name);
  if (!def) {
    const names = defs.map((d) => d.name).sort();
    const hint = suggest(name, names);
    const list = names.length ? ` Available tools: ${names.join(", ")}.` : "";
    const suggestMsg = hint ? ` Did you mean "${hint}"?` : "";
    return { ok: false, output: `Unknown tool: ${name}.${list}${suggestMsg}` };
  }
  const validated = validateToolArgs(def, input);
  if (!validated.ok) return { ok: false, output: validated.output };
  const args = validated.args;
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
