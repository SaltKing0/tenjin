import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveBot, listBots, botModelRef, botBudgetUSD, type BotProfile, type BotRoutineConfig, type BotHeartbeatConfig } from "../bots/profile";
import { runHeadless, capPolicy, type HeadlessOptions, type HeadlessResult } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid } from "../security/injection";
import { formatUSD } from "../agent/budget";
import { parseSchedule, nextRun, parseEvery, type Schedule } from "./schedule";
import { Redactor } from "../security/redact";
import { parseGatewaySettings, type GatewaySettings } from "./config";
import { memorySummariesOnSessionEnd } from "../config/loader";
import { cheapModelRef, type ModelRef } from "../config/models";
import { summarizeLatestSession } from "../memory/summaries";
import { createCheckInboxTool, createSendMessageTool } from "../bots/tools";
import { createRememberTool } from "../tools/memory";
import { formatInbox, inboxPolicyFromConfig, markRead, unreadMessages } from "../bots/inbox";
import type { ToolDef } from "../tools/registry";
import { emit } from "./events";

export interface JobLastRun {
  atMs: number;
  stopReason: string;
  costUSD: number;
  error?: string;
}

/**
 * One entry in a job's persisted run history (#151). `endMs - atMs` is the
 * run's duration; `session` references the session log written for the run.
 */
export interface JobRunRecord {
  /** Run start (Unix ms). */
  atMs: number;
  /** Run end (Unix ms). Duration = endMs - atMs. */
  endMs: number;
  status: "ok" | "error" | "timeout";
  stopReason: string;
  costUSD: number;
  /** Session log id created for the run, if one was written. */
  session?: string;
  error?: string;
}

/** Wire form of a history entry exposed via the console API / `JobView`. */
export interface JobHistoryView {
  at: string;
  end: string;
  status: "ok" | "error" | "timeout";
  stopReason: string;
  costUSD: number;
  durationMs: number;
  session?: string;
  error?: string;
}

export interface JobView {
  name: string;
  bot: string;
  prompt: string;
  cron: string | null;
  every: string | null;
  policy: "read-only" | "full";
  lastRun: {
    at: string;
    stopReason: string;
    costUSD: number;
    error?: string;
  } | null;
  /** Past runs, newest first (last `jobHistory` runs). */
  history: JobHistoryView[];
  nextDue: string;
  nextDueMs: number;
  running: boolean;
  kind: "job" | "heartbeat";
  postTo?: string;
  timeoutMs?: number;
}

export type JobRunResult =
  | { ok: true; name: string; stopReason: string; costUSD: number; text: string }
  | { ok: false; name?: string; error: string; code: "not_found" | "busy" | "failed" };

export interface ScheduledJob {
  name: string;
  botName: string;
  prompt: string;
  postTo?: string;
  policy: "read-only" | "full";
  schedule: Schedule;
  nextDueMs: number;
  running: boolean;
  kind: "job" | "heartbeat";
  lastRun: JobLastRun | null;
  /** Past runs, newest first (last `jobHistory` runs). Kept in sync with `lastRun`. */
  history: JobRunRecord[];
  /** Optional hard cap on a single run (ms). A hung run is released after this. */
  timeoutMs?: number;
}

export interface GatewayDeps {
  home: string;
  cwd: string;
  config: HarnessConfig;
  registry: ProviderRegistry;
  log?: (line: string) => void;
  channels?: Record<string, (text: string) => Promise<void>>;
  guard?: import("../security/guard").SecurityGuard | null;
}

export function scheduleRaw(s: Schedule): string {
  return s.kind === "every" ? s.raw : s.expr.raw;
}

export function buildJobs(settings: GatewaySettings, fromMs: number): ScheduledJob[] {
  const jobs: ScheduledJob[] = settings.jobs.map((j) => ({
    name: j.name,
    botName: j.bot,
    prompt: j.prompt,
    postTo: j.postTo,
    // A per-job policy wins; otherwise defer to the gateway allowWrites flag.
    policy: j.policy ?? (settings.allowWrites ? "full" : "read-only"),
    schedule: parseSchedule(j.scheduleSpec),
    nextDueMs: nextRun(parseSchedule(j.scheduleSpec), fromMs),
    running: false,
    kind: "job" as const,
    lastRun: null,
    history: [],
    ...(j.timeoutMs !== undefined ? { timeoutMs: j.timeoutMs } : {}),
  }));
  if (settings.heartbeat) {
    const hb = settings.heartbeat;
    const schedule: Schedule = { kind: "every", intervalMs: hb.intervalMs, raw: `${hb.intervalMs}ms` };
    jobs.push({
      name: "heartbeat",
      botName: hb.bot,
      prompt: "",
      policy: "read-only",
      schedule,
      nextDueMs: nextRun(schedule, fromMs),
      running: false,
      kind: "heartbeat",
      lastRun: null,
      history: [],
    });
  }
  return jobs;
}

