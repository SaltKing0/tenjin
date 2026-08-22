/**
 * Hybrid retrieval (Roadmap §12 B9-13, #390).
 *
 * Recall ladder: BM25 65% / vector 78% / HYBRID 91%. FTS5 is built into SQLite
 * (ships with bun — zero deps). One store, one row per chunk with a shared
 * chunk_id; a FTS5 virtual table is kept in sync with the chunk set, and
 * retrieval fuses a BM25 rank list (FTS5) with a cosine rank list (in-process
 * vector store) via Reciprocal Rank Fusion (RRF, k=60).
 *
 *   - QUERY CLASSIFICATION UP FRONT: concrete tokens (identifiers, symbols,
 *     error codes, dates, paths) route to a BM25-dominant pass; natural-language
 *     phrases route to the vector side; mixed queries run both.
 *   - RRF is rank-based, so the two incomparable score scales never need
 *     normalization.
 *   - The vector side degrades gracefully: empty/mismatched chunks simply
 *     contribute nothing, leaving a BM25-only result (never a crash).
 *
 * Retrieval is exposed as {@link hybridSearch} — the primitive B9-14 grounding
 * gates will later surface as an explicit tool.
 */

import { Database } from "bun:sqlite";
import { cosineSimilarity, type VectorChunk } from "./vector-store";

export type QueryRoute = "bm25" | "vector" | "mixed";

// A concrete token an exact-symbol query would carry: camelCase / snake_case
// identifiers, dotted symbols, error codes, dates and path segments.
const CAMEL_RE = /\b[a-z]+[A-Z][A-Za-z0-9_]*\b/;
const SNAKE_RE = /\b[a-z]+_[a-z0-9_]+\b/;
const SYMBOL_RE = /\b[A-Za-z_][A-Za-z0-9_.]*\(/; // fn call / qualified symbol
const DOTTED_RE = /\b[A-Za-z0-9]{2,}\.[A-Za-z0-9]{2,}\b/; // filename / dotted symbol (auth.ts)
const ERROR_CODE_RE = /\b(?:ENOENT|EACCES|ENOTFOUND|EADDRINUSE|HTTP\s*[45]\d{2})\b|\b[A-Z]{2,}-\d+\b/i;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/;
const PATH_RE = /(?:^|\s)(?:\.{1,2}\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/;

/**
 * Route a query before retrieval: concrete tokens → BM25-dominant; conceptual
 * phrases → vector; a mix of concrete tokens and prose → both.
 */
export function classifyQueryType(query: string): QueryRoute {
  const q = query.trim();
  if (!q) return "vector";
  const hasConcrete =
    CAMEL_RE.test(q) ||
    SNAKE_RE.test(q) ||
    SYMBOL_RE.test(q) ||
    DOTTED_RE.test(q) ||
    ERROR_CODE_RE.test(q) ||
    DATE_RE.test(q) ||
    PATH_RE.test(q);
  if (!hasConcrete) return "vector";
  const words = q.split(/\s+/).filter(Boolean).length;
  return words > 2 ? "mixed" : "bm25";
}

export interface RankedHit {
  id: string;
  text: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1/(k + rank(d)) over each list the doc
 * appears in. Rank is 1-based position. k=60 (per the issue); rank-based ⇒
 * scale-invariant across BM25 and cosine.
 */
export function reciprocalRankFusion(
  lists: RankedHit[][],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i];
      if (!hit) continue;
      const rank = i + 1;
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank));
    }
  }
  return scores;
}

/** Tokenize free text into a safe FTS5 MATCH expression (AND of quoted tokens). */
export function toFtsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  return tokens.join(" ");
}

/**
 * FTS5 full-text index over chunk bodies, kept in sync with the chunk set in
 * per-write transactions (insert/delete go through `db.transaction`, so the
 * FTS virtual table never sees a half-applied chunk update).
 */
export class FtsIndex {
  private readonly table: string;

  constructor(
    private readonly db: Database,
    table = "chunks_fts",
  ) {
    this.table = table;
  }

