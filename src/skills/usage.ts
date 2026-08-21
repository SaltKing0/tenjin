import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeSkillName } from "./loader";

/**
 * Skill usage tracking (#133). Every `use_skill` invocation appends one line to
 * a per-skill ndjson file so the harness can tell which skills get used, how
 * often they fail, and when — the raw material for self-improvement (a routine
 * flags error-prone / underused skills and proposes a refined version).
 */

export interface SkillUsage {
  skill: string;
  ts: string;
  ok: boolean;
  /** Set when `ok` is false — why the invocation failed. */
  error?: string;
  durationMs: number;
  /** Optional attribution (e.g. which bot used it). */
  bot?: string;
}

export function usageDir(projectDir: string): string {
  return join(projectDir, ".tenjin", "skills", "usage");
}

export function usagePathFor(projectDir: string, skill: string): string {
  // Sanitize so an untrusted skill name can never traverse out of the usage
  // dir (e.g. `../x` → cleaned to a single safe component).
  return join(usageDir(projectDir), `${sanitizeSkillName(skill)}.ndjson`);
}

/** Append one usage record (strictly append-only, never rewrites history). */
export function recordUsage(projectDir: string, entry: SkillUsage): void {
  mkdirSync(usageDir(projectDir), { recursive: true });
  appendFileSync(usagePathFor(projectDir, entry.skill), JSON.stringify(entry) + "\n");
}

/** Read every recorded usage line for a skill (oldest first). Skips corrupt lines. */
export function readUsage(projectDir: string, skill: string): SkillUsage[] {
  const p = usagePathFor(projectDir, skill);
  if (!existsSync(p)) return [];
  const entries: SkillUsage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as SkillUsage;
      if (parsed && typeof parsed.skill === "string") entries.push(parsed);
    } catch {
      // skip a corrupt line rather than failing the whole read
    }
  }
  return entries;
}

export interface UsageStats {
  skill: string;
  uses: number;
  errors: number;
  /** errors / uses, in 0..1. */
  errorRate: number;
  lastUsed: string | null;
  /** Sum of invocation durations (ms). */
  totalMs: number;
}

export function usageStats(projectDir: string, skill: string): UsageStats {
  const entries = readUsage(projectDir, skill);
  const errors = entries.filter((e) => !e.ok).length;
  return {
    skill,
    uses: entries.length,
    errors,
    errorRate: entries.length ? errors / entries.length : 0,
    lastUsed: entries.length ? (entries[entries.length - 1]?.ts ?? null) : null,
    totalMs: entries.reduce((sum, e) => sum + (e.durationMs || 0), 0),
  };
}

export interface AnalyzeOptions {
  /** Only consider skills used at least this many times. */
  minUses?: number;
  /** Flag a skill when its error rate is at least this (default 30%). */
  errorRateThreshold?: number;
}

/**
 * Flag skills that are used often enough and fail frequently — candidates for a
 * refined version. Deterministic and pure so a routine can run it cheaply.
 */
export function analyzeUsage(
  projectDir: string,
  skills: string[],
  opts: AnalyzeOptions = {},
): UsageStats[] {
  const minUses = opts.minUses ?? 2;
  const threshold = opts.errorRateThreshold ?? 0.3;
  const candidates: UsageStats[] = [];
  for (const name of skills) {
    const st = usageStats(projectDir, name);
    if (st.uses >= minUses && st.errorRate >= threshold) candidates.push(st);
  }
  // error rate desc, then uses desc — most problematic first
  candidates.sort((a, b) => b.errorRate - a.errorRate || b.uses - a.uses);
  return candidates;
}
