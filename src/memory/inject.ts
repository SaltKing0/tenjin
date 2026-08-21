import type { SummaryEntry } from "./summaries";
import type { LearningEntry } from "./learnings";

// Token budget instead of a character budget. A summary section that is too
// long wastes prompt tokens every run, so we bound it at the token level.
// DEFAULT_MAX_TOKENS ~ the old 3200-char default at ~4 chars/token.
export const DEFAULT_MAX_TOKENS = 800;

// Heuristic token count (no tokenizer dependency): ~4 chars per token is the
// common approximation for English prose. Ceil so an empty string is 1 token.
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface MemorySectionOptions {
  currentProject: string;
  maxTokens?: number;
  /** Tier-2 distilled learnings (core tier first). Injected ahead of the
   *  chronological summaries and bounded by the same shared token budget. */
  learnings?: LearningEntry[] | null;
}

const HEADER =
  "# Memory — recent sessions in this project\nWhat happened before, newest first:";

const LEARNINGS_HEADER = "# Learnings — durable takeaways for this project";

// A summary written under a parent directory is relevant to a current project
// that lives in one of its subdirectories (and vice versa): projects are often
// nested, and a moved repo keeps a shared prefix with its old location.
// Exact match is most relevant; an ancestor/descendant directory is relevant
// but weaker. Boundary-aware so "/proj" never matches "/projects".
function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathPrefix(prefix: string, path: string): boolean {
  const a = normPath(prefix);
  const b = normPath(path);
  return a === b || b.startsWith(a + "/");
}

function pathRelevance(projectPath: string, currentProject: string): number {
  if (projectPath === currentProject) return 1;
  if (isPathPrefix(projectPath, currentProject)) return 0.5;
  if (isPathPrefix(currentProject, projectPath)) return 0.5;
  return 0;
}

// Recency window over which a summary's freshness decays to zero.
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Weighting: relevance dominates recency so a directly-matching fact is always
// ranked above a merely-inherited one, while ties within a relevance tier are
// broken by recency (newest first).
const RELEVANCE_WEIGHT = 2;

function dateMs(created: string): number {
  const t = Date.parse(created);
  return Number.isFinite(t) ? t : NaN;
}

function entryScore(
  entry: SummaryEntry,
  currentProject: string,
  newestMs: number,
): number {
  const relevance = pathRelevance(entry.meta.projectPath, currentProject);
  let recency = 0;
  if (Number.isFinite(newestMs)) {
    const ageMs = newestMs - dateMs(entry.meta.created);
    recency = Number.isFinite(ageMs) ? Math.max(0, 1 - ageMs / RECENCY_WINDOW_MS) : 0;
  }
  return RELEVANCE_WEIGHT * relevance + recency;
}

export function buildMemorySection(
  entries: SummaryEntry[],
  opts: MemorySectionOptions,
): string | null {
  const max = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  // --- Tier-2 learnings (core) come first, newest-first (#204) so the shared
  // budget keeps the most recent takeaways instead of the oldest.
  const learningLines = (opts.learnings ?? [])
    .slice()
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    .map((l) => ({
      prefix: `- ${l.created.slice(0, 10)} (${l.sessionId}): `,
      text: l.fact,
    }));

  // --- chronological summaries (existing relevant+score ordering) ---
  const relevant = entries.filter(
    (e) => e.text && pathRelevance(e.meta.projectPath, opts.currentProject) > 0,
  );

  let newestMs = NaN;
  for (const e of relevant) {
    const t = dateMs(e.meta.created);
    if (Number.isFinite(t) && (Number.isNaN(newestMs) || t > newestMs)) newestMs = t;
  }

  const summaryLines = relevant
    .map((e) => ({ e, score: entryScore(e, opts.currentProject, newestMs) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.e.meta.created < b.e.meta.created ? 1 : -1;
    })
    .map(({ e: entry }) => ({
      prefix: `- ${entry.meta.created.slice(0, 10)} (${entry.meta.sessionId}): `,
      text: entry.text,
    }));

  const headers: string[] = [];
  if (learningLines.length > 0) headers.push(LEARNINGS_HEADER);
  if (summaryLines.length > 0) headers.push(HEADER);
  if (headers.length === 0) return null;
  const header = headers.join("\n");

  // Greedily fill the shared token budget: learnings first (core tier), then
  // summaries. A single oversized leading line is truncated rather than lost.
  const body: string[] = [];
  for (const { prefix, text } of [...learningLines, ...summaryLines]) {
    const candidate = `${header}\n${[...body, `${prefix}${text}`].join("\n")}`;
    if (estimateTokens(candidate) <= max) {
      body.push(`${prefix}${text}`);
      continue;
    }
    if (body.length === 0) {
      const roomChars = max * 4 - (header.length + 1 + prefix.length + 1);
      if (roomChars > 20) {
        body.push(`${prefix}${text.slice(0, roomChars - 1)}…`);
      }
    }
    break;
  }

  if (body.length === 0) return null;
  return `${header}\n${body.join("\n")}`;
}
