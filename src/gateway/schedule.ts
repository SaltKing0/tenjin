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

function dayMatches(d: Date, expr: CronExpr): boolean {
  if (expr.doms === null && expr.dows === null) return true;
  if (expr.doms === null) return expr.dows?.has(d.getDay()) ?? true;
  if (expr.dows === null) return expr.doms.has(d.getDate());
  return (expr.doms.has(d.getDate()) || expr.dows.has(d.getDay())) ?? true;
}

const MAX_MINUTE_ITERATIONS = 4 * 366 * 24 * 60;

export function nextRun(schedule: Schedule, fromMs: number): number {
  if (schedule.kind === "every") return fromMs + schedule.intervalMs;

  const t = new Date(fromMs);
  t.setSeconds(0, 0);
  for (let i = 0; i < MAX_MINUTE_ITERATIONS; i++) {
    t.setMinutes(t.getMinutes() + 1);
    if (!schedule.expr.minutes.has(t.getMinutes())) continue;
    if (!schedule.expr.hours.has(t.getHours())) continue;
    if (!schedule.expr.months.has(t.getMonth() + 1)) continue;
    if (!dayMatches(t, schedule.expr)) continue;
    return t.getTime();
  }
  throw new ConfigError(`no matching time for cron "${schedule.expr.raw}" within a year`);
}
