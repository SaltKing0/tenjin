import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  learningsPath,
  readLearnings,
  recordLearning,
  parseLearnings,
} from "../src/memory/learnings";
import { buildMemorySection } from "../src/memory/inject";
import { createRecordLearningTool } from "../src/tools/memory";
import { dispatch } from "../src/tools/registry";
import type { SummaryEntry } from "../src/memory/summaries";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tj-learn-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function entry(sessionId: string, projectPath: string, created: string, text: string): SummaryEntry {
  return {
    path: `/summaries/${sessionId}.md`,
    meta: { sessionId, projectPath, uptoEvent: 10, created },
    text,
  };
}

describe("recordLearning", () => {
  test("writes a dated learning with its source session", () => {
    const { path } = recordLearning(dir, "/proj", "Use bun for tests", "sess-1");
    expect(path).toBe(learningsPath(dir, "/proj"));
    const raw = readFileSync(path, "utf8");
    expect(raw).toMatch(/^-\s*\[\d{4}-\d{2}-\d{2}\] \(sess-1\): Use bun for tests$/m);
    const entries = readLearnings(dir, "/proj");
    expect(entries).toHaveLength(1);
    const only = entries![0];
    expect(only?.sessionId).toBe("sess-1");
    expect(only?.fact).toBe("Use bun for tests");
  });

  test("deduplicates: recording the same fact replaces the old entry", () => {
    recordLearning(dir, "/proj", "Use bun for tests", "sess-1");
    const second = recordLearning(dir, "/proj", "use  bun   for tests", "sess-2");
    expect(second.deduped).toBe(true);
    const entries = readLearnings(dir, "/proj");
    expect(entries).toHaveLength(1);
    // The newer source session wins.
    expect(entries![0]?.sessionId).toBe("sess-2");
  });

  test("different facts accumulate", () => {
    recordLearning(dir, "/proj", "fact one", "s1");
    recordLearning(dir, "/proj", "fact two", "s2");
    expect(readLearnings(dir, "/proj")).toHaveLength(2);
  });

  test("projects are isolated per file", () => {
    recordLearning(dir, "/proj-a", "about a", "s1");
    recordLearning(dir, "/proj-b", "about b", "s2");
    expect(learningsPath(dir, "/proj-a")).not.toBe(learningsPath(dir, "/proj-b"));
    expect(readLearnings(dir, "/proj-a")).toHaveLength(1);
    expect(readLearnings(dir, "/proj-b")).toHaveLength(1);
  });

  test("newlines in facts are collapsed", () => {
    recordLearning(dir, "/proj", "line one\nline two", "s1");
    const entries = readLearnings(dir, "/proj");
    expect(entries![0]?.fact).not.toContain("\n");
  });

  test("parseLearnings round-trips the on-disk format", () => {
    const raw = "- [2026-08-21] (sess-9): a takeaway\n";
    const entries = parseLearnings(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ created: "2026-08-21", sessionId: "sess-9", fact: "a takeaway" });
  });

  test("readLearnings returns null when nothing recorded", () => {
    expect(readLearnings(dir, "/proj")).toBeNull();
  });
});

describe("createRecordLearningTool", () => {
  const tool = (sessionId?: string) =>
    createRecordLearningTool({ memoryDirPath: dir, projectPath: "/proj", sessionId });

  test("records via the tool and reports success", async () => {
    const r = await dispatch([tool("s1")], "record_learning", { learning: "Use slept-check" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Recorded learning");
    expect(r.output).toContain("Use slept-check");
    expect(readLearnings(dir, "/proj")).toHaveLength(1);
  });

  test("empty learning rejected", async () => {
    const r = await dispatch([tool("s1")], "record_learning", { learning: "   " }, { cwd: dir });
    expect(r.ok).toBe(false);
  });

  test("reports when a duplicate was replaced", async () => {
    await dispatch([tool("s1")], "record_learning", { learning: "Do X" }, { cwd: dir });
    const r = await dispatch([tool("s2")], "record_learning", { learning: "do x" }, { cwd: dir });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("replaced a duplicate");
    expect(readLearnings(dir, "/proj")).toHaveLength(1);
    expect(readLearnings(dir, "/proj")![0]?.sessionId).toBe("s2");
  });
});

describe("buildMemorySection with learnings", () => {
  test("injects learnings before summaries (core tier first)", () => {
    const section = buildMemorySection([entry("sum", "/p", "2026-08-20T00:00:00Z", "summary text")], {
      currentProject: "/p",
      learnings: [{ fact: "durable takeaway", sessionId: "sess-9", created: "2026-08-21" }],
    });
    expect(section).not.toBeNull();
    const lIdx = section?.indexOf("# Learnings") ?? -1;
    const mIdx = section?.indexOf("# Memory — recent sessions") ?? -1;
    expect(lIdx).toBeGreaterThan(-1);
    expect(mIdx).toBeGreaterThan(lIdx);
    expect(section).toContain("durable takeaway");
    expect(section).toContain("summary text");
  });

  test("learnings are shown even when no summaries match the project", () => {
    const section = buildMemorySection([entry("sum", "/other", "2026-08-20T00:00:00Z", "foreign")], {
      currentProject: "/p",
      learnings: [{ fact: "only learning", sessionId: "s0", created: "2026-08-21" }],
    });
    expect(section).not.toBeNull();
    expect(section).toContain("only learning");
    expect(section).not.toContain("foreign");
  });

  test("learnings share the token budget and win over summaries", () => {
    const longSummary = "y".repeat(2000); // ~500 tokens, too big under maxTokens
    const section = buildMemorySection([entry("sum", "/p", "2026-08-20T00:00:00Z", longSummary)], {
      currentProject: "/p",
      maxTokens: 200,
      learnings: [{ fact: "short core takeaway", sessionId: "s0", created: "2026-08-21" }],
    });
    expect(section).not.toBeNull();
    // The core learning fits and is kept.
    expect(section).toContain("short core takeaway");
    // The oversized summary does not displace the earlier learning.
    expect(section?.indexOf("# Learnings")).toBeLessThan(section?.indexOf("# Memory") ?? 0);
  });

  test("still returns null when neither learnings nor matching summaries exist", () => {
    expect(
      buildMemorySection([], { currentProject: "/p", learnings: [] }),
    ).toBeNull();
  });
});
