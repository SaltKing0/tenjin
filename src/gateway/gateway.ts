import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveBot, listBots, botModelRef, botBudgetUSD, type BotProfile, type BotRoutineConfig, type BotHeartbeatConfig } from "../bots/profile";
import { scanInstalledBots } from "../bots/catalog";
import { reconcileOrphanedTasks } from "../bots/tasks";
import { runHeadless, capPolicy, type HeadlessOptions, type HeadlessResult } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid, hardenUntrustedInput } from "../security/injection";
import { createBudget, formatUSD, type Budget } from "../agent/budget";
import { parseSchedule, nextRun, parseEvery, type Schedule } from "./schedule";
import { Redactor } from "../security/redact";
import { parseGatewaySettings, type GatewaySettings } from "./config";
import { memorySummariesOnSessionEnd } from "../config/loader";
import { cheapModelRef, type ModelRef } from "../config/models";
import { summarizeLatestSession } from "../memory/summaries";
import { createCheckInboxTool, createSendMessageTool } from "../bots/tools";
import { createRememberTool } from "../tools/memory";
import { formatInbox, inboxPolicyFromConfig, markRead, unreadMessages, USER_SENDER } from "../bots/inbox";
import type { ToolDef } from "../tools/registry";
import { emit } from "./events";

export interface JobLastRun {
  atMs: number;
  stopReason: string;
  costUSD: number;
  error?: string;
}

/** Outcome of one completed job run (ok / error / timeout). */
export type JobRunStatus = "ok" | "error" | "timeout";

/** One entry in a job's persisted run history (#151). */
export interface JobRunRecord {
  /** Run end (for a completed run) epoch ms. */
  atMs: number;
  status: JobRunStatus;
  stopReason: string;
  costUSD: number;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
  /** Session log id, when session logging recorded one. */
  sessionId?: string;
  /** Error/timeout detail, when the run did not finish cleanly. */
  error?: string;
}

/** Default number of completed runs kept per job. */
export const DEFAULT_JOB_HISTORY_LEN = 20;

/** Default per-bot-pair reply cooldown for heartbeats (#181 safety net, ms). */
const DEFAULT_HEARTBEAT_REPLY_COOLDOWN_MS = 60_000;

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
  /** Completed runs, newest first (persisted; survives restarts). */
  history: Array<{
    at: string;
    status: "ok" | "error" | "timeout";
    stopReason: string;
    costUSD: number;
    durationMs: number;
    sessionId?: string;
    error?: string;
  }>;
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
  /** Completed runs, newest first; capped and persisted across restarts. */
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
    // Newest first; job.history is already kept newest-first.
    history: job.history.map((r) => ({
      at: new Date(r.atMs).toISOString(),
      status: r.status,
      stopReason: r.stopReason,
      costUSD: r.costUSD,
      durationMs: r.durationMs,
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.error ? { error: r.error } : {}),
    })),
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
 * Persisted gateway state (v2): per-job run history so a restart keeps the last
 * N completed runs per job. v1 files (a single `lastRun` per job) are migrated
 * to a one-entry history on load.
 */
interface GatewayStateJob {
  history: JobRunRecord[];
}

interface GatewayStateFile {
  version: 2;
  jobs: Record<string, GatewayStateJob>;
}

/** Prepend a completed run to a job's history, capped to the newest `cap` runs. */
export function pushRun(
  history: JobRunRecord[],
  run: JobRunRecord,
  cap: number,
): JobRunRecord[] {
  const next = [run, ...history];
  return cap > 0 && next.length > cap ? next.slice(0, cap) : next;
}

/** Project the newest history entry back onto the legacy `lastRun` shape. */
function toLastRun(r: JobRunRecord): JobLastRun {
  return {
    atMs: r.atMs,
    stopReason: r.stopReason,
    costUSD: r.costUSD,
    ...(r.error ? { error: r.error } : {}),
  };
}

/**
 * Sanitize a loaded history array: drop malformed entries, coerce bad statuses
 * to "ok", and cap the length. Never throws — a corrupt entry is skipped.
 */
