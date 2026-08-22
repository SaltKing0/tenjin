import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Optional SKILL.md-standard frontmatter fields (agentskills.io, #379). */
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
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

/* ------------------------------------------------------------------------- *
 * B15-1 (#379): SKILL.md-standard contract (agentskills.io)
 * ------------------------------------------------------------------------- */

/** Body limit: a skill body must stay under this many lines. */
export const MAX_SKILL_LINES = 500;
/** Body limit: a skill body must stay under this many estimated tokens. */
export const MAX_SKILL_TOKENS = 5000;
/** Name contract: lowercase-hyphen, 1-64 chars, alphanumeric/dash only. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Heuristic token count (no tokenizer dep): ~4 chars/token, ceil. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SkillValidation {
  ok: boolean;
  /** The offending field, for field-specific errors. */
  field?: string;
  /** Human message naming the field. */
  error?: string;
}

/**
 * Validate a skill against the SKILL.md-standard contract. Pure and testable:
 * returns a clean, field-specific error (never throws) so the loader can flag
 * an invalid skill with a precise reason.
 */
export function validateSkillFormat(opts: {
  name: string;
  dirName: string;
  description: string;
  content: string;
}): SkillValidation {
  const name = opts.name;
  if (!name) return { ok: false, field: "name", error: "name: missing required name field" };
  if (name.length > 64) return { ok: false, field: "name", error: `name: "${name}" exceeds 64 chars` };
  if (!SKILL_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      field: "name",
      error: `name: "${name}" is not lowercase-hyphen (1-64 chars, a-z0-9 and dashes)`,
    };
  }
  if (name !== opts.dirName) {
    return {
      ok: false,
      field: "name",
      error: `name: "${name}" does not match the skill directory name "${opts.dirName}"`,
    };
  }
  if (!opts.description.trim()) {
    return { ok: false, field: "description", error: "description: missing required description field" };
  }
  const lines = opts.content.split("\n").length;
  if (lines > MAX_SKILL_LINES) {
    return { ok: false, field: "content", error: `content: ${lines} lines exceeds ${MAX_SKILL_LINES}` };
  }
  const tokens = estimateTokens(opts.content);
  if (tokens > MAX_SKILL_TOKENS) {
    return { ok: false, field: "content", error: `content: ~${tokens} tokens exceeds ${MAX_SKILL_TOKENS}` };
  }
  return { ok: true };
}

/** Optional SKILL.md-standard frontmatter fields carried on the Skill. */
function optionalMeta(meta: Record<string, unknown>): Pick<Skill, "license" | "compatibility" | "allowedTools"> {
  return {
    license: typeof meta.license === "string" ? meta.license : undefined,
    compatibility: typeof meta.compatibility === "string" ? meta.compatibility : undefined,
    allowedTools: Array.isArray(meta["allowed-tools"])
      ? meta["allowed-tools"].filter((x): x is string => typeof x === "string")
      : undefined,
  };
}

/** Serialize a skill back to canonical SKILL.md (export side of the round-trip). */
export function exportSkill(skill: {
  name: string;
  description: string;
  content: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
}): string {
  const meta: Record<string, unknown> = {
    name: skill.name,
    description: skill.description.replace(/\s+/g, " ").trim(),
  };
  if (skill.license) meta.license = skill.license;
  if (skill.compatibility) meta.compatibility = skill.compatibility;
  if (skill.allowedTools?.length) meta["allowed-tools"] = skill.allowedTools;
  const fm = ["---", ...Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`), "---", ""].join("\n");
  return `${fm}${skill.content.trim()}\n`;
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
  const description = typeof meta.description === "string" ? meta.description.trim() : "";
  const content = (match[2] ?? "").trim();
  // B15-1 (#379): validate against the SKILL.md-standard contract; the
  // directory name must equal the frontmatter name, description is required,
  // and the body must respect the size limits. Field-specific reason on failure.
  const v = validateSkillFormat({ name, dirName: basename(dirname(path)), description, content });
  if (!v.ok) return { error: v.error };
  return {
    skill: { name, description, content, source, path, ...optionalMeta(meta) },
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
