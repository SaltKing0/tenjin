import { existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";

export interface VectorChunk {
  id: string;
  sessionId: string;
  projectPath: string;
  role: "user" | "assistant";
  text: string;
  embedding: number[];
  created: string;
  /** Embedding model used to produce `embedding` (optional; legacy chunks may lack it). */
  embedModel?: string;
  /** Dimension of `embedding` (optional; derived from `embedding.length` when absent). */
  embedDim?: number;
}

export function appendChunks(path: string, chunks: VectorChunk[]): void {
  if (chunks.length === 0) return;
  const lines = chunks.map((c) => JSON.stringify(c)).join("\n");
  appendFileSync(path, `${lines}\n`);
}

export function loadChunks(path: string): VectorChunk[] {
  if (!existsSync(path)) return [];
  const chunks: VectorChunk[] = [];
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as VectorChunk;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        Array.isArray(parsed.embedding) &&
        typeof parsed.text === "string"
      ) {
        chunks.push(parsed);
      }
    } catch {
      // skip corrupted line
    }
  }
  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SearchOptions {
  query: number[];
  topK?: number;
  projectPath?: string;
  minScore?: number;
  /** Expected embedding model; chunks whose stored `embedModel` differs are skipped. */
  embedModel?: string;
}

export interface SearchHit {
  chunk: VectorChunk;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Number of chunks skipped because their embedding model/dimension mismatched the query. */
  skipped: number;
}

export function searchChunks(chunks: Iterable<VectorChunk>, opts: SearchOptions): SearchResult {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  const queryDim = opts.query.length;
  const hits: SearchHit[] = [];
  let skipped = 0;
  for (const chunk of chunks) {
    if (opts.projectPath && chunk.projectPath !== opts.projectPath) continue;
    const chunkDim = chunk.embedDim ?? chunk.embedding.length;
    if (chunkDim !== queryDim || (opts.embedModel && chunk.embedModel && chunk.embedModel !== opts.embedModel)) {
      skipped++;
      continue;
    }
    const score = cosineSimilarity(opts.query, chunk.embedding);
    if (score < minScore) continue;
    hits.push({ chunk, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, topK), skipped };
}

/** Yield items from several arrays in order without allocating a combined copy. #310 */
function* concatIter<T>(...arrays: Array<T[]>): Iterable<T> {
  for (const a of arrays) for (const x of a) yield x;
}

export function indexedSessionIds(chunks: VectorChunk[]): Set<string> {
  return new Set(chunks.map((c) => c.sessionId));
}

/** Standard location of the chunk log inside a memory directory. */
export function vectorsFilePath(memoryDirPath: string): string {
  return `${memoryDirPath}/vectors.jsonl`;
}

/** Number of buffered chunks before a `VectorStore` flushes to disk on its own. */
export const DEFAULT_FLUSH_THRESHOLD = 32;

export interface CompactReport {
  /** Chunks (buffered + persisted) before compaction. */
  before: number;
  /** Chunks after removing duplicates / stale revisions. */
  after: number;
  /** `before - after`. */
  removed: number;
  /** Whether the underlying file was rewritten (false when nothing was removed). */
  rewritten: boolean;
}

/**
 * In-memory index over the chunk log. The file is read once at construction
 * (boot); new chunks are buffered and flushed in batches instead of rewriting
 * the whole file per event. `search` runs against the in-memory index.
 *
 * `search` uses a cheap dimension-blocking heuristic: only chunks whose
 * effective embedding dimension matches the query are scored, and everything
 * else is counted as `skipped` — observably identical to searching the whole
 * log, but it avoids scoring every chunk when many models/dimensions coexist.
 */
export class VectorStore {
  private chunks: VectorChunk[];
  private buffer: VectorChunk[] = [];
  private readonly flushThreshold: number;

  constructor(
    private readonly file: string,
    chunks: VectorChunk[] = [],
    flushThreshold: number = DEFAULT_FLUSH_THRESHOLD,
  ) {
    this.chunks = chunks;
    this.flushThreshold = flushThreshold;
  }

  static open(file: string, flushThreshold: number = DEFAULT_FLUSH_THRESHOLD): VectorStore {
    return new VectorStore(file, loadChunks(file), flushThreshold);
  }

  /** Total buffered + persisted chunks. */
  get size(): number {
    return this.chunks.length + this.buffer.length;
  }

  /** Distinct session ids present in the index (buffered + persisted). */
  sessionsIndexed(): Set<string> {
    return indexedSessionIds(this.chunks.concat(this.buffer));
  }

  /** All chunk ids currently in the index (buffered + persisted). #310 */
  chunkIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.chunks) ids.add(c.id);
    for (const c of this.buffer) ids.add(c.id);
    return ids;
  }

  /** Buffer one chunk; flushes automatically once the buffer threshold is reached. */
  add(chunk: VectorChunk, flush = false): void {
    this.buffer.push(chunk);
    if (flush || this.buffer.length >= this.flushThreshold) this.flush();
  }

  /** Buffer many chunks, auto-flushing on threshold (or once when `flush`). */
  addAll(chunks: VectorChunk[], flush = false): void {
    for (const c of chunks) this.add(c, flush);
  }

  /** Append any buffered chunks to the file once. No-op when the buffer is empty. */
  flush(): void {
    if (this.buffer.length === 0) return;
    appendChunks(this.file, this.buffer);
    this.chunks.push(...this.buffer);
    this.buffer = [];
  }

  /**
   * Search the in-memory index (buffered + persisted) with dimension/embedModel
   * blocking. #310: iterates both arrays directly (no O(n) `concat` copy per
   * retrieval) and lets `searchChunks` do the blocking + skipped accounting
   * exactly once.
   */
  search(opts: SearchOptions): SearchResult {
    return searchChunks(concatIter(this.chunks, this.buffer), opts);
  }

  /**
   * Remove duplicate / stale-revision chunks: per id the most recent `created`
   * wins (later file position breaks ties). Rewrites the file only when
   * something was actually removed, and resets the in-memory index + buffer.
   */
  compact(): CompactReport {
    const all = this.chunks.concat(this.buffer);
    const before = all.length;
    const byId = new Map<string, VectorChunk>();
    for (const c of all) {
      const existing = byId.get(c.id);
      if (!existing || c.created >= existing.created) byId.set(c.id, c);
    }
    const compacted = all.filter((c) => byId.get(c.id) === c);
    const removed = before - compacted.length;
    if (removed > 0) {
      const body = compacted.map((c) => JSON.stringify(c)).join("\n");
      writeFileSync(this.file, compacted.length > 0 ? `${body}\n` : "");
    }
    this.chunks = compacted;
    this.buffer = [];
    return { before, after: compacted.length, removed, rewritten: removed > 0 };
  }
}
