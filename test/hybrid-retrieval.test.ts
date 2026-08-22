import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  classifyQueryType,
  reciprocalRankFusion,
  toFtsQuery,
  FtsIndex,
  hybridSearch,
  type HybridSearchInput,
} from "../src/memory/hybrid";
import type { VectorChunk } from "../src/memory/vector-store";

const created = "2026-08-22T00:00:00Z";

function chunk(id: string, text: string, embedding: number[]): VectorChunk {
  return {
    id,
    sessionId: "s1",
    projectPath: "/proj",
    role: "user",
    text,
    embedding,
    created,
    embedDim: embedding.length,
  };
}

function emptyFts(): FtsIndex {
  return new FtsIndex(new Database(":memory:"));
}

describe("B9-13 query classification", () => {
  test("exact-symbol query routes to BM25", () => {
    expect(classifyQueryType("parseAuthToken")).toBe("bm25");
    expect(classifyQueryType("auth.ts")).toBe("bm25");
    expect(classifyQueryType("ENOENT")).toBe("bm25");
    expect(classifyQueryType("2026-08-22")).toBe("bm25");
    expect(classifyQueryType("src/config/loader.ts")).toBe("bm25");
  });

  test("conceptual phrase routes to vector", () => {
    expect(classifyQueryType("how does authentication work")).toBe("vector");
    expect(classifyQueryType("what changed in the memory layer")).toBe("vector");
  });

  test("mixed query routes to both", () => {
    expect(classifyQueryType("fix parseAuthToken in the auth service")).toBe("mixed");
  });
});

describe("B9-13 RRF fusion", () => {
  test("merges rank lists per formula (hand-computed k=60)", () => {
    const bm25 = [
      { id: "A", text: "", score: -1 },
      { id: "B", text: "", score: -2 },
      { id: "C", text: "", score: -3 },
    ];
    const vector = [
      { id: "C", text: "", score: 0.9 },
      { id: "A", text: "", score: 0.8 },
    ];
    const fused = reciprocalRankFusion([bm25, vector], 60);
    // A: 1/61 + 1/62 ; C: 1/63 + 1/61 ; B: 1/62
    const k = 60;
    const expected = (ranks: number[]) => ranks.reduce((s, r) => s + 1 / (k + r), 0);
    expect(fused.get("A")).toBeCloseTo(expected([1, 2]), 12);
    expect(fused.get("B")).toBeCloseTo(expected([2]), 12);
    expect(fused.get("C")).toBeCloseTo(expected([3, 1]), 12);
    // A > C > B
    const order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order).toEqual(["A", "C", "B"]);
  });
});

describe("B9-13 FTS5 index consistency", () => {
  test("upsert/remove keep the FTS index in sync (same-transaction)", () => {
    const fts = emptyFts();
    fts.upsert([
      { id: "c1", text: "function parseAuthToken(token) { return token; }" },
      { id: "c2", text: "Authentication is handled by the login service." },
    ]);
    expect(fts.has("c1")).toBe(true);
    expect(fts.has("c2")).toBe(true);
    expect(fts.bm25("parseAuthToken", 5).map((h) => h.id)).toContain("c1");

    // update c1's body — delete-then-insert in one transaction
    fts.upsert([{ id: "c1", text: "Renamed symbol is now tokenizeClaims." }]);
    expect(fts.bm25("parseAuthToken", 5).map((h) => h.id)).not.toContain("c1");
    expect(fts.bm25("tokenizeClaims", 5).map((h) => h.id)).toContain("c1");

    // delete
    fts.remove(["c2"]);
    expect(fts.has("c2")).toBe(false);
    expect(fts.bm25("login", 5)).toEqual([]);
  });
});

describe("B9-13 hybrid retrieval", () => {
  const corpus = [
    chunk("c1", "function parseAuthToken(token) { return token.slice(0, 8); }", [1, 0, 0, 0]),
    chunk("c2", "Authentication is handled by the login service.", [0, 1, 0, 0]),
  ];

  test("exact-symbol query routes to BM25 and hits", () => {
    const fts = emptyFts();
    fts.upsert(corpus.map((c) => ({ id: c.id, text: c.text })));
    const res = hybridSearch({
      query: "parseAuthToken",
      queryEmbedding: [1, 0, 0, 0],
      vectorChunks: corpus,
      fts,
    });
    expect(res.route).toBe("bm25");
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0]?.id).toBe("c1");
  });

  test("paraphrase query routes to vector side", () => {
    const fts = emptyFts();
    fts.upsert(corpus.map((c) => ({ id: c.id, text: c.text })));
    // query embedding matches c2's embedding → vector hits c2
    const res = hybridSearch({
      query: "how does authentication work",
      queryEmbedding: [0, 1, 0, 0],
      vectorChunks: corpus,
      fts,
    });
    expect(res.route).toBe("vector");
    expect(res.vectorUsed).toBe(true);
    expect(res.hits[0]?.id).toBe("c2");
  });

  test("mixed query fuses both sides", () => {
    const fts = emptyFts();
    fts.upsert(corpus.map((c) => ({ id: c.id, text: c.text })));
    const res = hybridSearch({
      query: "fix parseAuthToken in the auth service",
      queryEmbedding: [0, 1, 0, 0],
      vectorChunks: corpus,
      fts,
    });
    expect(res.route).toBe("mixed");
    expect(res.vectorUsed).toBe(true);
    // c1 appears via BM25, c2 via vector; both can be present after fusion
    expect(res.hits.some((h) => h.id === "c1")).toBe(true);
  });

  test("empty vector side degrades to BM25-only without crash", () => {
    const fts = emptyFts();
    fts.upsert(corpus.map((c) => ({ id: c.id, text: c.text })));
    const res = hybridSearch({
      query: "parseAuthToken",
      queryEmbedding: [],
      vectorChunks: [], // empty — vector side unavailable
      fts,
      route: "mixed", // would try both, but vector has nothing
    });
    expect(res.vectorUsed).toBe(false);
    expect(res.hits.map((h) => h.id)).toContain("c1");
    expect(res.hits.every((h) => h.id !== "c2")).toBe(true);
  });

  test("corrupt vector chunks (mismatched dim) are skipped, no crash", () => {
    const fts = emptyFts();
    fts.upsert(corpus.map((c) => ({ id: c.id, text: c.text })));
    const bad = [chunk("cX", "wrong dims", [1, 2, 3])]; // 3-dim vs query 4-dim
    const res = hybridSearch({
      query: "parseAuthToken",
      queryEmbedding: [1, 0, 0, 0],
      vectorChunks: bad,
      fts,
      route: "mixed",
    });
    expect(res.vectorUsed).toBe(true);
    expect(res.hits.map((h) => h.id)).toContain("c1");
    expect(res.hits.some((h) => h.id === "cX")).toBe(false);
  });
});

describe("B9-13 FTS query builder", () => {
  test("toFtsQuery quotes and AND-joins tokens safely", () => {
    expect(toFtsQuery("parseAuthToken")).toBe('"parseauthtoken"');
    expect(toFtsQuery("how does auth work")).toBe('"how" "does" "auth" "work"');
  });
});