export function normalizeHistory(raw: unknown, cap: number): JobRunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: JobRunRecord[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Partial<JobRunRecord>;
    if (typeof rec.atMs !== "number" || !Number.isFinite(rec.atMs)) continue;
    out.push({
      atMs: rec.atMs,
      status: rec.status === "error" || rec.status === "timeout" ? rec.status : "ok",
      stopReason: typeof rec.stopReason === "string" ? rec.stopReason : "",
      costUSD: typeof rec.costUSD === "number" ? rec.costUSD : 0,
      durationMs: typeof rec.durationMs === "number" ? rec.durationMs : 0,
      ...(typeof rec.sessionId === "string" ? { sessionId: rec.sessionId } : {}),
      ...(typeof rec.error === "string" ? { error: rec.error } : {}),
    });
  }
  return cap > 0 && out.length > cap ? out.slice(0, cap) : out;
}

function statePath(home: string): string {
  return join(home, "gateway-state.json");
}

function stateBakPath(home: string): string {
  return join(home, "gateway-state.json.bak");
}

function stateTmpPath(home: string): string {
  return join(home, "gateway-state.json.tmp");
}

/**
 * Parse + normalize a persisted state file. Returns `null` when the file cannot
 * be read as valid v2 state (unparseable JSON or structurally wrong shape), so
 * the caller can decide whether to fall back to a backup. Never throws.
 */
function parseStateFile(path: string, historyCap: number): GatewayStateFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const jobsRaw = rec.jobs;
  if (!jobsRaw || typeof jobsRaw !== "object") return null;
  const jobs: Record<string, GatewayStateJob> = {};
  for (const [name, entry] of Object.entries(jobsRaw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (rec.version === 1) {
      // Migrate the old single `lastRun` into a one-entry history.
      const lr = e.lastRun as Partial<JobLastRun> | null | undefined;
      jobs[name] = {
        history: lr && typeof lr.atMs === "number"
          ? normalizeHistory(
              [
                {
                  atMs: lr.atMs,
                  status: lr.error ? "error" : "ok",
                  stopReason: lr.stopReason ?? "",
                  costUSD: lr.costUSD ?? 0,
                  durationMs: 0,
                  ...(lr.error ? { error: lr.error } : {}),
                },
              ],
              historyCap,
            )
          : [],
      };
    } else {
      jobs[name] = { history: normalizeHistory(e.history, historyCap) };
    }
  }
  return { version: 2, jobs };
}

export function loadGatewayState(
  home: string,
  historyCap = DEFAULT_JOB_HISTORY_LEN,
  onWarn?: (msg: string) => void,
): GatewayStateFile {
  const empty: GatewayStateFile = { version: 2, jobs: {} };
  const path = statePath(home);
  if (!existsSync(path)) return empty;
  const parsed = parseStateFile(path, historyCap);
  if (parsed) return parsed;

  // The main file is corrupt (e.g. a crash mid-write) — recover the previous
  // good copy from the backup instead of silently starting from empty.
  const bak = stateBakPath(home);
  if (existsSync(bak)) {
    const fromBak = parseStateFile(bak, historyCap);
    if (fromBak) {
      onWarn?.(`gateway state corrupt at ${path}; recovered from ${bak}`);
      return fromBak;
    }
  }
  onWarn?.(`gateway state corrupt at ${path}; no usable backup (${bak}) — starting empty`);
  return empty;
}

/**
 * Atomically persist gateway state: write to a temp file, then rename over the
 * real path, and keep the previous good copy as `.bak`. A crash mid-write can
 * never leave the main file half-written — it holds either the old or the new
 * complete state, and the last good version survives in `.bak` (#187).
 */
export function saveGatewayState(home: string, state: GatewayStateFile): void {
  const path = statePath(home);
  const tmp = stateTmpPath(home);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  if (existsSync(path)) renameSync(path, stateBakPath(home));
  renameSync(tmp, path);
}

export class Gateway {
  settings: GatewaySettings;
  jobs: ScheduledJob[];
  private state: GatewayStateFile;
  private historyLen: number;

