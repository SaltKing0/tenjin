import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveBot, botModelRef, botBudgetUSD } from "../bots/profile";
import { runHeadless } from "../agent/headless";
import { formatUSD } from "../agent/budget";
import { parseSchedule, nextRun, type Schedule } from "./schedule";
import { parseGatewaySettings, type GatewaySettings } from "./config";
import { createCheckInboxTool } from "../bots/tools";
import { formatInbox, unreadMessages } from "../bots/inbox";
import type { ToolDef } from "../tools/registry";

export interface ScheduledJob {
  name: string;
  botName: string;
  prompt: string;
  postTo?: string;
  schedule: Schedule;
  nextDueMs: number;
  running: boolean;
  kind: "job" | "heartbeat";
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
    });
  }
  return jobs;
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

  private async execute(job: ScheduledJob): Promise<void> {
    this.log(`job ${job.name} start (bot=${job.botName})`);
    const profile = resolveBot(this.deps.home, job.botName);
    const ref = botModelRef(profile, this.deps.config);

    let message = job.prompt;
    let extraTools: ToolDef[] | undefined;
    if (job.kind === "heartbeat") {
      const unread = unreadMessages(profile.inboxDir);
      const inboxPart =
        unread.length > 0
          ? `You have ${unread.length} unread message(s):\n${formatInbox(unread)}\n`
          : "Your inbox is empty.\n";
      message =
        `Heartbeat check. ${inboxPart}` +
        `Briefly note anything actionable; if nothing needs attention reply with just "ok".`;
      extraTools = [createCheckInboxTool({ profile })];
    }

    const result = await runHeadless({
      provider: this.deps.registry.get(ref.provider),
      model: ref.model,
      soulText: profile.soulText,
      cwd: this.deps.cwd,
      message,
      maxTokens: this.deps.config.maxTokens,
      capUSD: botBudgetUSD(profile, this.deps.config.budgetUSD),
      policy: "read-only",
      extraTools,
      sessionLogDir: profile.sessionsDir,
      sessionBot: profile.name,
      guard: this.deps.guard,
    });
    this.log(
      `job ${job.name} done (${result.stopReason}, ${formatUSD(result.costUSD)})`,
    );

    const output = result.text.trim();
    if (!output) {
      this.log(`job ${job.name}: no output`);
      return;
    }
    if (job.postTo) {
      const post = this.deps.channels?.[job.postTo];
      if (!post) {
        this.log(`job ${job.name}: postTo channel "${job.postTo}" not available`);
        return;
      }
      await post(output);
      this.log(`job ${job.name}: posted to ${job.postTo}`);
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
