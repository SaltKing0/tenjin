import { ConfigError } from "../config/types";

export interface EverySchedule {
  kind: "every";
  intervalMs: number;
  raw: string;
}

export interface CronExpr {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number> | null;
  months: Set<number>;
  dows: Set<number> | null;
}

export type CronSchedule = { kind: "cron"; expr: CronExpr };

export type Schedule = EverySchedule | CronSchedule;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseEvery(raw: string): number {
  const match = /^(\d+)([smhd])$/.exec(raw.trim());
  if (!match || !match[1] || !match[2]) {
    throw new ConfigError(
      `invalid interval "${raw}" (expected forms like 30s, 15m, 1h, 1d)`,
    );
  }
  const unitMs = UNIT_MS[match[2]] ?? 0;
  const ms = Number(match[1]) * unitMs;
  if (ms <= 0) throw new ConfigError(`interval must be positive: "${raw}"`);
  return ms;
}

function parseField(
  field: string,
  min: number,
  max: number,
): Set<number> {
  const out = new Set<number>();
  for (const term of field.split(",")) {
    const trimmed = term.trim();
    let range = trimmed;
    let step = 1;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      range = trimmed.slice(0, slashIdx);
      step = Number(trimmed.slice(slashIdx + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new ConfigError(`invalid step in cron field "${field}"`);
      }
    }
    let lo = min;
    let hi = max;
    if (range !== "*" && range !== "") {
      const dashIdx = range.indexOf("-");
      if (dashIdx !== -1) {
        lo = Number(range.slice(0, dashIdx));
        hi = Number(range.slice(dashIdx + 1));
      } else {
        lo = Number(range);
        hi = slashIdx !== -1 ? max : lo;
      }
      if (
        !Number.isInteger(lo) ||
        !Number.isInteger(hi) ||
        lo < min ||
        hi > max ||
        lo > hi
      ) {
        throw new ConfigError(`cron value out of range (${min}-${max}): "${field}"`);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(raw: string): CronExpr {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ConfigError(`cron needs exactly 5 fields: "${raw}"`);
  }
  const [minute, hour, dom, month, dow] = fields;
  if (!minute || !hour || !dom || !month || !dow) {
    throw new ConfigError(`cron needs exactly 5 fields: "${raw}"`);
  }
  return {
    raw,
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    doms: dom === "*" ? null : parseField(dom, 1, 31),
    months: parseField(month, 1, 12),
    dows: dow === "*" ? null : parseField(dow, 0, 6),
  };
}

export function parseSchedule(spec: { every?: string; cron?: string }): Schedule {
  const hasEvery = spec.every !== undefined && spec.every !== "";
  const hasCron = spec.cron !== undefined && spec.cron !== "";
  if (hasEvery === hasCron) {
    throw new ConfigError("schedule needs exactly one of `every` or `cron`");
  }
  if (hasEvery) return { kind: "every", intervalMs: parseEvery(spec.every as string), raw: spec.every as string };
  return { kind: "cron", expr: parseCron(spec.cron as string) };
}

/**
 * Whether `d` satisfies the expression's day-of-month / day-of-week fields.
 *
 * Standard cron semantics: when both fields are restricted (`*` is unconstrained
 * and stored as `null`) the day matches if EITHER field matches (OR). When one
 * is `null` the other alone decides.
 */
function dayMatches(d: Date, expr: CronExpr): boolean {
  if (expr.doms === null && expr.dows === null) return true;
  if (expr.doms === null) return expr.dows?.has(d.getDay()) ?? false;
  if (expr.dows === null) return expr.doms.has(d.getDate());
  return expr.doms.has(d.getDate()) || expr.dows.has(d.getDay());
}

/** Smallest value in `set` (sets produced by `parseField` are never empty). */
function firstOf(set: Set<number>): number {
  let smallest = Infinity;
  for (const v of set) if (v < smallest) smallest = v;
  return smallest;
}

/** Smallest value in `set` strictly greater than `v`, or `undefined` if none. */
function nextGreater(set: Set<number>, v: number): number | undefined {
  let best: number | undefined;
  for (const x of set) if (x > v && (best === undefined || x < best)) best = x;
  return best;
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * Compute the next run of a cron schedule strictly after `fromMs`, advancing
 * field-by-field (minute → hour → day → month) instead of scanning every
 * minute. Each failed field jumps straight to its next allowed value, so the
 * work is bounded by field cardinality (≤ 60 minutes, ≤ 24 hours, ≤ 31 days,
 * ≤ 12 months per year) rather than by the number of minutes in a year.
 */
export function nextRun(schedule: Schedule, fromMs: number): number {
  if (schedule.kind === "every") return fromMs + schedule.intervalMs;

  const expr = schedule.expr;

  // Start strictly after `fromMs`, at minute precision.
  const t = new Date(fromMs);
  t.setSeconds(0, 0);
  t.setMilliseconds(0);
  t.setMinutes(t.getMinutes() + 1);

  for (;;) {
    const year = t.getFullYear();
    if (year > 2100) {
      // Unreachable in practice for any satisfiable expression; guards against
      // an infinite loop on impossible schedules (e.g. "0 0 30 2 *").
      throw new ConfigError(`no matching time for cron "${expr.raw}"`);
    }

    // Month.
    const month = t.getMonth() + 1;
    if (!expr.months.has(month)) {
      const nextMonth = nextGreater(expr.months, month);
      if (nextMonth === undefined) {
        t.setFullYear(year + 1, 0, 1);
        t.setHours(0, 0, 0, 0);
      } else {
        t.setFullYear(year, nextMonth - 1, 1);
        t.setHours(0, 0, 0, 0);
      }
      continue; // day/hour/minute reset to valid-fresh values by the jump
    }

    // Day (dom/dow). If the current day doesn't match, move to the next one
    // that does within this month; otherwise roll to the 1st of next month.
    if (!dayMatches(t, expr)) {
      const curMonth0 = t.getMonth();
      const monthDays = lastDayOfMonth(year, curMonth0);
      let advanced = false;
      for (let d = t.getDate() + 1; d <= monthDays; d++) {
        t.setDate(d);
        t.setHours(0, 0, 0, 0);
        if (dayMatches(t, expr)) {
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        t.setDate(1);
        t.setHours(0, 0, 0, 0);
        t.setMonth(t.getMonth() + 1); // may roll the year
      }
      continue;
    }

    // Hour.
    const hour = t.getHours();
    if (!expr.hours.has(hour)) {
      const nextHour = nextGreater(expr.hours, hour);
      if (nextHour === undefined) {
        t.setHours(0, 0, 0, 0);
        t.setDate(t.getDate() + 1);
      } else {
        t.setHours(nextHour, 0, 0, 0);
        t.setMinutes(firstOf(expr.minutes));
      }
      continue;
    }

    // Minute.
    const minute = t.getMinutes();
    if (!expr.minutes.has(minute)) {
      const nextMinute = nextGreater(expr.minutes, minute);
      if (nextMinute === undefined) {
        t.setHours(t.getHours() + 1, firstOf(expr.minutes), 0, 0);
      } else {
        t.setMinutes(nextMinute);
      }
      continue;
    }

    return t.getTime();
  }
}