/** One bot's contribution to the job set: its routines + optional heartbeat (#102). */
export interface BotJobFeed {
  bot: string;
  routines: BotRoutineConfig[];
  heartbeat?: BotHeartbeatConfig;
}

/**
 * Build scheduled jobs from per-bot `routines` and per-bot `heartbeat`
 * (`~/.tenjin/bots/<name>/config.yaml`). Each routine becomes a `kind: "job"`
 * scheduled entry; a per-bot heartbeat becomes a `kind: "heartbeat"` entry
 * named `heartbeat-<bot>`. Policy resolution mirrors gateway jobs: a routine's
 * explicit `policy` wins, otherwise the bot falls back to `read-only` (or
 * `full` when the gateway allowWrites flag is set).
 */
export function buildBotJobs(
  feeds: BotJobFeed[],
  fromMs: number,
  allowWrites: boolean,
): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  for (const feed of feeds) {
    for (const r of feed.routines) {
      const schedule = parseSchedule(r.scheduleSpec);
      jobs.push({
        name: r.name,
        botName: feed.bot,
        prompt: r.prompt,
        postTo: r.postTo,
        policy: r.policy ?? (allowWrites ? "full" : "read-only"),
        schedule,
        nextDueMs: nextRun(schedule, fromMs),
        running: false,
        kind: "job" as const,
        lastRun: null,
        history: [],
        ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
      });
    }
    if (feed.heartbeat) {
      const intervalMs = parseEvery(feed.heartbeat.every);
      const schedule: Schedule = { kind: "every", intervalMs, raw: feed.heartbeat.every };
      jobs.push({
        name: `heartbeat-${feed.bot}`,
        botName: feed.bot,
        prompt: "",
        policy: "read-only",
        schedule,
        nextDueMs: nextRun(schedule, fromMs),
        running: false,
        kind: "heartbeat" as const,
        lastRun: null,
        history: [],
      });
    }
  }
  return jobs;
}

