import type { Provider } from "../provider/types";
import type { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";
import { readSummary, writeSummary, summaryPath } from "./summaries";
import { readLearnings, recordLearning } from "./learnings";
import { checkForContradictions } from "./contradiction";

/**
 * End-of-session consolidation pass (Roadmap §12 B9-3).
 *
 * Sleep-time agents were explicitly rejected (§20 #19/#45); instead a single
 * cheap pass runs at a NATURAL boundary (post-turn, never mid-stream) once
 * calibrated context pressure crosses a threshold. It makes ONE extra call on
 * the configured cheap/helper model that:
 *
 *   - condenses the session's recall into an ongoing summary (a summary delta
 *     folded into the existing summary via the existing summaries tier), and
 *   - distills learnings CANDIDATES (proposals only — promotion gates are a
 *     later B9-6 concern), deduped by the existing learnings tier.
 *
 * Everything is written through the existing memory tiers; a helper-model
 * failure degrades gracefully (the session simply continues unconsolidated).
 */

/** Pressure ratio at which the pass fires (config `context.consolidation.threshold`). */
export const DEFAULT_CONSOLIDATION_THRESHOLD = 0.65;

/** Minimum turns between passes unless pressure rose strictly above the last pass. */
export const DEFAULT_CONSOLIDATION_MIN_TURNS = 5;

export interface ConsolidationConfig {
  enabled?: boolean;
  /** Pressure ratio (0..1) at which to trigger; default 0.65. */
  threshold?: number;
  /** Min turns between passes without strictly-higher pressure; default 5. */
  minTurnsBetween?: number;
  /** The configured cheap/helper model for the single consolidation call. */
  helper?: { provider: Provider; model: string; maxTokens?: number };
  /** Memory dir the summaries/learnings tiers live in. */
  memoryDir?: string;
  /** Project path learnings are attributed to. */
  projectPath?: string;
}

export interface ConsolidationTracker {
  lastRunIteration: number;
  lastRunPressureRatio: number;
}

export function newConsolidationTracker(): ConsolidationTracker {
  return { lastRunIteration: -1, lastRunPressureRatio: 0 };
}

/**
 * Gate: the pass fires only when calibrated pressure crosses the threshold,
 * and never twice within `minTurnsBetween` turns unless pressure rose strictly
 * above the previous pass (so a stuck-high session does not re-consolidate
 * every turn).
 */
export function shouldConsolidate(
  tracker: ConsolidationTracker,
  iteration: number,
  ratio: number,
  threshold: number = DEFAULT_CONSOLIDATION_THRESHOLD,
  minTurnsBetween: number = DEFAULT_CONSOLIDATION_MIN_TURNS,
): boolean {
  if (ratio < threshold) return false;
  if (tracker.lastRunIteration < 0) return true;
  const gap = iteration - tracker.lastRunIteration;
  if (gap <= minTurnsBetween && ratio <= tracker.lastRunPressureRatio) return false;
  return true;
}

export interface ConsolidationInput {
  provider: Provider;
  model: string;
  maxTokens: number;
  sessionKey: string;
  memoryDir: string;
  projectPath: string;
  sessionLog?: SessionLog | null;
  /** Log the pass (and any graceful skips) to the audit trail. */
  audit?: (kind: string, detail: string) => void;
  /** Opt-in contradiction check: after writing learnings, judge each NEWLY
   *  added candidate against the ACTIVE facts in `memoryDir` and record any
   *  contradiction (see memory/contradiction.ts). Off by default. */
  contradictionCheck?: {
    enabled?: boolean;
    /** Cap on total judge calls (default 4). */
    maxChecks?: number;
    /** Dedicated judge model; defaults to `model` (the consolidation helper). */
    model?: string;
  };
}

export type ConsolidationResult =
  | {
      ran: true;
      reason: "ran";
      summaryWritten: boolean;
      learningsAdded: number;
      learningsDeduped: number;
      /** Number of contradictions recorded by the (opt-in) check. */
      contradictions: number;
      message: string;
    }
  | { ran: false; reason: "failed"; message: string };

interface ConsolidationPayload {
  summary?: string;
  learnings?: string[];
}

const CONSOLIDATION_PROMPT = [
  "Consolidate the coding-agent session below into durable memory.",
  "Return ONLY a JSON object with exactly two keys:",
  '  {"summary": "<condensed recall as plain prose, at most 120 words>",',
  '   "learnings": ["<candidate durable fact 1>", "<candidate durable fact 2>", ...]}',
  "summary: fold this session's new activity into the existing summary, keeping",
  "threads continuous; condense recall, do not repeat what is already in it.",
  "learnings: distill up to 5 candidate durable takeaways, each a short factual",
  "sentence about the project or workflow. Proposals only — do not promote.",
  "Do not repeat facts already present in the existing learnings list.",
  "Do not emit anything outside the JSON object — no markdown fences, no prose.",
  "---",
  "Session trajectory:",
  "{{TRAJECTORY}}",
  "---",
  "Existing summary:",
  "{{PRIOR}}",
  "---",
  "Existing learnings (skip these):",
  "{{LEARNINGS}}",
  "---",
].join("\n");

/** Render the existing learnings list as bullet lines (or a marker when empty). */
function renderLearnings(entries: Array<{ fact: string }>): string {
  if (entries.length === 0) return "(none)";
  return entries.map((e) => `- ${e.fact}`).join("\n");
}

/**
 * Run the single consolidation pass: one cheap-model call, then write the
 * summary and learnings through the existing memory tiers. A provider failure
 * or empty/unparseable output is logged and swallowed — the session continues.
 */
export async function runConsolidation(input: ConsolidationInput): Promise<ConsolidationResult> {
  const trajectory = input.sessionLog
    ? renderTrajectory(input.sessionLog.events(), { full: true }).join("\n")
    : "";
  const existingSummary = readSummary(summaryPath(input.memoryDir, input.sessionKey))?.text ?? "";
  const existingLearnings = readLearnings(input.memoryDir, input.projectPath) ?? [];

  const prompt = CONSOLIDATION_PROMPT.replace("{{TRAJECTORY}}", trajectory || "(no trajectory)")
    .replace("{{PRIOR}}", existingSummary || "(none)")
    .replace("{{LEARNINGS}}", renderLearnings(existingLearnings));

  let raw: string;
  try {
    const response = await input.provider.chat({
      model: input.model,
      system: "You are a precise memory-consolidation assistant for a coding agent.",
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: input.maxTokens,
    });
    raw = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    input.audit?.("consolidation", `consolidation skipped: helper model failed (${msg})`);
    return { ran: false, reason: "failed", message: msg };
  }

  const payload = parsePayload(raw);
  if (!payload) {
    input.audit?.("consolidation", "consolidation skipped: helper output was not parseable JSON");
    return { ran: false, reason: "failed", message: "unparseable helper output" };
  }

  let summaryWritten = false;
  if (payload.summary && payload.summary.trim()) {
    // Write through the summaries tier. writeSummary keeps `uptoEvent`
    // monotonic, so an older concurrent pass can never regress a newer one.
    writeSummary(input.memoryDir, {
      sessionId: input.sessionKey,
      projectPath: input.projectPath,
      uptoEvent: input.sessionLog ? input.sessionLog.events().length : 0,
      created: new Date().toISOString(),
    }, payload.summary.trim());
    summaryWritten = true;
  }

  let learningsAdded = 0;
  let learningsDeduped = 0;
  const addedFacts: string[] = [];
  for (const fact of payload.learnings ?? []) {
    if (!fact || !fact.trim()) continue;
    const res = recordLearning(input.memoryDir, input.projectPath, fact, input.sessionKey);
    if (res.deduped) learningsDeduped++;
    else {
      learningsAdded++;
      addedFacts.push(fact.trim());
    }
  }

  // Opt-in contradiction check (IdeaGraph-derived): judge each newly-added
  // learning against the ACTIVE facts and record any contradiction. Bounded
  // by maxChecks and fully graceful — a judge/provider failure never aborts
  // the pass and never blocks the session.
  let contradictions = 0;
  if (input.contradictionCheck?.enabled && addedFacts.length > 0) {
    try {
      const records = await checkForContradictions({
        provider: input.provider,
        model: input.contradictionCheck.model ?? input.model,
        maxTokens: Math.min(input.maxTokens, 256),
        memoryDir: input.memoryDir,
        candidates: addedFacts,
        candidateIdPrefix: `session:${input.sessionKey}`,
        maxChecks: input.contradictionCheck.maxChecks,
        audit: input.audit,
      });
      contradictions = records.length;
    } catch {
      /* swallow: contradiction checking is best-effort */
    }
  }

  const message = `summary=${summaryWritten} learnings+${learningsAdded} deduped=${learningsDeduped} contradictions=${contradictions}`;
  input.audit?.("consolidation", `consolidation ran: ${message}`);
  return {
    ran: true,
    reason: "ran",
    summaryWritten,
    learningsAdded,
    learningsDeduped,
    contradictions,
    message,
  };
}

/**
 * Tolerant JSON extraction: find the first balanced {...} object in the
 * helper's output and parse it, tolerating surrounding prose or fences.
 */
function parsePayload(raw: string): ConsolidationPayload | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try {
          const parsed = JSON.parse(slice) as ConsolidationPayload;
          return {
            summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
            learnings: Array.isArray(parsed.learnings)
              ? parsed.learnings.filter((l): l is string => typeof l === "string")
              : undefined,
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
