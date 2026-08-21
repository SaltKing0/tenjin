import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tier-2 memory (#99): distilled, durable takeaways ("what did I learn about
// this project") that outlive chronological summaries. Stored per bot+project
// (a bot's `memoryDir` is its own, and within it each project gets its own
// file), deduplicated by normalized fact so re-learning the same thing updates
// the earlier entry instead of accumulating dupes.

export interface LearningEntry {
  fact: string;
  sessionId: string;
  created: string; // ISO date (YYYY-MM-DD)
}

/** Max entries kept per learnings.md file (#204). Oldest are dropped on overflow. */
export const DEFAULT_MAX_LEARNINGS = 200;

/** Sanitize a project path into a stable file slug ("/a/b" -> "a-b"). */
function projectSlug(projectPath: string): string {
  const slug = projectPath
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function learningsPath(memoryDirPath: string, projectPath: string): string {
  return join(memoryDirPath, "learnings", `${projectSlug(projectPath)}.md`);
}

function normalizeFact(fact: string): string {
  return fact.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parse the line-oriented " - [date] (session): fact" format back into entries. */
export function parseLearnings(raw: string): LearningEntry[] {
  const out: LearningEntry[] = [];
  for (const line of raw.split("\n")) {
    const m = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\s*\(([^)]*)\):\s*(.+)$/.exec(line);
    if (m) out.push({ created: m[1]!, sessionId: m[2]!, fact: m[3]! });
  }
  return out;
}

export function renderLearning(e: LearningEntry): string {
  return `- [${e.created.slice(0, 10)}] (${e.sessionId}): ${e.fact.replace(/\n+/g, " ")}`;
}

export function readLearnings(memoryDirPath: string, projectPath: string): LearningEntry[] | null {
  const path = learningsPath(memoryDirPath, projectPath);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  return raw ? parseLearnings(raw) : null;
}

/**
 * Drop the oldest entries so at most `maxEntries` remain. "Oldest" = earliest
 * `created` date; same-day ties break by file position (earlier = older),
 * matching the append-chronological order the file is written in.
 * Returns the survivors in their original relative order.
 */
function trimOldest(entries: LearningEntry[], maxEntries: number): LearningEntry[] {
  if (entries.length <= maxEntries) return entries;
  const keep = [...entries]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.created !== b.e.created) return a.e.created < b.e.created ? -1 : 1;
      return a.i - b.i;
    })
    .slice(entries.length - maxEntries)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.e);
  return keep;
}

/**
 * Persist a learning for this bot+project. If the same fact (case/whitespace
 * insensitive) already exists, its entry is replaced in place with the new
 * date/session; otherwise it is appended. When the file would exceed
 * `maxEntries` entries, the oldest are dropped (#204).
 */
export function recordLearning(
  memoryDirPath: string,
  projectPath: string,
  fact: string,
  sessionId: string,
  maxEntries: number = DEFAULT_MAX_LEARNINGS,
): { path: string; deduped: boolean } {
  const path = learningsPath(memoryDirPath, projectPath);
  mkdirSync(join(memoryDirPath, "learnings"), { recursive: true });

  const existing = existsSync(path) ? parseLearnings(readFileSync(path, "utf8")) : [];
  const entry: LearningEntry = {
    fact: fact.trim().replace(/\n+/g, " "),
    sessionId,
    created: new Date().toISOString().slice(0, 10),
  };
  const norm = normalizeFact(entry.fact);

  const next: LearningEntry[] = [];
  let deduped = false;
  for (const e of existing) {
    if (!deduped && normalizeFact(e.fact) === norm) {
      next.push(entry); // replace the earlier duplicate in place
      deduped = true;
    } else {
      next.push(e);
    }
  }
  if (!deduped) next.push(entry);

  writeFileSync(path, `${trimOldest(next, maxEntries).map(renderLearning).join("\n")}\n`);
  return { path, deduped };
}
