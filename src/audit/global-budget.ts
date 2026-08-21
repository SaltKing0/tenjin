import { aggregateSpend } from "./spend";

/**
 * Global spend limits (USD) across every scope (solo + all bots), configured
 * under `globalBudget` in config.yaml. 0 / unset means "no limit".
 */
export interface GlobalBudgetConfig {
  /** Max total spend for the UTC calendar day across all scopes. 0 = unlimited. */
  dailyUSD?: number;
  /** Max total spend for the UTC calendar month across all scopes. 0 = unlimited. */
  monthlyUSD?: number;
}

export interface GlobalSpend {
  /** Total spend for the UTC day containing `now` (all scopes). */
  todayUSD: number;
  /** Total spend for the UTC month containing `now` (all scopes). */
  monthUSD: number;
}

export interface GlobalBudgetCheck {
  allowed: boolean;
  /** Present only when `allowed` is false — names the violated window/limit. */
  reason?: string;
}

/** Injected for deterministic expiry in tests. */
export const GLOBAL_BUDGET_CACHE_TTL_MS = 20_000;

interface BudgetCacheEntry {
  home: string;
  day: string;
  month: string;
  computedAtMs: number;
  totals: GlobalSpend;
}

// #214: the global-budget gate is consulted before EVERY provider call; a full
// rescan of every session log on each call is the hottest path in the harness.
// Cache the aggregated totals for a short window (TTL ~20s) so hot calls hit
// memory, and document that budget exhaustion is detected at most TTL late.
let budgetCache: BudgetCacheEntry | null = null;

/** Clear the in-process cache (mainly for tests). */
export function resetGlobalBudgetCache(): void {
  budgetCache = null;
}

/** `now` defaults to the current time; injected for deterministic tests. */
export function aggregateGlobalSpend(
  home: string,
  now: Date = new Date(),
): GlobalSpend {
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const fresh =
    budgetCache !== null &&
    budgetCache.home === home &&
    budgetCache.day === day &&
    budgetCache.month === month &&
    now.getTime() - budgetCache.computedAtMs < GLOBAL_BUDGET_CACHE_TTL_MS;
  if (fresh) return budgetCache!.totals;

  const totals = computeGlobalSpend(home, day, month);
  budgetCache = { home, day, month, computedAtMs: now.getTime(), totals };
  return totals;
}

/** Un-cached scan of the session logs (used on cache miss). */
function computeGlobalSpend(home: string, day: string, month: string): GlobalSpend {
  const rows = aggregateSpend(home);
  let todayUSD = 0;
  let monthUSD = 0;
  for (const row of rows) {
    if (row.day.startsWith(month)) monthUSD += row.costUSD;
    if (row.day === day) todayUSD += row.costUSD;
  }
  return { todayUSD, monthUSD };
}

/** Enforce `globalBudget` limits against the spend aggregated from session logs. */
export function checkGlobalBudget(
  home: string,
  limits: GlobalBudgetConfig,
  now: Date = new Date(),
): GlobalBudgetCheck {
  if (
    (limits.dailyUSD === undefined || limits.dailyUSD <= 0) &&
    (limits.monthlyUSD === undefined || limits.monthlyUSD <= 0)
  ) {
    return { allowed: true };
  }
  const { todayUSD, monthUSD } = aggregateGlobalSpend(home, now);
  if (limits.dailyUSD && limits.dailyUSD > 0 && todayUSD >= limits.dailyUSD) {
    return {
      allowed: false,
      reason: `global daily budget reached (${todayUSD.toFixed(4)} USD >= ${limits.dailyUSD} USD limit)`,
    };
  }
  if (
    limits.monthlyUSD &&
    limits.monthlyUSD > 0 &&
    monthUSD >= limits.monthlyUSD
  ) {
    return {
      allowed: false,
      reason: `global monthly budget reached (${monthUSD.toFixed(4)} USD >= ${limits.monthlyUSD} USD limit)`,
    };
  }
  return { allowed: true };
}
