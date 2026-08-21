import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChunks,
  loadChunks,
  cosineSimilarity,
  searchChunks,
  indexedSessionIds,
  VectorStore,
  type VectorChunk,
} from "../src/memory/vector-store";

let file: string;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-vec-"));
  file = join(dir, "vectors.jsonl");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function chunk(overrides: Partial<VectorChunk> = {}): VectorChunk {
  return {
    id: "s1:0",
    sessionId: "s1",
    projectPath: "/p",
    role: "user",
    text: "hello",
    embedding: [1, 0, 0],
    created: "2026-08-21T00:00:00Z",
    ...overrides,
  };
}

describe("cosineSimilarity", () => {
  test("identical vectors score 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  test("orthogonal vectors score 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("opposite vectors score -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test("zero vector scores 0 without NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("persistence", () => {
  test("append + load round-trips chunks", () => {
    appendChunks(file, [chunk({ id: "a" }), chunk({ id: "b", sessionId: "s2" })]);
    const loaded = loadChunks(file);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.id).toBe("a");
    expect(loaded[1]?.sessionId).toBe("s2");
  });

  test("load skips corrupted lines and invalid entries", () => {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(file, `${JSON.stringify(chunk())}\n{broken\n`);
    appendFileSync(file, `${JSON.stringify({ id: "x", nope: true })}\n`);
    const loaded = loadChunks(file);
    expect(loaded).toHaveLength(1);
  });

  test("appendChunks with empty array writes nothing", () => {
    appendChunks(file, []);
    expect(loadChunks(file)).toHaveLength(0);
  });
});

describe("searchChunks", () => {
  const corpus = [
    chunk({ id: "auth-user", text: "fix auth bug", embedding: [1, 0.1, 0] }),
    chunk({ id: "auth-asst", role: "assistant", text: "refactored middleware", embedding: [0.9, 0.2, 0] }),
    chunk({ id: "other-proj", projectPath: "/elsewhere", text: "auth too", embedding: [0.99, 0, 0] }),
    chunk({ id: "unrelated", text: "garden tips", embedding: [0, 1, 0] }),
  ];

  test("ranks by similarity descending and respects topK", () => {
    const { hits } = searchChunks(corpus, { query: [1, 0, 0], topK: 2 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["other-proj", "auth-user"]);
    const first = hits[0];
    const second = hits[1];
    if (!first || !second) throw new Error("expected two hits");
    expect(first.score).toBeGreaterThan(second.score);
  });

  test("projectPath filter scopes results", () => {
    const { hits } = searchChunks(corpus, { query: [1, 0, 0], topK: 10, projectPath: "/p" });
    expect(hits.map((h) => h.chunk.id)).not.toContain("other-proj");
  });

  test("minScore drops weak matches", () => {
    const { hits } = searchChunks(corpus, { query: [1, 0, 0], topK: 10, minScore: 0.95 });
    expect(hits.map((h) => h.chunk.id)).toEqual([
      "other-proj",
      "auth-user",
      "auth-asst",
    ]);
  });

  test("empty corpus returns nothing", () => {
    const { hits } = searchChunks([], { query: [1, 0, 0] });
    expect(hits).toEqual([]);
  });

  test("skips chunks with mismatched dimension and reports counter", () => {
    const { hits, skipped } = searchChunks(
      [
        chunk({ id: "match", embedding: [1, 0, 0] }),
        chunk({ id: "dirty-3072", embedding: new Array(3072).fill(0.01) }),
        chunk({ id: "dirty-1536", embedding: new Array(1536).fill(0.01) }),
      ],
      { query: [1, 0, 0] },
    );
    expect(hits.map((h) => h.chunk.id)).toEqual(["match"]);
    expect(skipped).toBe(2);
  });

  test("skips chunks with a different embedModel and reports counter", () => {
    const { hits, skipped } = searchChunks(
      [
        chunk({ id: "same-model", embedModel: "text-embedding-3-small" }),
        chunk({ id: "other-model", embedModel: "text-embedding-3-large" }),
        chunk({ id: "legacy", embedModel: undefined }),
      ],
      { query: [1, 0, 0], embedModel: "text-embedding-3-small" },
    );
    // legacy chunk without embedModel metadata is still searched
    expect(hits.map((h) => h.chunk.id)).toContain("same-model");
    expect(hits.map((h) => h.chunk.id)).toContain("legacy");
    expect(hits.map((h) => h.chunk.id)).not.toContain("other-model");
    expect(skipped).toBe(1);
  });

  test("skipping does not throw even when every chunk mismatches", () => {
    const { hits, skipped } = searchChunks(
      [chunk({ id: "old", embedding: new Array(1536).fill(0.5) })],
      { query: new Array(3072).fill(0.5) },
    );
    expect(hits).toEqual([]);
    expect(skipped).toBe(1);
  });
});

test("indexedSessionIds collects distinct sessions", () => {
  const ids = indexedSessionIds([
    chunk({ sessionId: "a" }),
    chunk({ sessionId: "a" }),
    chunk({ sessionId: "b" }),
  ]);
  expect([...ids].sort()).toEqual(["a", "b"]);
});

describe("VectorStore", () => {
  test("open loads the whole file into memory once", () => {
    appendChunks(file, [chunk({ id: "a" }), chunk({ id: "b", sessionId: "s2" })]);
    const store = VectorStore.open(file);
    expect(store.size).toBe(2);
    expect([...store.sessionsIndexed()].sort()).toEqual(["s1", "s2"]);
  });

  test("add buffers without touching the file; search sees pending chunks", () => {
    const store = new VectorStore(file);
    store.add(chunk({ id: "pending" }));
    expect(existsSync(file)).toBe(false);
    const { hits } = store.search({ query: [1, 0, 0], topK: 10 });
    expect(hits.map((h) => h.chunk.id)).toEqual(["pending"]);
  });

  test("flush persists buffered chunks to the file", () => {
    const store = new VectorStore(file);
    store.add(chunk({ id: "a" }));
    store.flush();
    expect(loadChunks(file).map((c) => c.id)).toEqual(["a"]);
  });

  test("auto-flush writes to file once the buffer threshold is reached", () => {
    const store = new VectorStore(file, [], 3);
    store.addAll([chunk({ id: "a" }), chunk({ id: "b" }), chunk({ id: "c" })]);
    expect(loadChunks(file)).toHaveLength(3);
    expect(store.size).toBe(3);
  });

  test("flush with an empty buffer is a no-op", () => {
    const store = new VectorStore(file);
    store.flush();
    expect(existsSync(file)).toBe(false);
  });

  test("dimension-blocked search is behavior-identical to a full scan", () => {
    const corpus = [
      chunk({ id: "match", embedding: [1, 0, 0], embedModel: "text-embedding-3-small" }),
      chunk({ id: "legacy", embedding: [0.9, 0.1, 0], embedModel: undefined }),
      chunk({ id: "other-model", embedding: [0.5, 0.5, 0], embedModel: "text-embedding-3-large" }),
      chunk({ id: "dirty-1536", embedding: new Array(1536).fill(0.01) }),
    ];
    appendChunks(file, corpus);
    const store = VectorStore.open(file);
    const full = searchChunks(corpus, {
      query: [1, 0, 0],
      topK: 10,
      embedModel: "text-embedding-3-small",
    });
    const viaStore = store.search({
      query: [1, 0, 0],
      topK: 10,
      embedModel: "text-embedding-3-small",
    });
    expect(viaStore.hits.map((h) => h.chunk.id)).toEqual(full.hits.map((h) => h.chunk.id));
    expect(viaStore.skipped).toBe(full.skipped);
  });

  test("compact keeps the latest revision of a duplicated id and rewrites the file", () => {
    appendChunks(file, [
      chunk({ id: "auth", text: "old", created: "2026-08-20T00:00:00Z" }),
      chunk({ id: "auth", text: "new", created: "2026-08-21T00:00:00Z" }),
      chunk({ id: "garden", text: "garden" }),
    ]);
    const store = VectorStore.open(file);
    const report = store.compact();
    expect(report.before).toBe(3);
    expect(report.after).toBe(2);
    expect(report.removed).toBe(1);
    expect(report.rewritten).toBe(true);
    expect(store.size).toBe(2);
    const persisted = loadChunks(file);
    expect(persisted.filter((c) => c.id === "auth")).toHaveLength(1);
    expect(persisted.find((c) => c.id === "auth")!.text).toBe("new");
  });

  test("compact is a no-op (no rewrite) when there are no duplicates", () => {
    appendChunks(file, [chunk({ id: "a" }), chunk({ id: "b" })]);
    const store = VectorStore.open(file);
    const report = store.compact();
    expect(report.removed).toBe(0);
    expect(report.rewritten).toBe(false);
  });

  test("recall results are identical before and after compaction", () => {
    // A stale revision (zero vector) is already filtered by minScore, so compaction
    // removing it must not change what recall returns.
    appendChunks(file, [
      chunk({ id: "auth", text: "fix auth bug", embedding: [1, 0, 0], created: "2026-08-21T00:00:00Z" }),
      chunk({ id: "auth", text: "stale note", embedding: [0, 0, 0], created: "2026-08-20T00:00:00Z" }),
      chunk({ id: "garden", text: "garden tips", embedding: [0, 1, 0] }),
    ]);
    const before = VectorStore.open(file).search({ query: [1, 0, 0], topK: 5, minScore: 0.5 });
    const store = VectorStore.open(file);
    store.compact();
    const after = store.search({ query: [1, 0, 0], topK: 5, minScore: 0.5 });
    expect(after.hits.map((h) => h.chunk.id)).toEqual(before.hits.map((h) => h.chunk.id));
    expect(after.skipped).toBe(before.skipped);
  });

  test("compaction bounds file growth", () => {
    const many = Array.from({ length: 50 }, () =>
      chunk({ id: "dup", created: "2026-08-21T00:00:00Z" }),
    );
    appendChunks(file, many);
    const sizeBefore = statSync(file).size;
    const store = VectorStore.open(file);
    store.compact();
    expect(statSync(file).size).toBeLessThan(sizeBefore);
    expect(loadChunks(file)).toHaveLength(1);
  });
});
