import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ===========================================================================
// B9-6 Promotion gates wiring (#405)
// ---------------------------------------------------------------------------
// The skill-candidate pipeline. Every tool-call accept / reject /
// edit-after-suggest emits a SIGNAL; signals land in the DATED DAILY layer
// first — never straight to the durable tiers. A promotion pass aggregates the
// daily signals into candidates and applies GATES:
//
//   frequency       seen >= N times
//   query-diversity >= M distinct contexts
//   score           accept ratio (accepts / accepts+rejects)
//
//   PROJECT scope : gates pass -> AUTO-promote (errors cheaply reversible)
//   GLOBAL scope  : gates pass -> enters REVIEW QUEUE; a recorded human
//                   approval is required before it is written to memory
//                   (USER.md / MEMORY.md analog)
//
// One-off / single-context signals never promote; project signals never leak
// to global scope.
// ===========================================================================

export type SignalKind = "accept" | "reject" | "edit-after-suggest";
export type SignalScope = "project" | "global";

export interface Signal {
  kind: SignalKind;
  scope: SignalScope;
  /** The fact / pattern / candidate text this signal is about. */
  payload: string;
  /** Context (query / tool call / location) the signal occurred in — used for
   *  query-diversity. Empty string when unknown. */
  context?: string;
  /** ISO timestamp; the YYYY-MM-DD prefix selects the daily file. */
  ts: string;
}

export interface PromotionGates {
  /** Minimum times a candidate must be seen. */
  minFrequency: number;
  /** Minimum distinct contexts (query-diversity). */
  minContexts: number;
  /** Minimum accept ratio (accepts / accepts+rejects), 0..1. */
  minAcceptRatio: number;
}

export const DEFAULT_GATES: PromotionGates = {
  minFrequency: 3,
  minContexts: 2,
  minAcceptRatio: 0.5,
};

export interface PromotedItem {
  payload: string;
  scope: SignalScope;
  source: "auto" | "review";
  contexts: string[];
  promotedAt: string;
}

export interface ReviewItem {
  id: string;
  payload: string;
  scope: "global";
  contexts: string[];
  score: number;
  queuedAt: string;
}

export interface Candidate {
  payload: string;
  scope: SignalScope;
  frequency: number;
  contexts: string[];
  accepts: number;
  rejects: number;
  acceptRatio: number;
  gatesPass: boolean;
}

export interface PromotionReport {
  autoPromoted: string[];
  queued: string[];
  skipped: { payload: string; reason: string }[];
}

function signalsDir(memoryDir: string): string {
  return join(memoryDir, "signals");
}

export function dailySignalsPath(memoryDir: string, date: string): string {
  return join(signalsDir(memoryDir), "daily", `${date}.json`);
}

/** Project-scoped AUTO-promoted memory (project skill-candidate file). */
export function projectMemoryPath(memoryDir: string): string {
  return join(signalsDir(memoryDir), "project.json");
}

/** Global-scoped promoted memory (USER.md / MEMORY.md analog). */
export function globalMemoryPath(memoryDir: string): string {
  return join(signalsDir(memoryDir), "global.json");
}

