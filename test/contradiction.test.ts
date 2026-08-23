import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOverlappingFacts,
  llmContradictionJudge,
  readContradictions,
  writeContradiction,
  checkForContradictions,
  contradictionLogPath,
  type ContradictionRecord,
} from "../src/memory/contradiction";
import { writeFact, type FactInput } from "../src/memory/facts";
import { createRecordLearningTool } from "../src/tools/memory";
import { runConsolidation } from "../src/memory/consolidate";
import { SessionLog } from "../src/session/log";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-contra-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function factBase(over: Partial<FactInput> = {}): FactInput {
  return {
    type: "convention",
    tags: ["project"],
    date: "2026-08-22",
    sourceId: "doc-a",
    validFrom: "2026-01-01",
    validTo: null,
    text: "the rule",
    ...over,
  };
}

function mockProvider(reply = "{}"): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure window-overlap pruning (deterministic, no LLM)
// ---------------------------------------------------------------------------
describe("findOverlappingFacts (deterministic window overlap)", () => {
  const facts = [
    { id: "a", text: "x", validFrom: "2026-01-01", validTo: "2026-06-30" },
    { id: "b", text: "y", validFrom: "2026-03-01", validTo: null }, // open end
    { id: "c", text: "z", validFrom: "2027-01-01", validTo: null }, // future
  ];

  test("returns facts whose window overlaps the candidate window", () => {
    const hit = findOverlappingFacts(facts, { validFrom: "2026-05-01", validTo: "2026-07-01" });
    const ids = hit.map((f) => f.id).sort();
    expect(ids).toEqual(["a", "b"]); // a ends 06-30 (overlap), b open-ended
  });

  test("excludes facts entirely before/after the candidate window", () => {
    // bounded candidate window (2026-H2): a ended 06-30, c starts 2027 -> only b
    const hit = findOverlappingFacts(facts, { validFrom: "2026-07-01", validTo: "2026-12-31" });
    const ids = hit.map((f) => f.id).sort();
    expect(ids).toEqual(["b"]);
  });

  test("an open-ended fact window overlaps an open-ended candidate window", () => {
    const hit = findOverlappingFacts(facts, { validFrom: "2026-01-01", validTo: null });
    expect(hit.map((f) => f.id)).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// LLM judge: tolerant JSON parse + graceful degradation
// ---------------------------------------------------------------------------
describe("llmContradictionJudge", () => {
  test("parses a contradicts verdict", async () => {
    const p = mockProvider('{"contradicts": true, "reason": "different values"}');
    const judge = llmContradictionJudge(p, "m");
    const res = await judge("a=1", "a=2");
    expect(res.contradicts).toBe(true);
    expect(res.reason).toBe("different values");
  });

  test("tolerates surrounding prose / fences around the JSON", async () => {
    const p = mockProvider('```json\n{"contradicts": false, "reason": "no conflict"}\n```');
    const judge = llmContradictionJudge(p, "m");
    expect((await judge("x", "y")).contradicts).toBe(false);
  });

  test("degrades to no-contradiction on unparseable output", async () => {
    const p = mockProvider("I cannot determine this");
    const judge = llmContradictionJudge(p, "m");
    const res = await judge("x", "y");
    expect(res.contradicts).toBe(false);
  });

  test("degrades to no-contradiction when the provider throws", async () => {
    const p = {
      name: "mock",
      requests: [] as ChatRequest[],
      async chat(): Promise<ChatResponse> {
        throw new Error("boom");
      },
    };
    const judge = llmContradictionJudge(p, "m");
    const res = await judge("x", "y");
    expect(res.contradicts).toBe(false);
    expect(res.reason).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Persistence: JSON-lines contradiction log
// ---------------------------------------------------------------------------
describe("contradiction log persistence", () => {
  test("writeContradiction appends and readContradictions round-trips", () => {
    const rec: ContradictionRecord = {
      id: "r1",
      candidateText: "new learning",
      candidateId: "session:s1#0",
      targetFactId: "f1",
      targetFactText: "old fact",
      reason: "conflict",
      ts: "2026-08-22T00:00:00.000Z",
    };
    writeContradiction(home, rec);
    const all = readContradictions(home);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(rec);
    expect(contradictionLogPath(home)).toBe(join(home, "contradictions.jsonl"));
  });

  test("readContradictions returns [] when nothing recorded", () => {
    expect(readContradictions(home)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pipeline: checkForContradictions against the facts tier
// ---------------------------------------------------------------------------
describe("checkForContradictions", () => {
  test("records a contradiction against an active overlapping fact", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = mockProvider('{"contradicts": true, "reason": "budget differs"}');
    const audits: string[] = [];
    const records = await checkForContradictions({
      provider: p,
      model: "m",
      memoryDir: home,
      candidates: ["the retry budget is 5"],
      candidateIdPrefix: "session:s1",
      audit: (_k, d) => audits.push(d),
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.targetFactText).toBe("the retry budget is 3");
    expect(records[0]!.candidateId).toBe("session:s1#0");
    // persisted
    expect(readContradictions(home)).toHaveLength(1);
    expect(audits.some((a) => a.includes("contradicts"))).toBe(true);
  });

  test("does not record when the judge says no contradiction", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = mockProvider('{"contradicts": false, "reason": "no conflict"}');
    const records = await checkForContradictions({
      provider: p,
      model: "m",
      memoryDir: home,
      candidates: ["the retry budget is 5"],
      candidateIdPrefix: "session:s1",
    });
    expect(records).toHaveLength(0);
    expect(readContradictions(home)).toHaveLength(0);
  });

  test("never checks EXPIRED facts (only active ones)", async () => {
    writeFact(home, {
      type: "convention",
      tags: [],
      date: "2026-01-01",
      sourceId: "doc-b",
      validFrom: "2025-01-01",
      validTo: "2025-12-31", // expired well before now
      text: "deprecated setting",
    });
    const p = mockProvider('{"contradicts": true, "reason": "x"}');
    const records = await checkForContradictions({
      provider: p,
      model: "m",
      memoryDir: home,
      candidates: ["new setting"],
      candidateIdPrefix: "session:s1",
    });
    // The only stored fact is expired -> no judge call, no record.
    expect(records).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });

  test("capped at maxChecks total judge calls", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "fact one" }));
    writeFact(home, factBase({ sourceId: "doc-b", text: "fact two" }));
    writeFact(home, factBase({ sourceId: "doc-c", text: "fact three" }));
    const p = mockProvider('{"contradicts": true, "reason": "x"}');
    const records = await checkForContradictions({
      provider: p,
      model: "m",
      memoryDir: home,
      candidates: ["new learning"],
      candidateIdPrefix: "s",
      maxChecks: 2,
    });
    // exactly 2 judge calls (requests) happened, 2 records
    expect(p.requests).toHaveLength(2);
    expect(records).toHaveLength(2);
  });

  test("skips a candidate identical to an existing fact (no self-contradiction)", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = mockProvider('{"contradicts": true, "reason": "x"}');
    const records = await checkForContradictions({
      provider: p,
      model: "m",
      memoryDir: home,
      candidates: ["The retry budget is 3."], // same fact, different casing/punct
      candidateIdPrefix: "s",
    });
    expect(records).toHaveLength(0);
    expect(p.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: record_learning tool (opt-in warning, never blocks)
// ---------------------------------------------------------------------------
describe("record_learning contradiction warning", () => {
  test("appends a WARNING when the recorded learning contradicts an active fact", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = mockProvider('{"contradicts": true, "reason": "budget differs"}');
    const tool = createRecordLearningTool({
      memoryDirPath: home,
      projectPath: "/proj",
      contradictionCheck: { enabled: true, provider: p, model: "m" },
    });
    const out = await tool.handler({ learning: "the retry budget is 5" }, { cwd: home } as never);
    expect(out).toContain("Recorded learning");
    expect(out).toContain("WARNING");
    expect(out).toContain("the retry budget is 3");
    // the write still happened AND the contradiction was persisted
    expect(readContradictions(home)).toHaveLength(1);
  });

  test("no warning when disabled or provider absent (normal output)", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const tool = createRecordLearningTool({ memoryDirPath: home, projectPath: "/proj" });
    const out = await tool.handler({ learning: "the retry budget is 5" }, { cwd: home } as never);
    expect(out).toContain("Recorded learning");
    expect(out).not.toContain("WARNING");
    expect(readContradictions(home)).toHaveLength(0);
  });

  test("never throws on judge failure (best-effort)", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = {
      name: "mock",
      requests: [] as ChatRequest[],
      async chat(): Promise<ChatResponse> {
        throw new Error("boom");
      },
    };
    const tool = createRecordLearningTool({
      memoryDirPath: home,
      projectPath: "/proj",
      contradictionCheck: { enabled: true, provider: p, model: "m" },
    });
    const out = await tool.handler({ learning: "the retry budget is 5" }, { cwd: home } as never);
    expect(out).toContain("Recorded learning");
    expect(out).not.toContain("WARNING");
  });
});

describe("runConsolidation contradiction step", () => {
  function seedSession(text = "fix the parser"): SessionLog {
    const log = SessionLog.create(home);
    log.append({ t: "session_start", id: log.id, ts: "t", provider: "mock", model: "test-model" });
    log.append({ t: "message", role: "user", content: text, ts: "t" });
    log.append({ t: "message", role: "assistant", content: [{ type: "text", text: "done" }], ts: "t" });
    return log;
  }

  test("when enabled, records contradictions and reports the count", async () => {
    // Seed one active fact that the new learning will contradict.
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    // First call (consolidation) returns a learning; subsequent judge calls return "contradicts".
    let calls = 0;
    const p: Provider & { requests: ChatRequest[] } = {
      name: "mock",
      requests: [],
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls++;
        p.requests.push(req);
        const reply =
          calls === 1
            ? '{"summary":"fixed","learnings":["the retry budget is 5"]}'
            : '{"contradicts": true, "reason": "budget differs"}';
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: reply }],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      },
    };
    const audits: string[] = [];
    const result = await runConsolidation({
      provider: p,
      model: "m",
      maxTokens: 512,
      sessionKey: "s1",
      memoryDir: home,
      projectPath: "/proj",
      sessionLog: seedSession(),
      contradictionCheck: { enabled: true, maxChecks: 4 },
      audit: (k, d) => audits.push(d),
    });
    expect(result.ran).toBe(true);
    if (result.ran) {
      expect(result.contradictions).toBe(1);
    }
    expect(readContradictions(home)).toHaveLength(1);
  });

  test("when disabled, no contradiction step runs and no extra calls happen", async () => {
    writeFact(home, factBase({ sourceId: "doc-a", text: "the retry budget is 3" }));
    const p = mockProvider(
      '{"summary":"fixed","learnings":["the retry budget is 5"]}',
    );
    const result = await runConsolidation({
      provider: p,
      model: "m",
      maxTokens: 512,
      sessionKey: "s1",
      memoryDir: home,
      projectPath: "/proj",
      sessionLog: seedSession(),
    });
    expect(result.ran).toBe(true);
    if (result.ran) expect(result.contradictions).toBe(0);
    // only the single consolidation call — no judge calls
    expect(p.requests).toHaveLength(1);
    expect(readContradictions(home)).toHaveLength(0);
  });
});
