import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateGlobalSpend, checkGlobalBudget } from "../src/audit/global-budget";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-global-budget-"));
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
