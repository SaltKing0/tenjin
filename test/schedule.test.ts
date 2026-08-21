import { describe, test, expect } from "bun:test";
import {
  nextRun,
  parseCron,
  parseEvery,
  parseSchedule,
  type CronExpr,
  type Schedule,
} from "../src/gateway/schedule";
import { ConfigError } from "../src/config/types";

describe("parseEvery", () => {
  test("valid units convert to ms", () => {
    expect(parseEvery("30s")).toBe(30_000);
    expect(parseEvery("15m")).toBe(900_000);
    expect(parseEvery("1h")).toBe(3_600_000);
    expect(parseEvery("1d")).toBe(86_400_000);
  });

  test("invalid forms rejected", () => {
    for (const bad of ["", "10", "10x", "m", "-5m", "1.5h"]) {
      expect(() => parseEvery(bad)).toThrow(ConfigError);
    }
  });
});

describe("parseCron", () => {
  test("lists, ranges, steps", () => {
    const c = parseCron("0,30 9-17 */2 * *");
    expect([...c.minutes].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(c.hours.has(9) && c.hours.has(17) && !c.hours.has(18)).toBe(true);
    expect(c.hours.size).toBe(9); // 9..17 inclusive
    expect(c.doms?.size).toBe(16); // odd days: 1,3,...,31
    expect(c.months.size).toBe(12);
  });

  test("step on explicit range: 1-5/2 → 1,3,5", () => {
    const c = parseCron("1-5/2 * * * *");
    expect([...c.minutes].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  test("* fields become null (dom/dow)", () => {
    const c = parseCron("0 12 * * 5");
    expect(c.doms).toBeNull();
    expect(c.dows).toEqual(new Set([5]));
  });

  test("out-of-range values rejected", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("* * 32 * *")).toThrow(/out of range/);
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("* * * * 7")).toThrow(/out of range/);
  });

  test("wrong field count rejected", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("* * * * * *")).toThrow(/5 fields/);
  });
});

describe("parseSchedule", () => {
  test("exactly one of every/cron required", () => {
    expect(() => parseSchedule({})).toThrow(/exactly one/);
    expect(() => parseSchedule({ every: "1m", cron: "* * * * *" })).toThrow(
      /exactly one/,
    );
    expect(parseSchedule({ every: "5m" }).kind).toBe("every");
    expect(parseSchedule({ cron: "0 9 * * *" }).kind).toBe("cron");
  });

  test("optional IANA tz is stored on the schedule", () => {
    const cron = parseSchedule({ cron: "0 9 * * *", tz: "Europe/Berlin" });
    expect(cron.kind).toBe("cron");
    expect(cron.tz).toBe("Europe/Berlin");
    const every = parseSchedule({ every: "15m", tz: "UTC" });
    expect(every.kind).toBe("every");
    expect(every.tz).toBe("UTC");
    expect(parseSchedule({ cron: "0 9 * * *" }).tz).toBeUndefined();
  });

  test("unknown IANA tz is rejected", () => {
    expect(() => parseSchedule({ cron: "0 9 * * *", tz: "Europe/Neverland" })).toThrow(
      ConfigError,
    );
    expect(() => parseSchedule({ cron: "0 9 * * *", tz: "UTC+1" })).toThrow(
      /time zone/,
    );
  });
});

function at(local: string): number {
  return new Date(local).getTime();
}

describe("nextRun — every", () => {
  test("simple addition", () => {
    const from = at("2026-08-21T10:00:00");
    expect(nextRun({ kind: "every", intervalMs: 90_000, raw: "90s" }, from)).toBe(
      from + 90_000,
    );
  });
});

describe("nextRun — cron", () => {
  test("same day when still ahead", () => {
    const next = nextRun(parseSchedule({ cron: "0 9 * * *" }), at("2026-08-21T08:30:00"));
    expect(new Date(next).toString()).toContain("Aug 21 2026 09:00");
  });

  test("next day when already past", () => {
    const next = nextRun(parseSchedule({ cron: "0 9 * * *" }), at("2026-08-21T09:00:00"));
    expect(new Date(next).toString()).toContain("Aug 22 2026 09:00");
  });

  test("quarter-hourly lands on boundary", () => {
    const next = nextRun(parseSchedule({ cron: "*/15 * * * *" }), at("2026-08-21T10:02:00"));
    expect(new Date(next).getMinutes()).toBe(15);
  });

  test("first of next month", () => {
    const next = nextRun(parseSchedule({ cron: "0 0 1 * *" }), at("2026-08-21T12:00:00"));
    expect(new Date(next).toString()).toContain("Sep 01 2026 00:00");
  });

  test("year rollover", () => {
    const next = nextRun(parseSchedule({ cron: "0 0 1 1 *" }), at("2026-08-21T12:00:00"));
    expect(new Date(next).toString()).toContain("Jan 01 2027 00:00");
  });

  test("weekday-only skips weekend", () => {
    // 2026-08-21 is a Friday; 14:30 already passed → next is Monday the 24th
    const next = nextRun(parseSchedule({ cron: "30 14 * * 1-5" }), at("2026-08-21T15:00:00"));
    const d = new Date(next);
    expect(d.getDay()).toBe(1);
    expect(d.toString()).toContain("Aug 24 2026 14:30");
  });

  test("dom and dow OR semantics (standard cron)", () => {
    // 13th of month OR any Friday at noon
    // 2026-08-21 is Friday the 21st → matches via dow
    const next = nextRun(parseSchedule({ cron: "0 12 13 * 5" }), at("2026-08-20T12:00:00"));
    expect(new Date(next).toString()).toContain("Aug 21 2026 12:00");
  });

  test("leap-day schedule finds Feb 29", () => {
    const next = nextRun(parseSchedule({ cron: "0 0 29 2 *" }), at("2026-08-21T00:00:00"));
    expect(new Date(next).toString()).toContain("Feb 29 2028 00:00");
  });
});

