import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSkill, listSkills, projectSkillsDir } from "../src/skills/loader";
import { createUseSkillTool, createRefineSkillTool } from "../src/skills/activate";
import { recordUsage, readUsage, usageStats, analyzeUsage, usagePathFor, MAX_USAGE_FILE_BYTES } from "../src/skills/usage";
import {
  proposeRefine,
  activateRefine,
  listRefineVersions,
  pendingRefines,
} from "../src/skills/refine";
import { dispatch } from "../src/tools/registry";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-sk-self-"));
  project = mkdtempSync(join(tmpdir(), "tj-sk-self-proj-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

function addSkill(name: string, content: string, description = "test skill"): void {
  saveSkill(project, { name, description, content });
}

describe("use_skill usage tracking (#133)", () => {
  test("a successful use_skill invocation records ok usage", async () => {
    addSkill("greeter", "print hello");
    const tool = createUseSkillTool({ home, projectDir: project });
    const r = await dispatch([tool], "use_skill", { name: "greeter" }, { cwd: project });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("print hello");

    const usage = readUsage(project, "greeter");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.ok).toBe(true);
    expect(usage[0]?.skill).toBe("greeter");
    expect(typeof usage[0]?.durationMs).toBe("number");
  });

  test("a failed use_skill invocation records an error entry", async () => {
    const tool = createUseSkillTool({ home, projectDir: project });
    const r = await dispatch([tool], "use_skill", { name: "ghost" }, { cwd: project });
    expect(r.ok).toBe(false);

    const usage = readUsage(project, "ghost");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.ok).toBe(false);
    expect(usage[0]?.error).toMatch(/unknown skill/);
  });
});

test("usage file rolls over past the retention cap instead of growing unbounded (#317)", () => {
  recordUsage(project, { skill: "big", ts: "t0", ok: true, durationMs: 0 }); // creates dir + active file
  const active = usagePathFor(project, "big");
  // Grow the active file past the cap.
  writeFileSync(
    active,
    JSON.stringify({ skill: "big", ts: "t0", ok: true, durationMs: 0, pad: "x".repeat(MAX_USAGE_FILE_BYTES) }) +
      "\n",
  );
  // The next record rolls the oversized file over to `.1` and starts a fresh active file.
  recordUsage(project, { skill: "big", ts: "t1", ok: true, durationMs: 1 });
  expect(existsSync(`${active}.1`)).toBe(true);
  const usage = readUsage(project, "big");
  expect(usage).toHaveLength(1);
  expect(usage[0]?.ts).toBe("t1");
});

describe("usage analysis (#133)", () => {
  test("usageStats summarizes ok/error/duration and analyzeUsage flags error-prone skills", () => {
    // flaky skill: 2 uses, 1 error (50% error rate)
    recordUsage(project, { skill: "flaky", ts: "t1", ok: true, durationMs: 5 });
    recordUsage(project, { skill: "flaky", ts: "t2", ok: false, error: "boom", durationMs: 8 });
    // healthy skill: 2 uses, 0 errors
    recordUsage(project, { skill: "healthy", ts: "t1", ok: true, durationMs: 3 });
    recordUsage(project, { skill: "healthy", ts: "t2", ok: true, durationMs: 4 });

    const st = usageStats(project, "flaky");
    expect(st.uses).toBe(2);
    expect(st.errors).toBe(1);
    expect(st.errorRate).toBeCloseTo(0.5);
    expect(existsSync(usagePathFor(project, "flaky"))).toBe(true);

    const candidates = analyzeUsage(project, ["flaky", "healthy"]);
    expect(candidates.map((c) => c.skill)).toEqual(["flaky"]);
  });

  test("analyzeUsage ignores skills used too rarely", () => {
    recordUsage(project, { skill: "rare", ts: "t", ok: false, error: "x", durationMs: 1 });
    expect(analyzeUsage(project, ["rare"])).toEqual([]); // minUses default 2
  });
});

describe("skill refine proposals (#133)", () => {
  const OLD = "---\nname: porter\ndescription: old way\n---\ncarry slowly\n";
  const NEW_BODY = "---\nname: porter\ndescription: new way\nreason: packed too slowly\n---\ncarry fast\n";

  test("proposeRefine writes a VERSION file and leaves the active SKILL.md untouched", () => {
    addSkill("porter", OLD);
    const active = join(projectSkillsDir(project), "porter", "SKILL.md");
    const before = readFileSync(active, "utf8");

    const prop = proposeRefine(project, { skill: "porter", description: "new way", reason: "packed too slowly", content: NEW_BODY });
    expect(prop.version).toBe(1);
    expect(listRefineVersions(project, "porter")).toEqual([1]);

    // active skill unchanged until approved activation
    expect(readFileSync(active, "utf8")).toBe(before);
    expect(readFileSync(active, "utf8")).toContain("carry slowly");
  });

  test("activateRefine (approval-gated) switches the active skill to the proposal", () => {
    addSkill("porter", OLD);
    proposeRefine(project, { skill: "porter", description: "new way", reason: "slow", content: NEW_BODY });

    const active = join(projectSkillsDir(project), "porter", "SKILL.md");
    expect(readFileSync(active, "utf8")).toContain("carry slowly");

    // simulate approval → activation
    activateRefine(project, "porter", 1);
    expect(readFileSync(active, "utf8")).toContain("carry fast");
    expect(listSkills(home, project).find((s) => s.name === "porter")?.description).toContain("new way");
  });

  test("versions increment and pendingRefines lists proposals", () => {
    addSkill("porter", OLD);
    proposeRefine(project, { skill: "porter", description: "a", reason: "r1", content: NEW_BODY });
    proposeRefine(project, { skill: "porter", description: "b", reason: "r2", content: NEW_BODY });
    expect(listRefineVersions(project, "porter")).toEqual([1, 2]);

    const pending = pendingRefines(project, ["porter"]);
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.version)).toEqual([1, 2]);
  });

  test("refine_skill tool proposes a version without activating it", async () => {
    addSkill("porter", OLD);
    const tool = createRefineSkillTool({ projectDir: project });
    const r = await dispatch(
      [tool],
      "refine_skill",
      { skill: "porter", reason: "too slow", description: "new way", content: NEW_BODY },
      { cwd: project },
    );
    expect(r.ok).toBe(true);
    expect(String(r.output)).toContain("Proposed porter#v1");
    // active file not changed
    const active = join(projectSkillsDir(project), "porter", "SKILL.md");
    expect(readFileSync(active, "utf8")).toContain("carry slowly");
  });
});

describe("skills analyze CLI (#133)", () => {
  test("tenjin skills analyze reports a refine candidate and pending proposals", () => {
    const OLD = "---\nname: porter\ndescription: old\n---\ncarry slowly\n";
    const NEW_BODY = "---\nname: porter\ndescription: new\nreason: slow\n---\ncarry fast\n";
    addSkill("porter", OLD);
    recordUsage(project, { skill: "porter", ts: "t1", ok: true, durationMs: 1 });
    recordUsage(project, { skill: "porter", ts: "t2", ok: false, error: "x", durationMs: 1 });
    proposeRefine(project, { skill: "porter", description: "new", reason: "slow", content: NEW_BODY });

    const proc = Bun.spawnSync(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "skills", "analyze"],
      { cwd: project, env: { ...process.env, TENJIN_HOME: home } },
    );
    const out = proc.stdout?.toString() ?? "";
    expect(out).toContain("porter");
    expect(out).toContain("refine candidate");
    expect(out).toContain("pending refine proposals");
  });
});
