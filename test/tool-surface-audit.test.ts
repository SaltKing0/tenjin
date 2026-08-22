import { describe, test, expect } from "bun:test";
import type { ToolDef } from "../src/tools/registry";
import {
  auditToolSurface,
  auditErrors,
  isCleanToolSurface,
} from "../src/tools/audit";
import { readTool } from "../src/tools/read";
import { globTool } from "../src/tools/glob";
import { grepTool } from "../src/tools/grep";
import { writeTool } from "../src/tools/write";
import { editTool } from "../src/tools/edit";
import { applyPatchTool } from "../src/tools/apply-patch";
import { bashTool } from "../src/tools/bash";
import { webFetchTool } from "../src/tools/web-fetch";
import { createWebSearchTool } from "../src/tools/web-search";

function tool(over: Partial<ToolDef> & { name: string }): ToolDef {
  return {
    group: "read",
    description: "A sufficiently detailed description for this tool.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => "ok",
    ...over,
  };
}

/** The always-registered core tool surface (mirrors the runtime's base set). */
const CORE_TOOLS: ToolDef[] = [
  readTool,
  globTool,
  grepTool,
  writeTool,
  editTool,
  applyPatchTool,
  bashTool,
  webFetchTool,
  createWebSearchTool(),
];

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
  test("the always-registered core tools are clean (no duplicate/ambiguous/empty)", () => {
    const errors = auditErrors(CORE_TOOLS);
    expect(errors).toEqual([]);
    expect(isCleanToolSurface(CORE_TOOLS)).toBe(true);
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
