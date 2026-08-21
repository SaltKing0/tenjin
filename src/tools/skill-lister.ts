import type { ToolDef } from "../tools/registry";
import { listSkills } from "../skills/loader";

export function createListSkillsTool(deps: {
  home: string;
  projectDir: string;
}): ToolDef {
  return {
    name: "list_skills",
    group: "read",
    description:
      "List available skills with their name, description, and source (project or global). Broken skills are shown as broken with a reason instead of being hidden.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler(_args, _ctx) {
      const skills = listSkills(deps.home, deps.projectDir);
      if (skills.length === 0) return "no skills installed";
      return skills
        .map((s) =>
          s.broken
            ? `${s.name}\t${s.source}\t[broken: ${s.broken}]\t${s.path}`
            : `${s.name}\t${s.source}\t${s.description}`,
        )
        .join("\n");
    },
  };
}
