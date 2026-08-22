/**
 * Retrieval golden-set regression gate (Roadmap §12 B9-15, #395).
 *
 * A versioned in-repo golden set — {query, ground truth answer, expected
 * chunk-ids} over a small fixture corpus — guards the chunking + retrieval
 * pipeline against silent regressions. Wires into the existing CI staging
 * (B4-9 pattern) as a plain test that fails the build on threshold breach.
 *
 * The harness measures three signals per query:
 *   - context_recall  : relevant-retrieved / total-relevant (RAGAS)
 *   - context_precision: rank-weighted precision@K (RAGAS)
 *   - grep_recall     : deterministic-mode coverage — the query's key terms
 *                       actually appear in the retrieved text, independent of
 *                       any embedding model.
 *
 * CI has no embedding model, so the vector side runs on a DETERMINISTIC
 * token-frequency embedding (same harness, same pipeline) rather than the
 * live nomic/ollama path. Everything is deterministic: a golden set that
 * passes today either stays green or regresses loudly (diff-style report)
 * when chunking / retrieval / the corpus changes.
 */

import { Database } from "bun:sqlite";
import { FtsIndex, hybridSearch, type QueryRoute } from "./hybrid";
import { chunkStructure } from "./chunking";
import type { VectorChunk } from "./vector-store";

export interface GoldenEntry {
  id: string;
  query: string;
  /** Expected answer text (kept as documentation / grep source). */
  groundTruth?: string;
  /** Chunk ids that must be retrieved for `query`. */
  expectedChunkIds: string[];
  /** Key terms that must appear in the retrieved text (deterministic mode). */
  grepTerms?: string[];
}

export interface GoldenThresholds {
  contextRecall: number;
  contextPrecision: number;
  grepRecall: number;
}

export interface GoldenSet {
  version: number;
  corpusPath: string;
  topK: number;
  thresholds: GoldenThresholds;
  entries: GoldenEntry[];
}

export interface RetrievalMetrics {
  contextRecall: number;
  contextPrecision: number;
  grepRecall: number;
}

export interface EntryResult extends RetrievalMetrics {
  id: string;
  query: string;
  route: QueryRoute;
  retrieved: string[];
  expected: string[];
  /** Expected chunks that were not retrieved. */
  missing: string[];
  /** Expected chunks that do not exist in the built corpus index (drift). */
  missingFromIndex: string[];
}

export interface GateReport {
  corpusChunks: number;
  entries: EntryResult[];
  mean: RetrievalMetrics;
  regressed: EntryResult[];
  thresholdBreach: boolean;
}

/**
 * Rank-weighted precision@K (RAGAS context_precision):
 *   Σ_{k=1..K} (rel_k × P@k) / |relevant in top K|
 * where P@k is precision over the first k retrieved items.
 * Returns 0 when nothing relevant was retrieved.
 */
export function contextPrecision(relevant: ReadonlySet<string>, retrieved: readonly string[]): number {
  if (retrieved.length === 0) return 0;
  let relevantInTop = 0;
  let sum = 0;
  let seenRelevant = 0;
  for (let k = 1; k <= retrieved.length; k++) {
    const id = retrieved[k - 1];
    if (id !== undefined && relevant.has(id)) {
      seenRelevant++;
      sum += seenRelevant / k;
    }
  }
  relevantInTop = seenRelevant;
  if (relevantInTop === 0) return 0;
  return sum / relevantInTop;
}

/** Relevant-retrieved over total relevant (RAGAS context_recall). */
export function contextRecall(relevant: ReadonlySet<string>, retrieved: readonly string[]): number {
  if (relevant.size === 0) return 1.0;
  let hit = 0;
  for (const id of relevant) if (retrieved.includes(id)) hit++;
  return hit / relevant.size;
}

/**
 * Deterministic-mode recall: fraction of the query's key terms that appear
 * (case-insensitive substring) anywhere in the retrieved text.
 */
export function grepRecall(terms: readonly string[], retrievedTexts: readonly string[]): number {
  if (terms.length === 0) return 1.0;
  const haystack = retrievedTexts.join("\n").toLowerCase();
  let hit = 0;
  for (const t of terms) if (t && haystack.includes(t.toLowerCase())) hit++;
  return hit / terms.length;
}

/**
 * A deterministic, vocabulary-stable bag-of-words embedding. Used in CI where
 * no embedding model is available so the vector path of `hybridSearch` still
 * runs and is measured by the same harness. Token overlap gives meaningful
 * cosine similarity on a small curated corpus.
 */
export function makeTokenEmbedding(vocab: readonly string[]): (text: string) => number[] {
  const index = new Map<string, number>();
  vocab.forEach((w, i) => index.set(w.toLowerCase(), i));
  return (text: string) => {
    const counts = new Array(vocab.length).fill(0);
    for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/i)) {
      const i = raw ? index.get(raw) : undefined;
      if (i === undefined) continue;
      counts[i] = (counts[i] ?? 0) + 1;
    }
    let norm = 0;
    for (const c of counts) norm += c * c;
    norm = Math.sqrt(norm);
    if (norm === 0) return counts;
    return counts.map((c) => c / norm);
  };
}

