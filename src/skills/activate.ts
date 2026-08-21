import type { ToolDef } from "../tools/registry";
import { getSkill, type Skill } from "./loader";

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
      "Load an available skill's full instructions by name. Use when a skill matches the current task.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name" },
      },
      required: ["name"],
    },
    async handler(args, _ctx) {
      const name = String(args.name ?? "").trim();
      const skill = getSkill(deps.home, deps.projectDir, name);
      if (!skill) throw new Error(`unknown skill "${name}"`);
      const header = skill.description ? ` (${skill.description})` : "";
      return `# ${skill.name}${header}\n\n${skill.content}`;
    },
  };
}

export function summarizeSkills(skills: Skill[]): string {
  if (skills.length === 0) return "no skills installed";
  return skills
    .map((s) => `${s.name.padEnd(20)} ${s.source.padEnd(7)} ${s.description}`)
    .join("\n");
}
