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

/** `now` defaults to the current time; injected for deterministic tests. */
export function aggregateGlobalSpend(
  home: string,
  now: Date = new Date(),
): GlobalSpend {
  const rows = aggregateSpend(home);
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  let todayUSD = 0;
  let monthUSD = 0;
  for (const row of rows) {
    if (row.day.startsWith(month)) monthUSD += row.costUSD;
    if (row.day === today) todayUSD += row.costUSD;
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
