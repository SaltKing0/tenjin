import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateGlobalSpend, checkGlobalBudget, resetGlobalBudgetCache, GLOBAL_BUDGET_CACHE_TTL_MS } from "../src/audit/global-budget";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-global-budget-"));
  resetGlobalBudgetCache();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function seedSession(
  dir: string,
  id: string,
  provider: string,
  model: string,
  ts: string,
  usages: Array<{ inputTokens: number; outputTokens: number; costUSD: number }>,
): void {
  mkdirSync(dir, { recursive: true });
  const events = [
    { t: "session_start", id, ts, provider, model },
    ...usages.map((u) => ({ t: "usage", ...u, spentUSD: u.costUSD, ts })),
  ];
  writeFileSync(
    join(dir, `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

test("aggregateGlobalSpend sums cost across solo and all bot scopes for today and this month", () => {
  // A fixed "now" so day/month boundaries are deterministic (UTC).
  const now = new Date("2026-08-21T12:00:00Z");
  seedSession(
    join(home, "sessions"),
    "s1",
    "anthropic",
    "claude-sonnet-4-5",
    "2026-08-21T09:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 0.01 }],
  );
  seedSession(
    join(home, "bots", "researcher", "sessions"),
    "r1",
    "openai",
    "gpt-4o-mini",
    "2026-08-21T10:00:00Z",
    [{ inputTokens: 5000, outputTokens: 500, costUSD: 0.02 }],
  );
  // Earlier this month: counts toward month but not today.
  seedSession(
    join(home, "bots", "writer", "sessions"),
    "w1",
    "openai",
    "gpt-4o",
    "2026-08-05T10:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 0.05 }],
  );
  // Previous month: excluded completely.
  seedSession(
    join(home, "sessions"),
    "old",
    "openai",
    "gpt-4o",
    "2026-07-30T10:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 9 }],
  );

  const totals = aggregateGlobalSpend(home, now);
  expect(totals.todayUSD).toBeCloseTo(0.03);
  expect(totals.monthUSD).toBeCloseTo(0.08);
});

test("day boundary resets: spend from yesterday does not count toward today's limit", () => {
  const now = new Date("2026-08-21T08:00:00Z");
  seedSession(
    join(home, "sessions"),
    "yesterday",
    "a",
    "m",
    "2026-08-20T23:59:00Z",
    [{ inputTokens: 1, outputTokens: 1, costUSD: 0.5 }],
  );
  seedSession(
    join(home, "sessions"),
    "today",
    "a",
    "m",
    "2026-08-21T00:01:00Z",
    [{ inputTokens: 1, outputTokens: 1, costUSD: 0.2 }],
  );
  const totals = aggregateGlobalSpend(home, now);
  expect(totals.todayUSD).toBeCloseTo(0.2);
  expect(totals.monthUSD).toBeCloseTo(0.7);
});

test("checkGlobalBudget allows under the daily and monthly limits", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  seedSession(
    join(home, "sessions"),
    "s1",
    "a",
    "m",
    "2026-08-21T09:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 0.01 }],
  );
  const res = checkGlobalBudget(
    home,
    { dailyUSD: 0.5, monthlyUSD: 10 },
    now,
  );
  expect(res.allowed).toBe(true);
  expect(res.reason).toBeUndefined();
});

test("checkGlobalBudget blocks when the daily limit is exceeded, naming the limit", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  seedSession(
    join(home, "sessions"),
    "s1",
    "a",
    "m",
    "2026-08-21T09:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 1.0 }],
  );
  const res = checkGlobalBudget(
    home,
    { dailyUSD: 0.5 },
    now,
  );
  expect(res.allowed).toBe(false);
  expect(res.reason).toMatch(/daily/);
});

test("checkGlobalBudget blocks when the monthly limit is exceeded", () => {
  const now = new Date("2026-08-21T12:00:00Z");
  seedSession(
    join(home, "sessions"),
    "s1",
    "a",
    "m",
    "2026-08-01T00:00:00Z",
    [{ inputTokens: 1000, outputTokens: 100, costUSD: 3.0 }],
  );
  const res = checkGlobalBudget(
    home,
    { monthlyUSD: 2.0 },
    now,
  );
  expect(res.allowed).toBe(false);
  expect(res.reason).toMatch(/monthly/);
});

test("checkGlobalBudget with no limits always allows", () => {
  const res = checkGlobalBudget(home, {}, new Date());
  expect(res.allowed).toBe(true);
});

describe("global budget cache (#214)", () => {
  const t0 = new Date("2026-08-21T12:00:00Z");
  const withinTtl = new Date(t0.getTime() + GLOBAL_BUDGET_CACHE_TTL_MS - 1);
  const pastTtl = new Date(t0.getTime() + GLOBAL_BUDGET_CACHE_TTL_MS + 1);

  test("caches: repeated calls within TTL do not rescan the session logs", () => {
    seedSession(join(home, "sessions"), "s1", "a", "m", "2026-08-21T09:00:00Z", [
      { inputTokens: 1, outputTokens: 1, costUSD: 0.01 },
    ]);
    const first = aggregateGlobalSpend(home, t0);
    expect(first.todayUSD).toBeCloseTo(0.01);

    // New spend lands after the first aggregation, but within the TTL window
    // the cached totals must be returned (no full rescan of the logs).
    seedSession(join(home, "sessions"), "s2", "a", "m", "2026-08-21T10:00:00Z", [
      { inputTokens: 1, outputTokens: 1, costUSD: 0.5 },
    ]);
    const cached = aggregateGlobalSpend(home, withinTtl);
    expect(cached.todayUSD).toBeCloseTo(0.01); // stale-by-design within TTL
  });

  test("cache expires after TTL and picks up new spend", () => {
    seedSession(join(home, "sessions"), "s1", "a", "m", "2026-08-21T09:00:00Z", [
      { inputTokens: 1, outputTokens: 1, costUSD: 0.01 },
    ]);
    aggregateGlobalSpend(home, t0);

    seedSession(join(home, "sessions"), "s2", "a", "m", "2026-08-21T10:00:00Z", [
      { inputTokens: 1, outputTokens: 1, costUSD: 0.5 },
    ]);
    const expired = aggregateGlobalSpend(home, pastTtl);
    expect(expired.todayUSD).toBeCloseTo(0.51);
  });

  test("cache is keyed by home and resets on a new calendar day", () => {
    seedSession(join(home, "sessions"), "s1", "a", "m", "2026-08-21T09:00:00Z", [
      { inputTokens: 1, outputTokens: 1, costUSD: 0.5 },
    ]);
    // Day 1 (21st) cached.
    expect(aggregateGlobalSpend(home, t0).todayUSD).toBeCloseTo(0.5);
    // Still the 21st but day boundary check uses the calendar day: a later same-
    // day query within TTL stays cached (covered above). For a NEW day the cache
    // must not leak yesterday's todayUSD.
    const nextDay = new Date("2026-08-22T00:00:00Z");
    const d2 = aggregateGlobalSpend(home, nextDay);
    // The session is dated the 21st, so it counts toward month but not the 22nd.
    expect(d2.todayUSD).toBeCloseTo(0);
    expect(d2.monthUSD).toBeCloseTo(0.5);
  });
});
