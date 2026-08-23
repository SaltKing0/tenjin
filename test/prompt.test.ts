import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSoul, loadAgentsMd, buildSystemPrompt } from "../src/agent/prompt";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-prompt-home-"));
  project = mkdtempSync(join(tmpdir(), "tj-prompt-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe("loadSoul precedence", () => {
  test("project SOUL.md wins over global", () => {
    writeFileSync(join(home, "SOUL.md"), "global soul");
    mkdirSync(join(project, ".tenjin"), { recursive: true });
    writeFileSync(join(project, ".tenjin", "SOUL.md"), "project soul");

    const soul = loadSoul(home, project);
    expect(soul.source).toBe("project");
    expect(soul.text).toBe("project soul");
  });

  test("global used when no project override", () => {
    writeFileSync(join(home, "SOUL.md"), "global soul");
    const soul = loadSoul(home, project);
    expect(soul.source).toBe("global");
    expect(soul.text).toBe("global soul");
  });

  test("built-in default when neither exists", () => {
    const soul = loadSoul(home, project);
    expect(soul.source).toBe("default");
    expect(soul.text).toContain("Tenjin");
  });

  test("soul text is trimmed", () => {
    mkdirSync(join(project, ".tenjin"), { recursive: true });
    writeFileSync(join(project, ".tenjin", "SOUL.md"), "\n  padded  \n\n");
    expect(loadSoul(home, project).text).toBe("padded");
  });

  test("workspace SOUL.md is used when no project override (beats legacy global)", () => {
    writeFileSync(join(home, "SOUL.md"), "legacy global");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "SOUL.md"), "workspace soul");
    const soul = loadSoul(home, project);
    expect(soul.source).toBe("workspace");
    expect(soul.text).toBe("workspace soul");
  });

  test("project SOUL.md still wins over workspace", () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "SOUL.md"), "workspace soul");
    mkdirSync(join(project, ".tenjin"), { recursive: true });
    writeFileSync(join(project, ".tenjin", "SOUL.md"), "project soul");
    expect(loadSoul(home, project).source).toBe("project");
  });
});

describe("loadAgentsMd", () => {
  test("returns content when present", () => {
    writeFileSync(join(project, "AGENTS.md"), "# Rules\nuse bun");
    expect(loadAgentsMd(project)).toBe("# Rules\nuse bun");
  });

  test("null when absent", () => {
    expect(loadAgentsMd(project)).toBeNull();
  });

  test("null when empty file", () => {
    writeFileSync(join(project, "AGENTS.md"), "   \n");
    expect(loadAgentsMd(project)).toBeNull();
  });

  test("workspace AGENTS.md used as fallback when no project file", () => {
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "AGENTS.md"), "# Global rules\nuse bun");
    expect(loadAgentsMd(project, home)).toBe("# Global rules\nuse bun");
    // without home, no workspace is consulted
    expect(loadAgentsMd(project)).toBeNull();
  });

  test("project AGENTS.md wins over workspace", () => {
    writeFileSync(join(project, "AGENTS.md"), "project rules");
    mkdirSync(join(home, "workspace"), { recursive: true });
    writeFileSync(join(home, "workspace", "AGENTS.md"), "global rules");
    expect(loadAgentsMd(project, home)).toBe("project rules");
  });
});

describe("buildSystemPrompt", () => {
  const base = { agentsMd: null as string | null };

  test("contains soul, environment, and working style sections", () => {
    const prompt = buildSystemPrompt({
      ...base,
      soulText: "I am the soul.",
      cwd: "/some/cwd",
    });
    expect(prompt).toContain("I am the soul.");
    expect(prompt).toContain("# Environment");
    expect(prompt).toContain("cwd: /some/cwd");
    expect(prompt).toContain(`platform: ${process.platform}`);
    // B2-1 (#353): the clock is volatile per-turn data and must NOT live in the
    // stable system prefix (it would invalidate the provider prompt cache). It
    // moves to the volatile tail via buildVolatileTail.
    expect(prompt).not.toMatch(/date:/);
    expect(prompt).toContain("# Working style");
  });

  test("appends AGENTS.md section only when provided", () => {
    const without = buildSystemPrompt({ ...base, soulText: "s", cwd: "/" });
    expect(without).not.toContain("AGENTS.md");

    const withAgents = buildSystemPrompt({
      ...base,
      soulText: "s",
      cwd: "/",
      agentsMd: "always use tabs",
    });
    expect(withAgents).toContain("# Project context (AGENTS.md)");
    expect(withAgents).toContain("always use tabs");
  });

  test("sections are separated by blank lines", () => {
    const prompt = buildSystemPrompt({ ...base, soulText: "a", cwd: "/" });
    expect(prompt).toContain("a\n\n# Environment");
  });

  test("facts section renders right after soul", () => {
    const prompt = buildSystemPrompt({
      ...base,
      soulText: "soul here",
      cwd: "/",
      facts: "- [2026-08-21] prefers bun",
    });
    expect(prompt).toContain("# Facts\n- [2026-08-21] prefers bun");
    const soulIdx = prompt.indexOf("soul here");
    const factsIdx = prompt.indexOf("# Facts");
    const envIdx = prompt.indexOf("# Environment");
    expect(soulIdx).toBeLessThan(factsIdx);
    expect(factsIdx).toBeLessThan(envIdx);
  });

  test("full assembly orders soul, facts, environment, style, agents, memory", () => {
    const prompt = buildSystemPrompt({
      soulText: "SOUL",
      cwd: "/c",
      facts: "F1",
      agentsMd: "AGENTS",
      memorySection: "# Memory — recent sessions in this project\nMEM",
    });
    const order = [
      prompt.indexOf("SOUL"),
      prompt.indexOf("# Facts"),
      prompt.indexOf("# Environment"),
      prompt.indexOf("# Working style"),
      prompt.indexOf("# Project context"),
      prompt.indexOf("# Memory —"),
    ];
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("skills summary renders after memory when provided", () => {
    const prompt = buildSystemPrompt({
      soulText: "SOUL",
      cwd: "/c",
      agentsMd: null,
      memorySection: "# Memory — recent sessions in this project\nMEM",
      skillsSummary: "bun-testing           global  How tests work",
    });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("bun-testing");
    const memIdx = prompt.indexOf("# Memory —");
    const skillsIdx = prompt.indexOf("# Skills");
    expect(memIdx).toBeGreaterThan(-1);
    expect(skillsIdx).toBeGreaterThan(memIdx);
  });
});
