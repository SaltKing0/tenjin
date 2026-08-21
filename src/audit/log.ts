import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AuditKind =
  | "tool_block"
  | "approval"
  | "write_exec"
  | "budget_halt"
  | "channel_reject"
  | "delegation"
  | "gateway_msg"
  | "data_delete";

export interface AuditEvent {
  ts: string;
  kind: AuditKind;
  actor: string;
  bot?: string;
  detail: string;
}

export function auditPath(home: string): string {
  return join(home, "audit.jsonl");
}

export class AuditLog {
  constructor(readonly path: string) {}

  append(kind: AuditKind, actor: string, detail: string, bot?: string): void {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      kind,
      actor,
      ...(bot ? { bot } : {}),
      detail,
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  query(
    opts: { tail?: number; bot?: string; kind?: AuditKind } = {},
  ): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    const events: AuditEvent[] = [];
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (opts.bot && e.bot !== opts.bot) continue;
        if (opts.kind && e.kind !== opts.kind) continue;
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
