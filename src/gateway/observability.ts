import { existsSync, readdirSync } from "node:fs";
import type { ProviderStats } from "../provider/stats";
import { aggregateSpend, collectSessionScopes } from "../audit/spend";
import { approvalsDir, getRequest } from "./approvals";

/**
 * Observability endpoints for the always-on gateway (#135).
 *
 * `buildHealth` powers `GET /api/health` and `buildMetrics` powers `GET
 * /metrics` (Prometheus text format). Both read from disk (spend + session
 * counts) and from a process-lifetime `ProviderStats` counter wired into the
 * provider registry, which reports every chat outcome so provider reachability
 * is answered from cached data instead of a live probe per request.
 */

/** One scheduled job in the reduced shape the metrics read. */
export interface ObservabilityJob {
  running: boolean;
  nextDueMs: number;
}

/** Cache window for the disk aggregation behind health/metrics (#186). */
export const OBSERVABILITY_CACHE_TTL_MS = 20_000;

interface SpendCacheEntry {
  home: string;
  day: string;
  computedAtMs: number;
  totals: { totalUSD: number; todayUSD: number; today: string };
}

// #186: every health check and Prometheus scrape synchronously re-parsed every
// line of every session .jsonl (solo + all bots) via aggregateSpend. The same
// event loop serves SSE streams and /message — with thousands of sessions a
// single scrape blocked the gateway. Cache the spend totals for a short window
// (TTL ~20s, keyed by home + calendar day).
let spendCache: SpendCacheEntry | null = null;

interface DiskCountCacheEntry {
  home: string;
  computedAtMs: number;
  sessions: number;
  pendingApprovals: number;
}

// #317: health/metrics also synchronously readdir-scanned every session scope
// and every pending approval per scrape, on the same event loop that serves SSE
// and /message. Cache those counts with the same ~20s TTL as the spend totals.
let diskCountCache: DiskCountCacheEntry | null = null;

function diskCounts(
  home: string,
  nowMs: number,
): { sessions: number; pendingApprovals: number } {
  if (
    diskCountCache &&
    diskCountCache.home === home &&
    nowMs - diskCountCache.computedAtMs < OBSERVABILITY_CACHE_TTL_MS
  ) {
    return {
      sessions: diskCountCache.sessions,
      pendingApprovals: diskCountCache.pendingApprovals,
    };
  }
  const counts = {
    sessions: countSessions(home),
    pendingApprovals: countPendingApprovals(home),
  };
  diskCountCache = { home, computedAtMs: nowMs, ...counts };
  return counts;
}

/** Clear the in-process spend + disk-count caches (mainly for tests). */
export function resetObservabilityCache(): void {
  spendCache = null;
  diskCountCache = null;
}

export interface ObservabilityDeps {
  home: string;
  stats: ProviderStats;
  jobs?: ObservabilityJob[];
}

/** Total persisted session logs across solo + every bot scope. */
function countSessions(home: string): number {
  let total = 0;
  for (const { dir } of collectSessionScopes(home)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".jsonl")) total++;
    }
  }
  return total;
}

/** Pending (unresolved) approval requests on disk. */
function countPendingApprovals(home: string): number {
  const dir = approvalsDir(home);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const req = getRequest(home, f.replace(/\.json$/, ""));
    if (req && req.status === "pending") n++;
  }
  return n;
}

function spendTotals(home: string, now: Date = new Date()): { totalUSD: number; todayUSD: number; today: string } {
  const today = now.toISOString().slice(0, 10);
  const fresh =
    spendCache !== null &&
    spendCache.home === home &&
    spendCache.day === today &&
    now.getTime() - spendCache.computedAtMs < OBSERVABILITY_CACHE_TTL_MS;
  if (fresh) return spendCache!.totals;

  const rows = aggregateSpend(home, {});
  let totalUSD = 0;
  let todayUSD = 0;
  for (const r of rows) {
    totalUSD += r.costUSD;
    if (r.day === today) todayUSD += r.costUSD;
  }
  const totals = { totalUSD, todayUSD, today };
  spendCache = { home, day: today, computedAtMs: now.getTime(), totals };
  return totals;
}

/**
 * Structured health snapshot. `uptimeMs` is added by the HTTP layer, which owns
 * the server start time; everything else lives here.
 */
export function buildHealth(nowMs: number, deps: ObservabilityDeps): Record<string, unknown> {
  const jobs = deps.jobs ?? [];
  const activeJobs = jobs.filter((j) => j.running).length;
  const pendingJobs = jobs.filter((j) => !j.running && j.nextDueMs <= nowMs).length;
  const spend = spendTotals(deps.home, new Date(nowMs));
  const counts = diskCounts(deps.home, nowMs);
  return {
    activeJobs,
    pendingJobs,
    pendingApprovals: counts.pendingApprovals,
    budgetSpentTodayUSD: spend.todayUSD,
    spentTodayDay: spend.today,
    sessions: counts.sessions,
    spendUSDTotal: spend.totalUSD,
    providers: deps.stats.reachability(),
  };
}

/** Prometheus text. `value` may be a labeled series; a plain number keeps the size small. */
function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** Escape a value for use inside a Prometheus label string. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function buildMetrics(nowMs: number, deps: ObservabilityDeps): string {
  const jobs = deps.jobs ?? [];
  const pendingJobs = jobs.filter((j) => !j.running && j.nextDueMs <= nowMs).length;
  const spend = spendTotals(deps.home, new Date(nowMs));
  const counts = diskCounts(deps.home, nowMs);
  const reach = deps.stats.reachability();
  const lines: string[] = [];
  lines.push("# HELP tenjin_spend_usd_total Total spend recorded across all sessions, USD.");
  lines.push("# TYPE tenjin_spend_usd_total counter");
  lines.push(`tenjin_spend_usd_total ${fmtNum(spend.totalUSD)}`);
  lines.push("# HELP tenjin_jobs_pending Scheduled jobs currently due but not yet running.");
  lines.push("# TYPE tenjin_jobs_pending gauge");
  lines.push(`tenjin_jobs_pending ${pendingJobs}`);
  lines.push("# HELP tenjin_sessions_total Number of persisted session logs across all scopes.");
  lines.push("# TYPE tenjin_sessions_total gauge");
  lines.push(`tenjin_sessions_total ${counts.sessions}`);
  lines.push("# HELP tenjin_provider_errors_total Provider chat calls that failed since boot.");
  lines.push("# TYPE tenjin_provider_errors_total counter");
  lines.push(`tenjin_provider_errors_total ${deps.stats.total()}`);
  for (const [name, r] of Object.entries(reach)) {
    lines.push(`tenjin_provider_errors_total{provider="${esc(name)}"} ${r.errors}`);
  }
  return lines.join("\n") + "\n";
}
