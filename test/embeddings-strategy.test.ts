import { describe, test, expect } from "bun:test";
import type { EmbeddingProvider } from "../src/provider/embeddings";
import {
  DOCUMENT_PREFIX,
  QUERY_PREFIX,
  applyPrefix,
  embedWithRole,
  assertModelPinned,
  selectChangedChunks,
  embedOrDegrade,
  cleanDegradation,
} from "../src/memory/embedding-strategy";

/**
 * B9-12 (#389): local embedding strategy — Ollama nomic default, query/document
 * prefixes preserved, one embedding model pinned per index, incremental
 * re-index by chunk id, and clean degradation when the local endpoint is down.
 */

function captureProvider(model: string): { provider: EmbeddingProvider; sent: string[][] } {
  const sent: string[][] = [];
  const provider: EmbeddingProvider = {
    name: "fake",
    model,
    embed: async (texts) => {
      sent.push(texts);
      return texts.map(() => [0, 0]);
    },
  };
  return { provider, sent };
}

describe("prefix preservation (nomic model card)", () => {
  test("document vectors carry search_document: prefix", async () => {
    const { provider, sent } = captureProvider("nomic-embed-text");
    await embedWithRole(provider, ["hello world"], "document");
    expect(sent[0]![0]).toBe(`${DOCUMENT_PREFIX}hello world`);
  });

  test("query vectors carry search_query: prefix", async () => {
    const { provider, sent } = captureProvider("nomic-embed-text");
    await embedWithRole(provider, ["hello world"], "query");
    expect(sent[0]![0]).toBe(`${QUERY_PREFIX}hello world`);
  });

  test("applyPrefix is a no-op for models that need no prefix", () => {
    expect(applyPrefix("text", "document", "mxbai-embed-large")).toBe("text");
    expect(applyPrefix("text", "query", "text-embedding-3-small")).toBe("text");
  });
});

describe("model pinning per index", () => {
  test("matching model is accepted", () => {
    expect(() => assertModelPinned("nomic-embed-text", "nomic-embed-text")).not.toThrow();
  });

  test("mismatched query model is rejected with a clean error", () => {
    expect(() => assertModelPinned("nomic-embed-text", "mxbai-embed-large")).toThrow(/model/i);
  });
});

describe("incremental re-index by chunk id", () => {
  test("only new/changed chunk ids are selected", () => {
    const existing = new Set(["c1", "c2"]);
    const incoming = [{ id: "c1" }, { id: "c3" }, { id: "c4" }];
    const changed = selectChangedChunks(existing, incoming);
    expect(changed.map((c) => c.id)).toEqual(["c3", "c4"]); // c1 already indexed
  });

  test("a changed hash re-selects an existing id (spy counts embeds)", () => {
    const existing = new Set(["c1", "c2"]);
    const incoming = [
      { id: "c1", hash: "abc" }, // same id, new hash -> changed
      { id: "c2", hash: "same" },
      { id: "c2", hash: "same" }, // duplicate, already covered
    ];
    const changed = selectChangedChunks(existing, incoming, (id) => (id === "c1" ? "old-hash" : "same"));
    expect(changed.map((c) => c.id)).toEqual(["c1"]);
  });
});

describe("unreachable local endpoint degradation", () => {
  test("unreachable Ollama yields a clean degradation message, not silent empty", async () => {
    const provider: EmbeddingProvider = {
      name: "ollama",
      model: "nomic-embed-text",
      embed: async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434");
      },
    };
    let degraded = "";
    await expect(
      embedOrDegrade(() => provider.embed(["x"]), (m) => { degraded = m; }),
    ).rejects.toThrow();
    expect(degraded).toContain("unavailable");
    expect(degraded).not.toBe("");
    expect(degraded).not.toMatch(/^\s*$/);
  });

  test("cleanDegradation names the local endpoint problem", () => {
    const msg = cleanDegradation(new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:11434"));
    expect(msg).toContain("local embedding unavailable");
  });
});
