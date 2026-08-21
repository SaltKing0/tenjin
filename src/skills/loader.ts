import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { ConfigError } from "../config/types";

export interface Skill {
  name: string;
  description: string;
  content: string;
  source: "global" | "project";
  path: string;
}

export function globalSkillsDir(home: string): string {
  return join(home, "skills");
}

export function projectSkillsDir(projectDir: string): string {
  return join(projectDir, ".tenjin", "skills");
}

function parseSkillFile(path: string, source: "global" | "project"): Skill | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match || !match[1]) return null;
  let meta: any;
  try {
    meta = YAML.parse(match[1]);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object") return null;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!name) return null;
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  return { name, description, content: (match[2] ?? "").trim(), source, path };
}

function scanDir(dir: string, source: "global" | "project"): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const skill = parseSkillFile(path, source);
    if (skill) skills.push(skill);
  }
  return skills;
}

export function listSkills(home: string, projectDir: string): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skill of scanDir(globalSkillsDir(home), "global")) {
    byName.set(skill.name, skill);
  }
  for (const skill of scanDir(projectSkillsDir(projectDir), "project")) {
    byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkill(
  home: string,
  projectDir: string,
  name: string,
): Skill | null {
  return listSkills(home, projectDir).find((s) => s.name === name) ?? null;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sanitizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned || !NAME_PATTERN.test(cleaned)) {
    throw new ConfigError(`invalid skill name "${name}" (use lowercase letters, digits, dashes)`);
  }
  return cleaned;
}

export function saveSkill(
  projectDir: string,
  input: { name: string; description: string; content: string },
): string {
  const name = sanitizeSkillName(input.name);
  const dir = projectSkillsDir(projectDir);
  const skillDir = join(dir, name);
  if (existsSync(skillDir)) {
    throw new ConfigError(`skill "${name}" already exists`);
  }
  mkdirSync(skillDir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(input.description.replace(/\s+/g, " ").trim())}`,
    "---",
    "",
  ].join("\n");
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path, `${frontmatter}${input.content.trim()}\n`);
  return path;
}

export function skillTemplate(name: string): string {
  const safe = sanitizeSkillName(name);
  return [
    "---",
    `name: ${JSON.stringify(safe)}`,
    'description: "What this skill does and when to use it"',
    "---",
    "",
    `# ${safe}`,
    "",
    "Instructions for the agent go here.",
    "",
  ].join("\n");
}

export function scaffoldSkill(projectDir: string, name: string): string {
  const safe = sanitizeSkillName(name);
  const dir = join(projectSkillsDir(projectDir), safe);
  if (existsSync(dir)) {
    throw new ConfigError(`skill "${safe}" already exists`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, skillTemplate(safe));
  return path;
}