/** Global-scoped candidates that passed the gates and await human review. */
export function reviewQueuePath(memoryDir: string): string {
  return join(signalsDir(memoryDir), "review-queue.json");
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt file: treat as empty rather than crash the pass
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(value, null, 2)}\n`;
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

/** Emit one signal into the DATED DAILY layer only (never the durable tiers). */
export function emitSignal(memoryDir: string, signal: Signal): string {
  const date = (signal.ts || new Date().toISOString()).slice(0, 10);
  const path = dailySignalsPath(memoryDir, date);
  mkdirSync(join(signalsDir(memoryDir), "daily"), { recursive: true });
  const daily = readJsonArray(path);
  daily.push({ ...signal, context: signal.context ?? "" });
  writeJsonAtomic(path, daily);
  return path;
}

/** Read one day's signals (default: all daily files, oldest day first). */
export function readDailySignals(memoryDir: string, date?: string): Signal[] {
  if (date) return readJsonArray(dailySignalsPath(memoryDir, date)) as Signal[];
  const dir = join(signalsDir(memoryDir), "daily");
  if (!existsSync(dir)) return [];
  const out: Signal[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    out.push(...(readJsonArray(join(dir, file)) as Signal[]));
  }
  return out;
}

function normalizePayload(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Aggregate daily signals into per-(scope, payload) candidates and score the
 *  gates. A candidate's identity is its normalized payload within a scope. */
export function computeCandidates(
  memoryDir: string,
  gates: PromotionGates = DEFAULT_GATES,
): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const s of readDailySignals(memoryDir)) {
    const key = `${s.scope}\u0000${normalizePayload(s.payload)}`;
    let c = map.get(key);
    if (!c) {
      c = {
        payload: s.payload.trim(),
        scope: s.scope,
        frequency: 0,
        contexts: [],
        accepts: 0,
        rejects: 0,
        acceptRatio: 0,
        gatesPass: false,
      };
      map.set(key, c);
    }
    c.frequency++;
    const ctx = s.context ?? "";
    if (ctx && !c.contexts.includes(ctx)) c.contexts.push(ctx);
    if (s.kind === "accept" || s.kind === "edit-after-suggest") c.accepts++;
    else c.rejects++;
  }
  const out = [...map.values()];
  for (const c of out) {
    c.acceptRatio = c.accepts + c.rejects > 0 ? c.accepts / (c.accepts + c.rejects) : 0;
    c.gatesPass =
      c.frequency >= gates.minFrequency &&
      c.contexts.length >= gates.minContexts &&
      c.acceptRatio >= gates.minAcceptRatio;
  }
  return out;
}

/**
 * Promotion pass over the daily layer:
 *  - PROJECT candidates passing all gates are AUTO-promoted to the project
 *    memory file (errors there are cheaply reversible).
 *  - GLOBAL candidates passing all gates park in the REVIEW QUEUE (never
 *    written to memory without a recorded human approval).
 *  - Candidates failing any gate are skipped with a reason. Project signals
 *    never leak to the global scope — the two scopes are written to
 *    completely separate stores.
 * Returns a report of what happened.
 */
export function runPromotionPass(
  memoryDir: string,
  gates: PromotionGates = DEFAULT_GATES,
): PromotionReport {
  const report: PromotionReport = { autoPromoted: [], queued: [], skipped: [] };
  const project = readJsonArray(projectMemoryPath(memoryDir)) as PromotedItem[];
  const global = readJsonArray(globalMemoryPath(memoryDir)) as PromotedItem[];
  const queue = readJsonArray(reviewQueuePath(memoryDir)) as ReviewItem[];
  const projectKeys = new Set(project.map((i) => normalizePayload(i.payload)));
  const globalKeys = new Set(global.map((i) => normalizePayload(i.payload)));
  const queueKeys = new Set(queue.map((q) => normalizePayload(q.payload)));

  for (const c of computeCandidates(memoryDir, gates)) {
    const key = normalizePayload(c.payload);
    if (!c.gatesPass) {
      report.skipped.push({ payload: c.payload, reason: "gates not met" });
      continue;
    }
    if (c.scope === "project") {
      if (projectKeys.has(key)) {
        report.skipped.push({ payload: c.payload, reason: "already promoted" });
        continue;
      }
      project.push({
        payload: c.payload,
        scope: "project",
        source: "auto",
        contexts: c.contexts,
        promotedAt: new Date().toISOString(),
      });
      projectKeys.add(key);
      writeJsonAtomic(projectMemoryPath(memoryDir), project);
      report.autoPromoted.push(c.payload);
    } else {
      if (globalKeys.has(key)) {
        report.skipped.push({ payload: c.payload, reason: "already promoted" });
        continue;
      }
      if (queueKeys.has(key)) {
        report.skipped.push({ payload: c.payload, reason: "already queued" });
        continue;
      }
      queue.push({
        id: randomUUID().slice(0, 8),
        payload: c.payload,
        scope: "global",
        contexts: c.contexts,
        score: c.acceptRatio,
        queuedAt: new Date().toISOString(),
      });
      queueKeys.add(key);
      writeJsonAtomic(reviewQueuePath(memoryDir), queue);
      report.queued.push(c.payload);
    }
  }
  return report;
}

/** Promote a global review-queue item to memory after a recorded human
 *  approval. Returns false when the id is unknown (nothing written). */
export function approveReviewItem(memoryDir: string, id: string): boolean {
  const queue = readJsonArray(reviewQueuePath(memoryDir)) as ReviewItem[];
  const idx = queue.findIndex((q) => q.id === id);
  if (idx === -1) return false;
  const item = queue[idx]!;
  const global = readJsonArray(globalMemoryPath(memoryDir)) as PromotedItem[];
  if (!global.some((g) => normalizePayload(g.payload) === normalizePayload(item.payload))) {
    global.push({
      payload: item.payload,
      scope: "global",
      source: "review",
      contexts: item.contexts ?? [],
      promotedAt: new Date().toISOString(),
    });
    writeJsonAtomic(globalMemoryPath(memoryDir), global);
  }
  queue.splice(idx, 1);
  writeJsonAtomic(reviewQueuePath(memoryDir), queue);
  return true;
}
