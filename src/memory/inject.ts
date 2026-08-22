import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
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

// ===========================================================================
// B9-1 Tier-0 core-memory blocks (#363)
// ---------------------------------------------------------------------------
// Replace free-form memory injection with NAMED, agent-editable sections that
// always render in a fixed order with block labels. Each block has a hard
// token budget; overflowing is an ERROR returned to the model (forcing
// self-consolidation) — never a silent drop or truncation. The agent edits
// memory only through block-scoped primitives (add/replace/remove).
// ===========================================================================

/** The four named core-memory blocks, in fixed render order. */
export const CORE_BLOCK_NAMES = [
  "persona",
  "user",
  "learnings-synopsis",
  "conventions",
] as const;

export type CoreBlockName = (typeof CORE_BLOCK_NAMES)[number];

/** Human-readable render label per block. */
export const CORE_BLOCK_LABELS: Record<CoreBlockName, string> = {
  persona: "Persona",
  user: "User",
  "learnings-synopsis": "Learnings synopsis",
  conventions: "Conventions",
};

/** Default hard token budget per block (~4 chars/token). */
export const DEFAULT_CORE_BUDGET_TOKENS = 1000;

/** Content of every defined block; a missing/empty value means "not set". */
export type CoreBlocks = Record<CoreBlockName, string>;

export function emptyCoreBlocks(): CoreBlocks {
  return {
    persona: "",
    user: "",
    "learnings-synopsis": "",
    conventions: "",
  };
}

export function isCoreBlockName(name: string): name is CoreBlockName {
  return (CORE_BLOCK_NAMES as readonly string[]).includes(name);
}

function coreBlocksPath(memoryDir: string): string {
  return join(memoryDir, "core-memory.json");
}

/** Load persisted blocks, defaulting any unset block to "" and ignoring
 *  unknown keys so a hand-edited or future file stays forward-compatible. */
export function loadCoreBlocks(memoryDir: string): CoreBlocks {
  const blocks = emptyCoreBlocks();
  const path = coreBlocksPath(memoryDir);
  if (!existsSync(path)) return blocks;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const name of CORE_BLOCK_NAMES) {
      const v = parsed[name];
      if (typeof v === "string") blocks[name] = v;
    }
  } catch {
    // Corrupt file: fall back to empty rather than crashing the run.
  }
  return blocks;
}

/** Persist blocks (keys written in fixed order for diff-stability). */
export function saveCoreBlocks(memoryDir: string, blocks: CoreBlocks): void {
  mkdirSync(memoryDir, { recursive: true });
  const ordered: Record<string, string> = {};
  for (const name of CORE_BLOCK_NAMES) ordered[name] = blocks[name];
  writeFileSync(coreBlocksPath(memoryDir), `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

/** Render the blocks that have content, in fixed order, under a REFERENCE DATA
 *  heading with a label per block. Returns null when no block is set. */
export function renderCoreMemory(blocks: CoreBlocks): string | null {
  const rendered: string[] = [];
  for (const name of CORE_BLOCK_NAMES) {
    const content = blocks[name].trim();
    if (!content) continue;
    rendered.push(`## ${CORE_BLOCK_LABELS[name]}\n${content}`);
  }
  if (rendered.length === 0) return null;
  return `# Core memory (reference data)\n${rendered.join("\n\n")}`;
}

export interface EditCoreBlockResult {
  block: CoreBlockName;
  op: "add" | "replace" | "remove";
  content: string;
}

/**
 * The single block-scoped edit primitive. `op` is add/replace/remove per block
 * name; any name outside the defined blocks is rejected. add/replace enforce a
 * hard token budget and, on overflow, THROW an instructive error naming the
 * block and budget — nothing is written, so the model must consolidate.
 */
export function editCoreBlock(
  memoryDir: string,
  name: string,
  op: "add" | "replace" | "remove",
  content = "",
  budgetTokens = DEFAULT_CORE_BUDGET_TOKENS,
): EditCoreBlockResult {
  if (!isCoreBlockName(name)) {
    throw new Error(
      `Unknown core-memory block "${name}". Valid blocks: ${CORE_BLOCK_NAMES.join(", ")}.`,
    );
  }
  if (op === "remove") {
    const blocks = loadCoreBlocks(memoryDir);
    blocks[name] = "";
    saveCoreBlocks(memoryDir, blocks);
    return { block: name, op, content: "" };
  }
  if (op !== "add" && op !== "replace") {
    throw new Error(`Invalid core-memory op "${op}". Valid ops: add, replace, remove.`);
  }
  const text = String(content).trim();
  if (!text) {
    throw new Error(`Core-memory block "${name}" content must not be empty; use op "remove" to clear it.`);
  }
  const tokens = estimateTokens(text);
  if (tokens > budgetTokens) {
    throw new Error(
      `Core-memory block "${name}" exceeds its budget of ${budgetTokens} tokens (est. ${tokens}). ` +
        `Consolidate or shorten it; nothing was written.`,
    );
  }
  const blocks = loadCoreBlocks(memoryDir);
  blocks[name] = text;
  saveCoreBlocks(memoryDir, blocks);
  return { block: name, op, content: text };
}
