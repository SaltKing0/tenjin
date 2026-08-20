import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SoulSource {
  text: string;
  source: "project" | "global" | "default";
}

const DEFAULT_SOUL = `You are Tenjin — a precise, pragmatic coding agent.

- Prefer working code over abstract advice.
- Be brief. Show, don't tell.
- Never invent APIs; verify against the actual code.
- Leave code cleaner than you found it.`;

export function loadSoul(home: string, projectDir: string): SoulSource {
  const projectPath = join(projectDir, ".tenjin", "SOUL.md");
  if (existsSync(projectPath)) {
    return { text: readFileSync(projectPath, "utf8").trim(), source: "project" };
  }
  const globalPath = join(home, "SOUL.md");
  if (existsSync(globalPath)) {
    return { text: readFileSync(globalPath, "utf8").trim(), source: "global" };
  }
  return { text: DEFAULT_SOUL, source: "default" };
}

export function loadAgentsMd(projectDir: string): string | null {
  const path = join(projectDir, "AGENTS.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text || null;
}

export function buildSystemPrompt(inputs: {
  soulText: string;
  agentsMd: string | null;
  cwd: string;
}): string {
  const parts: string[] = [inputs.soulText];

  parts.push(
    [
      "# Environment",
      `cwd: ${inputs.cwd}`,
      `platform: ${process.platform}`,
      `date: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n"),
  );

  parts.push(
    "# Working style\n" +
      "- Use the provided tools to read, search, and modify files. Do not guess file contents.\n" +
      "- Prefer precise edits over rewrites. Keep changes minimal and focused.\n" +
      "- Verify assumptions against the actual code before acting on them.",
  );

  if (inputs.agentsMd) {
    parts.push(`# Project context (AGENTS.md)\n${inputs.agentsMd}`);
  }

  return parts.join("\n\n");
}
