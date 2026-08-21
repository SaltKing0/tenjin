import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRecallTool,
  createRememberTool,
  factsPath,
  readFacts,
} from "../src/tools/memory";
import { dispatch } from "../src/tools/registry";
import { appendChunks, type VectorChunk } from "../src/memory/vector-store";
import type { EmbeddingProvider } from "../src/provider/embeddings";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-memtools-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fakeEmbeddings: EmbeddingProvider = {
  name: "fake",
  model: "fake-1",
  async embed(texts) {
    return texts.map((t) => [
      t.includes("auth") ? 1 : 0,
      t.includes("garden") ? 1 : 0,
    ]);
  },
};

function seedVector(id: string, text: string, embedding: number[], project = "/proj"): void {
  const sessionId = id.split(":")[0] ?? id;
  const c: VectorChunk = {
    id,
    sessionId,
    projectPath: project,
    role: "user",
    text,
    embedding,
    created: "2026-08-21T00:00:00Z",
  };
  appendChunks(join(dir, "vectors.jsonl"), [c]);
}

describe("remember", () => {
  const remember = (fact: string) =>
    dispatch([createRememberTool({ memoryDirPath: dir })], "remember", { fact }, { cwd: dir });

  test("appends dated fact to facts.md", async () => {
    const r = await remember("prefers bun over npm");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Remembered");
    const raw = readFileSync(factsPath(dir), "utf8");
    expect(raw).toMatch(/^- \[\d{4}-\d{2}-\d{2}\] prefers bun over npm$/m);
  });

  test("multiple facts accumulate", async () => {
    await remember("fact one");
    await remember("fact two");
    expect(readFacts(dir)?.split("\n")).toHaveLength(2);
  });

  test("newlines in facts are collapsed", async () => {
    await remember("line one\nline two");
    expect(readFacts(dir)).not.toContain("\nline two");
  });

  test("empty fact rejected", async () => {
    expect((await remember("   ")).ok).toBe(false);
  });
});

describe("recall", () => {
  const makeTool = (embeddings: EmbeddingProvider | null = fakeEmbeddings) =>
    createRecallTool({ memoryDirPath: dir, projectPath: "/proj", embeddings });

  const recall = (query: string, embeddings?: EmbeddingProvider | null) =>
    dispatch([makeTool(embeddings)], "recall", { query }, { cwd: dir });

  test("returns scored hits scoped to project, sorted by relevance", async () => {
    seedVector("s1:0", "fixed the auth bug today", [1, 0]);
    seedVector("s2:0", "garden watering schedule", [0, 1]);
    seedVector("s3:0", "auth middleware refactor", [0.9, 0.1]);
    seedVector("sx:0", "other project auth", [1, 0], "/elsewhere");

    const r = await recall("auth bug");
    expect(r.ok).toBe(true);
    const lines = r.output.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("s1 user: fixed the auth bug today");
    expect(lines[0]).toMatch(/^\[1\.00\]/);
    expect(r.output).not.toContain("/elsewhere");
    expect(r.output).not.toContain("garden");
  });

  test("no matches message when nothing relevant", async () => {
    seedVector("s1:0", "garden stuff", [0, 1]);
    const r = await recall("quantum physics");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("No relevant memories");
  });

  test("reports unavailable without embedding provider", async () => {
    const r = await recall("anything", null);
    expect(r.output).toContain("unavailable");
    expect(r.output).toContain("OPENAI_API_KEY");
  });

  test("topK respected", async () => {
    for (let i = 0; i < 8; i++) {
      seedVector(`s${i}:0`, `auth thing ${i}`, [1, i / 10]);
    }
    const r = await dispatch(
      [makeTool()],
      "recall",
      { query: "auth", topK: 3 },
      { cwd: dir },
    );
    expect(r.output.split("\n")).toHaveLength(3);
  });
});
