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

function spendTotals(home: string): { totalUSD: number; todayUSD: number; today: string } {
  const rows = aggregateSpend(home, {});
  const today = new Date().toISOString().slice(0, 10);
  let totalUSD = 0;
  let todayUSD = 0;
  for (const r of rows) {
    totalUSD += r.costUSD;
    if (r.day === today) todayUSD += r.costUSD;
  }
  return { totalUSD, todayUSD, today };
}

/**
 * Structured health snapshot. `uptimeMs` is added by the HTTP layer, which owns
 * the server start time; everything else lives here.
 */
export function buildHealth(nowMs: number, deps: ObservabilityDeps): Record<string, unknown> {
  const jobs = deps.jobs ?? [];
  const activeJobs = jobs.filter((j) => j.running).length;
  const pendingJobs = jobs.filter((j) => !j.running && j.nextDueMs <= nowMs).length;
  const spend = spendTotals(deps.home);
  return {
    activeJobs,
    pendingJobs,
    pendingApprovals: countPendingApprovals(deps.home),
    budgetSpentTodayUSD: spend.todayUSD,
    spentTodayDay: spend.today,
    sessions: countSessions(deps.home),
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
  const spend = spendTotals(deps.home);
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
  lines.push(`tenjin_sessions_total ${countSessions(deps.home)}`);
  lines.push("# HELP tenjin_provider_errors_total Provider chat calls that failed since boot.");
  lines.push("# TYPE tenjin_provider_errors_total counter");
  lines.push(`tenjin_provider_errors_total ${deps.stats.total()}`);
  for (const [name, r] of Object.entries(reach)) {
    lines.push(`tenjin_provider_errors_total{provider="${esc(name)}"} ${r.errors}`);
  }
  return lines.join("\n") + "\n";
}
