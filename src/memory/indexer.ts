import { SessionLog } from "../session/log";
import type {
  ContentBlock,
} from "../provider/types";
import type { EmbeddingProvider } from "../provider/embeddings";
import {
  appendChunks,
  loadChunks,
  vectorsFilePath,
  type VectorChunk,
  type VectorStore,
} from "./vector-store";

const MAX_CHUNK_CHARS = 2000;

export interface IndexableText {
  eventIdx: number;
  role: "user" | "assistant";
  text: string;
}

export function extractIndexableTexts(events: import("../session/events").SessionEvent[]): IndexableText[] {
  const out: IndexableText[] = [];
  events.forEach((e, idx) => {
    if (e.t !== "message") return;
    if (typeof e.content === "string") {
      const text = e.content.trim();
      if (text) out.push({ eventIdx: idx, role: e.role, text: text.slice(0, MAX_CHUNK_CHARS) });
      return;
    }
    if (e.role !== "assistant") return;
    const text = e.content
      .map((b: ContentBlock) => (b.type === "text" ? b.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) out.push({ eventIdx: idx, role: "assistant", text: text.slice(0, MAX_CHUNK_CHARS) });
  });
  return out;
}

export interface IndexReport {
  indexed: string[];
  chunks: number;
  errors: string[];
}

export async function indexPendingSessions(opts: {
  sessionsDirPath: string;
  memoryDirPath: string;
  projectPath: string;
  embeddings: EmbeddingProvider;
  limit?: number;
  /** Optional in-memory index; when provided it is used for session dedup and
   *  buffered writes instead of re-loading the whole chunk log each pass. */
  store?: VectorStore;
}): Promise<IndexReport> {
  const report: IndexReport = { indexed: [], chunks: 0, errors: [] };
  const store = opts.store;
  // `vectorsFile` is only used on the legacy (store-less) path.
  const vectorsFile = store ? null : vectorsFilePath(opts.memoryDirPath);
  // #310: dedup by chunk id (`sessionId:eventIdx`) instead of whole sessions.
  // Session logs are append-only and can grow, so a session that is already
  // partially indexed must get its NEW messages indexed too, not be skipped
  // forever because its session id is in the done set.
  const existing = new Set<string>();
  if (store) {
    for (const id of store.chunkIds()) existing.add(id);
  } else {
    for (const c of loadChunks(vectorsFile!)) existing.add(c.id);
  }

  const limit = opts.limit ?? 10;
  let used = 0;
  // Most recently modified sessions first — the ones most likely to have
  // unindexed growth — while fully-indexed sessions are skipped cheaply.
  const logs = SessionLog.list(opts.sessionsDirPath)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((s) => SessionLog.open(s.path));

  for (const log of logs) {
    if (used >= limit) break;
    try {
      // Only events whose chunk id isn't already indexed (growing sessions
      // yield their new events here; unchanged sessions yield nothing).
      const newTexts = extractIndexableTexts(log.events()).filter(
        (t) => !existing.has(`${log.id}:${t.eventIdx}`),
      );
      if (newTexts.length === 0) continue;
      const vectors = await opts.embeddings.embed(newTexts.map((t) => t.text));
      const created = new Date().toISOString();
      const embedModel = opts.embeddings.model;
      const chunks: VectorChunk[] = newTexts.map((t, i) => {
        const embedding = vectors[i] ?? [];
        return {
          id: `${log.id}:${t.eventIdx}`,
          sessionId: log.id,
          projectPath: opts.projectPath,
          role: t.role,
          text: t.text,
          embedding,
          created,
          embedModel,
          embedDim: embedding.length,
        };
      });
      if (store) {
        store.addAll(chunks);
      } else {
        appendChunks(vectorsFile!, chunks);
      }
      // Mark as indexed only after the write succeeded, so a session whose
      // embed failed this pass is retried next pass instead of being lost.
      for (const t of newTexts) existing.add(`${log.id}:${t.eventIdx}`);
      report.indexed.push(log.id);
      report.chunks += chunks.length;
      used++;
    } catch (e) {
      report.errors.push(`${log.id}: ${(e as Error).message}`);
    }
  }

  if (store) store.flush();
  return report;
}
