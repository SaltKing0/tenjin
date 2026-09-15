import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCoreMemoryTool } from "../src/tools/memory";
import { loadCoreBlocks, renderCoreMemory } from "../src/memory/inject";
import { buildSystemPrompt } from "../src/agent/prompt";

let dir: string;
let tool: ReturnType<typeof createCoreMemoryTool>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tenjin-core-memory-tool-"));
  tool = createCoreMemoryTool({ memoryDirPath: dir });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("core_memory tool", () => {
  test("add writes into a defined block and persists", async () => {
    const out = await tool.handler({ block: "persona", op: "add", content: "I am Tenjin." }, {} as never);
    expect(out).toContain("persona");
    expect(loadCoreBlocks(dir).persona).toBe("I am Tenjin.");
  });

  test("replace overwrites; remove clears", async () => {
    await tool.handler({ block: "persona", op: "replace", content: "v2" }, {} as never);
    expect(loadCoreBlocks(dir).persona).toBe("v2");
    const out = await tool.handler({ block: "persona", op: "remove" }, {} as never);
    expect(out).toContain("Cleared");
    expect(loadCoreBlocks(dir).persona).toBe("");
  });

  test("rejects a block outside the defined set", async () => {
    await expect(
      tool.handler({ block: "random", op: "add", content: "x" }, {} as never),
    ).rejects.toThrow(/random/);
  });

  test("overflow returns an instructive error naming block + budget", async () => {
    await expect(
      tool.handler({ block: "user", op: "add", content: "y".repeat(10_000) }, {} as never),
    ).rejects.toThrow(/user/);
    await expect(
      tool.handler({ block: "user", op: "add", content: "y".repeat(10_000) }, {} as never),
    ).rejects.toThrow(/budget|tokens|limit|too (large|long)/i);
  });

  test("budget override is honoured", async () => {
    const strict = createCoreMemoryTool({ memoryDirPath: dir, budgetTokens: 5 });
    await expect(
      strict.handler({ block: "conventions", op: "add", content: "x".repeat(50) }, {} as never),
    ).rejects.toThrow(/budget|tokens|limit|too (large|long)/i);
  });
});

describe("prompt integration", () => {
  test("core memory renders before the recall memory section", () => {
    const prompt = buildSystemPrompt({
      soulText: "soul",
      agentsMd: null,
      cwd: "/p",
      coreMemory: renderCoreMemory({
        persona: "Tenjin",
        user: "",
        "learnings-synopsis": "",
        conventions: "",
      }),
      memorySection: "# Memory — recent sessions in this project\n- x",
    });
    expect(prompt.indexOf("Core memory (reference data)")).toBeGreaterThan(-1);
    expect(prompt.indexOf("Persona")).toBeGreaterThan(-1);
    const coreIdx = prompt.indexOf("Core memory (reference data)");
    const recallIdx = prompt.indexOf("recent sessions in this project");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(recallIdx).toBeGreaterThan(coreIdx);
  });
});