interface GoldenIndex {
  chunks: Array<{ id: string; text: string }>;
  vectorChunks: VectorChunk[];
  fts: FtsIndex;
}

/** Chunk the corpus once and index it with the given deterministic embedder. */
export function buildGoldenIndex(
  corpusText: string,
  embed: (text: string) => number[],
  projectPath = "/golden",
): GoldenIndex {
  const chunks = chunkStructure(corpusText).map((c) => ({ id: c.id, text: c.text }));
  const created = "2026-08-22T00:00:00Z";
  const vectorChunks: VectorChunk[] = chunks.map((c) => {
    const embedding = embed(c.text);
    return {
      id: c.id,
      sessionId: "golden",
      projectPath,
      role: "assistant",
      text: c.text,
      embedding,
      created,
      embedModel: "deterministic-tf",
      embedDim: embedding.length,
    };
  });
  const fts = new FtsIndex(new Database(":memory:"));
  fts.upsert(chunks);
  return { chunks, vectorChunks, fts };
}

/**
 * Run every golden query through the retrieval pipeline and score it against
 * the expected chunks. A query whose expected chunk no longer exists in the
 * corpus (chunking/corpus drift) is counted as a structural regression.
 */
export function runGoldenSet(
  set: GoldenSet,
  opts: { corpusText: string; embed: (text: string) => number[]; projectPath?: string },
): GateReport {
  const projectPath = opts.projectPath ?? "/golden";
  const { chunks, vectorChunks, fts } = buildGoldenIndex(opts.corpusText, opts.embed, projectPath);
  const indexIds = new Set(chunks.map((c) => c.id));

  const entries: EntryResult[] = set.entries.map((entry) => {
    const missingFromIndex = entry.expectedChunkIds.filter((id) => !indexIds.has(id));
    const res = hybridSearch({
      query: entry.query,
      queryEmbedding: opts.embed(entry.query),
      vectorChunks,
      fts,
      topK: set.topK,
      projectPath,
    });
    const retrieved = res.hits.map((h) => h.id);
    const expectedSet = new Set(entry.expectedChunkIds);
    const missing = entry.expectedChunkIds.filter((id) => !retrieved.includes(id));
    return {
      id: entry.id,
      query: entry.query,
      route: res.route,
      retrieved,
      expected: entry.expectedChunkIds,
      missing,
      missingFromIndex,
      contextRecall: contextRecall(expectedSet, retrieved),
      contextPrecision: contextPrecision(expectedSet, retrieved),
      grepRecall: grepRecall(entry.grepTerms ?? [], res.hits.map((h) => h.text)),
    };
  });

  const mean = {
    contextRecall: meanOf(entries.map((e) => e.contextRecall)),
    contextPrecision: meanOf(entries.map((e) => e.contextPrecision)),
    grepRecall: meanOf(entries.map((e) => e.grepRecall)),
  };

  const regressed = entries.filter(
    (e) =>
      e.missingFromIndex.length > 0 ||
      e.contextRecall < set.thresholds.contextRecall ||
      e.contextPrecision < set.thresholds.contextPrecision ||
      e.grepRecall < set.thresholds.grepRecall,
  );

  return { corpusChunks: chunks.length, entries, mean, regressed, thresholdBreach: regressed.length > 0 };
}

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

const fmt = (n: number) => n.toFixed(3);

/** Render a human-readable, diff-style regression report for CI output. */
export function formatDiffReport(report: GateReport): string {
  const lines: string[] = [];
  lines.push(
    `Retrieval golden set: ${report.entries.length} query(ies) over ${report.corpusChunks} corpus chunk(s)`,
  );
  lines.push(
    `  mean context_recall=${fmt(report.mean.contextRecall)} context_precision=${fmt(report.mean.contextPrecision)} grep_recall=${fmt(report.mean.grepRecall)}`,
  );
  if (report.regressed.length === 0) {
    lines.push("  OK — no regressions against the golden set.");
    return lines.join("\n");
  }
  lines.push(`  ${report.regressed.length} regressed query(ies):`);
  for (const e of report.regressed) {
    lines.push(`    - ${e.id}: "${e.query}" (route=${e.route})`);
    lines.push(
      `        context_recall=${fmt(e.contextRecall)} context_precision=${fmt(e.contextPrecision)} grep_recall=${fmt(e.grepRecall)}`,
    );
    if (e.missingFromIndex.length > 0) {
      lines.push(
        `        STRUCTURAL DRIFT: expected chunk(s) no longer exist in the corpus: ${e.missingFromIndex.join(", ")} — update the golden set`,
      );
    }
    if (e.missing.length > 0) {
      lines.push(`        MISSING expected chunk(s): ${e.missing.join(", ")}`);
      lines.push(`        retrieved: [${e.retrieved.join(", ")}]`);
    }
  }
  return lines.join("\n");
}