  constructor(private deps: GatewayDeps) {
    this.settings = parseGatewaySettings(deps.config.gateway);
    this.jobs = this.buildAllJobs(Date.now());
    this.historyLen = this.settings.jobHistoryLen ?? DEFAULT_JOB_HISTORY_LEN;
    // #19/#151: hydrate each job's persisted run history so a restart keeps the
    // last N runs (and knows which scheduled runs have already happened).
    this.state = loadGatewayState(deps.home, this.historyLen, (m) => this.log(m));
    this.hydrateJobHistories();
    this.pruneStaleState();
  }

  /**
   * Hydrate each job's persisted run history from `this.state` so boot and
   * reload keep the last N runs (and know which scheduled runs have already
   * happened). #185: without this on the reload path, a SIGHUP-triggered
   * reload rebuilt every job with `history: []` — empty console, blind
   * catch-up, and the next run persisted the truncated history over the
   * saved runs.
   */
  private hydrateJobHistories(): void {
    for (const job of this.jobs) {
      const saved = this.state.jobs[job.name];
      if (saved?.history && saved.history.length > 0) {
        job.history = saved.history;
        job.lastRun = toLastRun(job.history[0]!);
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
    // #185: rebuild the job set but keep hydrated history — a SIGHUP reload must
    // not wipe the persisted run history (and the `lastRun`-based catch-up).
    this.hydrateJobHistories();
    this.pruneStaleState();
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

  /** Persist a job's run history so catch-up + history survive restarts (#151). */
  private persistJob(job: ScheduledJob): void {
    this.state.jobs[job.name] = { history: job.history };
    try {
      saveGatewayState(this.deps.home, this.state);
    } catch {
      // Best-effort: state persistence must never fail a job run.
    }
  }

  /**
   * Drop persisted history entries for jobs that are no longer configured, so
   * deleted jobs don't accumulate in gateway-state.json forever — and a removed
   * job really disappears from the persisted state (#187).
   */
  private pruneStaleState(): void {
    const current = new Set(this.jobs.map((j) => j.name));
    let pruned = false;
    for (const name of Object.keys(this.state.jobs)) {
      if (!current.has(name)) {
        delete this.state.jobs[name];
        pruned = true;
      }
    }
    if (pruned) {
      try {
        saveGatewayState(this.deps.home, this.state);
      } catch {
        // Best-effort: pruning must never fail boot/reload.
      }
    }
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
    const runStartedMs = Date.now();
    emit("job.status", { name: job.name, bot: job.botName, running: true });
    // #190: per-run abort signal + external budget are scoped here so the error
    // path can report what an aborted (timed-out) run spent up to the abort.
    let timedOut = false;
    let controller: AbortController | null = null;
    let runBudget: Budget | null = null;
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
        // #181: the heartbeat only reacts to user-originated messages. Bot mail
        // (send_message / notifyBot) is inter-bot traffic the recipient handles
        // on a real run — surfacing it here would make two heartbeat bots reply
        // to each other forever. Bot messages stay unread (not auto-replied).
        const unread = unreadMessages(profile.inboxDir, inboxPolicy).filter(
          (m) => m.from === USER_SENDER,
        );
        const inboxPart =
          unread.length > 0
            ? // #189: bot-to-bot inbox content is untrusted — scan, audit and
              // frame it before it reaches the heartbeat prompt, matching the
              // tool-output hardening (a hostile bot could otherwise steer it).
              `You have ${unread.length} unread message(s):\n${hardenUntrustedInput(formatInbox(unread), {
                paranoid: resolveParanoid(this.deps.config.security, profile.config.security),
                audit: (kind, detail) => this.deps.log?.(`[${kind}] ${detail}`),
              })}\n`
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
          createSendMessageTool({
            home: this.deps.home,
            fromBot: profile.name,
            policy: inboxPolicy,
            // #181 safety net: per-bot-pair cooldown so a heartbeat can't loop.
            replyCooldownMs: this.settings.heartbeat?.replyCooldownMs ?? DEFAULT_HEARTBEAT_REPLY_COOLDOWN_MS,
          }),
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

      controller = new AbortController();
      // #190: give the run an external budget so a timed-out (aborted) run
      // still reports what it spent up to the abort, and thread an abort
      // signal through so a co-operating provider is really cancelled instead
      // of pinning the job slot while it keeps spending unrecorded.
      runBudget = createBudget(
        botBudgetUSD(profile, this.deps.config.budgetUSD),
        this.deps.config.pricing,
      );
      const headless = runHeadless({
        provider: this.deps.registry.get(ref.provider),
        model: ref.model,
        soulText: profile.soulText,
        cwd: this.deps.cwd,
        message,
        maxTokens: this.deps.config.maxTokens,
        maxTreeIterations: this.deps.config.maxTreeIterations ?? 0,
        capUSD: botBudgetUSD(profile, this.deps.config.budgetUSD),
        pricing: this.deps.config.pricing,
        budget: runBudget,
        signal: controller.signal,
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
        effort: profile.config.effort,
        redactor: Redactor.fromConfig(this.deps.config.security),
        context: this.deps.config.context,
      });

      // #19/#190: a per-job timeout aborts the run (so a co-operating provider
      // stops, freeing its work) AND releases the slot on a hard deadline (so
      // a provider that ignores the abort can't pin the slot forever). The
      // timeout path rejects here; the catch below books what the run spent up
      // to the abort from the shared budget.
      const result: HeadlessResult = await new Promise<HeadlessResult>((resolve, reject) => {
        let settled = false;
        const once = (fn: () => void) => () => {
          if (settled) return;
          settled = true;
          fn();
        };
        if (job.timeoutMs) {
          const timer = setTimeout(
            once(() => {
              timedOut = true;
              controller?.abort();
              reject(new Error(`job ${job.name} timed out after ${job.timeoutMs}ms`));
            }),
            job.timeoutMs,
          );
          headless.then(
            (r) => {
              clearTimeout(timer);
              once(() => resolve(r))();
            },
            (e) => {
              clearTimeout(timer);
              once(() => reject(e))();
            },
          );
        } else {
          headless.then(resolve, reject);
        }
      });
      const finishedAtMs = Date.now();
      const sessionId = result.sessionId;
      job.lastRun = {
        atMs: finishedAtMs,
        stopReason: result.stopReason,
        costUSD: result.costUSD,
      };
      job.history = pushRun(
        job.history,
        {
          atMs: finishedAtMs,
          status: "ok",
          stopReason: result.stopReason,
          costUSD: result.costUSD,
          durationMs: finishedAtMs - runStartedMs,
          ...(sessionId ? { sessionId } : {}),
        },
        this.historyLen,
      );
      this.persistJob(job);
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
      const err = e instanceof Error ? e : new Error(String(e));
      const isTimeout = timedOut || /timed out/.test(err.message);
      const status: JobRunStatus = isTimeout ? "timeout" : "error";
      const failedAtMs = Date.now();
      // #190: a timed-out (aborted) run books what it spent up to the abort
      // instead of a flat 0, so the spend shows up in history.
      const costUSD = isTimeout ? (runBudget?.spentUSD ?? 0) : 0;
      job.lastRun = {
        atMs: failedAtMs,
        stopReason: isTimeout ? "timeout" : "error",
        costUSD,
        error: err.message,
      };
      job.history = pushRun(
        job.history,
        {
          atMs: failedAtMs,
          status,
          stopReason: job.lastRun.stopReason,
          costUSD,
          durationMs: failedAtMs - runStartedMs,
          error: err.message,
        },
        this.historyLen,
      );
      emit("job.failed", { name: job.name, bot: job.botName, error: (e as Error).message });
      this.persistJob(job);
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
    // #140 boot scan: warn on broken installed bot packages (one broken bot
    // must never take the gateway down).
    const { broken } = scanInstalledBots(this.deps.home);
    for (const b of broken) {
      this.log(`broken bot package "${b.name}" at ${b.dir}: ${b.reason}`);
    }
    // #180: fail tasks orphaned by a previous process's restart so their
    // dependents fail fast instead of burning a full timeout.
    const orphaned = reconcileOrphanedTasks(this.deps.home);
    if (orphaned > 0) {
      this.log(`reconcile: ${orphaned} task(s) orphaned by restart — failed`);
    }
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
