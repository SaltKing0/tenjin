import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CORE_BLOCK_NAMES,
  CORE_BLOCK_LABELS,
  DEFAULT_CORE_BUDGET_TOKENS,
  editCoreBlock,
  emptyCoreBlocks,
  isCoreBlockName,
  loadCoreBlocks,
  renderCoreMemory,
  saveCoreBlocks,
  type CoreBlockName,
  type CoreBlocks,
} from "../src/memory/inject";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "stealth-memory-blocks-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function filled(): CoreBlocks {
  return {
    persona: "Tenjin, a precise pragmatic coding agent.",
    user: "Prefers concise, terminal-friendly answers.",
    "learnings-synopsis": "Verify APIs against real code.",
    conventions: "feat: and test: as separate commits.",
  };
}

describe("core-memory block names", () => {
  test("exposes exactly the four named blocks in fixed order", () => {
    expect(CORE_BLOCK_NAMES).toEqual([
      "persona",
      "user",
      "learnings-synopsis",
      "conventions",
    ]);
  });

  test("every block has a render label", () => {
    for (const name of CORE_BLOCK_NAMES) {
      expect(typeof CORE_BLOCK_LABELS[name]).toBe("string");
      expect(CORE_BLOCK_LABELS[name].length).toBeGreaterThan(0);
    }
  });

  test("isCoreBlockName accepts defined blocks and rejects everything else", () => {
    expect(isCoreBlockName("persona")).toBe(true);
    expect(isCoreBlockName("user")).toBe(true);
    expect(isCoreBlockName("learnings-synopsis")).toBe(true);
    expect(isCoreBlockName("conventions")).toBe(true);
    expect(isCoreBlockName("other")).toBe(false);
    expect(isCoreBlockName("facts")).toBe(false);
    expect(isCoreBlockName("")).toBe(false);
  });

  test("emptyCoreBlocks has empty content for every defined block", () => {
    const b = emptyCoreBlocks();
    for (const name of CORE_BLOCK_NAMES) {
      expect(b[name]).toBe("");
    }
  });
});

describe("renderCoreMemory", () => {
  test("renders blocks in fixed order with their labels", () => {
    const section = renderCoreMemory(filled());
    expect(section).not.toBeNull();
    if (!section) throw new Error("unreachable");
    // Every label present.
    for (const name of CORE_BLOCK_NAMES) {
      expect(section).toContain(CORE_BLOCK_LABELS[name]);
    }
    // Fixed order: each block's label precedes the next block's label.
    const positions = CORE_BLOCK_NAMES.map((n) => section.indexOf(CORE_BLOCK_LABELS[n]));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  test("returns null when no block has content", () => {
    expect(renderCoreMemory(emptyCoreBlocks())).toBeNull();
  });

  test("only renders blocks that have content, in fixed order", () => {
    const partial: CoreBlocks = {
      persona: "p",
      user: "",
      "learnings-synopsis": "l",
      conventions: "",
    };
    const section = renderCoreMemory(partial);
    expect(section).not.toBeNull();
    if (!section) throw new Error("unreachable");
    expect(section).toContain(CORE_BLOCK_LABELS.persona);
    expect(section).toContain(CORE_BLOCK_LABELS["learnings-synopsis"]);
    expect(section).not.toContain(CORE_BLOCK_LABELS.user);
    expect(section).not.toContain(CORE_BLOCK_LABELS.conventions);
    // Persona comes before learnings-synopsis.
    expect(section.indexOf(CORE_BLOCK_LABELS.persona)).toBeLessThan(
      section.indexOf(CORE_BLOCK_LABELS["learnings-synopsis"]),
    );
  });
});

describe("editCoreBlock", () => {
  test("add/replace content into a defined block persists", () => {
    editCoreBlock(dir, "persona", "add", "new persona");
    editCoreBlock(dir, "user", "add", "likes tests");
    const blocks = loadCoreBlocks(dir);
    expect(blocks.persona).toBe("new persona");
    expect(blocks.user).toBe("likes tests");
  });

  test("replace overwrites existing content", () => {
    editCoreBlock(dir, "persona", "replace", "second persona");
    expect(loadCoreBlocks(dir).persona).toBe("second persona");
  });

  test("remove clears a block", () => {
    editCoreBlock(dir, "user", "remove");
    expect(loadCoreBlocks(dir).user).toBe("");
  });

  test("edits outside the defined blocks are rejected", () => {
    expect(() =>
      editCoreBlock(dir, "not-a-block", "add", "x"),
    ).toThrow(/not-a-block/);
    expect(() =>
      editCoreBlock(dir, "facts", "add", "x"),
    ).toThrow(/invalid|unknown|defined|not a valid/i);
  });

  test("overflow returns an instructive error naming the block and budget", () => {
    const long = "y".repeat(10_000); // ~2500 tokens
    expect(() => editCoreBlock(dir, "conventions", "add", long)).toThrow();
    let caught: Error | undefined;
    try {
      editCoreBlock(dir, "conventions", "add", long, DEFAULT_CORE_BUDGET_TOKENS);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("conventions");
    expect(caught!.message).toMatch(/budget|tokens|limit|too (large|long)/i);
  });

  test("budget config is respected: smaller budget errors earlier", () => {
    const modest = "z".repeat(400); // ~100 tokens
    // Fits under a large budget.
    expect(() => editCoreBlock(dir, "persona", "replace", modest, 500)).not.toThrow();
    // Rejected under a tiny budget.
    expect(() => editCoreBlock(dir, "persona", "replace", modest, 10)).toThrow(
      /budget|tokens|limit|too (large|long)/i,
    );
  });

  test("empty content cannot be added (must use remove)", () => {
    expect(() => editCoreBlock(dir, "user", "add", "   ")).toThrow(/empty/);
  });
});

describe("storage round-trip", () => {
  test("saveCoreBlocks then loadCoreBlocks returns the same blocks", () => {
    const b = filled();
    saveCoreBlocks(dir, b);
    const loaded = loadCoreBlocks(dir);
    for (const name of CORE_BLOCK_NAMES as CoreBlockName[]) {
      expect(loaded[name]).toBe(b[name]);
    }
  });

  test("loadCoreBlocks on a fresh dir returns empty blocks", () => {
    const fresh = mkdtempSync(join(tmpdir(), "stealth-memory-fresh-"));
    try {
      const b = loadCoreBlocks(fresh);
      for (const name of CORE_BLOCK_NAMES) expect(b[name]).toBe("");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
