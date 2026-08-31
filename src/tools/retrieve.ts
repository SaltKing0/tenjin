import { Database } from "bun:sqlite";
import type { ToolDef } from "./registry";
import type { EmbeddingProvider } from "../provider/embeddings";
import { loadChunks, vectorsFilePath } from "../memory/vector-store";
import {
  FtsIndex,
  hybridSearch,
  type HybridResult,
  type QueryRoute,
} from "../memory/hybrid";
import type { VectorStore } from "../memory/vector-store";
import { Redactor } from "../security/redact";
import {
  groundResponse,
  type GroundingContext,
} from "../memory/grounding";

/**
 * B9-14 (#394): retrieval exposed as an EXPLICIT tool, never auto-injected
 * into every prompt. The model calls `retrieve` on demand and is then gated by
 * the grounding layer (src/memory/grounding.ts): it may answer only from the
 * returned chunks, must cite a delivered chunk-id, and must abstain when no
 * evidence is found. Because the tool appears in the tool registry it is also
 * surfaced in the B5-3 progressive-disclosure index (#378) at Level 1 only.
 */

export interface RetrieveDeps {
  memoryDirPath: string;
  projectPath: string;
  embeddings: EmbeddingProvider | null;
  store?: VectorStore;
  /**
   * Injectable search primitive so the tool is unit-testable headlessly
   * without an embedding provider. Defaults to the real hybrid retrieval.
   */
  search?: (opts: { query: string; topK: number; route?: QueryRoute }) => Promise<HybridResult>;
}

/** Default hybrid search: FTS5 ∥ vectors over the project's chunk log. */
async function defaultSearch(
  deps: RetrieveDeps,
  opts: { query: string; topK: number; route?: QueryRoute },
): Promise<HybridResult> {
  if (!deps.embeddings) {
    return { hits: [], route: opts.route ?? "bm25", vectorUsed: false };
  }
  const [queryEmbedding] = await deps.embeddings.embed([opts.query]);
  if (!queryEmbedding) {
    return { hits: [], route: opts.route ?? "bm25", vectorUsed: false };
  }
  const chunks = loadChunks(vectorsFilePath(deps.memoryDirPath));
  const fts = new FtsIndex(new Database(":memory:"));
  try {
    fts.upsert(chunks.map((c) => ({ id: c.id, text: c.text })));
    return hybridSearch({
      query: opts.query,
      queryEmbedding,
      vectorChunks: chunks,
      fts,
      topK: opts.topK,
      route: opts.route,
      projectPath: deps.projectPath,
    });
  } finally {
    fts.close();
  }
}

/** Render retrieved hits with their chunk-ids so they can be cited back.
 * When a GroundingContext is supplied, a machine-readable ledger is appended
 * (fenced, last block) so the caller can gate the final answer against the
 * exact context that was delivered this call (B9-14, #470). */
export function formatRetrieval(
  res: HybridResult,
  redactor: Redactor = new Redactor(),
  delivered?: GroundingContext,
): string {
  const head = `retrieve (route: ${res.route}${res.vectorUsed ? ", vector + bm25" : ", bm25 only"}):`;
  if (res.hits.length === 0) {
    return `${head}\nNo relevant chunks found. Grounding: abstain unless other context was delivered.`;
  }
  const lines = res.hits.map((h) => {
    const safeText = redactor.redact(h.text);
    const text = safeText.length > 160 ? `${safeText.slice(0, 160)}…` : safeText;
    return `[${h.score.toFixed(3)}] chunk-id "${h.id}": ${text}`;
  });
  if (!delivered || delivered.chunks.size === 0) {
    return [head, ...lines].join("\n");
  }
  const ledger = [
    "```grounding-ledger",
    "delivered-chunks:",
    ...[...delivered.chunks.keys()].map((id) => `- ${id}`),
    "answers MUST cite only these ids (or delivered file:line); otherwise abstain.",
    "```",
  ];
  return [head, ...lines, ...ledger].join("\n");
}

export function createRetrieveTool(deps: RetrieveDeps): ToolDef {
  const search = deps.search ?? ((o) => defaultSearch(deps, o));
  return {
    name: "retrieve",
    group: "read",
    description:
      "Explicitly retrieve relevant memory/project chunks for a query. Returns ranked hits with chunk-ids. " +
      "Answers may be given ONLY from the returned context: cite a delivered chunk-id (or file:line) for every " +
      "claim, and abstain (say you don't know) if no relevant chunk is returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        topK: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    async handler(args, ctx) {
      const query = String(args.query).trim();
      if (!query) throw new Error("query must not be empty");
      const topK = Math.min(10, Math.max(1, Number(args.topK) || 5));
      const res = await search({ query, topK });
      // B9-14 (#470): the delivered-context contract is now ENFORCED, not just
      // documented. The tool output embeds a grounding ledger: the exact chunk
      // ids + texts delivered this call, so the agent loop can gate the final
      // answer against what was actually handed to the model (see
      // GroundingContext). Zero hits still returns the abstain instruction.
      const delivered: GroundingContext = {
        chunks: new Map(res.hits.map((h) => [h.id, h.text])),
        files: new Map(),
      };
      return formatRetrieval(res, ctx.redactor ?? new Redactor(), delivered);
    },
  };
}
