import { describe, test, expect } from "bun:test";
import { buildMemorySection } from "../src/memory/inject";
import type { SummaryEntry } from "../src/memory/summaries";

function entry(
  sessionId: string,
  projectPath: string,
  created: string,
  text: string,
): SummaryEntry {
  return {
    path: `/summaries/${sessionId}.md`,
    meta: { sessionId, projectPath, uptoEvent: 10, created },
    text,
  };
}

test("returns null when no entries match the project", () => {
  const section = buildMemorySection([entry("a", "/other", "2026-08-20", "text")], {
    currentProject: "/mine",
  });
  expect(section).toBeNull();
});

test("returns null for empty input", () => {
  expect(buildMemorySection([], { currentProject: "/mine" })).toBeNull();
});

test("filters to current project and sorts newest first", () => {
  const section = buildMemorySection(
    [
      entry("old", "/mine", "2026-08-19T10:00:00Z", "older work"),
      entry("foreign", "/other", "2026-08-21T10:00:00Z", "not mine"),
      entry("new", "/mine", "2026-08-21T09:00:00Z", "newer work"),
    ],
    { currentProject: "/mine" },
  );
  expect(section).toContain("(new):");
  expect(section).toContain("newer work");
  const newIdx = section?.indexOf("(new)") ?? -1;
  const oldIdx = section?.indexOf("(old)") ?? -1;
  expect(newIdx).toBeGreaterThan(-1);
  expect(oldIdx).toBeGreaterThan(newIdx);
  expect(section).not.toContain("not mine");
});

test("subdirectory project inherits memory from its parent project", () => {
  const section = buildMemorySection(
    [entry("parent", "/proj", "2026-08-20T10:00:00Z", "parent work")],
    { currentProject: "/proj/sub" },
  );
  expect(section).not.toBeNull();
  expect(section).toContain("parent work");
});

test("moving into a subdirectory keeps the parent summary injectable", () => {
  const section = buildMemorySection(
    [entry("child", "/old/proj/sub", "2026-08-20T10:00:00Z", "child work")],
    { currentProject: "/old/proj" },
  );
  expect(section).not.toBeNull();
  expect(section).toContain("child work");
});

test("prefix matching is boundary-aware: /m does not match /mine", () => {
  const section = buildMemorySection([entry("a", "/m", "2026-08-20", "text")], {
    currentProject: "/mine",
  });
  expect(section).toBeNull();
});

test("a directly matching fact outranks an older inherited one", () => {
  const matching = entry("matching", "/proj", "2026-08-10T00:00:00Z", "directly matching fact");
  const inherited = entry("inherited", "/proj/sub", "2026-08-21T00:00:00Z", "inherited new fact");
  const section = buildMemorySection([inherited, matching], { currentProject: "/proj" });
  expect(section).not.toBeNull();
  const mIdx = section?.indexOf("(matching):") ?? -1;
  const iIdx = section?.indexOf("(inherited):") ?? -1;
  expect(mIdx).toBeGreaterThan(-1);
  expect(iIdx).toBeGreaterThan(-1);
  // Higher relevance wins over recency.
  expect(mIdx).toBeLessThan(iIdx);
});

test("respects maxTokens budget by dropping lowest-ranked first", () => {
  const longText = "x".repeat(1000); // ~250 tokens each
  const entries = [
    entry("s1", "/p", "2026-08-21T01:00:00Z", longText),
    entry("s2", "/p", "2026-08-20T01:00:00Z", longText),
    entry("s3", "/p", "2026-08-19T01:00:00Z", longText),
  ];
  const section = buildMemorySection(entries, { currentProject: "/p", maxTokens: 600 });
  expect(section).not.toBeNull();
  if (!section) throw new Error("unreachable");
  expect(section).toContain("(s1)");
  expect(section).toContain("(s2)");
  expect(section).not.toContain("(s3)");
});

test("truncates a single oversized summary instead of dropping it", () => {
  const section = buildMemorySection(
    [entry("big", "/p", "2026-08-21T01:00:00Z", "y".repeat(5000))],
    { currentProject: "/p", maxTokens: 250 },
  );
  expect(section).toContain("(big):");
  expect(section?.endsWith("…")).toBe(true);
});

test("section includes header lines", () => {
  const section = buildMemorySection([entry("a", "/p", "c", "did things")], {
    currentProject: "/p",
  });
  expect(section?.startsWith("# Memory — recent sessions in this project")).toBe(true);
});
