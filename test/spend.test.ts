import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateSpend, renderSpend } from "../src/audit/spend";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-spend-"));
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

test("aggregates across solo and bot scopes", () => {
  seedSession(
    join(home, "sessions"),
    "s1",
    "anthropic",
    "claude-sonnet-4-5",
    "2026-08-20T10:00:00Z",
    [
      { inputTokens: 1000, outputTokens: 100, costUSD: 0.01 },
      { inputTokens: 2000, outputTokens: 200, costUSD: 0.02 },
    ],
  );
  seedSession(
    join(home, "bots", "researcher", "sessions"),
    "s2",
    "openai",
    "gpt-4o-mini",
    "2026-08-21T10:00:00Z",
    [{ inputTokens: 5000, outputTokens: 500, costUSD: 0.001 }],
  );

  const rows = aggregateSpend(home);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.scope).toBe("solo");
  expect(rows[0]?.costUSD).toBeCloseTo(0.03);
  expect(rows[0]?.inputTokens).toBe(3000);
  expect(rows[0]?.sessions).toBe(1);
  expect(rows[1]?.scope).toBe("researcher");
});

test("--bot filter scopes to one bot", () => {
  seedSession(join(home, "sessions"), "s1", "a", "m", "2026-08-21T10:00:00Z", [{ inputTokens: 1, outputTokens: 1, costUSD: 1 }]);
  seedSession(join(home, "bots", "writer", "sessions"), "s2", "a", "m", "2026-08-21T10:00:00Z", [{ inputTokens: 1, outputTokens: 1, costUSD: 0.5 }]);
  const rows = aggregateSpend(home, { bot: "writer" });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.scope).toBe("writer");
});

test("--days filters old sessions", () => {
  const now = new Date();
  const old = new Date(now.getTime() - 10 * 86_400_000);
  seedSession(join(home, "sessions"), "old", "a", "m", old.toISOString(), [{ inputTokens: 1, outputTokens: 1, costUSD: 9 }]);
  seedSession(join(home, "sessions"), "new", "a", "m", now.toISOString(), [{ inputTokens: 1, outputTokens: 1, costUSD: 1 }]);
  expect(aggregateSpend(home, { days: 7 }).map((r) => r.costUSD)).toEqual([1]);
  expect(aggregateSpend(home)).toHaveLength(2);
});

test("corrupted and empty session files are skipped", () => {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "broken.jsonl"), "{nope\n");
  writeFileSync(join(home, "sessions", "empty.jsonl"), "");
  expect(aggregateSpend(home)).toEqual([]);
});

test("renderSpend produces table with total", () => {
  seedSession(join(home, "sessions"), "s1", "anthropic", "claude-sonnet-4-5", "2026-08-21T10:00:00Z", [
    { inputTokens: 1500, outputTokens: 2500, costUSD: 0.042 },
  ]);
  const out = renderSpend(aggregateSpend(home));
  expect(out).toContain("scope");
  expect(out).toContain("claude-sonnet-4-5");
  expect(out).toContain("1.5k");
  expect(out).toContain("$0.04");
  expect(out).toContain("total:");
  expect(renderSpend([])).toBe("no spend recorded");
});
