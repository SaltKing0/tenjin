import { describe, test, expect } from "bun:test";
import {
  buildDisclosureIndex,
  renderDisclosureIndex,
  indexTokens,
  resolveDisclosure,
  discloseTool,
  discloseSkill,
  type DisclosureIndex,
} from "../src/agent/disclosure";
import type { ToolDef } from "../src/tools/registry";
import type { Skill } from "../src/skills/loader";
import { buildSystemPrompt } from "../src/agent/prompt";

function mkTool(name: string, description: string, props: Record<string, unknown> = {}): ToolDef {
  return {
    name,
    group: "read",
    description,
    inputSchema: { type: "object", properties: props, required: Object.keys(props) },
    async handler() {
      return "ok";
    },
  };
}

function mkSkill(name: string, description: string, content: string): Skill {
  return { name, description, content, source: "global", path: `/skills/${name}/SKILL.md` };
}

const SKILL_BODY =
  "When to use: ...\nSteps: 1) ... 2) ...\nEdge cases: ...\nThis body text must never appear in the preamble index.";

describe("Level-1 index under a token budget (B5-3)", () => {
  test("a preamble with N=20 tools stays under a token budget (index only)", () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      mkTool(`tool_${i}`, `one-line description for tool ${i}`),
    );
    const skills = Array.from({ length: 5 }, (_, i) =>
      mkSkill(`skill_${i}`, `one-line skill description ${i}`, SKILL_BODY),
    );
    const index = buildDisclosureIndex(tools, skills);
    expect(index.tools).toHaveLength(20);
    expect(index.skills).toHaveLength(5);
    // Well under a typical preamble budget for the index alone.
    expect(indexTokens(index)).toBeLessThan(600);
    // And each index line is name + one-line description only.
    const rendered = renderDisclosureIndex(index);
    expect(rendered).toContain("tool_0: one-line description for tool 0");
  });
});

describe("full schema appears exactly after explicit request (B5-3)", () => {
  test("schema details are absent from the index, present after resolveDisclosure", () => {
    const tool = mkTool("write_file", "write a file", { path: { type: "string" } });
    const index = buildDisclosureIndex([tool], []);

    const rendered = renderDisclosureIndex(index);
    // Before any request, the index carries NO schema internals.
    expect(rendered).not.toContain("properties");
    expect(rendered).not.toContain("required");
    expect(rendered).not.toContain("path");
    // The index line is just name + description.
    expect(rendered).toContain("- write_file: write a file");

    // After the explicit request, the full schema is delivered.
    const d = resolveDisclosure(index, [tool], [], "write_file");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("tool");
    if (d!.kind === "tool") {
      expect(d!.schema.name).toBe("write_file");
      expect(d!.schema.inputSchema.properties).toEqual({ path: { type: "string" } });
      expect(d!.schema.inputSchema.required).toEqual(["path"]);
    }
  });

  test("unknown names resolve to null (no accidental disclosure)", () => {
    const index = buildDisclosureIndex([mkTool("a", "desc")], []);
    expect(resolveDisclosure(index, [mkTool("a", "desc")], [], "nope")).toBeNull();
  });

  test("discloseTool returns the full schema directly", () => {
    const d = discloseTool(mkTool("f", "d", { x: { type: "number" } }));
    expect(d.kind).toBe("tool");
    if (d.kind === "tool") expect(d.schema.inputSchema.properties.x).toEqual({ type: "number" });
  });
});

describe("skill bodies not in preamble; loaded on activation (B5-3)", () => {
  test("SKILL.md body is absent from the index; returned only via disclose", () => {
    const skill = mkSkill("my-skill", "helps do X", SKILL_BODY);
    const index = buildDisclosureIndex([], [skill]);
    const rendered = renderDisclosureIndex(index);
    // Preamble carries the one-line description, not the body.
    expect(rendered).toContain("- my-skill: helps do X");
    expect(rendered).not.toContain("When to use");
    expect(rendered).not.toContain("Steps:");
    expect(rendered).not.toContain("Edge cases");

    // Level 2 disclosure returns the body on demand.
    const d = resolveDisclosure(index, [], [skill], "my-skill");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("skill");
    if (d!.kind === "skill") expect(d!.body).toBe(SKILL_BODY);
    const ds = discloseSkill(skill);
    expect(ds.kind).toBe("skill");
    if (ds.kind === "skill") expect(ds.body).toBe(SKILL_BODY);
  });

  test("broken skills are omitted from the index and cannot be disclosed", () => {
    const broken = { ...mkSkill("broken", "desc", "body"), broken: "missing name field" };
    const index = buildDisclosureIndex([], [broken]);
    expect(index.skills).toHaveLength(0);
    expect(renderDisclosureIndex(index)).not.toContain("broken");
    expect(resolveDisclosure(index, [], [broken], "broken")).toBeNull();
  });
});

describe("index is byte-identical across turns (cache-shape compatible, B5-3)", () => {
  test("identical inputs render to identical strings", () => {
    const tools = [mkTool("zeta", "z desc"), mkTool("alpha", "a desc"), mkTool("mid", "m desc")];
    const skills = [mkSkill("beta", "b desc", "body"), mkSkill("aaa", "a desc", "body")];

    const indexA = buildDisclosureIndex(tools, skills);
    const indexB = buildDisclosureIndex(tools, skills);
    expect(renderDisclosureIndex(indexA)).toBe(renderDisclosureIndex(indexB));

    // Re-rendering the same index is stable.
    expect(renderDisclosureIndex(indexA)).toBe(renderDisclosureIndex(indexA));

    // Deterministic ordering (sorted by name) — independent of input order.
    const shuffledTools = [tools[1]!, tools[2]!, tools[0]!];
    const indexC = buildDisclosureIndex(shuffledTools, skills);
    expect(renderDisclosureIndex(indexC)).toBe(renderDisclosureIndex(indexA));
  });

  test("index sorts entries by name (byte-stable layout)", () => {
    const index: DisclosureIndex = buildDisclosureIndex(
      [mkTool("zz", "d"), mkTool("aa", "d")],
      [mkSkill("cc", "d", "b"), mkSkill("bb", "d", "b")],
    );
    expect(index.tools.map((t) => t.name)).toEqual(["aa", "zz"]);
    expect(index.skills.map((s) => s.name)).toEqual(["bb", "cc"]);
  });
});

describe("system-prompt integration (B5-3)", () => {
  test("disclosureIndex renders into the prompt when provided, absent otherwise", () => {
    const index = buildDisclosureIndex(
      [mkTool("alpha", "a desc")],
      [mkSkill("beta", "b desc", "body")],
    );
    const rendered = renderDisclosureIndex(index);

    const withIndex = buildSystemPrompt({
      soulText: "soul",
      agentsMd: null,
      cwd: "/p",
      disclosureIndex: rendered,
    });
    expect(withIndex).toContain("- alpha: a desc");
    expect(withIndex).toContain("- beta: b desc");

    // Without the option, nothing new is injected (byte-identical to before).
    const without = buildSystemPrompt({
      soulText: "soul",
      agentsMd: null,
      cwd: "/p",
    });
    expect(without).not.toContain("- alpha: a desc");
    expect(without).not.toContain("disclosure");
  });
});
