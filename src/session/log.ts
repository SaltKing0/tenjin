import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionEvent } from "./events";

export interface SessionSummary {
  id: string;
  path: string;
  mtimeMs: number;
  preview: string;
  parentId?: string;
}

export class SessionLog {
  private constructor(
    readonly path: string,
    readonly id: string,
  ) {}

  static create(dir: string): SessionLog {
    mkdirSync(dir, { recursive: true });
    const id = newId();
    return new SessionLog(join(dir, `${id}.jsonl`), id);
  }

  static open(path: string): SessionLog {
    if (!existsSync(path)) throw new Error(`session not found: ${path}`);
    return new SessionLog(path, idFromPath(path));
  }

  static resolve(dir: string, idPrefix: string): SessionLog {
    const exact = join(dir, `${idPrefix}.jsonl`);
    if (existsSync(exact)) return SessionLog.open(exact);
    const match = readdirSync(dir).find(
      (f) => f.endsWith(".jsonl") && f.startsWith(idPrefix),
    );
    if (!match) {
      throw new Error(`no session matching "${idPrefix}" in ${dir}`);
    }
    return SessionLog.open(join(dir, match));
  }

  static fork(sourceDir: string, sourceIdPrefix: string, uptoEvent?: number): SessionLog {
    const source = SessionLog.resolve(sourceDir, sourceIdPrefix);
    const events = source.events();
    const count =
      uptoEvent === undefined
        ? events.length
        : Math.max(0, Math.min(uptoEvent, events.length));

    const forked = SessionLog.create(sourceDir);
    const sourceStart = events.find((e) => e.t === "session_start");
    const start = sourceStart?.t === "session_start" ? sourceStart : undefined;

    forked.append({
      t: "session_start",
      id: forked.id,
      ts: new Date().toISOString(),
      provider: start?.provider ?? "",
      model: start?.model ?? "",
      parent: { id: source.id, uptoEvent: count },
    });
    for (const event of events.slice(0, count)) {
      if (event.t === "session_start") continue;
      forked.append(event);
    }
    return forked;
  }

  static list(dir: string): SessionSummary[] {
    if (!existsSync(dir)) return [];
    const summaries: SessionSummary[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(dir, file);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const meta = scanMeta(path);
      summaries.push({
        id: idFromPath(path),
        path,
        mtimeMs,
        preview: meta.preview,
        parentId: meta.parentId,
      });
    }
    return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  append(event: SessionEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  events(): SessionEvent[] {
    if (!existsSync(this.path)) return [];
    const events: SessionEvent[] = [];
    const raw = readFileSync(this.path, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // skip corrupted line
      }
    }
    return events;
  }
}

function newId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  return `${ts}-${randomUUID().slice(0, 4)}`;
}

function idFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.jsonl$/, "");
}

function scanMeta(path: string): { preview: string; parentId?: string } {
  let preview = "(no user messages)";
  let parentId: string | undefined;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SessionEvent;
        if (e.t === "session_start" && e.parent && parentId === undefined) {
          parentId = e.parent.id;
        }
        if (preview === "(no user messages)" && e.t === "message" && e.role === "user") {
          const text = typeof e.content === "string" ? e.content : "[blocks]";
          preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        }
        if (preview !== "(no user messages)" && parentId !== undefined) break;
      } catch {
        continue;
      }
    }
  } catch {
    // unreadable
  }
  return { preview, parentId };
}