describe("nextRun — month & leap-year boundaries", () => {
  test("non-leap year skips Feb 29, lands on next leap year", () => {
    // 2027 is not a leap year; the 29th of Feb only exists in 2028.
    const next = nextRun(parseSchedule({ cron: "0 0 29 2 *" }), at("2027-02-28T12:00:00"));
    expect(new Date(next).toString()).toContain("Feb 29 2028");
  });

  test("Feb 30 never exists → throws ConfigError", () => {
    expect(() =>
      nextRun(parseSchedule({ cron: "0 0 30 2 *" }), at("2026-01-01T00:00:00")),
    ).toThrow(ConfigError);
  });

  test("dom 31 in a month that lacks a 31st → throws ConfigError", () => {
    // April has 30 days; dom 31 can never match in April any year.
    expect(() =>
      nextRun(parseSchedule({ cron: "0 0 31 4 *" }), at("2026-01-01T00:00:00")),
    ).toThrow(ConfigError);
  });

  test("rolls across a 30-day month to the next month with a 31st", () => {
    // April has no 31st, so "0 0 31 * *" from April lands on May 31.
    const next = nextRun(parseSchedule({ cron: "0 0 31 * *" }), at("2026-04-20T00:00:00"));
    expect(new Date(next).toString()).toContain("May 31 2026");
  });

  test("crosses a January 31st boundary into February", () => {
    const next = nextRun(parseSchedule({ cron: "0 0 1 * *" }), at("2026-01-31T12:00:00"));
    expect(new Date(next).toString()).toContain("Feb 01 2026");
  });
});

/**
 * Slow reference implementation (the previous minute-scan) used only to prove
 * the direct field-by-field computation returns identical results.
 */
function bruteDayMatches(d: Date, expr: CronExpr): boolean {
  if (expr.doms === null && expr.dows === null) return true;
  if (expr.doms === null) return expr.dows?.has(d.getDay()) ?? false;
  if (expr.dows === null) return expr.doms.has(d.getDate());
  return expr.doms.has(d.getDate()) || expr.dows.has(d.getDay());
}

function bruteNextRun(schedule: Schedule, fromMs: number): number | undefined {
  if (schedule.kind === "every") return fromMs + schedule.intervalMs;
  const expr = schedule.expr;
  const t = new Date(fromMs);
  t.setSeconds(0, 0);
  t.setMilliseconds(0);
  for (let i = 0; i < 4 * 366 * 24 * 60; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (!expr.minutes.has(t.getMinutes())) continue;
    if (!expr.hours.has(t.getHours())) continue;
    if (!expr.months.has(t.getMonth() + 1)) continue;
    if (!bruteDayMatches(t, expr)) continue;
    return t.getTime();
  }
  return undefined;
}

/**
 * Europe/Berlin DST 2026:
 *   spring 29 Mar 02:00 CET → 03:00 CEST  (01:00 UTC)
 *   fall   25 Oct 03:00 CEST → 02:00 CET  (01:00 UTC)
 *
 * Expected instants are UTC milliseconds so the assertions do not depend
 * on the host timezone.
 */