/** Map a persisted record back to the `lastRun` shape used across the codebase. */
function toLastRun(r: JobRunRecord): JobLastRun {
  return {
    atMs: r.atMs,
    stopReason: r.stopReason,
    costUSD: r.costUSD,
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Wire form of a single history record for the console API. */
export function historyView(r: JobRunRecord): JobHistoryView {
  return {
    at: new Date(r.atMs).toISOString(),
    end: new Date(r.endMs).toISOString(),
    status: r.status,
    stopReason: r.stopReason,
    costUSD: r.costUSD,
    durationMs: Math.max(0, r.endMs - r.atMs),
    ...(r.session ? { session: r.session } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** Snapshot a live (or config-built) job for the console API. */
export function jobView(job: ScheduledJob): JobView {
  return {
    name: job.name,
    bot: job.botName,
    prompt: job.prompt,
    cron: job.schedule.kind === "cron" ? job.schedule.expr.raw : null,
    every: job.schedule.kind === "every" ? job.schedule.raw : null,
    policy: job.policy,
    lastRun: job.lastRun
      ? {
          at: new Date(job.lastRun.atMs).toISOString(),
          stopReason: job.lastRun.stopReason,
          costUSD: job.lastRun.costUSD,
          ...(job.lastRun.error ? { error: job.lastRun.error } : {}),
        }
      : null,
    history: job.history.map(historyView),
    nextDue: new Date(job.nextDueMs).toISOString(),
    nextDueMs: job.nextDueMs,
    running: job.running,
    kind: job.kind,
    ...(job.postTo ? { postTo: job.postTo } : {}),
    ...(job.timeoutMs !== undefined ? { timeoutMs: job.timeoutMs } : {}),
  };
}

export function listConfiguredJobs(rawGateway: unknown, fromMs = Date.now()): JobView[] {
  return buildJobs(parseGatewaySettings(rawGateway), fromMs).map(jobView);
}

export function dueJobs(jobs: ScheduledJob[], nowMs: number): ScheduledJob[] {
  return jobs.filter((j) => !j.running && j.nextDueMs <= nowMs);
}

export function msUntilNextJob(jobs: ScheduledJob[], nowMs: number): number {
  const running = jobs.filter((j) => j.running);
  const pending = jobs.filter((j) => !j.running);
  if (pending.length === 0) return running.length > 0 ? 250 : 1000;
  const earliest = Math.min(...pending.map((j) => j.nextDueMs));
  return Math.max(0, Math.min(earliest - nowMs, 30_000));
}

/**
 * Persisted gateway state so a restart can tell which scheduled runs have
 * already happened (#19) and reconstruct each job's recent run history (#151).
 * Version 2 stores the last N runs per job; version 1 files (a single
 * `lastRun`) are migrated on load.
 */
interface GatewayJobState {
  runs: JobRunRecord[];
}

interface GatewayStateFile {
  version: 2;
  jobs: Record<string, GatewayJobState>;
}

/** Validate/normalize a persisted run record; drop malformed entries. */
function normalizeRun(raw: unknown): JobRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.atMs !== "number" || typeof r.endMs !== "number") return null;
  const rec: JobRunRecord = {
    atMs: r.atMs,
    endMs: r.endMs,
    status: r.status === "timeout" ? "timeout" : r.status === "error" ? "error" : "ok",
    stopReason: typeof r.stopReason === "string" ? r.stopReason : "error",
    costUSD: typeof r.costUSD === "number" ? r.costUSD : 0,
  };
  if (typeof r.session === "string") rec.session = r.session;
  if (typeof r.error === "string") rec.error = r.error;
  return rec;
}

/** Migrate a legacy v1 `lastRun` into a run record (duration unknown). */
function legacyToRun(raw: unknown): JobRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.atMs !== "number") return null;
  const rec: JobRunRecord = {
    atMs: r.atMs,
    endMs: r.atMs, // v1 did not track a separate end; duration is unknown
    status: typeof r.error === "string" ? "error" : "ok",
    stopReason: typeof r.stopReason === "string" ? r.stopReason : "error",
    costUSD: typeof r.costUSD === "number" ? r.costUSD : 0,
  };
  if (typeof r.error === "string") rec.error = r.error;
  return rec;
}

function statePath(home: string): string {
  return join(home, "gateway-state.json");
}

export function loadGatewayState(home: string): GatewayStateFile {
  const empty: GatewayStateFile = { version: 2, jobs: {} };
  const path = statePath(home);
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  const p = parsed as Record<string, unknown> | null;
  if (!p || typeof p.jobs !== "object" || p.jobs === null) return empty;
  const jobs: Record<string, GatewayJobState> = {};
  for (const [name, raw] of Object.entries(p.jobs as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const j = raw as Record<string, unknown>;
    const runs: JobRunRecord[] = [];
    if (Array.isArray(j.runs)) {
      for (const r of j.runs) {
        const rec = normalizeRun(r);
        if (rec) runs.push(rec);
      }
    } else if (j.lastRun) {
      // Legacy v1: the single lastRun becomes the newest history entry.
      const rec = legacyToRun(j.lastRun);
      if (rec) runs.push(rec);
    }
    if (runs.length > 0) jobs[name] = { runs };
  }
  return { version: 2, jobs };
}

export function saveGatewayState(home: string, state: GatewayStateFile): void {
  writeFileSync(statePath(home), JSON.stringify(state, null, 2));
}

/** Settle `p` within `ms`; a timeout rejects with `msg`. The loser is detached. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class Gateway {
  settings: GatewaySettings;
  jobs: ScheduledJob[];
  private state: GatewayStateFile;

  constructor(private deps: GatewayDeps) {
    this.settings = parseGatewaySettings(deps.config.gateway);
    this.jobs = this.buildAllJobs(Date.now());
    // #19/#151: hydrate each job's run history from persisted state so a
    // restart knows which scheduled runs have already happened (catch-up) and
    // keeps its recent run history without loss.
    this.state = loadGatewayState(deps.home);
    for (const job of this.jobs) {
      const saved = this.state.jobs[job.name]?.runs;
      if (saved && saved.length > 0) {
        job.history = [...saved];
        job.lastRun = toLastRun(saved[0]!);
      }
    }
  }

  /**
   * Re-read the jobs from a fresh config and rebuild the schedule, so the
   * running gateway picks up `tenjin job add/rm` changes without a restart
   * (wired up to SIGHUP in the CLI). Channels/handlers keep their previous
   * settings — only the job set (including per-bot routines) is refreshed.
   */
  reload(config: HarnessConfig): void {
    this.deps.config = config;
    this.settings = parseGatewaySettings(config.gateway);
    this.jobs = this.buildAllJobs(Date.now());
  }

  /**
   * Collect each bot's `routines` + `heartbeat` from its config.yaml so they
   * can be registered as scheduled jobs with bot context (#102). A bot that
   * fails to resolve is skipped with a log line — a single broken bot must not
   * prevent the gateway from booting.
   */
  private botFeeds(): BotJobFeed[] {
    const feeds: BotJobFeed[] = [];
    for (const name of listBots(this.deps.home)) {
      try {
        const profile = resolveBot(this.deps.home, name);
        const routines = profile.config.routines ?? [];
        const heartbeat = profile.config.heartbeat;
        if (routines.length === 0 && !heartbeat) continue;
        feeds.push({
          bot: profile.name,
          routines,
          ...(heartbeat ? { heartbeat } : {}),
        });
      } catch (e) {
        this.log(`bot ${name}: skipping routines (${(e as Error).message})`);
      }
    }
    return feeds;
  }

  /** Gateway jobs + per-bot routines, with global duplicate-name detection. */
  private buildAllJobs(fromMs: number): ScheduledJob[] {
    const jobs = buildJobs(this.settings, fromMs);
    jobs.push(...buildBotJobs(this.botFeeds(), fromMs, this.settings.allowWrites));
    const seen = new Set<string>();
    for (const j of jobs) {
      if (seen.has(j.name)) {
        throw new ConfigError(
          `duplicate job name "${j.name}" (gateway job or bot routine)`,
        );
      }
      seen.add(j.name);
    }
    return jobs;
  }

  private log(line: string): void {
    this.deps.log?.(`[${new Date().toISOString()}] ${line}`);
  }

  describe(): string[] {
    const lines: string[] = [];
    const channels = Object.keys(this.deps.channels ?? {});
    lines.push(
      `channels: ${channels.length ? channels.join(", ") : "(none — jobs still run)"}`,
    );
    if (this.settings.telegram?.enabled) {
      lines.push(
        `telegram: enabled, defaultBot=${this.settings.telegram.defaultBot ?? "(unset)"}, allowlist=${this.settings.telegram.allowedUsers.length} user(s)`,
      );
    }
    for (const job of this.jobs) {
      lines.push(
        `job ${job.name}: bot=${job.botName} every=${scheduleRaw(job.schedule)} next=${new Date(job.nextDueMs).toISOString()}${job.postTo ? ` → ${job.postTo}` : ""}`,
      );
    }
    if (this.settings.jobs.length === 0) lines.push("jobs: (none)");
    return lines;
  }

  listJobs(): JobView[] {
    return this.jobs.map(jobView);
  }

  /** Persist a job's run history so catch-up and history survive restarts. */
  private persistJob(job: ScheduledJob): void {
    this.state.jobs[job.name] = { runs: [...job.history] };
    try {
      saveGatewayState(this.deps.home, this.state);
    } catch {
      // Best-effort: state persistence must never fail a job run.
    }
  }

  /**
   * Prepend a run record to the job's history, keep only the last
   * `jobHistory` runs, sync `lastRun` to the newest, and persist (#151).
   * `lastRun` stays a derived view of history[0] for the existing consumers
   * (catch-up, renderer, console subtitle).
   */
  private recordRun(job: ScheduledJob, record: JobRunRecord): void {
    job.history.unshift(record);
    if (job.history.length > this.settings.jobHistory) {
      job.history.length = this.settings.jobHistory;
    }
    job.lastRun = toLastRun(record);
    this.persistJob(job);
  }

  /**
   * #19: whether `job` has a scheduled run that came due after its last run and
   * was therefore skipped while the gateway was down. No persisted history yet
   * (first ever boot) → nothing to catch up.
   */
  isOverdue(job: ScheduledJob, nowMs = Date.now()): boolean {
    if (!job.lastRun) return false;
    if (job.running) return false;
    return nextRun(job.schedule, job.lastRun.atMs) <= nowMs;
  }

  /**
   * #19: fire the jobs whose scheduled runs were missed during downtime, at
   * most `catchUp.max` per boot. Each runs once now, then resumes its normal
   * cadence. Returns how many runs were fired.
   */
  async catchUpOverdue(nowMs = Date.now()): Promise<number> {
    if (!this.settings.catchUp.enabled) return 0;
    const candidates = this.jobs.filter((j) => this.isOverdue(j, nowMs));
    const toFire = candidates.slice(0, this.settings.catchUp.max);
    for (const job of toFire) {
      this.log(`job ${job.name} catch-up: missed run(s) during downtime, firing`);
      job.running = true;
      try {
        await this.execute(job);
      } catch (e) {
        this.log(`job ${job.name} catch-up error: ${(e as Error).message}`);
      } finally {
        job.running = false;
      }
      job.nextDueMs = nextRun(job.schedule, nowMs);
    }
    return toFire.length;
  }

  /**
   * Run a job immediately. Does not advance `nextDueMs` — cron stays on
   * its existing cadence. Returns a structured result rather than throwing
   * for unknown/busy jobs so the HTTP layer can map status codes.
   */
  async runNow(name: string): Promise<JobRunResult> {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return { ok: false, error: `unknown job "${name}"`, code: "not_found" };
    if (job.running) {
      return { ok: false, name, error: `job "${name}" is already running`, code: "busy" };
    }
    job.running = true;
    try {
      const result = await this.execute(job);
      return {
        ok: true,
        name,
        stopReason: result.stopReason,
        costUSD: result.costUSD,
        text: result.text,
      };
    } catch (e) {
      return { ok: false, name, error: (e as Error).message, code: "failed" };
    } finally {
      job.running = false;
    }
  }

  async fireDue(nowMs: number): Promise<void> {
    for (const job of dueJobs(this.jobs, nowMs)) {
      job.running = true;
      void this.execute(job)
        .catch((e) => this.log(`job ${job.name} error: ${(e as Error).message}`))
        .finally(() => {
          job.running = false;
        });
      job.nextDueMs = nextRun(job.schedule, nowMs);
    }
  }

  private async execute(job: ScheduledJob): Promise<HeadlessResult> {
    this.log(`job ${job.name} start (bot=${job.botName})`);
    emit("job.status", { name: job.name, bot: job.botName, running: true });
    const startedAt = Date.now();
    let recorded = false;
    try {
      const profile = resolveBot(this.deps.home, job.botName);
      const ref = botModelRef(profile, this.deps.config);

      let message = job.prompt;
      let extraTools: ToolDef[] | undefined;
      let approve: HeadlessOptions["approve"];
      // Effective tool policy for this run: the job's own policy, capped by
      // the bot's security policy (a bot can only tighten, never upgrade).
      const jobPolicy = capPolicy(job.policy, profile.config.security?.policy);
      if (job.kind === "heartbeat") {
        const inboxPolicy = inboxPolicyFromConfig(this.deps.config.inbox);
        const unread = unreadMessages(profile.inboxDir, inboxPolicy);
        const inboxPart =
          unread.length > 0
            ? `You have ${unread.length} unread message(s):\n${formatInbox(unread)}\n`
            : "Your inbox is empty.\n";
        message =
          `Heartbeat check. ${inboxPart}` +
          `If a message needs a reply, answer the sender with send_message. ` +
          `Briefly note anything actionable; if nothing needs attention reply with just "ok".`;
        if (unread.length > 0) {
          markRead(
            profile.inboxDir,
            unread.map((m) => m.id),
          );
        }
        const tools: ToolDef[] = [
          createCheckInboxTool({ profile, policy: inboxPolicy }),
          createSendMessageTool({ home: this.deps.home, fromBot: profile.name, policy: inboxPolicy }),
          createRememberTool({ memoryDirPath: profile.memoryDir }),
        ];
        extraTools = tools;
        // The heartbeat is fully autonomous: allow its own tools, keep read access.
        approve = async (name, group) =>
          group === "read" || tools.some((t) => t.name === name);
      } else {
        // Scheduled jobs are headless/autonomous: reads are fine, writes are
        // allowed only when the job's (bot-capped) policy is full.
        approve = async (_name, group) =>
          group === "read" ? true : jobPolicy === "full";
      }

      const headless = runHeadless({
        provider: this.deps.registry.get(ref.provider),
        model: ref.model,
        soulText: profile.soulText,
        cwd: this.deps.cwd,
        message,
        maxTokens: this.deps.config.maxTokens,
        capUSD: botBudgetUSD(profile, this.deps.config.budgetUSD),
        pricing: this.deps.config.pricing,
        globalBudget: this.deps.config.globalBudget,
        policy: jobPolicy,
        denyTools: profile.config.security?.denyTools,
        extraTools,
        approve,
        home: this.deps.home,
        memoryDir: profile.memoryDir,
        sessionLogDir: profile.sessionsDir,
        sessionBot: profile.name,
        guard: guardForBot(
          this.deps.config.security,
          profile.config.security,
          this.deps.guard?.onBlock,
        ),
        paranoid: resolveParanoid(this.deps.config.security, profile.config.security),
        redactor: Redactor.fromConfig(this.deps.config.security),
        context: this.deps.config.context,
      });
      // #19: a per-job timeout releases a hung provider call so it can't pin
      // the job slot forever. The loser is detached (may settle later in the
      // background) — freeing the slot is what matters.
      const result = job.timeoutMs
        ? await withTimeout(
            headless,
            job.timeoutMs,
            `job ${job.name} timed out after ${job.timeoutMs}ms`,
          )
        : await headless;
      this.recordRun(job, {
        atMs: startedAt,
        endMs: Date.now(),
        status: "ok",
        stopReason: result.stopReason,
        costUSD: result.costUSD,
        ...(result.sessionId ? { session: result.sessionId } : {}),
      });
      recorded = true;
      this.log(
        `job ${job.name} done (${result.stopReason}, ${formatUSD(result.costUSD)})`,
      );

      // #37: fold the bot’s just-finished session into its memory summary when
      // gateway-driven summaries are enabled. Best-effort — never fails the job.
      await this.summarizeAfterRun(profile, ref);

      const output = result.text.trim();
      if (!output) {
        this.log(`job ${job.name}: no output`);
        return result;
      }
      if (job.postTo) {
        const post = this.deps.channels?.[job.postTo];
        if (!post) {
          this.log(`job ${job.name}: postTo channel "${job.postTo}" not available`);
          return result;
        }
        await post(output);
        this.log(`job ${job.name}: posted to ${job.postTo}`);
      }
      return result;
    } catch (e) {
      // Record the failed run once. A success already recorded is never
      // overwritten (e.g. a postTo failure after a successful run).
      if (!recorded) {
        this.recordRun(job, {
          atMs: startedAt,
          endMs: Date.now(),
          status: (e as Error).message.includes("timed out") ? "timeout" : "error",
          stopReason: "error",
          costUSD: 0,
          error: (e as Error).message,
        });
      }
      throw e;
    } finally {
      const lr = job.lastRun;
      emit("job.status", {
        name: job.name,
        bot: job.botName,
        running: false,
        stopReason: lr?.stopReason ?? "error",
        costUSD: lr?.costUSD ?? 0,
        ...(lr?.error ? { error: lr.error } : {}),
      });
    }
  }

  /**
   * #37: summarize the bot's most recent session into its memory summary, if
   * enabled. Best-effort — a summarizer failure is logged but never fails a job.
   */
  private async summarizeAfterRun(
    profile: BotProfile,
    runRef: ModelRef,
  ): Promise<void> {
    if (!memorySummariesOnSessionEnd(this.deps.config)) return;
    try {
      const sumRef = cheapModelRef(this.deps.config) ?? runRef;
      const res = await summarizeLatestSession({
        sessionsDirPath: profile.sessionsDir,
        memoryDirPath: profile.memoryDir,
        provider: this.deps.registry.get(sumRef.provider),
        model: sumRef.model,
        maxTokens: this.deps.config.maxTokens,
        projectPath: this.deps.cwd,
      });
      if (res) {
        this.log(
          `job summary: ${profile.name} session ${res.sessionId} (${res.words} words)`,
        );
      }
    } catch (e) {
      this.log(`job summary failed for ${profile.name}: ${(e as Error).message}`);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    for (const line of this.describe()) this.log(line);
    // #19: fire scheduled runs that fell due while the gateway was down before
    // the main loop starts polling future cadences.
    await this.catchUpOverdue();
    while (!signal.aborted) {
      const now = Date.now();
      await this.fireDue(now);
      const wait = msUntilNextJob(this.jobs, now);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
    const inFlight = this.jobs.filter((j) => j.running).length;
    this.log(`gateway stopped (${inFlight} job(s) may still be finishing)`);
  }
}

export function gatewayHomeCheck(home: string, settings: GatewaySettings): void {
  for (const job of settings.jobs) {
    try {
      resolveBot(home, job.bot);
    } catch {
      throw new ConfigError(`job "${job.name}" references unknown bot "${job.bot}"`);
    }
  }
}
