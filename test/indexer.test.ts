import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionLog } from "../src/session/log";
import {
  extractIndexableTexts,
  indexPendingSessions,
} from "../src/memory/indexer";
import { loadChunks } from "../src/memory/vector-store";
import type { EmbeddingProvider } from "../src/provider/embeddings";
import type { SessionEvent } from "../src/session/events";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-idx-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedSession(...messages: Array<{ role: "user" | "assistant"; content: any }>): SessionLog {
  const log = SessionLog.create(home);
  log.append({ t: "session_start", id: log.id, ts: "t", provider: "a", model: "m" });
  for (const m of messages) {
    log.append({ t: "message", role: m.role, content: m.content, ts: "t" });
  }
  return log;
}

const fakeEmbeddings: EmbeddingProvider = {
  name: "fake",
  model: "fake-1",
  async embed(texts) {
    return texts.map((t) => [
      t.length % 7,
      (t.match(/auth/g) ?? []).length,
      (t.match(/bug/g) ?? []).length,
      t.includes("garden") ? 1 : 0,
    ]);
  },
};

describe("extractIndexableTexts", () => {
  test("pulls user strings and assistant text blocks with event indices", () => {
    const events: SessionEvent[] = [
      { t: "session_start", id: "s", ts: "t", provider: "a", model: "m" },
      { t: "message", role: "user", content: "fix the auth bug", ts: "t" },
      {
        t: "message",
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "x", name: "read_file", input: {} },
        ],
        ts: "t",
      },
      { t: "tool_call", id: "x", name: "read_file", input: {}, ts: "t" },
      { t: "tool_result", id: "x", name: "read_file", ok: true, output: "...", ts: "t" },
    ];
    const out = extractIndexableTexts(events);
    expect(out).toEqual([
      { eventIdx: 1, role: "user", text: "fix the auth bug" },
      { eventIdx: 2, role: "assistant", text: "Looking." },
    ]);
  });

  test("skips empty and block-content user messages", () => {
    const events: SessionEvent[] = [
      { t: "message", role: "user", content: "   ", ts: "t" },
      {
        t: "message",
        role: "user",
        content: [{ type: "tool_result", toolUseId: "q", content: "data" }],
        ts: "t",
      },
    ];
    expect(extractIndexableTexts(events)).toEqual([]);
  });
});

describe("indexPendingSessions", () => {
  const opts = () => ({
    sessionsDirPath: home,
    memoryDirPath: home,
    projectPath: "/proj",
    embeddings: fakeEmbeddings,
  });

  test("indexes sessions into vectors.jsonl with metadata", async () => {
    seedSession(
      { role: "user", content: "fix the auth bug" },
      { role: "assistant", content: [{ type: "text", text: "done fixing" }] },
    );
    const report = await indexPendingSessions(opts());
    expect(report.indexed).toHaveLength(1);
    expect(report.chunks).toBe(2);
    expect(report.errors).toEqual([]);

    const chunks = loadChunks(join(home, "vectors.jsonl"));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.projectPath).toBe("/proj");
    expect(chunks[0]?.embedding).toHaveLength(4);
    expect(chunks[0]?.id).toMatch(/:\d+$/);
  });

  test("second run is a no-op (idempotent)", async () => {
    seedSession({ role: "user", content: "hello garden" });
    const first = await indexPendingSessions(opts());
    expect(first.indexed).toHaveLength(1);
    const second = await indexPendingSessions(opts());
    expect(second.indexed).toHaveLength(0);
    expect(second.chunks).toBe(0);
  });

  test("sessions without indexable content are skipped without error", async () => {
    const log = SessionLog.create(home);
    log.append({ t: "session_start", id: log.id, ts: "t", provider: "a", model: "m" });
    const report = await indexPendingSessions(opts());
    expect(report.indexed).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
  });

  test("embedding failure is reported per-session without killing others", async () => {
    seedSession({ role: "user", content: "first" });
    seedSession({ role: "user", content: "second" });
    let calls = 0;
    const flaky: EmbeddingProvider = {
      name: "flaky",
      model: "f",
      async embed(texts) {
        calls++;
        if (calls === 1) throw new Error("embed down");
        return texts.map(() => [1]);
      },
    };
    const report = await indexPendingSessions({ ...opts(), embeddings: flaky });
    expect(report.errors).toHaveLength(1);
    expect(report.indexed).toHaveLength(1);

    const retry = await indexPendingSessions({ ...opts(), embeddings: flaky });
    expect(retry.indexed).toHaveLength(1);
  });

  test("limit caps sessions per pass", async () => {
    seedSession({ role: "user", content: "one" });
    seedSession({ role: "user", content: "two" });
    seedSession({ role: "user", content: "three" });
    const report = await indexPendingSessions({ ...opts(), limit: 2 });
    expect(report.indexed).toHaveLength(2);
  });
});
