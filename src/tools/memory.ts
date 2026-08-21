import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "./registry";
import type { EmbeddingProvider } from "../provider/embeddings";
import { loadChunks, searchChunks } from "../memory/vector-store";

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
    async handler(args, _ctx) {
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

export function createRecallTool(deps: {
  memoryDirPath: string;
  projectPath: string;
  embeddings: EmbeddingProvider | null;
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
    async handler(args, _ctx) {
      if (!deps.embeddings) {
        return "Semantic recall unavailable: no embedding provider configured (set OPENAI_API_KEY).";
      }
      const query = String(args.query).trim();
      if (!query) throw new Error("query must not be empty");
      const [vector] = await deps.embeddings.embed([query]);
      if (!vector) throw new Error("embedding provider returned no vector");
      const chunks = loadChunks(join(deps.memoryDirPath, "vectors.jsonl"));
      const hits = searchChunks(chunks, {
        query: vector,
        topK: Math.min(10, Math.max(1, Number(args.topK) || 5)),
        projectPath: deps.projectPath,
        minScore: 0.15,
      });
      if (hits.length === 0) return "No relevant memories found.";
      return hits
        .map((h) => {
          const date = h.chunk.created.slice(0, 10);
          const text = h.chunk.text.length > 150 ? `${h.chunk.text.slice(0, 150)}…` : h.chunk.text;
          return `[${h.score.toFixed(2)}] ${date} ${h.chunk.sessionId} ${h.chunk.role}: ${text}`;
        })
        .join("\n");
    },
  };
}
