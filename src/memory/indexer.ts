import { SessionLog } from "../session/log";
import type {
  ContentBlock,
} from "../provider/types";
import type { EmbeddingProvider } from "../provider/embeddings";
import {
  appendChunks,
  indexedSessionIds,
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
  const done = store ? store.sessionsIndexed() : indexedSessionIds(loadChunks(vectorsFile!));

  const logs = SessionLog.list(opts.sessionsDirPath)
    .filter((s) => !done.has(s.id))
    .slice(0, opts.limit ?? 10)
    .map((s) => SessionLog.open(s.path));

  for (const log of logs) {
    try {
      const texts = extractIndexableTexts(log.events());
      if (texts.length === 0) continue;
      const vectors = await opts.embeddings.embed(texts.map((t) => t.text));
      const created = new Date().toISOString();
      const embedModel = opts.embeddings.model;
      const chunks: VectorChunk[] = texts.map((t, i) => {
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
      report.indexed.push(log.id);
      report.chunks += chunks.length;
    } catch (e) {
      report.errors.push(`${log.id}: ${(e as Error).message}`);
    }
  }

  if (store) store.flush();
  return report;
}
