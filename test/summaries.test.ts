import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePendingSummaries,
  generateSummary,
  listSummaries,
  readSummary,
  sessionsWithoutSummary,
  sessionsWithStaleSummary,
  summarizeLatestSession,
  summaryPath,
  writeSummary,
  type SummaryMeta,
} from "../src/memory/summaries";
import { SessionLog } from "../src/session/log";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-mem-home-"));
  project = mkdtempSync(join(tmpdir(), "tj-mem-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function mockProvider(reply = "Worked on auth. Fixed login bug."): Provider & {
  requests: ChatRequest[];
} {
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

function seedSession(withUserText: string): SessionLog {
  const log = SessionLog.create(home);
  log.append({
    t: "session_start",
    id: log.id,
    ts: "t",
    provider: "anthropic",
    model: "test-model",
  });
  log.append({ t: "message", role: "user", content: withUserText, ts: "t" });
  log.append({
    t: "message",
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    ts: "t",
  });
  return log;
}

test("writeSummary + readSummary round-trip frontmatter", () => {
  const meta: SummaryMeta = {
    sessionId: "s1",
    projectPath: "/proj",
    uptoEvent: 42,
    created: "2026-08-21T10:00:00Z",
  };
  writeSummary(home, meta, "Did things.");

  const entry = readSummary(summaryPath(home, "s1"));
  expect(entry).not.toBeNull();
  expect(entry?.meta).toEqual(meta);
  expect(entry?.text).toBe("Did things.");
});

test("readSummary returns null for missing or malformed files", () => {
  expect(readSummary(summaryPath(home, "ghost"))).toBeNull();
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(join(home, "summaries"), { recursive: true });
  const bad = summaryPath(home, "bad");
  writeFileSync(bad, "no frontmatter here");
  expect(readSummary(bad)).toBeNull();
});

test("listSummaries returns all valid entries", () => {
  writeSummary(home, { sessionId: "a", projectPath: "/p", uptoEvent: 1, created: "c" }, "A");
  writeSummary(home, { sessionId: "b", projectPath: "/q", uptoEvent: 2, created: "c" }, "B");
  const all = listSummaries(home);
  expect(all.map((e) => e.meta.sessionId).sort()).toEqual(["a", "b"]);
});

test("readSummary tolerates ids that YAML would mangle if unquoted", () => {
  const meta: SummaryMeta = {
    sessionId: "202608210033-3898",
    projectPath: "/p",
    uptoEvent: 1,
    created: "2026-08-21T10:00:00Z",
  };
  writeSummary(home, meta, "text");
  expect(readSummary(summaryPath(home, meta.sessionId))?.meta.sessionId).toBe(
    "202608210033-3898",
  );
});

test("sessionsWithoutSummary skips summarized ones", () => {
  const a = seedSession("session a");
  const b = seedSession("session b");
  writeSummary(
    home,
    { sessionId: a.id, projectPath: "/p", uptoEvent: 3, created: "c" },
    "summarized",
  );
  const pending = sessionsWithoutSummary(home, home);
  expect(pending.map((l) => l.id)).toEqual([b.id]);
});

test("sessionsWithStaleSummary includes summarized sessions with new events", () => {
  const stale = seedSession("has summary, needs refresh");
  const fresh = seedSession("has summary, no new events");
  const none = seedSession("no summary at all");
  // Both summarized sessions currently have uptoEvent === their event count.
  writeSummary(
    home,
    { sessionId: stale.id, projectPath: "/p", uptoEvent: 3, created: "c" },
    "stale",
  );
  writeSummary(
    home,
    { sessionId: fresh.id, projectPath: "/p", uptoEvent: 3, created: "c" },
    "fresh",
  );

  // New events arrive on `stale` only, pushing it past its pointer.
  stale.append({ t: "message", role: "user", content: "new event", ts: "t" });

  const ids = sessionsWithStaleSummary(home, home).map((l) => l.id);
  // `stale` (delta) and `none` (no summary) are pending; `fresh` is not.
  expect(ids).toContain(stale.id);
  expect(ids).toContain(none.id);
  expect(ids).not.toContain(fresh.id);
});

describe("generateSummary", () => {
  test("writes file with lineage pointer and trajectory-based prompt", async () => {
    const log = seedSession("fix the parser");
    const provider = mockProvider("Parsed the fix session.");

    const text = await generateSummary(log, {
      provider,
      model: "test-model",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
    });

    expect(text).toBe("Parsed the fix session.");
    const entry = readSummary(summaryPath(home, log.id));
    expect(entry?.meta.sessionId).toBe(log.id);
    expect(entry?.meta.projectPath).toBe(project);
    expect(entry?.meta.uptoEvent).toBe(3);

    const prompt = String(provider.requests[0]?.messages[0]?.content);
    expect(prompt).toContain("fix the parser");
    expect(prompt).toContain(`session ${log.id}`);
  });

  test("empty summarizer output throws", async () => {
    const log = seedSession("x");
    await expect(
      generateSummary(log, {
        provider: mockProvider(""),
        model: "m",
        maxTokens: 512,
        projectPath: project,
        memoryDirPath: home,
      }),
    ).rejects.toThrow(/empty output/);
  });
});

describe("generatePendingSummaries", () => {
  test("processes pending sessions and reports errors without dying", async () => {
    const a = seedSession("alpha");
    const b = seedSession("beta");

    let calls = 0;
    const flaky: Provider = {
      name: "flaky",
      async chat() {
        calls++;
        if (calls === 1) {
          return {
            stopReason: "end_turn",
            content: [{ type: "text", text: "summary a" }],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        throw new Error("api down");
      },
    };

    const report = await generatePendingSummaries({
      sessionsDirPath: home,
      memoryDirPath: home,
      provider: flaky,
      model: "m",
      maxTokens: 512,
      projectPath: project,
    });

    expect(report.generated).toHaveLength(1);
    expect(report.errors).toHaveLength(1);
    const errorId = report.errors[0]?.split(":")[0];
    const generatedId = report.generated[0];
    expect(errorId).toBeDefined();
    expect(generatedId).toBeDefined();
    if (!generatedId) throw new Error("unreachable");
    expect(report.generated).not.toContain(errorId);
    expect(existsSync(summaryPath(home, generatedId))).toBe(true);
  });

  test("second run finds nothing pending (idempotent)", async () => {
    seedSession("only one");
    const provider = mockProvider();
    const opts = {
      sessionsDirPath: home,
      memoryDirPath: home,
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
    };
    const first = await generatePendingSummaries(opts);
    expect(first.generated).toHaveLength(1);
    const second = await generatePendingSummaries(opts);
    expect(second.generated).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });

  test("limit caps work per pass", async () => {
    seedSession("one");
    seedSession("two");
    seedSession("three");
    const provider = mockProvider();
    const report = await generatePendingSummaries({
      sessionsDirPath: home,
      memoryDirPath: home,
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      limit: 2,
    });
    expect(report.generated).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
  });

  test("a summarized session with new events is picked up and its delta folded in (#207)", async () => {
    const log = seedSession("original activity");
    const provider = mockProvider("updated summary");
    const opts = {
      sessionsDirPath: home,
      memoryDirPath: home,
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
    };

    // First pass summarizes the session (3 events → uptoEvent 3).
    let report = await generatePendingSummaries(opts);
    expect(report.generated).toContain(log.id);
    expect(readSummary(summaryPath(home, log.id))?.meta.uptoEvent).toBe(3);

    // New activity arrives after the summary was written.
    log.append({ t: "message", role: "user", content: "follow-up work", ts: "t" });
    log.append({
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "more" }],
      ts: "t",
    });

    // A session that already has a summary should still be picked when it has
    // events beyond uptoEvent.
    report = await generatePendingSummaries(opts);
    expect(report.generated).toContain(log.id);
    // The delta was folded in and the pointer advanced.
    expect(readSummary(summaryPath(home, log.id))?.meta.uptoEvent).toBe(5);
    // The incremental pass rendered the new events, not the whole trajectory.
    const prompts = provider.requests.map((r) => String(r.messages?.[0]?.content ?? ""));
    const lastPrompt = prompts[prompts.length - 1] ?? "";
    expect(lastPrompt).toContain("follow-up work");
    expect(lastPrompt).not.toContain("original activity");
  });

  test("a summarized session with no new events stays skipped (#207)", async () => {
    const log = seedSession("stable");
    const provider = mockProvider();
    const opts = {
      sessionsDirPath: home,
      memoryDirPath: home,
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
    };
    await generatePendingSummaries(opts);
    expect(provider.requests).toHaveLength(1);
    // No new events: a second pass makes no further provider call.
    const second = await generatePendingSummaries(opts);
    expect(second.generated).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("incremental summaries (#37)", () => {
  test("second run only passes events after uptoEvent and advances the pointer", async () => {
    const log = seedSession("alpha task");
    const provider = mockProvider("first summary");
    const opts = {
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
    };

    await generateSummary(log, opts);
    expect(provider.requests).toHaveLength(1);
    expect(readSummary(summaryPath(home, log.id))?.meta.uptoEvent).toBe(3);

    // New activity arrives after the first summary has been written.
    log.append({ t: "message", role: "user", content: "beta follow-up", ts: "t" });
    log.append({
      t: "message",
      role: "assistant",
      content: [{ type: "text", text: "more" }],
      ts: "t",
    });

    await generateSummary(log, opts);
    expect(provider.requests).toHaveLength(2);
    const secondPrompt = String(provider.requests[1]?.messages[0]?.content);
    // Only the new events are rendered for the incremental pass.
    expect(secondPrompt).toContain("beta follow-up");
    expect(secondPrompt).not.toContain("alpha task");
    // The prior summary is carried in for continuity.
    expect(secondPrompt).toContain("first summary");
    expect(readSummary(summaryPath(home, log.id))?.meta.uptoEvent).toBe(5);
  });

  test("no new events leaves the existing summary untouched (no provider call)", async () => {
    const log = seedSession("stable");
    const provider = mockProvider("s");
    const opts = {
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
    };
    await generateSummary(log, opts);
    expect(provider.requests).toHaveLength(1);

    await generateSummary(log, opts);
    expect(provider.requests).toHaveLength(1); // no extra call
    expect(readSummary(summaryPath(home, log.id))?.meta.uptoEvent).toBe(3);
  });
});

describe("summarizeLatestSession (#37 gateway path)", () => {
  test("writes a summary for the newest session in the given dirs", async () => {
    const sessions = mkdtempSync(join(tmpdir(), "tj-mem-sess-"));
    try {
      const log = SessionLog.create(sessions);
      log.append({ t: "session_start", id: log.id, ts: "t", provider: "anthropic", model: "m" });
      log.append({ t: "message", role: "user", content: "gateway session work", ts: "t" });

      const provider = mockProvider("gateway summary");
      const res = await summarizeLatestSession({
        sessionsDirPath: sessions,
        memoryDirPath: home,
        provider,
        model: "m",
        maxTokens: 512,
        projectPath: project,
      });

      expect(res?.sessionId).toBe(log.id);
      expect(res?.sessionId).toBeDefined();
      const entry = readSummary(summaryPath(home, log.id));
      expect(entry?.meta.uptoEvent).toBe(2);
      expect(provider.requests).toHaveLength(1);
    } finally {
      rmSync(sessions, { recursive: true, force: true });
    }
  });

  test("returns null when there are no sessions", async () => {
    const sessions = mkdtempSync(join(tmpdir(), "tj-mem-empty-"));
    try {
      const provider = mockProvider("x");
      const res = await summarizeLatestSession({
        sessionsDirPath: sessions,
        memoryDirPath: home,
        provider,
        model: "m",
        maxTokens: 512,
        projectPath: project,
      });
      expect(res).toBeNull();
      expect(provider.requests).toHaveLength(0);
    } finally {
      rmSync(sessions, { recursive: true, force: true });
    }
  });
});

describe("summary full trajectory + map-reduce (#136)", () => {
  function seedManyMessages(n: number, per: number): SessionLog {
    const log = SessionLog.create(home);
    log.append({
      t: "session_start",
      id: log.id,
      ts: "t",
      provider: "anthropic",
      model: "test-model",
    });
    for (let i = 0; i < n; i++) {
      log.append({ t: "message", role: "user", content: `fact ${i} ` + "z".repeat(per), ts: "t" });
    }
    return log;
  }

  test("summary prompt uses complete events, not 160-char truncated lines", async () => {
    const longUser = "head " + "x".repeat(180) + " KEYFACT_BEYOND_160";
    const log = seedSession(longUser);
    const provider = mockProvider("ok");
    await generateSummary(log, {
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
    });

    const prompt = String(provider.requests[0]?.messages[0]?.content);
    expect(prompt).toContain("KEYFACT_BEYOND_160");
    // The fact sits beyond the 160th char, where the old truncating render cut it.
    expect(prompt.indexOf("KEYFACT_BEYOND_160")).toBeGreaterThan(160);
  });

  test("long session map-reduces: chunk summaries then a fusion call", async () => {
    // ~6×150 chars of user text + header ≈ 900+ chars of trajectory.
    const log = seedManyMessages(6, 150);
    const provider = mockProvider("fused");
    const text = await generateSummary(log, {
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
      promptBudgetTokens: 50, // 200 input chars/call → forces multiple chunks
    });

    const prompts = provider.requests.map((r) => String(r.messages?.[0]?.content ?? ""));
    // multiple chunk calls + one fusion call
    expect(prompts.length).toBeGreaterThan(2);
    // every intermediate call is a per-chunk summary …
    for (let i = 0; i < prompts.length - 1; i++) {
      expect(prompts[i] ?? "").toContain("Summarize this portion");
    }
    // … and the final call is the fusion.
    expect(prompts[prompts.length - 1] ?? "").toContain("Partial summaries");

    // The input budget is respected: no single chunk call carries the whole
    // ~900-char trajectory.
    const inputBudget = 50 * 4 + 300; // tokens→chars + fixed prompt overhead
    for (let i = 0; i < prompts.length - 1; i++) {
      expect((prompts[i] ?? "").length).toBeLessThan(inputBudget);
    }

    // The fused summary is what gets written.
    const entry = readSummary(summaryPath(home, log.id));
    expect(entry?.text).toBe("fused");
  });

  test("map-reduce folds an existing summary into the fusion", async () => {
    const log = seedSession("alpha work");
    const provider = mockProvider("first");
    const opts = {
      provider,
      model: "m",
      maxTokens: 512,
      projectPath: project,
      memoryDirPath: home,
    };
    await generateSummary(log, opts);
    expect(provider.requests).toHaveLength(1);

    // A burst of new activity makes the incremental pass overflow the budget.
    for (let i = 0; i < 6; i++) {
      log.append({ t: "message", role: "user", content: `new fact ${i} ` + "y".repeat(150), ts: "t" });
    }
    await generateSummary(log, { ...opts, promptBudgetTokens: 50 });

    const prompts = provider.requests.map((r) => String(r.messages?.[0]?.content ?? ""));
    const last = prompts[prompts.length - 1] ?? "";
    expect(prompts.length).toBeGreaterThan(2);
    expect(last).toContain("Existing summary");
    expect(last).toContain("first"); // prior summary carried into the fusion
  });
});
