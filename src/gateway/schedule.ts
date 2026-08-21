import { ConfigError } from "../config/types";

export interface EverySchedule {
  kind: "every";
  intervalMs: number;
  raw: string;
  tz?: string;
}

export interface CronExpr {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  doms: Set<number> | null;
  months: Set<number>;
  dows: Set<number> | null;
}

export type CronSchedule = { kind: "cron"; expr: CronExpr; tz?: string };

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

function parseTimeZone(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (name === "") return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
  } catch {
    throw new ConfigError(`unknown time zone "${raw}"`);
  }
  return name;
}

export function parseSchedule(spec: {
  every?: string;
  cron?: string;
  tz?: string;
}): Schedule {
  const hasEvery = spec.every !== undefined && spec.every !== "";
  const hasCron = spec.cron !== undefined && spec.cron !== "";
  if (hasEvery === hasCron) {
    throw new ConfigError("schedule needs exactly one of `every` or `cron`");
  }
  const tz = parseTimeZone(spec.tz);
  if (hasEvery) {
    return { kind: "every", intervalMs: parseEvery(spec.every as string), raw: spec.every as string, tz };
  }
  return { kind: "cron", expr: parseCron(spec.cron as string), tz };
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
  if (schedule.tz) return nextRunInZone(schedule.expr, fromMs, schedule.tz);

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

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = DTF_CACHE.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    DTF_CACHE.set(timeZone, dtf);
  }
  return dtf;
}

function zonedParts(ms: number, timeZone: string): WallTime & { second: number } {
  const map: Record<string, string> = {};
  for (const p of zonedFormatter(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * UTC instants whose civil wall-clock in `timeZone` equals `w`. Empty in a
 * DST gap; two instants (earliest first) in a DST overlap.
 */
function wallInstants(w: WallTime, timeZone: string): number[] {
  const targetAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  let ms = targetAsUtc;
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(ms, timeZone);
    const gotAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const delta = gotAsUtc - targetAsUtc;
    if (delta === 0) break;
    ms -= delta;
  }
  const found: number[] = [];
  const seen = new Set<number>();
  // DST shifts are 30 or 60 minutes; probe ±2h around the converged guess.
  for (const delta of [-7_200_000, -3_600_000, -1_800_000, 0, 1_800_000, 3_600_000, 7_200_000]) {
    const candidate = ms + delta;
    const p = zonedParts(candidate, timeZone);
    if (sameWall(p, w) && p.second === 0 && !seen.has(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
  }
  found.sort((a, b) => a - b);
  return found;
}

function utcLastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function wallDow(w: WallTime): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

function dayMatchesWall(w: WallTime, expr: CronExpr): boolean {
  if (expr.doms === null && expr.dows === null) return true;
  if (expr.doms === null) return expr.dows?.has(wallDow(w)) ?? false;
  if (expr.dows === null) return expr.doms.has(w.day);
  return expr.doms.has(w.day) || expr.dows.has(wallDow(w));
}

function addOneDay(w: WallTime): WallTime {
  let { year, month, day, hour, minute } = w;
  day++;
  if (day > utcLastDayOfMonth(year, month - 1)) {
    day = 1;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return { year, month, day, hour, minute };
}

function addOneHour(w: WallTime): WallTime {
  const hour = w.hour + 1;
  if (hour > 23) return addOneDay({ ...w, hour: 0 });
  return { ...w, hour };
}

function addOneMinute(w: WallTime): WallTime {
  const minute = w.minute + 1;
  if (minute > 59) return addOneHour({ ...w, minute: 0 });
  return { ...w, minute };
}

function nextRunInZone(expr: CronExpr, fromMs: number, timeZone: string): number {
  const p = zonedParts(fromMs, timeZone);
  let w: WallTime = addOneMinute({
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
  });

  for (;;) {
    if (w.year > 2100) {
      throw new ConfigError(`no matching time for cron "${expr.raw}"`);
    }

    if (!expr.months.has(w.month)) {
      const nextMonth = nextGreater(expr.months, w.month);
      if (nextMonth === undefined) {
        w = { year: w.year + 1, month: 1, day: 1, hour: 0, minute: 0 };
      } else {
        w = { year: w.year, month: nextMonth, day: 1, hour: 0, minute: 0 };
      }
      continue;
    }

    if (!dayMatchesWall(w, expr)) {
      const monthDays = utcLastDayOfMonth(w.year, w.month - 1);
      let advanced = false;
      for (let d = w.day + 1; d <= monthDays; d++) {
        const cand: WallTime = { ...w, day: d, hour: 0, minute: 0 };
        if (dayMatchesWall(cand, expr)) {
          w = cand;
          advanced = true;
          break;
        }
      }
      if (!advanced) {
        w =
          w.month === 12
            ? { year: w.year + 1, month: 1, day: 1, hour: 0, minute: 0 }
            : { year: w.year, month: w.month + 1, day: 1, hour: 0, minute: 0 };
      }
      continue;
    }

    if (!expr.hours.has(w.hour)) {
      const nextHour = nextGreater(expr.hours, w.hour);
      if (nextHour === undefined) {
        w = addOneDay({ ...w, hour: 0, minute: 0 });
      } else {
        w = { ...w, hour: nextHour, minute: firstOf(expr.minutes) };
      }
      continue;
    }

    if (!expr.minutes.has(w.minute)) {
      const nextMinute = nextGreater(expr.minutes, w.minute);
      if (nextMinute === undefined) {
        w = addOneHour({ ...w, minute: firstOf(expr.minutes) });
      } else {
        w = { ...w, minute: nextMinute };
      }
      continue;
    }

    const instants = wallInstants(w, timeZone).filter((ms) => ms > fromMs);
    if (instants[0] === undefined) {
      w = addOneMinute(w);
      continue;
    }
    return instants[0];
  }
}
