import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "./registry";
import type { EmbeddingProvider } from "../provider/embeddings";
import {
  loadChunks,
  searchChunks,
  type SearchOptions,
  type VectorStore,
} from "../memory/vector-store";
import { recordLearning } from "../memory/learnings";
import { checkForContradictions } from "../memory/contradiction";
import type { Provider } from "../provider/types";
import {
  CORE_BLOCK_NAMES,
  editCoreBlock,
  DEFAULT_CORE_BUDGET_TOKENS,
} from "../memory/inject";
import { Redactor } from "../security/redact";

export function factsPath(memoryDirPath: string): string {
  return join(memoryDirPath, "facts.md");
}

export function readFacts(memoryDirPath: string): string | null {
  const path = factsPath(memoryDirPath);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  return raw || null;
}

export function createRememberTool(deps: {
  memoryDirPath: string;
}): ToolDef {
  return {
    name: "remember",
    group: "write",
    description:
      "Persist a durable fact about the user or project to long-term memory. Use for stable preferences and decisions, not transient state.",
    inputSchema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "One concise, self-contained fact" },
      },
      required: ["fact"],
    },
    async handler(args, ctx) {
      const fact = String(args.fact).trim();
      if (!fact) throw new Error("fact must not be empty");
      const path = factsPath(deps.memoryDirPath);
      mkdirSync(deps.memoryDirPath, { recursive: true });
      const line = `- [${new Date().toISOString().slice(0, 10)}] ${fact.replace(/\n+/g, " ")}`;
      appendFileSync(path, `${line}\n`);
      return `Remembered: ${line}`;
    },
  };
}

export function createRecordLearningTool(deps: {
  memoryDirPath: string;
  projectPath: string;
  /** Source session to attribute the learning to. When absent, "manual". */
  sessionId?: string;
  /** Entries kept per learnings.md file (#204); defaults to DEFAULT_MAX_LEARNINGS. */
  maxEntries?: number;
  /** Opt-in contradiction check (IdeaGraph-derived): when enabled and a
   *  provider is present, judge the recorded learning against the ACTIVE facts
   *  in `memoryDirPath` and append a warning to the tool output when it
   *  contradicts one. Reuses the consolidation helper/cheap model. Off by
   *  default; never blocks the write and never breaks on judge failure. */
  contradictionCheck?: {
    enabled?: boolean;
    provider?: Provider;
    model?: string;
    maxChecks?: number;
    audit?: (kind: string, detail: string) => void;
  };
}): ToolDef {
  return {
    name: "record_learning",
    group: "write",
    description:
      "Distill a durable, deduplicated learning (fact plus source session) into long-term memory for this bot and project. Use near the end of a session to capture the 1-3 most important takeaways; recording the same fact again replaces the earlier entry. The oldest entries are dropped if the file grows past its cap.",
    inputSchema: {
      type: "object",
      properties: {
        learning: {
          type: "string",
          description: "One concise, self-contained learning",
        },
      },
      required: ["learning"],
    },
    async handler(args) {
      const learning = String(args.learning).trim();
      if (!learning) throw new Error("learning must not be empty");
      const { deduped } = recordLearning(
        deps.memoryDirPath,
        deps.projectPath,
        learning,
        deps.sessionId ?? "manual",
        deps.maxEntries,
      );

      // Opt-in contradiction check: surface (not block) a conflict so the agent
      // can correct or supersede it, rather than recording it silently.
      let warning = "";
      const cc = deps.contradictionCheck;
      if (cc?.enabled && cc.provider && cc.model) {
        try {
          const records = await checkForContradictions({
            provider: cc.provider,
            model: cc.model,
            memoryDir: deps.memoryDirPath,
            candidates: [learning],
            candidateIdPrefix: "tool:record_learning",
            maxChecks: cc.maxChecks,
            audit: cc.audit,
          });
          if (records.length > 0) {
            const r = records[0]!;
            warning = `\nWARNING: '${learning}' contradicts active fact '${r.targetFactText}' (${r.reason || "conflict"}) — consider superseding it.`;
          }
        } catch {
          /* best-effort: a judge failure never breaks the tool */
        }
      }
      return `Recorded learning${deduped ? " (replaced a duplicate)" : ""}: ${learning}${warning}`;
    },
  };
}

