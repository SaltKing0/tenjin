import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

// ===========================================================================
// B9-4 Structured fact files with time-validity (#396)
// ---------------------------------------------------------------------------
// Facts are durable, structured assertions ("the retry budget is 3", "the API
// key lives in .env") with a MANDATORY validity window and provenance. Stored
// as one plain Markdown file per fact with YAML frontmatter:
//
//   ---
//   id: <stable id>
//   type: <free-form, e.g. config | convention | decision>
//   tags: [a, b]
//   date: 2026-08-22
//   sourceId: <where the fact came from>
//   validFrom: 2026-08-01      # mandatory, inclusive start
//   validTo: 2026-09-01        # mandatory key; null = open end
//   supersedes: <id>           # optional lifecycle chain
//   ---
//   <fact body text>
//
// Every read carries the provenance (sourceId) so it can be wired into
// citations (B9-14). Retrieval is TEMPORAL: it filters by a reference-time
// argument, so the "current" fact is the one whose window CONTAINS T — not
// merely the one with the latest validFrom (the 41%-failure regression class:
// "ORDER BY valid_from DESC without a reference-time filter returns the wrong
// 'current' fact"). Stale entries (validTo in the past) rank below active ones
// and are flagged, never silently dropped.
// ===========================================================================

/** Input to writeFact. Both validFrom and validTo are mandatory; validTo may
 *  be null to express an open end (valid forever from validFrom onward). */
export interface FactInput {
  /** Free-form fact type (e.g. "config", "convention", "decision"). */
  type: string;
  tags: string[];
  /** ISO date (YYYY-MM-DD) the fact was recorded. */
  date: string;
  /** Provenance: the source the fact came from (doc path, chunk-id, ...). */
  sourceId: string;
  /** Inclusive start of validity. Mandatory. */
  validFrom: string;
  /** Inclusive end of validity. Mandatory KEY; null = open end. */
  validTo: string | null;
  /** id of the fact this one supersedes (lifecycle). */
  supersedes?: string;
  /** Fact body text. */
  text: string;
  /** Optional explicit id; derived deterministically from the text when omitted. */
  id?: string;
}

export interface Fact extends FactInput {
  id: string;
  /** Normalized: null = open end. */
  validTo: string | null;
  /** Computed at query time; not persisted. */
  status: "active" | "expired";
  /** Set when a later fact supersedes this one. */
  supersededBy?: string;
  path: string;
}

/** A fact as returned by queryFacts, with its time-relative status. */
export interface FactHit {
  fact: Fact;
  status: "active" | "expired";
}

export interface FactQuery {
  /** Reference time; a fact is "active" when its window contains this time.
   *  Defaults to the current time. Accepts YYYY-MM-DD, ISO datetime, Date or ms. */
  referenceTime?: string | Date | number;
  /** Restrict to one fact type. */
  type?: string;
  /** Restrict to facts carrying ALL of these tags. */
  tags?: string[];
  /** Max hits returned (after ranking). */
  limit?: number;
}

/** Directory holding the fact files under a memory dir. */
export function factsDir(memoryDir: string): string {
  return join(memoryDir, "facts");
}

export function factPath(memoryDir: string, id: string): string {
  return join(factsDir(memoryDir), `${id}.md`);
}

function slug(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "fact";
}

