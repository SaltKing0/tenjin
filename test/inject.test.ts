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

test("respects maxChars budget by dropping oldest first", () => {
  const longText = "x".repeat(1000);
  const entries = [
    entry("s1", "/p", "2026-08-21T01:00:00Z", longText),
    entry("s2", "/p", "2026-08-20T01:00:00Z", longText),
    entry("s3", "/p", "2026-08-19T01:00:00Z", longText),
  ];
  const section = buildMemorySection(entries, { currentProject: "/p", maxChars: 2400 });
  expect(section).not.toBeNull();
  if (!section) throw new Error("unreachable");
  expect(section).toContain("(s1)");
  expect(section).toContain("(s2)");
  expect(section).not.toContain("(s3)");
  expect(section.length).toBeLessThanOrEqual(2400);
});

test("truncates a single oversized summary instead of dropping it", () => {
  const section = buildMemorySection(
    [entry("big", "/p", "2026-08-21T01:00:00Z", "y".repeat(5000))],
    { currentProject: "/p", maxChars: 1000 },
  );
  expect(section).toContain("(big):");
  expect(section?.length).toBeLessThanOrEqual(1000);
  expect(section?.endsWith("…")).toBe(true);
});

test("section includes header lines", () => {
  const section = buildMemorySection([entry("a", "/p", "c", "did things")], {
    currentProject: "/p",
  });
  expect(section?.startsWith("# Memory — recent sessions in this project")).toBe(true);
});