export function createRecallTool(deps: {
  memoryDirPath: string;
  projectPath: string;
  embeddings: EmbeddingProvider | null;
  /** Optional in-memory index; when provided, search runs against it instead of
   *  re-loading the whole chunk log on every call. */
  store?: VectorStore;
}): ToolDef {
  return {
    name: "recall",
    group: "read",
    description:
      "Semantically search past session memories of this project. Returns the most relevant snippets with dates and scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for" },
        topK: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
    async handler(args, ctx) {
      if (!deps.embeddings) {
        return "Semantic recall unavailable: no embedding provider configured (set OPENAI_API_KEY).";
      }
      const query = String(args.query).trim();
      if (!query) throw new Error("query must not be empty");
      const [vector] = await deps.embeddings.embed([query]);
      if (!vector) throw new Error("embedding provider returned no vector");
      const opts: SearchOptions = {
        query: vector,
        topK: Math.min(10, Math.max(1, Number(args.topK) || 5)),
        projectPath: deps.projectPath,
        minScore: 0.15,
        embedModel: deps.embeddings.model,
      };
      const { hits, skipped } = deps.store
        ? deps.store.search(opts)
        : searchChunks(loadChunks(join(deps.memoryDirPath, "vectors.jsonl")), opts);
      const warnings: string[] = [];
      if (skipped > 0) {
        warnings.push(
          `${skipped} chunk(s) skipped: stored embedding model/dimension differs from "${deps.embeddings.model}" (${vector.length}d)`,
        );
      }
      const prefix = warnings.length > 0 ? `${warnings.join("; ")}\n` : "";
      if (hits.length === 0) return `${prefix}No relevant memories found.`;
      const redactor = ctx.redactor ?? new Redactor();
      return (
        prefix +
        hits
          .map((h) => {
            const date = h.chunk.created.slice(0, 10);
            const safeText = redactor.redact(h.chunk.text);
            const text = safeText.length > 150 ? `${safeText.slice(0, 150)}…` : safeText;
            return `[${h.score.toFixed(2)}] ${date} ${h.chunk.sessionId} ${h.chunk.role}: ${text}`;
          })
          .join("\n")
      );
    },
  };
}

/**
 * B9-1 (#363): the block-scoped core-memory edit primitive. The agent may only
 * add/replace/remove the named Tier-0 blocks (persona, user, learnings-synopsis,
 * conventions). Overflowing a block's budget throws an instructive error naming
 * the block + budget (nothing is written), forcing the model to self-consolidate.
 */
export function createCoreMemoryTool(deps: {
  memoryDirPath: string;
  /** Per-block token budget override; defaults to DEFAULT_CORE_BUDGET_TOKENS. */
  budgetTokens?: number;
}): ToolDef {
  return {
    name: "core_memory",
    group: "write",
    description:
      "Edit a named Tier-0 core-memory block (persona, user, learnings-synopsis, conventions). " +
      "Only these blocks are editable. op=add/replace sets a block's content; op=remove clears it. " +
      "Each block has a hard token budget — exceeding it returns an error and writes nothing, so " +
      "consolidate or shorten instead of growing it.",
    inputSchema: {
      type: "object",
      properties: {
        block: {
          type: "string",
          enum: [...CORE_BLOCK_NAMES],
          description: "Which core-memory block to edit",
        },
        op: {
          type: "string",
          enum: ["add", "replace", "remove"],
          description: "add/replace set content; remove clears the block",
        },
        content: {
          type: "string",
          description: "New content for the block (ignored for remove)",
        },
      },
      required: ["block", "op"],
    },
    async handler(args, _ctx) {
      const block = String(args.block);
      const op = String(args.op);
      if (op !== "add" && op !== "replace" && op !== "remove") {
        throw new Error(`Invalid core-memory op "${op}". Valid ops: add, replace, remove.`);
      }
      const content = args.content == null ? "" : String(args.content);
      const result = editCoreBlock(
        deps.memoryDirPath,
        block,
        op,
        content,
        deps.budgetTokens ?? DEFAULT_CORE_BUDGET_TOKENS,
      );
      if (op === "remove") return `Cleared core-memory block "${result.block}".`;
      return `Set core-memory block "${result.block}" (${result.content.length} chars).`;
    },
  };
}
