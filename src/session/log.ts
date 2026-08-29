import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionEvent } from "./events";
import { emit } from "../gateway/events";

export interface SessionSummary {
  id: string;
  path: string;
  mtimeMs: number;
  preview: string;
  parentId?: string;
}

export interface CorruptLine {
  path: string;
  line: number;
}

const DEFAULT_PREVIEW = "(no user messages)";

interface SessionMeta {
  id: string;
  preview: string;
  parentId?: string;
  mtimeMs: number;
}

export class SessionLog {
  private constructor(
    readonly path: string,
    readonly id: string,
    private readonly metaPath: string,
  ) {}

  static create(dir: string): SessionLog {
    mkdirSync(dir, { recursive: true });
    const id = newId();
    const path = join(dir, `${id}.jsonl`);
    return new SessionLog(path, id, metaPathFor(path));
  }

  static open(path: string): SessionLog {
    if (!existsSync(path)) throw new Error(`session not found: ${path}`);
    return new SessionLog(path, idFromPath(path), metaPathFor(path));
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
    forked.seedPreviewFrom(events.slice(0, count));
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
      const metaPath = metaPathFor(path);
      const meta = readMeta(metaPath);
      let preview: string;
      let parentId: string | undefined;
      if (meta) {
        preview = meta.preview;
        parentId = meta.parentId;
      } else {
        const scanned = scanMeta(path);
        preview = scanned.preview;
        parentId = scanned.parentId;
      }
      summaries.push({
        id: idFromPath(path),
        path,
        mtimeMs,
        preview,
        parentId,
      });
    }
    return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  append(event: SessionEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
    this.updateMeta(event);
    if (event.t === "session_start") {
      emit("session.event", { id: this.id, t: "session_start" });
    }
  }

  events(): SessionEvent[] {
    return resolveChain(this);
  }

  readEvents(): { events: SessionEvent[]; corrupt: CorruptLine[] } {
    if (!existsSync(this.path)) return { events: [], corrupt: [] };
    const events: SessionEvent[] = [];
    const corrupt: CorruptLine[] = [];
    const lines = readFileSync(this.path, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        corrupt.push({ path: this.path, line: i + 1 });
      }
    }
    return { events, corrupt };
  }

  private updateMeta(event: SessionEvent): void {
    // Only a first user message (preview) or a forked session_start (parentId)
    // can change the sidecar meta. Everything else (assistant/tool/usage
    // events) touches nothing, so skip the read/stat/write disk I/O entirely
    // instead of doing 4+ sync ops per appended event (#317).
    const mayChange =
      (event.t === "message" && event.role === "user") ||
      (event.t === "session_start" && event.parent !== undefined);
    if (!mayChange) return;

    const meta = readMeta(this.metaPath) ?? {
      id: this.id,
      preview: DEFAULT_PREVIEW,
      mtimeMs: 0,
    };
    let changed = false;
    if (event.t === "session_start" && event.parent && meta.parentId === undefined) {
      meta.parentId = event.parent.id;
      changed = true;
    }
    if (
      event.t === "message" &&
      event.role === "user" &&
      meta.preview === DEFAULT_PREVIEW
    ) {
      const text = typeof event.content === "string" ? event.content : "[blocks]";
      meta.preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      changed = true;
    }
    // Nothing changed → no stat, no write.
    if (!changed) return;
    try {
      meta.mtimeMs = statSync(this.path).mtimeMs;
    } catch {
      // path unreadable; keep previous value
    }
    this.writeMeta(meta);
  }

  private seedPreviewFrom(events: SessionEvent[]): void {
    const meta = readMeta(this.metaPath) ?? {
      id: this.id,
      preview: DEFAULT_PREVIEW,
      mtimeMs: 0,
    };
    if (meta.preview !== DEFAULT_PREVIEW) return;
    for (const event of events) {
      if (event.t !== "message" || event.role !== "user") continue;
      const text = typeof event.content === "string" ? event.content : "[blocks]";
      meta.preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      break;
    }
    this.writeMeta(meta);
  }

  private writeMeta(meta: SessionMeta): void {
    try {
      writeFileSync(this.metaPath, `${JSON.stringify(meta)}\n`);
    } catch {
      // best-effort index
    }
  }
}

function newId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
  // Four hex characters only provide 16 bits of entropy. At soak-test volume
  // that made birthday collisions common enough for a later session to reuse
  // an existing log path. Keep IDs readable while giving the random suffix a
  // full 64 bits of entropy.
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  return `${ts}-${suffix}`;
}

