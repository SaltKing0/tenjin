import { describe, test, expect } from "bun:test";
import {
  contextPrecision,
  contextRecall,
  grepRecall,
  makeTokenEmbedding,
  runGoldenSet,
  formatDiffReport,
  type GoldenSet,
} from "../src/memory/retrieval-gate";

describe("B9-15 retrieval metric math", () => {
  test("context_precision is rank-weighted (RAGAS definition)", () => {
    // relevant at rank 1 → precision 1.0
    expect(contextPrecision(new Set(["A"]), ["A", "B", "C"])).toBeCloseTo(1.0, 12);
    // relevant at rank 2 → 0.5
    expect(contextPrecision(new Set(["A"]), ["B", "A", "C"])).toBeCloseTo(0.5, 12);
    // two relevant at ranks 1 and 3 → (1 + 2/3) / 2
    expect(contextPrecision(new Set(["A", "C"]), ["A", "B", "C"])).toBeCloseTo(5 / 6, 12);
    // nothing relevant retrieved → 0
    expect(contextPrecision(new Set(["A"]), ["B", "C", "D"])).toBe(0);
    // empty retrieval → 0
    expect(contextPrecision(new Set(["A"]), [])).toBe(0);
  });

  test("context_recall is relevant-retrieved over total relevant", () => {
    expect(contextRecall(new Set(["A", "C"]), ["A", "B"])).toBeCloseTo(0.5, 12);
    expect(contextRecall(new Set(["A"]), ["A"])).toBeCloseTo(1.0, 12);
    expect(contextRecall(new Set(["A", "B"]), [])).toBe(0);
    // empty expected set is trivially satisfied
    expect(contextRecall(new Set(), ["X"])).toBe(1.0);
  });

  test("grep_recall is case-insensitive substring coverage of the terms", () => {
    expect(grepRecall(["alpha", "beta"], ["alpha gamma"])).toBeCloseTo(0.5, 12);
    expect(grepRecall(["alpha"], ["ALPHA gamma"])).toBeCloseTo(1.0, 12);
    expect(grepRecall(["alpha", "beta", "gamma"], ["alpha", "gamma"])).toBeCloseTo(2 / 3, 12);
    expect(grepRecall([], ["anything"])).toBe(1.0);
  });
});

describe("B9-15 deterministic token embedding", () => {
  test("same token sets collide; different vocab does not (deterministic)", () => {
    const vocab = ["login", "auth", "token", "release"];
    const embed = makeTokenEmbedding(vocab);
    const a = embed("login auth");
    const b = embed("auth login");
    const c = embed("release");
    // bag-of-words → same multiset gives identical vector
    expect(a).toEqual(b);
    // different terms give different vectors
    expect(a).not.toEqual(c);
    // unknown terms are ignored (vocab-stable)
    expect(embed("unknownword").every((v) => v === 0)).toBe(true);
  });
});

describe("B9-15 threshold breach report", () => {
  test("runGoldenSet flags a regressed query and renders a diff-style report", () => {
    const set: GoldenSet = {
      version: 1,
      corpusPath: "corpus.md",
      topK: 3,
      thresholds: { contextRecall: 1.0, contextPrecision: 0.5, grepRecall: 1.0 },
      entries: [
        {
          id: "exact-symbol",
          query: "parseAuthToken",
          expectedChunkIds: ["parent-1"],
          grepTerms: ["parseAuthToken"],
        },
        {
          // expected chunk does not exist → structural drift → must breach
          id: "drift",
          query: "missing",
          expectedChunkIds: ["parent-99"],
          grepTerms: ["missing"],
        },
      ],
    };
    // A corpus whose retrieval CANNOT produce parent-1: two unrelated chunks.
    const corpusText = [
      "## Alpha",
      "The alpha module handles scheduling.",
      "## Beta",
      "The beta module handles persistence.",
    ].join("\n");
    const report = runGoldenSet(set, {
      corpusText,
      embed: makeTokenEmbedding(["alpha", "beta"]),
    });
    expect(report.thresholdBreach).toBe(true);
    // drift entry reports its missing expected chunk as regressed
    expect(report.regressed.some((r) => r.id === "drift")).toBe(true);
    const text = formatDiffReport(report);
    expect(text).toContain("drift");
    expect(text).toContain("parent-99");
  });

  test("a clean golden set does not breach thresholds", () => {
    const set: GoldenSet = {
      version: 1,
      corpusPath: "corpus.md",
      topK: 3,
      thresholds: { contextRecall: 1.0, contextPrecision: 0.5, grepRecall: 1.0 },
      entries: [
        {
          id: "exact-symbol",
          query: "parseAuthToken",
          expectedChunkIds: ["parent-0"],
          grepTerms: ["parseAuthToken"],
        },
      ],
    };
    const corpusText = [
      "## Auth",
      "The parseAuthToken helper validates a bearer token.",
      "## Other",
      "Unrelated persistence details.",
    ].join("\n");
    const report = runGoldenSet(set, {
      corpusText,
      embed: makeTokenEmbedding(["parseauth", "token", "auth"]),
    });
    expect(report.thresholdBreach).toBe(false);
  });
});
