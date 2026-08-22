// B5-3 progressive disclosure (#378): with rich tooling (and MCP, #346) the
// full inputSchemas / SKILL.md bodies are the token bomb. This module builds a
// byte-stable Level-1 INDEX — {name, one-line description} for every tool and
// skill — that slots into the stable cache prefix (B2-1/#353), and discloses
// the full schema / skill body only on explicit request (Level 2) or via
// read_file for linked files (Level 3).
//
//   Level 1: preamble = index only (name + one-line description), byte-stable
//   Level 2: full inputSchema / SKILL.md body on demand (schema_get-style)
//   Level 3: skill-linked files (scripts/, references/) via read_file only
//   B7-6:    index lists only the tools/skills relevant to the turn
import type { ToolDef } from "../tools/registry";
import type { Skill } from "../skills/loader";
import type { ToolSchema } from "../provider/types";

/** One entry of the Level-1 index: a one-line description, never the schema. */
export interface DisclosureEntry {
  name: string;
  description: string;
}

/** The byte-stable Level-1 index for tools and skills. */
export interface DisclosureIndex {
  tools: DisclosureEntry[];
  skills: DisclosureEntry[];
}

/** A resolved Level-2 disclosure: full tool schema or skill body. */
export type Disclosure =
  | { kind: "tool"; name: string; schema: ToolSchema }
  | { kind: "skill"; name: string; body: string };

function oneLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

function byName(a: DisclosureEntry, b: DisclosureEntry): number {
  return a.name.localeCompare(b.name);
}

/** Build the Level-1 index (name + one-line description only, sorted so the
 *  rendered output is byte-identical across turns — cache-shape compatible). */
export function buildDisclosureIndex(
  tools: ToolDef[],
  skills: Skill[],
): DisclosureIndex {
  return {
    tools: tools
      .map((t) => ({ name: t.name, description: oneLine(t.description) }))
      .sort(byName),
    skills: skills
      .filter((s) => !s.broken)
      .map((s) => ({ name: s.name, description: oneLine(s.description) }))
      .sort(byName),
  };
}

/** Render the index deterministically (stable order + fixed layout). */
export function renderDisclosureIndex(index: DisclosureIndex): string {
  const lines: string[] = [];
  if (index.tools.length > 0) {
    lines.push("# Tools");
    for (const t of index.tools) lines.push(`- ${t.name}: ${t.description}`);
  }
  if (index.skills.length > 0) {
    lines.push("# Skills");
    for (const s of index.skills) lines.push(`- ${s.name}: ${s.description}`);
  }
  return lines.join("\n");
}

// Heuristic token count (codebase convention: ~4 chars/token).
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Token cost of the rendered index (Level-1 only). */
export function indexTokens(index: DisclosureIndex): number {
  return estimateTokens(renderDisclosureIndex(index));
}

/** Level-2 disclosure of a tool: the FULL inputSchema, absent from the index. */
export function discloseTool(def: ToolDef): Disclosure {
  return {
    kind: "tool",
    name: def.name,
    schema: { name: def.name, description: def.description, inputSchema: def.inputSchema },
  };
}

/** Level-2 disclosure of a skill: the SKILL.md body, absent from the index. */
export function discloseSkill(skill: Skill): Disclosure {
  return { kind: "skill", name: skill.name, body: skill.content };
}

/**
 * Resolve an explicit request for a name to its full disclosure (schema_get
 * style). Returns null when the name is neither a tool nor a skill. This is the
 * ONLY way a full schema / skill body is delivered — never in the preamble.
 */
export function resolveDisclosure(
  index: DisclosureIndex,
  tools: ToolDef[],
  skills: Skill[],
  name: string,
): Disclosure | null {
  if (index.tools.some((t) => t.name === name)) {
    const def = tools.find((t) => t.name === name);
    if (def) return discloseTool(def);
  }
  if (index.skills.some((s) => s.name === name)) {
    const skill = skills.find((s) => s.name === name && !s.broken);
    if (skill) return discloseSkill(skill);
  }
  return null;
}
