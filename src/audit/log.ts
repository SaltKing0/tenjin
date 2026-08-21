import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Redactor } from "../security/redact";

export type AuditKind =
  | "tool_block"
  | "approval"
  | "write_exec"
  | "budget_halt"
  | "channel_reject"
  | "delegation"
  | "gateway_msg"
  | "data_delete"
  | "settings_changed"
  | "guard_disabled";

export interface AuditEvent {
  ts: string;
  kind: AuditKind;
  actor: string;
  bot?: string;
  detail: string;
}

export interface AuditQuery {
  tail?: number;
  bot?: string;
  kind?: AuditKind;
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Inclusive upper bound, epoch ms. */
  to?: number;
}

export function auditPath(home: string): string {
  return join(home, "audit.jsonl");
}

export class AuditLog {
  constructor(
    readonly path: string,
    readonly redactor: Redactor = new Redactor(),
  ) {}

  append(kind: AuditKind, actor: string, detail: string, bot?: string): void {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      kind,
      actor,
      ...(bot ? { bot } : {}),
      detail: this.redactor.redact(detail),
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  query(opts: AuditQuery = {}): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    const windowed = opts.from !== undefined || opts.to !== undefined;
    const events: AuditEvent[] = [];
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (opts.bot && e.bot !== opts.bot) continue;
        if (opts.kind && e.kind !== opts.kind) continue;
        if (windowed) {
          const ts = Date.parse(e.ts);
          if (!Number.isFinite(ts)) continue;
          if (opts.from !== undefined && ts < opts.from) continue;
          if (opts.to !== undefined && ts > opts.to) continue;
        }
        events.push(e);
      } catch {
        // skip corrupted
      }
    }
    return opts.tail ? events.slice(-opts.tail) : events;
  }
}

export function formatAudit(events: AuditEvent[]): string {
  if (events.length === 0) return "(no audit events)";
  return events
    .map((e) => {
      const ts = e.ts.slice(5, 16).replace("T", " ");
      const bot = e.bot ? ` [${e.bot}]` : "";
      return `${ts} ${e.kind.padEnd(14)} ${e.actor}${bot}: ${e.detail}`;
    })
    .join("\n");
}

export function formatAuditMarkdown(events: AuditEvent[]): string {
  const lines = ["# Audit export", "", `- events: ${events.length}`, ""];
  if (events.length === 0) {
    lines.push("No audit events in this window.", "");
    return lines.join("\n");
  }
  for (const e of events) {
    lines.push(`## ${e.ts} - ${e.kind}`, "");
    lines.push(`- actor: ${e.actor}`);
    if (e.bot) lines.push(`- bot: ${e.bot}`);
    lines.push(`- detail: ${e.detail}`, "");
  }
  return lines.join("\n");
}
