import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatRequest, ChatResponse, Provider } from "../provider/types";
import { queryFacts } from "./facts";

// ===========================================================================
// Contradiction detection (IdeaGraph-derived, "kontrastiert mit")
// ---------------------------------------------------------------------------
// Stealth's facts tier tracks TIME (validity window + supersedes chain) but not
// SEMANTIC TENSION: two facts can be simultaneously active yet contradict each
// other, and nothing ever notices. This module closes that gap. When a new
// durable assertion (e.g. a consolidation learning) contradicts an ACTIVE fact
// with an overlapping validity window, it is recorded to a contradiction log
// (and audited) instead of silently accumulating — so stale/wrong memory can
// be surfaced and resolved rather than acted upon unknowingly.
//
// The pipeline is deliberately cheap and bounded:
//   - deterministic window-overlap pruning (no LLM) narrows the candidate set
//   - a single call per overlapping active fact decides the contradiction
//   - total judge calls are capped (`maxChecks`), and every judge/provider
//     failure degrades to "no contradiction" (the session continues).
// ===========================================================================

/** A validity window: [validFrom, validTo], null validTo = open end. */
export interface ContradictionWindow {
  validFrom: string;
  validTo: string | null;
}

/** A recorded contradiction between a candidate assertion and an active fact. */
export interface ContradictionRecord {
  id: string;
  /** The new/candidate assertion text that contradicts the fact. */
  candidateText: string;
  /** Provenance of the candidate (e.g. "session:<key>#<index>"). */
  candidateId: string;
  /** id of the active fact being contradicted. */
  targetFactId: string;
  /** text of the active fact being contradicted. */
  targetFactText: string;
  /** Short human explanation from the judge. */
  reason: string;
  /** ISO timestamp the contradiction was recorded. */
  ts: string;
}

/** A judge decides whether two statements contradict; returns a verdict. */
export type ContradictionJudge = (
  candidate: string,
  existingFactText: string,
) => Promise<{ contradicts: boolean; reason: string }>;

export interface ContradictionCheckOptions {
  provider: Provider;
  model: string;
  maxTokens?: number;
  /** Memory dir whose facts tier holds the active facts to check against. */
  memoryDir: string;
  /** Candidate durable assertions to check. */
  candidates: string[];
  /** Provenance prefix recorded on each hit (e.g. the session key). */
  candidateIdPrefix: string;
  /** Validity window of the candidates (default: open-ended from today). */
  candidateWindow?: ContradictionWindow;
  /** Cap on total judge calls (default 4). */
  maxChecks?: number;
  /** Injectable judge (tests); defaults to llmContradictionJudge. */
  judge?: ContradictionJudge;
  audit?: (kind: string, detail: string) => void;
}

export const DEFAULT_MAX_CHECKS = 4;

// ---------------------------------------------------------------------------
// Persistence: JSON-lines contradiction log under the memory dir
// ---------------------------------------------------------------------------

export function contradictionLogPath(memoryDir: string): string {
  return join(memoryDir, "contradictions.jsonl");
}

export function readContradictions(memoryDir: string): ContradictionRecord[] {
  const path = contradictionLogPath(memoryDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as ContradictionRecord;
      } catch {
        return null; // corrupt line: skip, never crash the reader
      }
    })
    .filter((r): r is ContradictionRecord => r !== null);
}

export function writeContradiction(memoryDir: string, record: ContradictionRecord): void {
  mkdirSync(memoryDir, { recursive: true });
  appendFileSync(contradictionLogPath(memoryDir), `${JSON.stringify(record)}\n`);
}

// ---------------------------------------------------------------------------
// Deterministic window-overlap pruning (pure, no LLM)
// ---------------------------------------------------------------------------

export interface Windowed {
  id: string;
  validFrom: string;
  validTo: string | null;
}

function ms(v: string | null): number {
  return v === null ? Infinity : Date.parse(v);
}

/** True when the two validity windows overlap ([a0,a1] x [b0,b1]). */
function overlap(a: ContradictionWindow, b: ContradictionWindow): boolean {
  const a0 = ms(a.validFrom);
  const a1 = ms(a.validTo);
  const b0 = ms(b.validFrom);
  const b1 = ms(b.validTo);
  return a0 <= b1 && b0 <= a1;
}

/** Return the subset of `facts` whose validity window overlaps `window`. */
export function findOverlappingFacts<T extends Windowed>(
  facts: T[],
  window: ContradictionWindow,
): T[] {
  return facts.filter((f) => overlap({ validFrom: f.validFrom, validTo: f.validTo }, window));
}

