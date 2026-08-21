import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSkill,
  listSkills,
  sanitizeSkillName,
  saveSkill,
  scaffoldSkill,
  skillTemplate,
} from "../src/skills/loader";
import { createSaveSkillTool } from "../src/tools/skill-writer";
import { buildSkillsSection, createUseSkillTool, summarizeSkills } from "../src/skills/activate";
import { dispatch } from "../src/tools/registry";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-skill-home-"));
  project = mkdtempSync(join(tmpdir(), "tj-skill-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function writeSkill(
  base: string,
  name: string,
  frontmatter: string,
  body = "Do the thing.",
  source: "global" | "project" = "global",
): void {
  const dir =
    source === "global"
      ? join(base, "skills", name)
      : join(base, ".tenjin", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}\n`);
}

test("listSkills discovers global and project skills", () => {
  writeSkill(home, "bun-testing", 'name: "bun-testing"\ndescription: "How tests work"', undefined, "global");
  writeSkill(project, "deploy", 'name: "deploy"\ndescription: "Deploy steps"', undefined, "project");

  const all = listSkills(home, project);
  expect(all.map((s) => s.name)).toEqual(["bun-testing", "deploy"]);
  expect(all[0]?.source).toBe("global");
  expect(all[1]?.source).toBe("project");
});

test("project skill shadows global skill of same name", () => {
  writeSkill(home, "shared", 'name: "shared"\ndescription: "global version"', "GLOBAL BODY", "global");
  writeSkill(project, "shared", 'name: "shared"\ndescription: "project version"', "PROJECT BODY", "project");

  const all = listSkills(home, project);
  expect(all).toHaveLength(1);
  expect(all[0]?.source).toBe("project");
  expect(all[0]?.content).toBe("PROJECT BODY");
});

test("getSkill returns null for unknown names", () => {
  writeSkill(home, "real", 'name: "real"\ndescription: "x"');
  expect(getSkill(home, project, "real")?.name).toBe("real");
  expect(getSkill(home, project, "ghost")).toBeNull();
});

test("malformed skills are skipped silently", () => {
  const dir = join(home, "skills", "broken");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "no frontmatter");
  const dir2 = join(home, "skills", "noname");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "SKILL.md"), "---\ndescription: no name\n---\nbody");
  expect(listSkills(home, project)).toEqual([]);
});

test("empty dirs yield empty list", () => {
  expect(listSkills(home, project)).toEqual([]);
});

describe("sanitizeSkillName", () => {
  test("passes through clean names", () => {
    expect(sanitizeSkillName("bun-testing")).toBe("bun-testing");
    expect(sanitizeSkillName("Code-Review-2")).toBe("code-review-2");
  });

  test("normalizes spaces and underscores to dashes", () => {
    expect(sanitizeSkillName("My Cool Skill")).toBe("my-cool-skill");
    expect(sanitizeSkillName("a_b__c")).toBe("a-b-c");
  });

  test("rejects names that reduce to nothing", () => {
    expect(() => sanitizeSkillName("---")).toThrow(/invalid skill name/);
    expect(() => sanitizeSkillName("   ")).toThrow(/invalid skill name/);
  });
});

describe("saveSkill", () => {
  test("writes quoted frontmatter and content to project dir", () => {
    const path = saveSkill(project, {
      name: "Release Flow",
      description: "Steps to cut a release\nwith newlines",
      content: "1. bump version\n2. tag",
    });
    expect(path).toContain(join(".tenjin", "skills", "release-flow", "SKILL.md"));
    const raw = require("node:fs").readFileSync(path, "utf8");
    expect(raw).toContain('name: "release-flow"');
    expect(raw).toContain("Steps to cut a release with newlines");
    expect(raw).toContain("1. bump version");
    expect(getSkill(home, project, "release-flow")?.description).toBe(
      "Steps to cut a release with newlines",
    );
  });

  test("collision with existing skill throws", () => {
    saveSkill(project, { name: "dup", description: "d", content: "c" });
    expect(() =>
      saveSkill(project, { name: "dup", description: "d2", content: "c2" }),
    ).toThrow(/already exists/);
  });

  test("saved ids survive YAML round-trip (digit-heavy names)", () => {
    saveSkill(project, { name: "2026-checklist", description: "y", content: "c" });
    expect(getSkill(home, project, "2026-checklist")?.name).toBe("2026-checklist");
  });
});

test("skillTemplate produces valid parseable scaffold", () => {
  const md = skillTemplate("My New Skill");
  expect(md).toContain('name: "my-new-skill"');
  const dir = join(home, "skills", "my-new-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  expect(getSkill(home, project, "my-new-skill")?.name).toBe("my-new-skill");
});

describe("buildSkillsSection", () => {
  beforeEach(() => {
    writeSkill(home, "testing", 'name: "testing"\ndescription: "How to test"', "RUN bun test", "global");
    writeSkill(project, "deploy", 'name: "deploy"\ndescription: "How to deploy"', "RUN deploy.sh", "project");
  });

  test("null when nothing pinned", () => {
    expect(buildSkillsSection(home, project, [])).toBeNull();
  });

  test("renders pinned skill with header and content", () => {
    const section = buildSkillsSection(home, project, ["testing"]);
    expect(section).toContain("# Active skills");
    expect(section).toContain("## testing — How to test");
    expect(section).toContain("RUN bun test");
  });

  test("multiple pinned skills separated; unknown names skipped", () => {
    const section = buildSkillsSection(home, project, ["testing", "deploy", "ghost"]);
    expect(section).toContain("RUN bun test");
    expect(section).toContain("RUN deploy.sh");
    expect(section).not.toContain("ghost");
  });
});

describe("use_skill tool", () => {
  beforeEach(() => {
    writeSkill(home, "testing", 'name: "testing"\ndescription: "How to test"', "RUN bun test", "global");
  });

  const dispatchUse = (name: string) =>
    dispatch(
      [createUseSkillTool({ home, projectDir: project })],
      "use_skill",
      { name },
      { cwd: project },
    );

  test("returns skill body for known name", async () => {
    const r = await dispatchUse("testing");
    expect(r.ok).toBe(true);
    expect(r.output).toContain("# testing (How to test)");
    expect(r.output).toContain("RUN bun test");
  });

  test("unknown skill is an error result", async () => {
    const r = await dispatchUse("nope");
    expect(r.ok).toBe(false);
    expect(r.output).toContain('unknown skill "nope"');
  });
});

test("summarizeSkills formats listing lines", () => {
  writeSkill(home, "aa-first", 'name: "aa-first"\ndescription: "First one"');
  const lines = summarizeSkills(listSkills(home, project)).split("\n");
  expect(lines[0]).toContain("aa-first");
  expect(lines[0]).toContain("global");
  expect(lines[0]).toContain("First one");
  expect(summarizeSkills([])).toBe("no skills installed");
});

describe("save_skill tool", () => {
  const makeTool = () => createSaveSkillTool({ projectDir: project });

  test("saves skill via dispatch", async () => {
    const r = await dispatch(
      [makeTool()],
      "save_skill",
      { name: "release-steps", description: "How to release", content: "1. tag\n2. push" },
      { cwd: project },
    );
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Saved skill to");
    expect(getSkill(home, project, "release-steps")?.content).toContain("1. tag");
  });

  test("collision surfaces as error result", async () => {
    await dispatch(
      [makeTool()],
      "save_skill",
      { name: "dup", description: "d", content: "c" },
      { cwd: project },
    );
    const r = await dispatch(
      [makeTool()],
      "save_skill",
      { name: "dup", description: "d2", content: "c2" },
      { cwd: project },
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("already exists");
  });

  test("invalid name surfaces as error result", async () => {
    const r = await dispatch(
      [makeTool()],
      "save_skill",
      { name: "!!!", description: "d", content: "c" },
      { cwd: project },
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("invalid skill name");
  });
});

test("scaffoldSkill writes editable template or throws on collision", () => {
  const path = scaffoldSkill(project, "My Scaffold");
  expect(existsSync(path)).toBe(true);
  const raw = require("node:fs").readFileSync(path, "utf8");
  expect(raw).toContain('name: "my-scaffold"');
  expect(() => scaffoldSkill(project, "my-scaffold")).toThrow(/already exists/);
});
