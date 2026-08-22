import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listSkills,
  exportSkill,
  validateSkillFormat,
  MAX_SKILL_LINES,
  MAX_SKILL_TOKENS,
  type Skill,
} from "../src/skills/loader";
import { summarizeSkills } from "../src/skills/activate";

/**
 * B15-1 (#379): align skills/ to the open SKILL.md standard (agentskills.io) —
 * directory skills with validated YAML frontmatter, body limits, on-demand
 * disclosure (B5-3), and an export/import round-trip.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-skillfmt-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeSkill(name: string, fm: Record<string, unknown>, body: string): string {
  const dir = join(home, "skills", name);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", "", body];
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n") + "\n");
  return join(dir, "SKILL.md");
}

describe("valid directory skill loads with frontmatter surfaced", () => {
  test("frontmatter fields name/description + optional fields surface", () => {
    writeSkill("bun-testing", {
      name: "bun-testing",
      description: "How to run tests with bun; use when a task involves bun test",
      license: "MIT",
      compatibility: "agentskills.io v1",
      "allowed-tools": ["bun", "read_file"],
    }, "# bun-testing\nRun `bun test`.");
    const loaded = listSkills(home, "/tmp/none").find((s) => s.name === "bun-testing");
    expect(loaded).toBeTruthy();
    expect(loaded!.description).toContain("How to run tests");
    expect(loaded!.license).toBe("MIT");
    expect(loaded!.compatibility).toBe("agentskills.io v1");
    expect(loaded!.allowedTools).toEqual(["bun", "read_file"]);
    expect(loaded!.content).toContain("bun test");
  });

  test("loads a skill with only the required fields", () => {
    writeSkill("minimal", { name: "minimal", description: "Minimal valid skill" }, "# minimal\nhi");
    const loaded = listSkills(home, "/tmp/none").find((s) => s.name === "minimal");
    expect(loaded).toBeTruthy();
    expect(loaded!.broken).toBeUndefined();
  });
});

describe("field-specific validation errors", () => {
  test("name/dirname mismatch is rejected naming the name field", () => {
    writeSkill("actual-dir", { name: "other-name", description: "d" }, "body");
    const v = validateSkillFormat({ name: "other-name", dirName: "actual-dir", description: "d", content: "body" });
    expect(v.ok).toBe(false);
    expect(v.field).toBe("name");
    expect(v.error).toContain("directory");
  });

  test("missing description is rejected naming the description field", () => {
    const v = validateSkillFormat({ name: "foo", dirName: "foo", description: "", content: "body" });
    expect(v.ok).toBe(false);
    expect(v.field).toBe("description");
    expect(v.error).toContain("description");
  });

  test("invalid name (uppercase/space) is rejected naming the name field", () => {
    const v = validateSkillFormat({ name: "Foo Bar!", dirName: "Foo Bar!", description: "d", content: "b" });
    expect(v.ok).toBe(false);
    expect(v.field).toBe("name");
  });

  test("over-long body is rejected naming the content field", () => {
    const longBody = Array.from({ length: MAX_SKILL_LINES + 10 }, () => "x").join("\n");
    const v = validateSkillFormat({ name: "foo", dirName: "foo", description: "d", content: longBody });
    expect(v.ok).toBe(false);
    expect(v.field).toBe("content");
  });

  test("body over the token budget is rejected", () => {
    const hugeBody = "word ".repeat(MAX_SKILL_TOKENS * 4 + 100); // ~ >5k tokens at ~4 chars/token
    const v = validateSkillFormat({ name: "foo", dirName: "foo", description: "d", content: hugeBody });
    expect(v.ok).toBe(false);
    expect(v.field).toBe("content");
  });

  test("valid skill passes validation", () => {
    const v = validateSkillFormat({ name: "foo", dirName: "foo", description: "d", content: "body" });
    expect(v.ok).toBe(true);
  });
});

describe("progressive disclosure (B5-3)", () => {
  test("body is NOT in the preamble until activated", () => {
    const skill: Skill = {
      name: "bun-testing",
      description: "How to run tests with bun",
      content: "SECRET_BODY_ONLY_ON_ACTIVATION run bun test",
      source: "global",
      path: "/x/SKILL.md",
    };
    const preamble = summarizeSkills([skill]);
    expect(preamble).toContain("bun-testing");
    expect(preamble).toContain("How to run tests with bun");
    expect(preamble).not.toContain("SECRET_BODY_ONLY_ON_ACTIVATION");
  });
});

describe("export/import round-trip", () => {
  test("export -> reimport is identical", () => {
    const skill = {
      name: "bun-testing",
      description: "How to run tests with bun",
      license: "MIT",
      content: "# bun-testing\nRun `bun test`.",
    };
    const exported = exportSkill(skill);
    // Write it into a fresh skills dir and load it back through the loader.
    const dir = join(home, "skills", skill.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), exported);
    const loaded = listSkills(home, "/tmp/none").find((s) => s.name === skill.name);
    expect(loaded).toBeTruthy();
    expect(loaded!.content).toBe(skill.content.trim());
    expect(loaded!.license).toBe("MIT");
    // Re-exporting the loaded skill yields identical bytes.
    expect(
      exportSkill({
        name: loaded!.name,
        description: loaded!.description,
        license: loaded!.license,
        compatibility: loaded!.compatibility,
        allowedTools: loaded!.allowedTools,
        content: loaded!.content,
      }),
    ).toBe(exported);
  });
});
