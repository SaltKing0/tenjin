import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import type { Provider } from "../provider/types";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";

export interface SummaryMeta {
  sessionId: string;
  projectPath: string;
  uptoEvent: number;
  created: string;
}

export interface SummaryEntry {
  path: string;
  meta: SummaryMeta;
  text: string;
}

const SUMMARY_PROMPT = [
  "Summarize this coding-agent session in at most 120 words.",
  "Cover: what was worked on, key decisions made, outcomes, and any open threads.",
  "Plain prose only — no headers, no bullet lists.",
  "The session trajectory follows:",
  "---",
  "{{TRAJECTORY}}",
  "---",
].join("\n");

// Used when a summary already exists for the session: only the events after the
// previous `uptoEvent` pointer are rendered, and the old summary is carried in
// so the model can fold new activity into it rather than repeating history.
const INCREMENTAL_PROMPT = [
  "This session already has a summary covering earlier activity.",
  "Fold only the NEW activity below into that summary: keep threads continuous,",
  "note new decisions and outcomes, at most 150 words.",
  "Existing summary:",
  "---",
  "{{PRIOR}}",
  "---",
  "New activity (session {{SESSION_ID}}) since the last summary follows:",
  "---",
  "{{TRAJECTORY}}",
  "---",
].join("\n");

// Map-reduce prompts (#136): when a session's full trajectory is too long for a
// single summary call, it is split into chunks, each chunk is summarized, and
// the partials are fused into one summary in a final call.
const CHUNK_PROMPT = [
  "Summarize this portion of a coding-agent session in at most 80 words.",
  "Keep concrete facts, decisions and outcomes; plain prose only.",
  "The session portion follows:",
  "---",
  "{{CHUNK}}",
  "---",
].join("\n");

const FUSION_PROMPT = [
  "Combine the following partial summaries of ONE coding-agent session into a single",
  "coherent summary of at most 150 words, merging overlapping points and removing",
  "repetition. Plain prose only.",
  "Partial summaries:",
  "---",
  "{{PARTS}}",
  "---",
].join("\n");

const FUSION_WITH_PRIOR_PROMPT = [
  "This session already has a summary covering earlier activity.",
  "Fold the following partial summaries of the NEW activity into that summary,",
  "keeping threads continuous, at most 150 words. Plain prose only.",
  "Existing summary:",
  "---",
  "{{PRIOR}}",
  "---",
  "New-activity partial summaries:",
  "---",
  "{{PARTS}}",
  "---",
].join("\n");

// Chars-per-token estimate, matching the context-window guard (config/context).
const CHARS_PER_TOKEN = 4;
/** Default input-token budget for a single summary call; longer trajectories map-reduce. */
const DEFAULT_PROMPT_BUDGET_TOKENS = 2000;

export function summaryPath(memoryDirPath: string, sessionId: string): string {
  return join(memoryDirPath, "summaries", `${sessionId}.md`);
}

export function readSummary(path: string): SummaryEntry | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match || !match[1]) return null;
  let meta: Partial<SummaryMeta>;
  try {
    meta = YAML.parse(match[1]) as Partial<SummaryMeta>;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || !meta.sessionId) return null;
  return {
    path,
    meta: {
      sessionId: String(meta.sessionId),
      projectPath: String(meta.projectPath ?? ""),
      uptoEvent: Number(meta.uptoEvent ?? 0),
      created: String(meta.created ?? ""),
    },
    text: (match[2] ?? "").trim(),
  };
}

