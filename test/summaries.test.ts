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
