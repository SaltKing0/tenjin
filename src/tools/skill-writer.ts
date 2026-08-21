import type { ToolDef } from "../tools/registry";
import { saveSkill } from "../skills/loader";

export function createSaveSkillTool(deps: { projectDir: string }): ToolDef {
  return {
    name: "save_skill",
    group: "write",
    description:
      "Persist a reusable skill to the project so future sessions can load it via use_skill. Use when you notice a repeatable pattern worth capturing.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short lowercase-dash name, e.g. bun-testing" },
        description: {
          type: "string",
          description: "One line: what the skill does and when to use it",
        },
        content: { type: "string", description: "Full instructions in markdown" },
      },
      required: ["name", "description", "content"],
    },
    async handler(args, _ctx) {
      const path = saveSkill(deps.projectDir, {
        name: String(args.name ?? ""),
        description: String(args.description ?? ""),
        content: String(args.content ?? ""),
      });
      return `Saved skill to ${path}`;
    },
  };
}
