import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStagedCompaction,
  resolveStage,
  shouldMutate,
  newTracker,
  DEFAULT_STAGES,
} from "../src/session/compaction";
import type { ChatMessage, ContentBlock } from "../src/provider/types";

function toolMsg(toolUseId: string, content: string): ChatMessage {
  return { role: "user", content: [{ type: "tool_result", toolUseId, content }] };
}

function block(m: ChatMessage, idx: number): ContentBlock {
  return (m.content as ContentBlock[])[idx]!;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "tenjin-compaction-"));
}

describe("stage resolution (table-driven)", () => {
  test("each stage fires at its calibrated threshold", () => {
    expect(DEFAULT_STAGES).toMatchObject({ warn: 0.7, elide: 0.8, elideDeep: 0.85, summarize: 0.9, critical: 0.99 });
    expect(resolveStage(0.5)).toBe(0);
    expect(resolveStage(0.75)).toBe(1); // warn
    expect(resolveStage(0.82)).toBe(2); // elide
    expect(resolveStage(0.95)).toBe(4); // summarize
  });

  test("config-driven table overrides thresholds", () => {
    const table = { warn: 0.5, elide: 0.6, summarize: 0.8 };
    expect(resolveStage(0.55, table)).toBe(1);
    expect(resolveStage(0.7, table)).toBe(2);
    expect(resolveStage(0.85, table)).toBe(4);
  });
});

describe("stage 2 — pointer replacement + non-lossy offload", () => {
  test("old tool output pointer-replaced, last-N verbatim, original recoverable from archive", async () => {
    const dir = tmpDir();
    const original = "ORIGINAL TOOL OUTPUT " + "x".repeat(500);
    const msgs = [toolMsg("tr1", original), toolMsg("tr2", "second-result")];
    try {
      const res = await runStagedCompaction(msgs, {
        pressureTokens: 850,
        windowTokens: 1000,
        archiveDir: dir,
        sessionKey: "sess",
        keepLast: 1,
      });
      expect(res.stage).toBe(2);
      expect(res.mutated).toBe(true);
      expect(res.elidedCount).toBe(1);
      // Oldest (tr1) replaced by a pointer; marker present.
      expect((block(msgs[0]!, 0) as { content: string }).content).toBe("[tool result archived → tr1]");
      // Last-1 (tr2) kept verbatim.
      expect((block(msgs[1]!, 0) as { content: string }).content).toBe("second-result");
      // Archive file exists and contains the evicted content byte-exact.
      const archivePath = join(dir, "sess.md");
      expect(existsSync(archivePath)).toBe(true);
      expect(readFileSync(archivePath, "utf8")).toContain(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stage 4 — summarize", () => {
  test("keeps last-N verbatim; injects summary + archive path; archive byte-exact", async () => {
    const dir = tmpDir();
    const msgs = [toolMsg("tr1", "content-one"), toolMsg("tr2", "content-two"), toolMsg("tr3", "content-three")];
    try {
      const summarize = async (seg: string) => `SUMMARY(${seg.length})`;
      const res = await runStagedCompaction(msgs, {
        pressureTokens: 950,
        windowTokens: 1000,
        archiveDir: dir,
        sessionKey: "sess",
        keepLast: 1,
        summarize,
      });
      expect(res.stage).toBe(4);
      expect(res.summaryInjected).toBe(true);
      // Note unshifted to the front: [note, tr1', tr2', tr3'].
      expect(String(msgs[0]!.content)).toContain("Summary: SUMMARY(");
      expect(String(msgs[0]!.content)).toContain("Full history archived at");
      // Last-1 (tr3, now index 3) stays verbatim.
      expect((block(msgs[3]!, 0) as { content: string }).content).toBe("content-three");
      // Older two offloaded byte-exact.
      const archiveText = readFileSync(join(dir, "sess.md"), "utf8");
      expect(archiveText).toContain("content-one");
      expect(archiveText).toContain("content-two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("summarize failure falls back to archive-only (still injects path)", async () => {
    const dir = tmpDir();
    const msgs = [toolMsg("tr1", "content-one"), toolMsg("tr2", "content-two")];
    try {
      const res = await runStagedCompaction(msgs, {
        pressureTokens: 950,
        windowTokens: 1000,
        archiveDir: dir,
        sessionKey: "sess",
        keepLast: 0,
        summarize: async () => {
          throw new Error("cheap model unavailable");
        },
      });
      expect(res.stage).toBe(4);
      expect(res.summaryInjected).toBe(true);
      expect(String(msgs[0]!.content)).toContain("Full history archived at");
      expect(String(msgs[0]!.content)).not.toContain("Summary:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stage 1 — warn only", () => {
  test("warn stage never mutates messages", async () => {
    const dir = tmpDir();
    const msgs = [toolMsg("tr1", "hello")];
    const warns: string[] = [];
    try {
      const res = await runStagedCompaction(msgs, {
        pressureTokens: 750,
        windowTokens: 1000,
        archiveDir: dir,
        sessionKey: "sess",
        warn: (m) => warns.push(m),
      });
      expect(res.stage).toBe(1);
      expect(res.mutated).toBe(false);
      expect(warns.length).toBeGreaterThan(0);
      expect((block(msgs[0]!, 0) as { content: string }).content).toBe("hello");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cache law", () => {
  test("no re-compaction within N turns without pressure escalation", () => {
    const t = newTracker();
    expect(shouldMutate(t, 0, 2, 1)).toBe(true); // first mutation allowed
    t.lastMutatedIteration = 0;
    t.lastStage = 2;
    expect(shouldMutate(t, 1, 2, 1)).toBe(false); // same stage, consecutive → skip
    expect(shouldMutate(t, 1, 4, 1)).toBe(true); // escalated to higher stage → allow
    expect(shouldMutate(t, 5, 2, 1)).toBe(true); // gap >= minTurnsBetween → allow
  });

  test("stage 0 never mutates regardless of history", () => {
    const t = newTracker();
    t.lastMutatedIteration = 0;
    t.lastStage = 2;
    expect(shouldMutate(t, 1, 0, 1)).toBe(false);
  });
});
