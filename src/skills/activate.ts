import type { ToolDef } from "../tools/registry";
import { getSkill, sanitizeSkillName, type Skill } from "./loader";
import { recordUsage } from "./usage";
import { proposeRefine } from "./refine";

export function buildSkillsSection(
  home: string,
  projectDir: string,
  pinned: Iterable<string>,
): string | null {
  const parts: string[] = [];
  for (const name of pinned) {
    const skill = getSkill(home, projectDir, name);
    if (!skill) continue;
    const header = skill.description ? `## ${skill.name} — ${skill.description}` : `## ${skill.name}`;
    parts.push(`${header}\n${skill.content}`);
  }
  if (parts.length === 0) return null;
  return `# Active skills\n${parts.join("\n\n")}`;
}

export function createUseSkillTool(deps: {
  home: string;
  projectDir: string;
}): ToolDef {
  return {
    name: "use_skill",
    group: "read",
    description:
      "Load an available skill's full instructions by name. Use when a skill matches the current task. Every invocation is recorded for skill self-improvement.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async handler(args, _ctx) {
      const name = sanitizeSkillName(String(args.name ?? ""));
      const start = performance.now();
      const ts = new Date().toISOString();
      try {
        const skill = getSkill(deps.home, deps.projectDir, name);
        if (!skill) throw new Error(`unknown skill "${name}"`);
        recordUsage(deps.projectDir, {
          skill: name,
          ts,
          ok: true,
          durationMs: performance.now() - start,
        });
        const header = skill.description ? ` (${skill.description})` : "";
        return `# ${skill.name}${header}\n\n${skill.content}`;
      } catch (e) {
        recordUsage(deps.projectDir, {
          skill: name,
          ts,
          ok: false,
          error: (e as Error).message,
          durationMs: performance.now() - start,
        });
        throw e;
      }
    },
  };
}

/**
 * Lets the bot propose a new version of a skill (non-destructive). Writes a
 * VERSION-n.md proposal next to the active SKILL.md, which stays in force until
 * the proposal is approved and activated (#133).
 */
export function createRefineSkillTool(deps: { projectDir: string }): ToolDef {
  return {
    name: "refine_skill",
    group: "write",
    description:
      "Propose a new version of an existing skill based on how it has performed. Writes a non-destructive VERSION proposal; the active SKILL.md is untouched until the proposal is approved and activated.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name to refine" },
        description: { type: "string", description: "Updated short description" },
        reason: { type: "string", description: "Why this refinement is needed (e.g. observed failure)" },
        content: { type: "string", description: "The full proposed SKILL.md (frontmatter + body)" },
      },
      required: ["skill", "reason", "content"],
    },
    async handler(args, _ctx) {
      const skill = sanitizeSkillName(String(args.skill ?? ""));
      const reason = String(args.reason ?? "").trim();
      const content = String(args.content ?? "").trim();
      if (!skill || !reason || !content) {
        throw new Error("refine_skill requires skill, reason, and content");
      }
      const proposal = proposeRefine(deps.projectDir, {
        skill,
        description: String(args.description ?? "").trim(),
        reason,
        content,
      });
      return `Proposed ${skill}#v${proposal.version} — active SKILL.md unchanged until the proposal is approved and activated`;
    },
  };
}

export function summarizeSkills(skills: Skill[]): string {
  if (skills.length === 0) return "no skills installed";
  return skills
    .map((s) =>
      s.broken
        ? `${s.name.padEnd(20)} ${s.source.padEnd(7)} [broken: ${s.broken}]`
        : `${s.name.padEnd(20)} ${s.source.padEnd(7)} ${s.description}`,
    )
    .join("\n");
}