  init(): void {
    this.db.run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING fts5(id UNINDEXED, body)`,
    );
  }

  /** Add or update chunks by id (delete-then-insert) in one transaction. */
  upsert(chunks: Array<{ id: string; text: string }>): void {
    if (chunks.length === 0) return;
    this.init();
    this.db.transaction(() => {
      for (const c of chunks) {
        this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [c.id]);
        this.db.run(`INSERT INTO ${this.table}(id, body) VALUES (?, ?)`, [c.id, c.text]);
      }
    })();
  }

  /** Remove chunks by id in one transaction. */
  remove(ids: string[]): void {
    if (ids.length === 0) return;
    this.init();
    this.db.transaction(() => {
      for (const id of ids) this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]);
    })();
  }

  /** True when the given id is present in the FTS index. */
  has(id: string): boolean {
    return this.db.query(`SELECT 1 AS x FROM ${this.table} WHERE id = ?`).get(id) != null;
  }

  /** Ranked BM25 results (best first) for a query. */
  bm25(query: string, topK = 10): RankedHit[] {
    this.init();
    const match = toFtsQuery(query);
    if (!match) return [];
    const rows = this.db
      .query(
        `SELECT id, body, bm25(${this.table}) AS s FROM ${this.table} WHERE ${this.table} MATCH ? ORDER BY s ASC LIMIT ?`,
      )
      .all(match, Math.max(1, topK)) as Array<{ id: string; body: string; s: number }>;
    return rows.map((r) => ({ id: r.id, text: r.body, score: r.s }));
  }

  close(): void {
    this.db.close();
  }
}

export interface HybridSearchInput {
  query: string;
  queryEmbedding: number[];
  vectorChunks: VectorChunk[];
  fts: FtsIndex;
  topK?: number;
  /** RRF k (default 60). */
  k?: number;
  /** Force a route; defaults to {@link classifyQueryType}. */
  route?: QueryRoute;
  projectPath?: string;
  minScore?: number;
}

export interface HybridResult {
  hits: RankedHit[];
  route: QueryRoute;
  /** Whether the vector side actually contributed (false when it degraded). */
  vectorUsed: boolean;
}

/** Cosine-rank the vector side (best first), reusing the store's scoring. */
function vectorRank(
  chunks: VectorChunk[],
  query: number[],
  topK: number,
  projectPath?: string,
  minScore = 0,
): RankedHit[] {
  const qDim = query.length;
  const hits: Array<{ c: VectorChunk; s: number }> = [];
  for (const c of chunks) {
    if (projectPath && c.projectPath !== projectPath) continue;
    const dim = c.embedDim ?? c.embedding.length;
    if (qDim > 0 && dim !== qDim) continue;
    const s = cosineSimilarity(query, c.embedding);
    if (s < minScore) continue;
    hits.push({ c, s });
  }
  hits.sort((a, b) => b.s - a.s);
  return hits.slice(0, topK).map((h) => ({ id: h.c.id, text: h.c.text, score: h.s }));
}

/**
 * Hybrid retrieval: stage 1 parallel recall (BM25 ∥ cosine), stage 2 RRF fusion.
 * The vector side degrades to nothing (BM25-only) when empty or unusable.
 */
export function hybridSearch(input: HybridSearchInput): HybridResult {
  const topK = input.topK ?? 10;
  const k = input.k ?? 60;
  const route = input.route ?? classifyQueryType(input.query);

  const bm25: RankedHit[] =
    route === "bm25" || route === "mixed"
      ? input.fts.bm25(input.query, topK)
      : [];

  let vector: RankedHit[] = [];
  let vectorUsed = false;
  if (route === "vector" || route === "mixed") {
    if (input.queryEmbedding.length > 0 && input.vectorChunks.length > 0) {
      vector = vectorRank(
        input.vectorChunks,
        input.queryEmbedding,
        topK,
        input.projectPath,
        input.minScore,
      );
      vectorUsed = true;
    }
  }

  const fused = reciprocalRankFusion(
    [bm25, vector].filter((l) => l.length > 0),
    k,
  );
  const byId = new Map<string, RankedHit>();
  for (const h of bm25) if (!byId.has(h.id)) byId.set(h.id, h);
  for (const h of vector) if (!byId.has(h.id)) byId.set(h.id, h);

  const hits = [...fused.entries()]
    .map(([id, score]) => ({ id, score, text: byId.get(id)?.text ?? "" }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return { hits, route, vectorUsed };
}
