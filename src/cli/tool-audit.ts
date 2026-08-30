import { stdout } from "node:process";
import {
  auditToolSurface,
  type AuditFinding,
} from "../tools/audit";
import { applyPatchTool } from "../tools/apply-patch";
import { bashTool } from "../tools/bash";
import { editTool } from "../tools/edit";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { readTool } from "../tools/read";
import type { ToolDef } from "../tools/registry";
import { webFetchTool } from "../tools/web-fetch";
import { createWebSearchTool } from "../tools/web-search";
import { writeTool } from "../tools/write";

/**
 * The baseline product tool surface. Dynamic integrations (MCP, memory and
 * bot-only tools) are intentionally excluded: this command is safe to run in
 * a fresh installation without config, credentials or an external process.
 */
export function defaultToolAuditSurface(): ToolDef[] {
  return [
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
}

export interface ToolAuditReport {
  schemaVersion: 1;
  toolCount: number;
  ok: boolean;
  errors: number;
  warnings: number;
  findings: AuditFinding[];
}

export const TOOL_AUDIT_USAGE =
  "usage: tenjin audit-tools [--json]\n" +
  "  Check the built-in tool API for duplicate names, ambiguous parameters and quality warnings.\n" +
  "  --json  emit a stable, machine-readable report\n";

export function buildToolAuditReport(defs: ToolDef[]): ToolAuditReport {
  const findings = auditToolSurface(defs);
  const errors = findings.filter((finding) => finding.severity === "error").length;
  return {
    schemaVersion: 1,
    toolCount: defs.length,
    ok: errors === 0,
    errors,
    warnings: findings.length - errors,
    findings,
  };
}

export function renderToolAuditReport(report: ToolAuditReport): string {
  const lines = [
    `tool surface: ${report.toolCount} tool(s), ${report.errors} error(s), ${report.warnings} warning(s)`,
  ];
  for (const finding of report.findings) {
    const param = finding.param ? ` param=${finding.param}` : "";
    lines.push(`  ${finding.severity.toUpperCase()} ${finding.code} tool=${finding.tool}${param}: ${finding.detail}`);
  }
  lines.push(`tool surface audit: ${report.ok ? "OK" : "FAILED"}`);
  return lines.join("\n");
}

export interface ToolAuditDeps {
  write?: (text: string) => void;
  tools?: ToolDef[];
}

/** Run the configuration-free product command. Exit 1 only for audit errors. */
export function runToolAudit(args: string[], deps: ToolAuditDeps = {}): number {
  const write = deps.write ?? ((text: string) => stdout.write(text));
  if (args.includes("--help") || args.includes("-h")) {
    write(TOOL_AUDIT_USAGE);
    return 0;
  }
  const json = args.includes("--json");
  const invalid = args.filter((arg) => arg !== "--json");
  if (invalid.length) {
    write(`unknown audit-tools option ${JSON.stringify(invalid[0])}\n${TOOL_AUDIT_USAGE}`);
    return 2;
  }
  const report = buildToolAuditReport(deps.tools ?? defaultToolAuditSurface());
  write(json ? `${JSON.stringify(report)}\n` : `${renderToolAuditReport(report)}\n`);
  return report.ok ? 0 : 1;
}
