import { describe, test, expect } from "bun:test";
import type { ToolDef } from "../src/tools/registry";
import {
  auditToolSurface,
  auditErrors,
  isCleanToolSurface,
} from "../src/tools/audit";
import {
  buildToolAuditReport,
  defaultToolAuditSurface,
  runToolAudit,
} from "../src/cli/tool-audit";

function tool(over: Partial<ToolDef> & { name: string }): ToolDef {
  return {
    group: "read",
    description: "A sufficiently detailed description for this tool.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => "ok",
    ...over,
  };
}

describe("B2-8 static lint: duplicate tool names fail", () => {
  test("a tool registered twice is reported as an error", () => {
    const findings = auditErrors([
      tool({ name: "dup" }),
      tool({ name: "dup" }),
    ]);
    expect(findings.some((f) => f.code === "duplicate_tool_name")).toBe(true);
    expect(isCleanToolSurface([tool({ name: "dup" }), tool({ name: "dup" })])).toBe(false);
  });
});

describe("B2-8 static lint: ambiguous parameter names fail", () => {
  test("the same param name with a different type across tools is ambiguous", () => {
    const a = tool({ name: "a", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] } });
    const b = tool({ name: "b", inputSchema: { type: "object", properties: { path: { type: "number" } }, required: [] } });
    const findings = auditErrors([a, b]);
    const amb = findings.find((f) => f.code === "ambiguous_param");
    expect(amb).toBeDefined();
    expect(amb!.param).toBe("path");
  });

  test("a param with vs without an enum across tools is ambiguous", () => {
    const a = tool({ name: "a", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["read", "write"] } }, required: [] } });
    const b = tool({ name: "b", inputSchema: { type: "object", properties: { mode: { type: "string" } }, required: [] } });
    expect(auditErrors([a, b]).some((f) => f.code === "ambiguous_param")).toBe(true);
  });

  test("the same param name with a consistent type is NOT ambiguous", () => {
    const a = tool({ name: "a", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] } });
    const b = tool({ name: "b", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: [] } });
    expect(auditErrors([a, b]).some((f) => f.code === "ambiguous_param")).toBe(false);
  });
});

describe("B2-8 static lint: empty description fails", () => {
  test("a tool with an empty description is an error", () => {
    expect(auditErrors([tool({ name: "x", description: "  " })]).some((f) => f.code === "empty_description")).toBe(true);
  });
});

describe("B2-8 CI gate over the real core tool surface", () => {
  test("the baseline built-in tools are clean (no duplicate/ambiguous/empty)", () => {
    const errors = auditErrors(defaultToolAuditSurface());
    expect(errors).toEqual([]);
    expect(isCleanToolSurface(defaultToolAuditSurface())).toBe(true);
  });
});

describe("B2-8 quality warnings (not CI-blocking)", () => {
  test("a free-string param that names a bounded vocabulary is flagged as a warning", () => {
    const t = tool({
      name: "y",
      inputSchema: {
        type: "object",
        properties: { format: { type: "string", description: "one of: json, markdown" } },
        required: [],
      },
    });
    const findings = auditToolSurface([t]);
    const warn = findings.find((f) => f.code === "free_string_maybe_enum");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
    expect(auditErrors([t]).length).toBe(0); // warnings don't block CI
  });

  test("a terse description is a warning, not an error", () => {
    const findings = auditToolSurface([tool({ name: "z", description: "short" })]);
    expect(findings.some((f) => f.code === "short_description" && f.severity === "warning")).toBe(true);
  });
});

describe("B2-8 product command", () => {
  test("reports the real baseline surface and a machine-readable clean result", () => {
    const report = buildToolAuditReport(defaultToolAuditSurface());
    expect(report).toMatchObject({ schemaVersion: 1, toolCount: 9, ok: true, errors: 0 });

    let output = "";
    const code = runToolAudit(["--json"], { write: (text) => { output += text; } });
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, toolCount: 9, ok: true, errors: 0 });
  });

  test("returns a nonzero exit code only for audit errors", () => {
    let output = "";
    const code = runToolAudit([], {
      tools: [tool({ name: "duplicate" }), tool({ name: "duplicate" })],
      write: (text) => { output += text; },
    });
    expect(code).toBe(1);
    expect(output).toContain("duplicate_tool_name");
    expect(output).toContain("tool surface audit: FAILED");
  });

  test("rejects unknown options with usage exit code", () => {
    let output = "";
    expect(runToolAudit(["--bogus"], { write: (text) => { output += text; } })).toBe(2);
    expect(output).toContain("unknown audit-tools option");
    expect(output).toContain("usage: tenjin audit-tools");
  });
});
