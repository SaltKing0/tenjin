import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectSkillsDir } from "./loader";
import { ConfigError } from "../config/types";

/**
 * Skill refine proposals (#133). A proposed new version is written as a
 * VERSION-<n>.md file NEXT TO a skill's active SKILL.md, which stays untouched —
 * so the old version remains active until the proposal is explicitly activated
 * (which is the approval-gated step). This makes improvements non-destructive:
 * a bot can always propose, but nothing changes until a human/approver says so.
 */

export interface RefineProposal {
  skill: string;
  version: number;
  description: string;
  reason: string;
  /** The FULL proposed SKILL.md (frontmatter + body). */
  content: string;
}

function refineDir(projectDir: string, skill: string): string {
  return join(projectSkillsDir(projectDir), skill, "refine");
}

function versionFile(projectDir: string, skill: string, version: number): string {
  return join(refineDir(projectDir, skill), `VERSION-${version}.md`);
}

/** List existing proposal version numbers for a skill, ascending. */
export function listRefineVersions(projectDir: string, skill: string): number[] {
  const dir = refineDir(projectDir, skill);
  if (!existsSync(dir)) return [];
  const versions: number[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^VERSION-(\d+)\.md$/.exec(f);
    if (m) versions.push(parseInt(m[1] ?? "", 10));
  }
  return versions.sort((a, b) => a - b);
}

export function readRefineProposal(
  projectDir: string,
  skill: string,
  version: number,
): RefineProposal | null {
  const p = versionFile(projectDir, skill, version);
  if (!existsSync(p)) return null;
  // The proposal file is itself a full SKILL.md; the frontmatter carries the
  // description and reason fields used by the analyse/report surface.
  const raw = readFileSync(p, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  const fm = m?.[1] ?? "";
  const desc = fm ? extractField(fm, "description") : "";
  const reason = fm ? extractField(fm, "reason") : "";
  return {
    skill,
    version,
    description: desc,
    reason,
    content: raw,
  };
}

function extractField(frontmatter: string, field: string): string {
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(frontmatter);
  if (!m || !m[1]) return "";
  const v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/**
 * Write a new refine proposal as the next VERSION-n.md. The active SKILL.md is
 * NOT touched here — activation is a separate, approval-gated step.
 */
export function proposeRefine(
  projectDir: string,
  input: { skill: string; description: string; reason: string; content: string },
): RefineProposal {
  const skill = input.skill;
  const versions = listRefineVersions(projectDir, skill);
  const version = (versions.length ? (versions[versions.length - 1] ?? 0) : 0) + 1;

  const frontmatter = [
    "---",
    `name: ${JSON.stringify(skill)}`,
    `description: ${JSON.stringify(input.description.replace(/\s+/g, " ").trim())}`,
    `reason: ${JSON.stringify(input.reason.trim())}`,
    "---",
    "",
  ].join("\n");
  const body =
    typeof input.content === "string" && input.content.trim().startsWith("---")
      ? input.content.trim()
      : `${frontmatter}${input.content.trim()}\n`;

  mkdirSync(refineDir(projectDir, skill), { recursive: true });
  writeFileSync(versionFile(projectDir, skill, version), body);
  return readRefineProposal(projectDir, skill, version)!;
}

/** All pending proposals across the given skills (highest version reads first). */
export function pendingRefines(
  projectDir: string,
  skills: string[],
): RefineProposal[] {
  const out: RefineProposal[] = [];
  for (const skill of skills) {
    const versions = listRefineVersions(projectDir, skill);
    for (const v of versions) {
      const p = readRefineProposal(projectDir, skill, v);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * ACTIVATION: apply an approved proposal by copying its content over the active
 * SKILL.md. Callers must gate this behind the approvals flow — this function
 * only performs the switch, it does not itself decide approval.
 */
export function activateRefine(
  projectDir: string,
  skill: string,
  version: number,
): string {
  const proposal = readRefineProposal(projectDir, skill, version);
  if (!proposal) {
    throw new ConfigError(`no refine proposal ${skill}#v${version}`);
  }
  const active = join(projectSkillsDir(projectDir), skill, "SKILL.md");
  if (!existsSync(active)) {
    throw new ConfigError(`skill \"${skill}\" has no active SKILL.md to update`);
  }
  writeFileSync(active, proposal.content);
  return active;
}
