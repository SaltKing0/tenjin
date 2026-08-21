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
  /** Set when the SKILL.md could not be parsed; carries the reason. */
  broken?: string;
}

export function globalSkillsDir(home: string): string {
  return join(home, "skills");
}

export function projectSkillsDir(projectDir: string): string {
  return join(projectDir, ".tenjin", "skills");
}

interface ParseResult {
  skill?: Skill;
  error?: string;
}

function parseSkillFile(path: string, source: "global" | "project"): ParseResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { error: `unreadable: ${(e as Error).message}` };
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match || !match[1]) return { error: "missing YAML frontmatter" };
  let meta: any;
  try {
    meta = YAML.parse(match[1]);
  } catch (e) {
    return { error: `invalid YAML: ${(e as Error).message}` };
  }
  if (!meta || typeof meta !== "object") return { error: "invalid frontmatter" };
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  if (!name) return { error: "missing name field" };
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  return {
    skill: { name, description, content: (match[2] ?? "").trim(), source, path },
  };
}

function scanDir(dir: string, source: "global" | "project"): Skill[] {
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    const { skill, error } = parseSkillFile(path, source);
    if (skill) {
      skills.push(skill);
      continue;
    }
    const reason = error ?? "unknown parse error";
    console.warn(`[skills] ${path}: broken skill (${reason})`);
    skills.push({
      name: entry.name,
      description: "",
      content: "",
      source,
      path,
      broken: reason,
    });
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
  return listSkills(home, projectDir).find((s) => !s.broken && s.name === name) ?? null;
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
  input: { name: string; description: string; content: string; overwrite?: boolean },
): string {
  const name = sanitizeSkillName(input.name);
  const dir = projectSkillsDir(projectDir);
  const skillDir = join(dir, name);
  if (existsSync(skillDir) && !input.overwrite) {
    throw new ConfigError(
      `skill "${name}" already exists; pass overwrite: true to update it`,
    );
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
