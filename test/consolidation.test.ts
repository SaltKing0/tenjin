import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runConsolidation,
  shouldConsolidate,
  newConsolidationTracker,
  DEFAULT_CONSOLIDATION_THRESHOLD,
  DEFAULT_CONSOLIDATION_MIN_TURNS,
} from "../src/memory/consolidate";
import { readSummary, summaryPath } from "../src/memory/summaries";
import { readLearnings, learningsPath } from "../src/memory/learnings";
import { SessionLog } from "../src/session/log";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-consol-home-"));
  project = mkdtempSync(join(tmpdir(), "tj-consol-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

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

function seedSession(text = "fix the parser"): SessionLog {
  const log = SessionLog.create(home);
  log.append({ t: "session_start", id: log.id, ts: "t", provider: "anthropic", model: "test-model" });
  log.append({ t: "message", role: "user", content: text, ts: "t" });
  log.append({ t: "message", role: "assistant", content: [{ type: "text", text: "done" }], ts: "t" });
  return log;
}

const VALID_JSON =
  '{"summary":"Fixed the parser and added tests.","learnings":["project uses zero deps","parser needs fuzz tests"]}';

describe("shouldConsolidate (B9-3 trigger gate)", () => {
  test("fires on first threshold crossing", () => {
    const t = newConsolidationTracker();
    expect(shouldConsolidate(t, 0, DEFAULT_CONSOLIDATION_THRESHOLD)).toBe(true);
    expect(shouldConsolidate(t, 0, 0.9)).toBe(true);
  });

  test("below threshold never fires", () => {
    const t = newConsolidationTracker();
    expect(shouldConsolidate(t, 5, 0.1)).toBe(false);
    expect(shouldConsolidate(t, 5, 0.6)).toBe(false);
    // even at a high iteration count with no prior run
    expect(shouldConsolidate(t, 99, 0.64)).toBe(false);
  });

  test("skips within the window unless pressure strictly rises", () => {
    const t = newConsolidationTracker();
    // first run at high pressure
    expect(shouldConsolidate(t, 3, 0.8)).toBe(true);
    t.lastRunIteration = 3;
    t.lastRunPressureRatio = 0.8;
    // soon after, same/lower pressure -> skip (mid-stream / no new pressure)
    expect(shouldConsolidate(t, 4, 0.8)).toBe(false);
    expect(shouldConsolidate(t, 5, 0.79)).toBe(false);
    // strictly higher pressure -> allowed even within the window
    expect(shouldConsolidate(t, 5, 0.9)).toBe(true);
    // beyond the window -> allowed at same pressure
    expect(shouldConsolidate(t, 3 + DEFAULT_CONSOLIDATION_MIN_TURNS + 1, 0.8)).toBe(true);
  });
});

describe("runConsolidation (B9-3 pass)", () => {
  test("threshold crossing triggers exactly one helper call and writes both tiers", async () => {
    const log = seedSession("fix the parser");
    const provider = mockProvider(VALID_JSON);
    const audits: string[] = [];

    const result = await runConsolidation({
      provider,
      model: "cheap-model",
      maxTokens: 1024,
      sessionKey: log.id,
      memoryDir: home,
      projectPath: project,
      sessionLog: log,
      audit: (kind, detail) => audits.push(`${kind}: ${detail}`),
    });

    // exactly one call
    expect(provider.requests).toHaveLength(1);
    expect(result.ran).toBe(true);
    if (!result.ran) throw new Error("unreachable");
    expect(result.summaryWritten).toBe(true);
    expect(result.learningsAdded).toBe(2);

    // summary written to the summaries tier, pointer advanced past the events
    const summary = readSummary(summaryPath(home, log.id));
    expect(summary?.text).toContain("Fixed the parser");
    expect(summary?.meta.uptoEvent).toBe(3);

    // learnings written to the learnings tier, attributed to this session
    const learnings = readLearnings(home, project);
    expect(learnings?.map((l) => l.fact).sort()).toEqual([
      "parser needs fuzz tests",
      "project uses zero deps",
    ]);

    // the single call went to the helper model with the recall folded in
    expect(provider.requests[0]?.model).toBe("cheap-model");
    const prompt = String(provider.requests[0]?.messages[0]?.content);
    expect(prompt).toContain("fix the parser");

    // pass logged to the audit trail
    expect(audits.some((a) => a.startsWith("consolidation: consolidation ran"))).toBe(true);
  });

  test("learnings dedupe collapses overlapping entries across passes", async () => {
    const log = seedSession("fix the parser");
    const provider = mockProvider(VALID_JSON);
    const input = {
      provider,
      model: "m",
      maxTokens: 1024,
      sessionKey: log.id,
      memoryDir: home,
      projectPath: project,
      sessionLog: log,
    };

    const first = await runConsolidation(input);
    expect(first.ran).toBe(true);
    if (!first.ran) throw new Error("unreachable");
    expect(first.learningsAdded).toBe(2);
    expect(first.learningsDeduped).toBe(0);

    // Second pass proposes one existing + one new fact -> dedupe the existing.
    const provider2 = mockProvider(
      '{"summary":"Fixed the parser and added tests.","learnings":["project uses zero deps","new fact here"]}',
    );
    const second = await runConsolidation({ ...input, provider: provider2 });
    expect(second.ran).toBe(true);
    if (!second.ran) throw new Error("unreachable");
    expect(second.learningsAdded).toBe(1);
    expect(second.learningsDeduped).toBe(1);

    const learnings = readLearnings(home, project);
    expect(learnings?.map((l) => l.fact)).toContain("new fact here");
    // the existing fact was not duplicated
    const count = learnings?.filter((l) => l.fact === "project uses zero deps").length;
    expect(count).toBe(1);
  });

  test("helper-model failure degrades gracefully — session continues unconsolidated", async () => {
    const log = seedSession("fix the parser");
    const audits: string[] = [];
    const failing: Provider = {
      name: "failing",
      async chat() {
        throw new Error("api down");
      },
    };

    let result;
    try {
      result = await runConsolidation({
        provider: failing,
        model: "m",
        maxTokens: 1024,
        sessionKey: log.id,
        memoryDir: home,
        projectPath: project,
        sessionLog: log,
        audit: (kind, detail) => audits.push(`${kind}: ${detail}`),
      });
    } catch (e) {
      throw new Error(`must not throw, got: ${(e as Error).message}`);
    }

    expect(result.ran).toBe(false);
    expect(result.reason).toBe("failed");
    // nothing written to either tier
    expect(readSummary(summaryPath(home, log.id))).toBeNull();
    expect(readLearnings(home, project)).toBeNull();
    // failure logged to the audit trail
    expect(audits.some((a) => a.includes("helper model failed (api down)"))).toBe(true);
  });

  test("unparseable helper output is skipped gracefully", async () => {
    const log = seedSession("x");
    const provider = mockProvider("sorry, no JSON here");
    const result = await runConsolidation({
      provider,
      model: "m",
      maxTokens: 1024,
      sessionKey: log.id,
      memoryDir: home,
      projectPath: project,
      sessionLog: log,
    });
    expect(result.ran).toBe(false);
    expect(provider.requests).toHaveLength(1);
  });

  test("learnings file lands in the expected per-project path", async () => {
    const log = seedSession("y");
    await runConsolidation({
      provider: mockProvider(VALID_JSON),
      model: "m",
      maxTokens: 1024,
      sessionKey: log.id,
      memoryDir: home,
      projectPath: project,
      sessionLog: log,
    });
    // learningsPath is the on-disk tier location (existsSync under it).
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    expect(existsSync(learningsPath(home, project))).toBe(true);
  });
});
