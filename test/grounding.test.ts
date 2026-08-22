import { describe, test, expect } from "bun:test";
import {
  parseCitation,
  isValidCitation,
  verifyCitation,
  extractCitations,
  verifyAnswerCitations,
  abstention,
  groundResponse,
  faithfulnessSpotCheck,
  type GroundingContext,
} from "../src/memory/grounding";
import { createRetrieveTool, formatRetrieval } from "../src/tools/retrieve";
import type { HybridResult, QueryRoute } from "../src/memory/hybrid";

function ctx(opts: {
  chunks?: Record<string, string>;
  files?: Record<string, string>;
}): GroundingContext {
  return {
    chunks: new Map(Object.entries(opts.chunks ?? {})),
    files: new Map(Object.entries(opts.files ?? {})),
  };
}

describe("B9-14 citation parsing & format assertion", () => {
  test("file:line and bare chunk-id are valid citation formats", () => {
    expect(isValidCitation("src/loader.ts:42")).toBe(true);
    expect(isValidCitation("chunk_ab12cd")).toBe(true);
    expect(isValidCitation("./a/b.ts:3")).toBe(true);
    expect(isValidCitation("a-b_c.9:1")).toBe(true);
  });

  test("malformed citations are rejected", () => {
    expect(isValidCitation("")).toBe(false);
    expect(isValidCitation("has spaces here")).toBe(false);
    expect(isValidCitation("(paren)")).toBe(false);
    expect(isValidCitation("file.ts:line")).toBe(false);
  });

  test("parseCitation distinguishes file vs chunk", () => {
    expect(parseCitation("src/a.ts:7")).toEqual({ kind: "file", path: "src/a.ts", line: 7 });
    expect(parseCitation("chunk_xyz")).toEqual({ kind: "chunk", id: "chunk_xyz" });
  });

  test("extractCitations finds @-prefixed file:line and chunk-id markers", () => {
    const answer =
      "The loader parses auth tokens (@src/auth/parser.ts:12) and caches them (@chunk_ab12).";
    expect(extractCitations(answer)).toEqual(["src/auth/parser.ts:12", "chunk_ab12"]);
  });
});

describe("B9-14 citation verification", () => {
  test("nonexistent chunk-id fails verification (forces retry/abstain)", () => {
    const c = ctx({ chunks: { chunk_real: "real text" } });
    const res = verifyCitation("chunk_missing", c);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not in the delivered context");
  });

  test("delivered chunk-id passes verification", () => {
    const c = ctx({ chunks: { chunk_real: "real text" } });
    expect(verifyCitation("chunk_real", c).ok).toBe(true);
  });

  test("file:line passes only when the file is delivered and the line exists", () => {
    const c = ctx({ files: { "src/a.ts": "line1\nline2\nline3" } });
    expect(verifyCitation("src/a.ts:2", c).ok).toBe(true);
    expect(verifyCitation("src/a.ts:99", c).ok).toBe(false); // out of range
    expect(verifyCitation("src/other.ts:1", c).ok).toBe(false); // not delivered
  });

  test("verifyAnswerCitations collects only the failing citations", () => {
    const c = ctx({ chunks: { chunk_ok: "text" } });
    const failures = verifyAnswerCitations(
      "One valid (@chunk_ok) and two bad (@chunk_ghost @src/nope.ts:1).",
      c,
    );
    expect(failures.map((f) => f.citation).sort()).toEqual(["chunk_ghost", "src/nope.ts:1"]);
  });
});

describe("B9-14 grounding gate / abstention", () => {
  test("no delivered evidence produces the abstention fallback (no invented answer)", () => {
    const res = groundResponse({ question: "What is foo?", answer: "foo is 42", ctx: ctx({}) });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("abstain");
    expect(res.output).not.toContain("foo is 42"); // the invented answer is never emitted
    expect(res.output).toBe(abstention("What is foo?"));
  });

  test("answer with an unverifiable citation is rejected and forces retry/abstain", () => {
    const c = ctx({ chunks: { chunk_ok: "real text" } });
    const res = groundResponse({
      question: "q",
      answer: "It works (@chunk_ghost).",
      ctx: c,
    });
    expect(res.ok).toBe(false);
    expect(res.output).toContain("Unverifiable citation");
  });

  test("answer with only valid citations passes the gate", () => {
    const c = ctx({ chunks: { chunk_ok: "real text" } });
    const res = groundResponse({
      question: "q",
      answer: "It works (@chunk_ok).",
      ctx: c,
    });
    expect(res.ok).toBe(true);
    expect(res.output).toBe("It works (@chunk_ok).");
  });
});