describe("nextRun — IANA timezone (DST-safe)", () => {
  const berlin0900 = parseSchedule({ cron: "0 9 * * *", tz: "Europe/Berlin" });

  test("09:00 Europe/Berlin across the spring-forward (CET → CEST)", () => {
    // Sat 28 Mar 10:00 CET = 09:00 UTC; next civil 09:00 is Sun 29 Mar 09:00 CEST = 07:00 UTC.
    const from = Date.UTC(2026, 2, 28, 9, 0, 0);
    expect(nextRun(berlin0900, from)).toBe(Date.UTC(2026, 2, 29, 7, 0, 0));
  });

  test("09:00 Europe/Berlin still same-day after the spring gap", () => {
    // Sun 29 Mar 08:00 CEST = 06:00 UTC; 09:00 CEST the same morning is 07:00 UTC.
    const from = Date.UTC(2026, 2, 29, 6, 0, 0);
    expect(nextRun(berlin0900, from)).toBe(Date.UTC(2026, 2, 29, 7, 0, 0));
  });

  test("09:00 Europe/Berlin across the fall-back (CEST → CET)", () => {
    // Sat 24 Oct 10:00 CEST = 08:00 UTC; next civil 09:00 is Sun 25 Oct 09:00 CET = 08:00 UTC.
    const from = Date.UTC(2026, 9, 24, 8, 0, 0);
    expect(nextRun(berlin0900, from)).toBe(Date.UTC(2026, 9, 25, 8, 0, 0));
  });

  test("09:00 America/New_York across US spring-forward", () => {
    // 8 Mar 2026 02:00 EST → 03:00 EDT. Sat 7 Mar 10:00 EST = 15:00 UTC;
    // next 09:00 is Sun 8 Mar 09:00 EDT = 13:00 UTC.
    const sched = parseSchedule({ cron: "0 9 * * *", tz: "America/New_York" });
    const from = Date.UTC(2026, 2, 7, 15, 0, 0);
    expect(nextRun(sched, from)).toBe(Date.UTC(2026, 2, 8, 13, 0, 0));
  });

  test("non-existent 02:30 Europe/Berlin on the spring-forward day is skipped", () => {
    // 29 Mar 02:30 CET does not exist (clocks jump 02:00 → 03:00).
    // From Sat 28 Mar 03:00 CET the next 02:30 is Mon 30 Mar 02:30 CEST = 00:30 UTC.
    const sched = parseSchedule({ cron: "30 2 * * *", tz: "Europe/Berlin" });
    const from = Date.UTC(2026, 2, 28, 2, 0, 0); // 03:00 CET
    expect(nextRun(sched, from)).toBe(Date.UTC(2026, 2, 30, 0, 30, 0));
  });

  test("ambiguous 02:30 Europe/Berlin on the fall-back day fires at the first occurrence", () => {
    // 25 Oct 02:30 happens twice. From Sat 24 Oct 03:00 CEST pick the first
    // (CEST) occurrence: 02:30 CEST = 00:30 UTC, not 02:30 CET = 01:30 UTC.
    const sched = parseSchedule({ cron: "30 2 * * *", tz: "Europe/Berlin" });
    const from = Date.UTC(2026, 9, 24, 1, 0, 0); // 03:00 CEST
    expect(nextRun(sched, from)).toBe(Date.UTC(2026, 9, 25, 0, 30, 0));
  });

  test("impossible zoned schedule still throws", () => {
    expect(() =>
      nextRun(
        parseSchedule({ cron: "0 0 30 2 *", tz: "Europe/Berlin" }),
        Date.UTC(2026, 0, 1),
      ),
    ).toThrow(ConfigError);
  });

  test("tz-aware nextRun is independent of the process timezone", () => {
    const from = Date.UTC(2026, 2, 28, 9, 0, 0);
    const expected = Date.UTC(2026, 2, 29, 7, 0, 0);
    const src = [
      `import { nextRun, parseSchedule } from ${JSON.stringify(`${import.meta.dir}/../src/gateway/schedule.ts`)};`,
      `const n = nextRun(parseSchedule({ cron: "0 9 * * *", tz: "Europe/Berlin" }), ${from});`,
      `process.stdout.write(String(n));`,
    ].join("\n");
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", src],
      env: { ...process.env, TZ: "Pacific/Auckland" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(Number(proc.stdout.toString())).toBe(expected);
  });
});

describe("nextRun — direct computation matches brute-force baseline", () => {
  const expressions = [
    "* * * * *",
    "*/15 * * * *",
    "0 9 * * *",
    "30 14 * * 1-5",
    "0 12 13 * 5",
    "0 0 1 * *",
    "0 0 29 2 *",
    "5 4 1,15 * *",
    "0 0 1 1 *",
    "10-50/10 8-18 * * *",
    "0 0 * * 0",
    "15,45 */2 * * 1,3,5",
  ];
  const froms = [
    "2026-08-21T08:30:00",
    "2026-08-21T09:00:00",
    "2026-12-31T23:30:00",
    "2027-02-28T12:00:00", // day before a non-leap Feb 29 target
    "2028-02-28T12:00:00", // day before the leap Feb 29
    "2024-02-29T12:00:00", // on an actual leap day
    "2096-02-28T12:00:00", // near the upper bound guard
    "2026-04-20T00:00:00", // 30-day month boundary
    "2026-01-31T00:00:00", // month rollover
    "2026-08-21T15:00:00",
  ];
  for (const raw of expressions) {
    for (const from of froms) {
      test(`${raw} from ${from}`, () => {
        const schedule = parseSchedule({ cron: raw });
        const fromMs = at(from);
        const expected = bruteNextRun(schedule, fromMs);
        if (expected === undefined) return; // no match within brute-force window
        expect(nextRun(schedule, fromMs)).toBe(expected);
      });
    }
  }
});
