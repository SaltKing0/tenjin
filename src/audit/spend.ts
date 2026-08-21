import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "../config/loader";

export interface SpendRow {
  scope: string;
  model: string;
  day: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  /** #142: effort level of the session(s) aggregated into this row. */
  effort?: string;
}

export interface BotBreakdown {
  scope: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

interface SessionSummary {
  model: string;
  startedTs: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  costUSD: number;
  effort?: string;
}

function readSessionFile(path: string): SessionSummary | null {
  if (!existsSync(path)) return null;
  let model = "?";
  let startedTs = "";
  let effort: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let costUSD = 0;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.t === "session_start") {
          model = `${e.provider}:${e.model}`;
          startedTs = e.ts;
          if (typeof e.effort === "string") effort = e.effort;
        } else if (e.t === "usage") {
          inputTokens += e.inputTokens ?? 0;
          outputTokens += e.outputTokens ?? 0;
          cacheReadInputTokens += e.cacheReadInputTokens ?? 0;
          costUSD += e.costUSD ?? 0;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  if (!startedTs) return null;
  return { model, startedTs, inputTokens, outputTokens, cacheReadInputTokens, costUSD, effort };
}

export function collectSessionScopes(home: string): Array<{ scope: string; dir: string }> {
  const scopes: Array<{ scope: string; dir: string }> = [
    { scope: "solo", dir: sessionsDir(home) },
  ];
  const botsDir = join(home, "bots");
  if (existsSync(botsDir)) {
    for (const entry of readdirSync(botsDir)) {
      scopes.push({ scope: entry, dir: join(botsDir, entry, "sessions") });
    }
  }
  return scopes;
}

export function aggregateSpend(
  home: string,
  opts: { days?: number; bot?: string } = {},
): SpendRow[] {
  const cutoff =
    opts.days && opts.days > 0
      ? Date.now() - opts.days * 86_400_000
      : 0;

  const byKey = new Map<string, SpendRow>();
  for (const { scope, dir } of collectSessionScopes(home)) {
    if (opts.bot && scope !== opts.bot) continue;
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const summary = readSessionFile(join(dir, file));
      if (!summary) continue;
      if (cutoff && new Date(summary.startedTs).getTime() < cutoff) continue;
      const day = summary.startedTs.slice(0, 10);
      const key = `${scope}|${summary.model}|${day}`;
      const row =
        byKey.get(key) ??
        ({
          scope,
          model: summary.model,
          day,
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          costUSD: 0,
        } satisfies SpendRow);
      row.sessions += 1;
      row.inputTokens += summary.inputTokens;
      row.outputTokens += summary.outputTokens;
      row.cacheReadInputTokens += summary.cacheReadInputTokens;
      row.costUSD += summary.costUSD;
      if (summary.effort !== undefined && row.effort === undefined) row.effort = summary.effort;
      byKey.set(key, row);
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.costUSD - a.costUSD || a.scope.localeCompare(b.scope),
  );
}

export function perBotBreakdown(rows: SpendRow[]): BotBreakdown[] {
  const byScope = new Map<string, BotBreakdown>();
  for (const r of rows) {
    const cur = byScope.get(r.scope) ?? {
      scope: r.scope,
      sessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
    };
    cur.sessions += r.sessions;
    cur.inputTokens += r.inputTokens;
    cur.outputTokens += r.outputTokens;
    cur.costUSD += r.costUSD;
    byScope.set(r.scope, cur);
  }
  return [...byScope.values()].sort(
    (a, b) => b.costUSD - a.costUSD || a.scope.localeCompare(b.scope),
  );
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function renderSpend(rows: SpendRow[]): string {
  if (rows.length === 0) return "no spend recorded";
  const header =
    "scope".padEnd(14) +
    "model".padEnd(30) +
    "day".padEnd(12) +
    "sess".padStart(5) +
    "in".padStart(10) +
    "out".padStart(10) +
    "cached".padStart(10) +
    "cost".padStart(10);
  const lines = [header, "─".repeat(header.length)];
  for (const r of rows) {
    lines.push(
      r.scope.padEnd(14) +
        r.model.padEnd(30) +
        r.day.padEnd(12) +
        String(r.sessions).padStart(5) +
        fmtTokens(r.inputTokens).padStart(10) +
        fmtTokens(r.outputTokens).padStart(10) +
        fmtTokens(r.cacheReadInputTokens).padStart(10) +
        fmtUsd(r.costUSD).padStart(10),
    );
  }
  const total = rows.reduce((sum, r) => sum + r.costUSD, 0);
  lines.push(`${"─".repeat(header.length)}\ntotal: ${fmtUsd(total)}`);
  return lines.join("\n");
}
