// ===========================================================================
// B2-8 Tool-surface quality audit cycle (#441)
// ---------------------------------------------------------------------------
// A static audit over the registered tool surface so the tool API stays
// coherent as it grows. Run it (or its CI-gated test) whenever a new tool is
// registered:
//
//   errors   — must be zero for CI to pass:
//     duplicate_tool_name  a tool name registered more than once
//     ambiguous_param      one param name used with DIFFERENT type/enum
//                          meaning across tools (the same name must mean the
//                          same thing everywhere)
//     empty_description    a tool with no description
//   warnings — quality guidance, not CI-blocking:
//     free_string_maybe_enum  a string param whose description names a bounded
//                          vocabulary but has no enum — prefer an enum
//     short_description       a tool whose description is too terse to be
//                          unambiguous
//
// Related actions should live as ONE tool with an `action` enum rather than a
// swarm of near-duplicate tools — this audit surfaces the duplicate-name /
// ambiguous-param smell that swarm-style surfaces create.
// ===========================================================================

import type { ToolDef } from "./registry";

export type AuditSeverity = "error" | "warning";

export type AuditCode =
  | "duplicate_tool_name"
  | "ambiguous_param"
  | "empty_description"
  | "free_string_maybe_enum"
  | "short_description";

export interface AuditFinding {
  severity: AuditSeverity;
  code: AuditCode;
  /** Tool name(s) the finding refers to. */
  tool: string;
  /** Param name when the finding is about a specific parameter. */
  param?: string;
  detail: string;
}

const MIN_DESCRIPTION_CHARS = 20;
/** A description that lists a bounded vocabulary but has no enum. */
const ENUM_HINT = /\b(one of|either|choose from|allowed values)\b/i;

/** The property spec shape inside an input schema. */
type PropSpec = { type?: string; enum?: unknown[]; description?: string };

/**
 * Audit a set of tool definitions. Returns findings sorted by severity then
 * code; callers gate CI on `errors()` being empty.
 */
export function auditToolSurface(defs: ToolDef[]): AuditFinding[] {
  const findings: AuditFinding[] = [];

  // --- per-tool checks ---------------------------------------------------
  for (const d of defs) {
    if (!d.description || !d.description.trim()) {
      findings.push({
        severity: "error",
        code: "empty_description",
        tool: d.name,
        detail: "tool has an empty description",
      });
    } else if (d.description.trim().length < MIN_DESCRIPTION_CHARS) {
      findings.push({
        severity: "warning",
        code: "short_description",
        tool: d.name,
        detail: `description is short (${d.description.trim().length} chars < ${MIN_DESCRIPTION_CHARS})`,
      });
    }
    const props = (d.inputSchema.properties ?? {}) as Record<string, PropSpec>;
    for (const [pname, spec] of Object.entries(props)) {
      if (
        spec.type === "string" &&
        !spec.enum &&
        spec.description &&
        ENUM_HINT.test(spec.description)
      ) {
        findings.push({
          severity: "warning",
          code: "free_string_maybe_enum",
          tool: d.name,
          param: pname,
          detail: `string param "${pname}" names a bounded vocabulary but has no enum — prefer an enum over a free string`,
        });
      }
    }
  }

  // --- duplicate tool names ----------------------------------------------
  const counts = new Map<string, number>();
  for (const d of defs) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n > 1) {
      findings.push({
        severity: "error",
        code: "duplicate_tool_name",
        tool: name,
        detail: `tool "${name}" is registered ${n} times`,
      });
    }
  }

  // --- ambiguous params --------------------------------------------------
  // A param name used across tools must carry a CONSISTENT type + enum
  // signature; a divergence means the same name means different things in
  // different places (a swarm-style smell).
  const paramUsage = new Map<
    string,
    Array<{ tool: string; type?: string; enumSig?: string }>
  >();
  for (const d of defs) {
    const props = (d.inputSchema.properties ?? {}) as Record<string, PropSpec>;
    for (const [pname, spec] of Object.entries(props)) {
      const enumSig = spec.enum ? JSON.stringify(spec.enum) : undefined;
      const list = paramUsage.get(pname) ?? [];
      list.push({ tool: d.name, type: spec.type, enumSig });
      paramUsage.set(pname, list);
    }
  }
  for (const [pname, usages] of paramUsage) {
    if (usages.length < 2) continue;
    const sigs = new Set(usages.map((u) => `${u.type ?? "*"}|${u.enumSig ?? "-"}`));
    if (sigs.size > 1) {
      findings.push({
        severity: "error",
        code: "ambiguous_param",
        tool: usages.map((u) => u.tool).join(", "),
        param: pname,
        detail: `param "${pname}" has inconsistent type/enum across tools (${[...sigs].join(" ; ")})`,
      });
    }
  }

  return findings.sort(
    (a, b) =>
      (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1) ||
      a.code.localeCompare(b.code),
  );
}

/** Only the CI-blocking (error) findings. */
export function auditErrors(defs: ToolDef[]): AuditFinding[] {
  return auditToolSurface(defs).filter((f) => f.severity === "error");
}

/** Convenience: true when the surface is clean enough for CI. */
export function isCleanToolSurface(defs: ToolDef[]): boolean {
  return auditErrors(defs).length === 0;
}
