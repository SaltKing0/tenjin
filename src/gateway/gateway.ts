import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveBot, botModelRef, botBudgetUSD, type BotProfile } from "../bots/profile";
import { runHeadless, capPolicy, type HeadlessOptions, type HeadlessResult } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { formatUSD } from "../agent/budget";
import { parseSchedule, nextRun, type Schedule } from "./schedule";
import { Redactor } from "../security/redact";
import { parseGatewaySettings, type GatewaySettings } from "./config";
import { memorySummariesOnSessionEnd } from "../config/loader";
import { cheapModelRef, type ModelRef } from "../config/models";
import { summarizeLatestSession } from "../memory/summaries";
import { createCheckInboxTool, createSendMessageTool } from "../bots/tools";
import { createRememberTool } from "../tools/memory";
import { formatInbox, inboxPolicyFromConfig, markRead, unreadMessages } from "../bots/inbox";
import type { ToolDef } from "../tools/registry";

export interface JobLastRun {
  atMs: number;
  stopReason: string;
  costUSD: number;
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
  nextDue: string;
  nextDueMs: number;
  running: boolean;
  kind: "job" | "heartbeat";
  postTo?: string;
}

export type JobRunResult =
  | { ok: true; name: string; stopReason: string; costUSD: number; text: string }
  | { ok: false; name?: string; error: string; code: "not_found" | "busy" | "failed" };

export interface ScheduledJob {
  name: string;
  botName: string;
  prompt: string;
  postTo?: string;
  schedule: Schedule;
  nextDueMs: number;
  running: boolean;
  kind: "job" | "heartbeat";
  lastRun: JobLastRun | null;
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
    schedule: parseSchedule(j.scheduleSpec),
    nextDueMs: nextRun(parseSchedule(j.scheduleSpec), fromMs),
    running: false,
    kind: "job" as const,
    lastRun: null,
  }));
  if (settings.heartbeat) {
    const hb = settings.heartbeat;
    const schedule: Schedule = { kind: "every", intervalMs: hb.intervalMs, raw: `${hb.intervalMs}ms` };
    jobs.push({
      name: "heartbeat",
      botName: hb.bot,
      prompt: "",
      schedule,
      nextDueMs: nextRun(schedule, fromMs),
      running: false,
      kind: "heartbeat",
      lastRun: null,
    });
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
    policy: "read-only",
    lastRun: job.lastRun
      ? {
          at: new Date(job.lastRun.atMs).toISOString(),
          stopReason: job.lastRun.stopReason,
          costUSD: job.lastRun.costUSD,
          ...(job.lastRun.error ? { error: job.lastRun.error } : {}),
        }
      : null,
    nextDue: new Date(job.nextDueMs).toISOString(),
    nextDueMs: job.nextDueMs,
    running: job.running,
    kind: job.kind,
    ...(job.postTo ? { postTo: job.postTo } : {}),
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

export class Gateway {
  readonly settings: GatewaySettings;
  readonly jobs: ScheduledJob[];

  constructor(private deps: GatewayDeps) {
    this.settings = parseGatewaySettings(deps.config.gateway);
    this.jobs = buildJobs(this.settings, Date.now());
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
    try {
      const profile = resolveBot(this.deps.home, job.botName);
      const ref = botModelRef(profile, this.deps.config);

      let message = job.prompt;
      let extraTools: ToolDef[] | undefined;
      let approve: HeadlessOptions["approve"];
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
      }

      const result = await runHeadless({
        provider: this.deps.registry.get(ref.provider),
        model: ref.model,
        soulText: profile.soulText,
        cwd: this.deps.cwd,
        message,
        maxTokens: this.deps.config.maxTokens,
        capUSD: botBudgetUSD(profile, this.deps.config.budgetUSD),
        pricing: this.deps.config.pricing,
        policy: capPolicy("read-only", profile.config.security?.policy),
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
        redactor: Redactor.fromConfig(this.deps.config.security),
      });
      job.lastRun = {
        atMs: Date.now(),
        stopReason: result.stopReason,
        costUSD: result.costUSD,
      };
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
      if (!job.lastRun) {
        job.lastRun = {
          atMs: Date.now(),
          stopReason: "error",
          costUSD: 0,
          error: (e as Error).message,
        };
      }
      throw e;
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
