import { existsSync, appendFileSync, readFileSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { Redactor } from "../security/redact";

export type AuditKind =
  | "tool_block"
  | "approval"
  | "write_exec"
  | "budget_halt"
  | "budget_exceeded"
  | "channel_reject"
  | "delegation"
  | "gateway_msg"
  | "data_delete"
  | "settings_changed"
  | "guard_disabled"
  | "prompt_injection"
  | "transcribe"
  | "consolidation";

export const AUDIT_KINDS: readonly AuditKind[] = [
  "tool_block",
  "approval",
  "write_exec",
  "budget_halt",
  "budget_exceeded",
  "channel_reject",
  "delegation",
  "gateway_msg",
  "data_delete",
  "settings_changed",
  "guard_disabled",
  "prompt_injection",
  "transcribe",
  "consolidation",
];

export interface AuditEvent {
  ts: string;
  kind: AuditKind;
  actor: string;
  bot?: string;
  detail: string;
  /** Optional correlation id linking related audit events (e.g. a delegation run). */
  correlationId?: string;
}

export interface AuditQuery {
  tail?: number;
  bot?: string;
  kind?: AuditKind;
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Inclusive upper bound, epoch ms. */
  to?: number;
  correlationId?: string;
}

export function auditPath(home: string): string {
  return join(home, "audit.jsonl");
}

/** Bytes read per backward chunk when tailing an audit log from its end (#317). */
const TAIL_CHUNK_BYTES = 64 * 1024;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Return the last `n` complete non-blank lines of a JSONL file in file order by
 * reading only from the end, instead of parsing the whole (unbounded) file. The
 * read window grows (rarely) when a single chunk does not contain `n` lines
 * (very long lines / a large tail); a file smaller than the window is read whole.
 */
function readTailLines(path: string, n: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    let pos = size;
    let text = "";
    while (pos > 0 && countNewlines(text) < n) {
      const chunkLen = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= chunkLen;
      const buf = Buffer.alloc(chunkLen);
      readSync(fd, buf, 0, chunkLen, pos);
      text = buf.toString("utf8") + text;
    }
    // Our window starts at a line boundary only when it begins right after a
    // newline (or at the file start); otherwise its first element is a partial
    // line that must be dropped, even when a chunk boundary falls on a newline.
    let startsAtLineStart = pos === 0;
    if (pos > 0) {
      const probe = Buffer.alloc(1);
      readSync(fd, probe, 0, 1, pos - 1);
      startsAtLineStart = probe[0] === 10; // '\n'
    }
    const lines = text.split("\n");
    if (!startsAtLineStart) lines.shift();
    return lines.filter((l) => l.trim() !== "").slice(-n);
  } finally {
    closeSync(fd);
  }
}

export class AuditLog {
  constructor(
    readonly path: string,
    readonly redactor: Redactor = new Redactor(),
  ) {}

  append(
    kind: AuditKind,
    actor: string,
    detail: string,
    bot?: string,
    correlationId?: string,
  ): void {
    const event: AuditEvent = {
      ts: new Date().toISOString(),
      kind,
      actor,
      ...(bot ? { bot } : {}),
      ...(correlationId ? { correlationId } : {}),
      detail: this.redactor.redact(detail),
    };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  query(opts: AuditQuery = {}): AuditEvent[] {
    if (!existsSync(this.path)) return [];
    const windowed = opts.from !== undefined || opts.to !== undefined;
    const hasFilters =
      opts.bot !== undefined ||
      opts.kind !== undefined ||
      opts.correlationId !== undefined ||
      windowed;

    // Hot path: a bare `tail: N` reads only the last N lines from the file end
    // instead of parsing the whole unbounded audit.jsonl. Filtered queries still
    // need the whole file to keep last-N-matching semantics.
    const lines =
      opts.tail !== undefined && !hasFilters
        ? readTailLines(this.path, opts.tail)
        : readFileSync(this.path, "utf8").split("\n");

    const events: AuditEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEvent;
        if (opts.bot && e.bot !== opts.bot) continue;
        if (opts.kind && e.kind !== opts.kind) continue;
        if (opts.correlationId && e.correlationId !== opts.correlationId) continue;
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