// ---------------------------------------------------------------------------
// LLM judge (single call, tolerant parse, graceful on failure)
// ---------------------------------------------------------------------------

const JUDGE_PROMPT = [
  "You judge whether two factual statements contradict each other.",
  'Return ONLY a JSON object: {"contradicts": true|false, "reason": "<short explanation>"}.',
  'Set "contradicts" to true only if BOTH statements cannot be true at the same time.',
  "Candidate (new):",
  "{{CANDIDATE}}",
  "Existing fact:",
  "{{EXISTING}}",
  "No markdown fences, no prose outside the JSON object.",
].join("\n");

/** Tolerant JSON extraction: first balanced {...} object in the output. */
function parseJudge(raw: string): { contradicts: boolean; reason: string } | null {
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
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1)) as Record<string, unknown>;
          return {
            contradicts: parsed.contradicts === true,
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Build an LLM-backed judge. Any failure (throw or unparseable) degrades to
 *  "no contradiction" so a flaky helper never breaks a session. */
export function llmContradictionJudge(
  provider: Provider,
  model: string,
  maxTokens: number = 256,
): ContradictionJudge {
  return async (candidate, existingFactText) => {
    try {
      const prompt = JUDGE_PROMPT.replace("{{CANDIDATE}}", candidate).replace(
        "{{EXISTING}}",
        existingFactText,
      );
      const resp = await provider.chat({
        model,
        system: "You are a precise contradiction judge for a coding agent's memory store.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens,
      });
      const raw = resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      return parseJudge(raw) ?? { contradicts: false, reason: "" };
    } catch {
      return { contradicts: false, reason: "" };
    }
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Normalize a statement for self-comparison (case/punct/whitespace-insensitive). */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function truncate(s: string, n = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

/**
 * Check a set of candidate durable assertions against the ACTIVE facts in
 * `memoryDir`. For each candidate, prune to overlapping active facts
 * (deterministic), judge each up to `maxChecks` total, and persist + audit any
 * contradiction found. Returns the recorded records. Degrades gracefully on
 * judge/provider failure (a failed judge is simply skipped).
 */
export async function checkForContradictions(
  opts: ContradictionCheckOptions,
): Promise<ContradictionRecord[]> {
  const window: ContradictionWindow =
    opts.candidateWindow ?? { validFrom: new Date().toISOString().slice(0, 10), validTo: null };
  const judge = opts.judge ?? llmContradictionJudge(opts.provider, opts.model, opts.maxTokens);
  const cap = opts.maxChecks ?? DEFAULT_MAX_CHECKS;

  // Only ACTIVE facts (their validity window contains now) can be contradicted
  // by a new assertion — stale/expired facts are not judged.
  const active = queryFacts(opts.memoryDir, {})
    .filter((h) => h.status === "active")
    .map((h) => h.fact);

  const records: ContradictionRecord[] = [];
  let checks = 0;

  for (let i = 0; i < opts.candidates.length; i++) {
    const candidateText = opts.candidates[i]!.trim();
    if (!candidateText) continue;
    const norm = normalize(candidateText);
    const pool = findOverlappingFacts(active, window).filter(
      (f) => f.text.trim().length > 0 && normalize(f.text) !== norm,
    );

    for (const fact of pool) {
      if (checks >= cap) {
        opts.audit?.("contradiction", `contradiction check capped at ${cap}; ${pool.length - (checks - records.length)} candidate(s) not judged`);
        return records;
      }
      checks++;
      let verdict: { contradicts: boolean; reason: string };
      try {
        verdict = await judge(candidateText, fact.text);
      } catch {
        continue; // judge failure: skip this fact, keep going
      }
      if (verdict.contradicts) {
        const record: ContradictionRecord = {
          id: `${shortHash(candidateText + fact.id)}`,
          candidateText,
          candidateId: `${opts.candidateIdPrefix}#${i}`,
          targetFactId: fact.id,
          targetFactText: fact.text,
          reason: verdict.reason?.trim() ?? "",
          ts: new Date().toISOString(),
        };
        writeContradiction(opts.memoryDir, record);
        opts.audit?.(
          "contradiction",
          `candidate '${truncate(candidateText)}' contradicts fact ${fact.id}: ${record.reason}`,
        );
        records.push(record);
      }
    }
  }
  return records;
}
