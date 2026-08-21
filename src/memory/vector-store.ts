import { existsSync, appendFileSync, readFileSync } from "node:fs";

export interface VectorChunk {
  id: string;
  sessionId: string;
  projectPath: string;
  role: "user" | "assistant";
  text: string;
  embedding: number[];
  created: string;
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
}

export interface SearchHit {
  chunk: VectorChunk;
  score: number;
}

export function searchChunks(chunks: VectorChunk[], opts: SearchOptions): SearchHit[] {
  const topK = opts.topK ?? 5;
  const minScore = opts.minScore ?? 0;
  const hits: SearchHit[] = [];
  for (const chunk of chunks) {
    if (opts.projectPath && chunk.projectPath !== opts.projectPath) continue;
    const score = cosineSimilarity(opts.query, chunk.embedding);
    if (score < minScore) continue;
    hits.push({ chunk, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

export function indexedSessionIds(chunks: VectorChunk[]): Set<string> {
  return new Set(chunks.map((c) => c.sessionId));
}