export function listSummaries(memoryDirPath: string): SummaryEntry[] {
  const dir = join(memoryDirPath, "summaries");
  if (!existsSync(dir)) return [];
  const entries: SummaryEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const entry = readSummary(join(dir, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

export function sessionsWithoutSummary(
  sessionsDirPath: string,
  memoryDirPath: string,
): SessionLog[] {
  const summarized = new Set(listSummaries(memoryDirPath).map((s) => s.meta.sessionId));
  return SessionLog.list(sessionsDirPath)
    .filter((s) => !summarized.has(s.id))
    .map((s) => SessionLog.open(s.path));
}

export async function generateSummary(
  log: SessionLog,
  opts: {
    provider: Provider;
    model: string;
    maxTokens: number;
    projectPath: string;
    memoryDirPath: string;
    /** Input-token budget per summary call; longer trajectories map-reduce (#136). */
    promptBudgetTokens?: number;
  },
): Promise<string> {
  const events = log.events();
  // If a summary already exists for this session, only fold in the events after
  // its `uptoEvent` pointer; otherwise summarize the whole trajectory.
  const existing = readSummary(summaryPath(opts.memoryDirPath, log.id));
  const startFrom = existing ? Math.min(existing.meta.uptoEvent, events.length) : 0;
  if (existing && startFrom >= events.length) {
    // Nothing new since the last summary — leave it untouched.
    return existing.text;
  }

  const newEvents = events.slice(startFrom);
  // Summaries consume the COMPLETE trajectory (no 160-char line truncation);
  // only the human console keeps the capped rendering.
  const trajectory = renderTrajectory(newEvents, { full: true }).join("\n");

  const budgetTokens = opts.promptBudgetTokens ?? DEFAULT_PROMPT_BUDGET_TOKENS;
  const text =
    estimateTokens(trajectory) <= budgetTokens
      ? // Single call: fold existing summary in when present.
        await summarizeOnce(
          opts,
          existing
            ? INCREMENTAL_PROMPT.replace("{{PRIOR}}", existing.text)
                .replace("{{SESSION_ID}}", String(log.id))
                .replace("{{TRAJECTORY}}", trajectory)
            : SUMMARY_PROMPT.replace("{{TRAJECTORY}}", trajectory),
        )
      : // Long session: chunk-summarize each part, then fuse (map-reduce).
        await mapReduce(opts, { trajectory, existing, budgetTokens });
  if (!text) throw new Error("summarizer returned empty output");

  const meta: SummaryMeta = {
    sessionId: log.id,
    projectPath: opts.projectPath,
    uptoEvent: events.length,
    created: new Date().toISOString(),
  };
  writeSummary(opts.memoryDirPath, meta, text);
  return text;
}

/** One provider call that returns the trimmed text of the summary. */
async function summarizeOnce(
  opts: { provider: Provider; model: string; maxTokens: number },
  prompt: string,
): Promise<string> {
  const response = await opts.provider.chat({
    model: opts.model,
    system: "You are a precise technical summarizer.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: opts.maxTokens,
  });
  return response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

/**
 * Map-reduce a trajectory too long for a single call: split it into budget-sized
 * chunks, summarize each, then fuse the partials (optionally folding an existing
 * prior summary) into one summary.
 */
async function mapReduce(
  opts: { provider: Provider; model: string; maxTokens: number },
  args: { trajectory: string; existing: SummaryEntry | null; budgetTokens: number },
): Promise<string> {
  const chunks = splitTrajectory(args.trajectory, args.budgetTokens);
  const partials: string[] = [];
  for (const chunk of chunks) {
    const part = await summarizeOnce(
      opts,
      CHUNK_PROMPT.replace("{{CHUNK}}", chunk),
    );
    if (part) partials.push(part);
  }
  const parts = partials.join("\n\n");
  return args.existing
    ? summarizeOnce(
        opts,
        FUSION_WITH_PRIOR_PROMPT.replace("{{PRIOR}}", args.existing.text).replace(
          "{{PARTS}}",
          parts,
        ),
      )
    : summarizeOnce(opts, FUSION_PROMPT.replace("{{PARTS}}", parts));
}

/** Rough token estimate for a text (chars/4, matching the context guard). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split a rendered trajectory into chunks that each stay within `maxTokens` (on a line boundary). */
function splitTrajectory(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * CHARS_PER_TOKEN);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const line of text.split("\n")) {
    const add = line.length + 1; // + the newline we'll rejoin
    if (current.length > 0 && currentChars + add > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += add;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks.length > 0 ? chunks : [text];
}

export function writeSummary(
  memoryDirPath: string,
  meta: SummaryMeta,
  text: string,
): string {
  const path = summaryPath(memoryDirPath, meta.sessionId);
  mkdirSync(join(memoryDirPath, "summaries"), { recursive: true });

  // #208: two concurrent generateSummary runs on the same session can both read
  // the same old `existing` state and then write one after the other — the older
  // writer could win and regress `uptoEvent`, so the next incremental pass would
  // replay events or clobber fresher summaries. Never let an older writer
  // overwrite a newer summary: if the on-disk pointer is already >= ours we lose
  // and discard cleanly. The write itself goes through a temp file + atomic
  // rename so a crash mid-write cannot leave a corrupt or truncated summary.
  const current = readSummary(path);
  if (current && current.meta.uptoEvent >= meta.uptoEvent) {
    return path;
  }

  const frontmatter = [
    "---",
    `sessionId: ${JSON.stringify(meta.sessionId)}`,
    `projectPath: ${JSON.stringify(meta.projectPath)}`,
    `uptoEvent: ${meta.uptoEvent}`,
    `created: ${JSON.stringify(meta.created)}`,
    "---",
    "",
  ].join("\n");
  const content = `${frontmatter}${text.trim()}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    // Do not leave a stray temp file behind on a failed rename.
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
  return path;
}

export interface GenerationReport {
  generated: string[];
  errors: string[];
}

export interface SummarizeLatestResult {
  sessionId: string;
  words: number;
}

/**
 * Gateway path for #37: summarize the newest session in `sessionsDirPath` into
 * `memoryDirPath`, incrementally folding in anything since its last `uptoEvent`.
 * Returns null when there are no sessions. Errors from the provider propagate to
 * the caller, which decides whether to log them.
 */
export async function summarizeLatestSession(opts: {
  sessionsDirPath: string;
  memoryDirPath: string;
  provider: Provider;
  model: string;
  maxTokens: number;
  projectPath: string;
}): Promise<SummarizeLatestResult | null> {
  const sessions = SessionLog.list(opts.sessionsDirPath);
  // SessionLog.list() is sorted by mtime descending, so the newest is first.
  const latest = sessions[0];
  if (!latest) return null;
  const log = SessionLog.open(latest.path);
  const text = await generateSummary(log, {
    provider: opts.provider,
    model: opts.model,
    maxTokens: opts.maxTokens,
    projectPath: opts.projectPath,
    memoryDirPath: opts.memoryDirPath,
  });
  return { sessionId: log.id, words: text.trim().split(/\s+/).filter(Boolean).length };
}

export async function generatePendingSummaries(opts: {
  sessionsDirPath: string;
  memoryDirPath: string;
  provider: Provider;
  model: string;
  maxTokens: number;
  projectPath: string;
  limit?: number;
}): Promise<GenerationReport> {
  const report: GenerationReport = { generated: [], errors: [] };
  const pending = sessionsWithoutSummary(opts.sessionsDirPath, opts.memoryDirPath);
  for (const log of pending.slice(0, opts.limit ?? 10)) {
    try {
      await generateSummary(log, opts);
      report.generated.push(log.id);
    } catch (e) {
      report.errors.push(`${log.id}: ${(e as Error).message}`);
    }
  }
  return report;
}