describe("B9-14 identical gating across grep and hybrid modes", () => {
  // The gate reasons only over the delivered context; it must not care how
  // that context was produced. Feed the same chunk through "grep" (BM25-only)
  // and "hybrid" shapes and assert the gate behaves identically.
  test("grep-mode and hybrid-mode context gate identically", () => {
    const grepCtx = ctx({ chunks: { chunk_g: "auth parser symbol" } });
    const hybridCtx = ctx({ chunks: { chunk_h: "auth parser symbol" } });

    const gOk = groundResponse({ question: "q", answer: "auth (@chunk_g)", ctx: grepCtx });
    const hOk = groundResponse({ question: "q", answer: "auth (@chunk_h)", ctx: hybridCtx });
    expect(gOk.ok).toBe(true);
    expect(hOk.ok).toBe(true);

    // And both reject a hallucinated chunk-id identically.
    const gBad = groundResponse({ question: "q", answer: "auth (@nope_g)", ctx: grepCtx });
    const hBad = groundResponse({ question: "q", answer: "auth (@nope_h)", ctx: hybridCtx });
    expect(gBad.ok).toBe(false);
    expect(hBad.ok).toBe(false);
  });

  test("a hybrid result missing evidence abstains exactly like an empty grep result", () => {
    const hybridNoHit = ctx({});
    const grepNoHit = ctx({});
    const a = groundResponse({ question: "q", answer: "ans", ctx: hybridNoHit });
    const b = groundResponse({ question: "q", answer: "ans", ctx: grepNoHit });
    expect(a).toEqual(b);
    expect(a.ok).toBe(false);
  });
});

describe("B9-14 faithfulness spot-check hook", () => {
  const c = ctx({ chunks: { chunk_1: "The retry loop uses full-jitter backoff with circuit breaking." } });

  test("claims traced to delivered chunks are supported", () => {
    const samples = faithfulnessSpotCheck(
      ["The retry loop uses full-jitter backoff", "unrelated moon cheese"],
      c,
    );
    expect(samples[0]!.supported).toBe(true);
    expect(samples[1]!.supported).toBe(false);
  });
});

describe("B9-14 retrieve tool (explicit retrieval)", () => {
  test("formatRetrieval renders chunk-ids and an abstain hint when empty", () => {
    const empty: HybridResult = { hits: [], route: "bm25", vectorUsed: false };
    expect(formatRetrieval(empty)).toContain("No relevant chunks found");
    expect(formatRetrieval(empty)).toContain("abstain");

    const filled: HybridResult = {
      hits: [
        { id: "chunk_1", text: "auth parser", score: 0.91 },
        { id: "chunk_2", text: "auth cache", score: 0.8 },
      ],
      route: "mixed",
      vectorUsed: true,
    };
    const out = formatRetrieval(filled);
    expect(out).toContain('chunk-id "chunk_1"');
    expect(out).toContain("route: mixed");
  });

  test("createRetrieveTool handler uses the injected search and cites chunk-ids", async () => {
    const tool = createRetrieveTool({
      memoryDirPath: "/tmp/none",
      projectPath: "/proj",
      embeddings: null,
      search: async ({ query, topK, route }: { query: string; topK: number; route?: QueryRoute }) => ({
        hits: [{ id: "chunk_sim", text: `result for ${query}`, score: 0.7 }],
        route: route ?? "bm25",
        vectorUsed: false,
      }),
    });
    const out = await tool.handler({ query: "auth", topK: 3 }, { cwd: "/proj" });
    expect(out).toContain('chunk-id "chunk_sim"');
    expect(out).toContain("result for auth");
  });

  test("empty query throws", async () => {
    const tool = createRetrieveTool({
      memoryDirPath: "/tmp/none",
      projectPath: "/proj",
      embeddings: null,
      search: async () => ({ hits: [], route: "bm25", vectorUsed: false }),
    });
    expect(tool.handler({ query: "   " }, { cwd: "/proj" })).rejects.toThrow("query must not be empty");
  });
});
