import { describe, test, expect } from "bun:test";
import {
  chunkStructure,
  parentTextForLeaf,
  detectContentKind,
  estTokens,
} from "../src/memory/chunking";

/**
 * B9-11 (#388): structure-first chunking + small-to-big in the indexer — split
 * at STRUCTURE boundaries (functions/classes for code, headings then paragraph
 * breaks for markdown), embed small leaves, return the parent block to the LLM,
 * with complete metadata and bounded token sizes.
 */

const CODE = `import { x } from "dep";

export function alpha() {
  const a = 1;
  return a;
}

export function beta() {
  const b = 2;
  return b + alpha();
}

export function gamma() {
  const c = 3;
  return c;
}
`;

const MARKDOWN = `# Project

Intro paragraph that belongs to the top level.

## Setup
A small setup section.

## Build
Longer build instructions with several sentences that give the heading
hierarchy a chance to show up across a few lines of running text here.
`;

describe("detectContentKind", () => {
  test("detects code vs markdown vs plain", () => {
    expect(detectContentKind(CODE)).toBe("code");
    expect(detectContentKind(MARKDOWN)).toBe("markdown");
    expect(detectContentKind("just some plain prose without structure")).toBe("plain");
  });
});

describe("code structure chunking", () => {
  test("chunks land on function boundaries — no function split mid-body", () => {
    const chunks = chunkStructure(CODE, { maxTokens: 512, sourcePath: "/p/f.ts" });
    // Each of the three functions appears in full in exactly one parent chunk.
    for (const fn of ["alpha", "beta", "gamma"]) {
      const parents = chunks.filter((c) => c.parent);
      const containing = parents.filter((c) => c.text.includes(`function ${fn}`));
      expect(containing.length).toBe(1);
      // The full body (the function's closing brace) is in that same chunk.
      expect(containing[0]!.text).toContain(`return`);
    }
  });

  test("no chunk cuts a function mid-body", () => {
    const chunks = chunkStructure(CODE, { maxTokens: 512 });
    for (const c of chunks) {
      // A function that starts in a chunk must also end (its body) in that chunk.
      const open = (c.text.match(/function\s+\w+/g) ?? []).length;
      if (open > 0) {
        expect(c.text.trim().endsWith("}")).toBe(true);
      }
    }
  });
});

describe("markdown structure chunking", () => {
  test("small section stays whole (heading hierarchy respected)", () => {
    const chunks = chunkStructure(MARKDOWN, { maxTokens: 512 });
    // The "## Setup" section is small -> it stays whole as one parent.
    const setup = chunks.find((c) => c.text.includes("A small setup section"));
    expect(setup).toBeTruthy();
    expect(setup!.parent).toBe(true);
    expect(setup!.meta.headingPath).toContain("Setup");
    expect(setup!.text).toContain("A small setup section");
  });

  test("heading hierarchy is recorded in metadata", () => {
    const chunks = chunkStructure(MARKDOWN, { maxTokens: 512 });
    const build = chunks.find((c) => c.text.includes("Longer build instructions"));
    expect(build).toBeTruthy();
    expect(build!.meta.headingPath).toContain("Project");
    expect(build!.meta.headingPath).toContain("Build");
  });
});

describe("small-to-big leaf/parent relation", () => {
  test("large parent splits into leaves; retrieval returns the parent text", () => {
    // A single large function whose body pushes it over the leaf budget but
    // under the hard max (so it stays a single parent that yields leaves).
    const big = `export function huge() {\n${Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i};`).join("\n")}\n  return 0;\n}`;
    const chunks = chunkStructure(big, { maxTokens: 2000, leafTokens: 60 });
    const leaves = chunks.filter((c) => !c.parent);
    const parent = chunks.find((c) => c.parent);
    expect(parent).toBeTruthy();
    expect(leaves.length).toBeGreaterThan(1);
    // Every leaf points at the parent.
    for (const l of leaves) {
      expect(l.parentId).toBe(parent!.id);
      expect(l.meta.parentChunkId).toBe(parent!.id);
    }
    // Retrieval of a leaf returns the full parent text.
    expect(parentTextForLeaf(chunks, leaves[0]!.id)).toContain("export function huge()");
  });

  test("small parent has no leaves (stays a single chunk)", () => {
    const chunks = chunkStructure(`export function tiny() { return 1; }`, { maxTokens: 512, leafTokens: 60 });
    const parents = chunks.filter((c) => c.parent);
    const leaves = chunks.filter((c) => !c.parent);
    expect(parents.length).toBeGreaterThanOrEqual(1);
    expect(leaves.length).toBe(0);
  });
});

describe("metadata completeness", () => {
  test("every chunk carries source, title, heading path, and line bounds", () => {
    const chunks = chunkStructure(MARKDOWN, { maxTokens: 512, sourcePath: "/p/notes.md", title: "Notes" });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.meta.sourcePath).toBe("/p/notes.md");
      expect(c.meta.title).toBe("Notes");
      expect(Array.isArray(c.meta.headingPath)).toBe(true);
      expect(c.meta.startLine).toBeGreaterThanOrEqual(0);
      expect(c.meta.endLine).toBeGreaterThanOrEqual(c.meta.startLine);
    }
  });
});

describe("token-size bounds", () => {
  test("every chunk stays within the configured max token bound", () => {
    const chunks = chunkStructure(MARKDOWN, { maxTokens: 40 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(estTokens(c.text)).toBeLessThanOrEqual(40);
    }
  });
});
