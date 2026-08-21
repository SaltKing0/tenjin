import { describe, test, expect } from "bun:test";
import {
  nextRun,
  parseCron,
  parseEvery,
  parseSchedule,
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