export function idFromPath(filePath: string): string {
  return basename(filePath.replace(/\\/g, "/")).replace(/\.jsonl$/, "");
}

/** One node in a session's ancestry chain (#131). */
export interface SessionLineageNode {
  id: string;
  /** The session this one was forked from, or null for a root session. */
  parentId: string | null;
  /** How many events were inherited from the parent (null for a root). */
  uptoEvent: number | null;
  isFork: boolean;
  /** Compression (context-elision) events recorded in THIS session only. */
  compressionCount: number;
  compressions: Array<{
    beforeTokens: number;
    afterTokens: number;
    elidedTokens: number;
    ts: string;
  }>;
}

/**
 * Walk a session's ancestry by following each `session_start.parent` id from
 * the requested session up to the root. The returned array is newest-first
 * (the requested session, then its parent, ...). Each node's compression
 * events are those recorded in that session's own log — inherited events are
 * not repeated — so it is possible to see where each context-elision happened.
 * Cycle-safe: a malformed self-referential chain is truncated.
 */
export function sessionLineage(dir: string, idPrefix: string): SessionLineageNode[] {
  const lineage: SessionLineageNode[] = [];
  const seen = new Set<string>();
  let current: SessionLog | null = SessionLog.resolve(dir, idPrefix);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const events = current.readEvents().events;
    const start = events.find(
      (e): e is Extract<SessionEvent, { t: "session_start" }> => e.t === "session_start",
    );
    const parentId = start?.parent?.id ?? null;
    const compressions = events
      .filter((e): e is Extract<SessionEvent, { t: "compression" }> => e.t === "compression")
      .map((e) => ({
        beforeTokens: e.beforeTokens,
        afterTokens: e.afterTokens,
        elidedTokens: e.elidedTokens,
        ts: e.ts,
      }));
    lineage.push({
      id: current.id,
      parentId,
      uptoEvent: start?.parent?.uptoEvent ?? null,
      isFork: parentId !== null,
      compressionCount: compressions.length,
      compressions,
    });
    if (!parentId) break;
    let parent: SessionLog;
    try {
      parent = SessionLog.resolve(dir, parentId);
    } catch {
      break; // parent missing → ancestry ends here rather than throwing
    }
    current = parent;
  }
  return lineage;
}

function resolveChain(log: SessionLog, seen: Set<string> = new Set()): SessionEvent[] {
  const local = log.readEvents().events;
  if (seen.has(log.id)) return local;
  seen.add(log.id);

  const start = local.find((e) => e.t === "session_start");
  const parent = start?.t === "session_start" ? start.parent : undefined;
  if (!start || start.t !== "session_start" || !parent) return local;

  let parentLog: SessionLog;
  try {
    parentLog = SessionLog.resolve(dirname(log.path), parent.id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`session ${log.id} parent "${parent.id}" not found (${detail})`);
  }
  const inherited = resolveChain(parentLog, seen)
    .slice(0, parent.uptoEvent)
    .filter((e) => e.t !== "session_start");

  const own = local.filter((e) => e !== start);
  return [start, ...inherited, ...own];
}

function metaPathFor(path: string): string {
  return path.replace(/\.jsonl$/, ".meta.json");
}

function readMeta(metaPath: string): SessionMeta | null {
  try {
    if (!existsSync(metaPath)) return null;
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Partial<SessionMeta>;
    return {
      id: parsed.id ?? "",
      preview: typeof parsed.preview === "string" ? parsed.preview : DEFAULT_PREVIEW,
      parentId: parsed.parentId,
      mtimeMs: parsed.mtimeMs ?? 0,
    };
  } catch {
    return null;
  }
}

function scanMeta(path: string): { preview: string; parentId?: string } {
  let preview = DEFAULT_PREVIEW;
  let parentId: string | undefined;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SessionEvent;
        if (e.t === "session_start" && e.parent && parentId === undefined) {
          parentId = e.parent.id;
        }
        if (preview === DEFAULT_PREVIEW && e.t === "message" && e.role === "user") {
          const text = typeof e.content === "string" ? e.content : "[blocks]";
          preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        }
        if (preview !== DEFAULT_PREVIEW && parentId !== undefined) break;
      } catch {
        continue;
      }
    }
  } catch {
    // unreadable
  }
  return { preview, parentId };
}
