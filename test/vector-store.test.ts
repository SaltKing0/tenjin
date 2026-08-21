import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChunks,
  loadChunks,
  cosineSimilarity,
  searchChunks,
  indexedSessionIds,
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