/** Small deterministic hash so the same text maps to the same id. */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function dateMs(v: string | null): number {
  if (v === null) return Infinity;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/** Mandatory-field validation. Field-specific errors so a caller can tell
 *  exactly which field is missing (test #396 requirement 3). */
function validate(input: FactInput): void {
  if (!input.validFrom || typeof input.validFrom !== "string") {
    throw new Error(
      "fact write rejected: validFrom is required (inclusive start of validity, YYYY-MM-DD)",
    );
  }
  if (input.validTo === undefined) {
    throw new Error(
      "fact write rejected: validTo is required (use null for an open end)",
    );
  }
  if (input.validTo !== null && !Number.isFinite(dateMs(input.validTo))) {
    throw new Error(
      `fact write rejected: validTo "${String(input.validTo)}" is not a valid date`,
    );
  }
  if (!Number.isFinite(dateMs(input.validFrom))) {
    throw new Error(
      `fact write rejected: validFrom "${String(input.validFrom)}" is not a valid date`,
    );
  }
  if (input.validTo !== null && dateMs(input.validFrom) > dateMs(input.validTo)) {
    throw new Error(
      `fact write rejected: validFrom (${input.validFrom}) is after validTo (${input.validTo})`,
    );
  }
  if (!input.sourceId) {
    throw new Error("fact write rejected: sourceId (provenance) is required");
  }
}

function renderFrontmatter(f: Fact): string {
  const lines = [
    "---",
    `id: ${JSON.stringify(f.id)}`,
    `type: ${JSON.stringify(f.type)}`,
    `tags: ${JSON.stringify(f.tags)}`,
    `date: ${JSON.stringify(f.date)}`,
    `sourceId: ${JSON.stringify(f.sourceId)}`,
    `validFrom: ${JSON.stringify(f.validFrom)}`,
    `validTo: ${JSON.stringify(f.validTo)}`,
  ];
  if (f.supersedes) lines.push(`supersedes: ${JSON.stringify(f.supersedes)}`);
  if (f.supersededBy) lines.push(`supersededBy: ${JSON.stringify(f.supersededBy)}`);
  lines.push("---", "");
  return lines.join("\n");
}

function writeFactFile(path: string, f: Fact): void {
  const content = `${renderFrontmatter(f)}${f.text.trim()}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function readFactFile(path: string): Fact | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m || !m[1]) return null;
  let meta: Record<string, unknown>;
  try {
    const parsed = YAML.parse(m[1]) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;
    meta = parsed;
  } catch {
    return null;
  }
  const id = String(meta.id ?? "");
  if (!id) return null;
  const fact: Fact = {
    id,
    type: String(meta.type ?? ""),
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    date: String(meta.date ?? ""),
    sourceId: String(meta.sourceId ?? ""),
    validFrom: String(meta.validFrom ?? ""),
    validTo: meta.validTo === null || meta.validTo === undefined ? null : String(meta.validTo),
    supersedes: meta.supersedes ? String(meta.supersedes) : undefined,
    supersededBy: meta.supersededBy ? String(meta.supersededBy) : undefined,
    text: (m[2] ?? "").trim(),
    status: "active",
    path,
  };
  return fact;
}

/** Read every fact stored under `memoryDir`. */
export function readFacts(memoryDir: string): Fact[] {
  const dir = factsDir(memoryDir);
  if (!existsSync(dir)) return [];
  const out: Fact[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const f = readFactFile(join(dir, file));
    if (f) out.push(f);
  }
  return out;
}

/**
 * Persist a fact. Enforces the mandatory validity window + provenance at
 * write. When `supersedes` names an existing fact, that fact's window is
 * clamped to end where this one begins and it is marked superseded (the
 * lifecycle transition), so the old fact is flagged expired from then on but
 * stays retrievable within its own (narrower) window.
 */
export function writeFact(memoryDir: string, input: FactInput): Fact {
  validate(input);
  const dir = factsDir(memoryDir);
  mkdirSync(dir, { recursive: true });
  const id = input.id ?? `${slug(input.text)}-${shortHash(input.text)}`;
  const path = factPath(memoryDir, id);
  const fact: Fact = {
    id,
    type: input.type,
    tags: input.tags,
    date: input.date,
    sourceId: input.sourceId,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    supersedes: input.supersedes,
    text: input.text,
    status: "active",
    path,
  };
  writeFactFile(path, fact);
  if (input.supersedes) supersedePredecessor(memoryDir, input.supersedes, fact);
  return fact;
}

function supersedePredecessor(memoryDir: string, oldId: string, next: Fact): void {
  const old = readFactFile(factPath(memoryDir, oldId));
  if (!old) return;
  const nextFrom = dateMs(next.validFrom);
  const curTo = dateMs(old.validTo);
  // The predecessor's validity ends where the successor begins (unless it
  // already ended earlier).
  const newTo =
    old.validTo === null || (Number.isFinite(nextFrom) && nextFrom < curTo)
      ? next.validFrom
      : old.validTo;
  old.validTo = newTo;
  old.supersededBy = next.id;
  writeFactFile(old.path, old);
}

function refMs(t: string | Date | number): number {
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/**
 * TEMPORAL retrieval: returns facts ranked by validity at `referenceTime`.
 * A fact is ACTIVE when its [validFrom, validTo] window contains the reference
 * time; otherwise it is EXPIRED. Active facts rank first (newest validFrom
 * first), expired facts follow (also newest-first) — expired facts are FLAGGED,
 * never dropped, so a caller can still surface "this used to be true" with its
 * original window. This is the fix for the regression where sorting by
 * validFrom alone returns the wrong "current" fact at time T.
 */
export function queryFacts(memoryDir: string, q: FactQuery = {}): FactHit[] {
  const ref = q.referenceTime === undefined ? Date.now() : refMs(q.referenceTime);
  const hits: FactHit[] = [];
  for (const f of readFacts(memoryDir)) {
    if (q.type !== undefined && f.type !== q.type) continue;
    if (q.tags && q.tags.length > 0 && !q.tags.every((t) => f.tags.includes(t))) continue;
    const fromMs = dateMs(f.validFrom);
    const toMs = dateMs(f.validTo);
    const active = Number.isFinite(fromMs) && fromMs <= ref && ref <= toMs;
    hits.push({ fact: f, status: active ? "active" : "expired" });
  }
  hits.sort((a, b) => {
    if (a.status !== b.status) return a.status === "active" ? -1 : 1;
    return dateMs(b.fact.validFrom) - dateMs(a.fact.validFrom);
  });
  return q.limit !== undefined ? hits.slice(0, q.limit) : hits;
}

/** Format a fact's provenance reference for a citation (pairs with B9-14).
 *  Carries both the source the fact came from and the fact's own id. */
export function citationFor(fact: Pick<Fact, "sourceId" | "id">): string {
  return `source:${fact.sourceId}#fact:${fact.id}`;
}
