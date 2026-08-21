import { ConfigError } from "../config/types";
import { parseSchedule } from "./schedule";

export interface JobConfig {
  name: string;
  bot: string;
  prompt: string;
  postTo?: string;
  scheduleSpec: { every?: string; cron?: string };
}

export interface TelegramChannelConfig {
  enabled: boolean;
  defaultBot?: string;
  allowedUsers: number[];
}

export interface GatewaySettings {
  jobs: JobConfig[];
  telegram: TelegramChannelConfig | null;
}

interface RawJob {
  name?: unknown;
  bot?: unknown;
  prompt?: unknown;
  postTo?: unknown;
  every?: unknown;
  cron?: unknown;
}

export function parseGatewaySettings(raw: unknown): GatewaySettings {
  if (raw === null || raw === undefined) {
    return { jobs: [], telegram: null };
  }
  if (typeof raw !== "object") {
    throw new ConfigError("gateway config must be a mapping");
  }
  const gw = raw as Record<string, unknown>;
  const settings: GatewaySettings = { jobs: [], telegram: null };

  const rawJobs = gw.jobs;
  if (rawJobs !== undefined && rawJobs !== null) {
    if (!Array.isArray(rawJobs)) throw new ConfigError("gateway.jobs must be a list");
    const seen = new Set<string>();
    for (const entry of rawJobs as RawJob[]) {
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const bot = typeof entry.bot === "string" ? entry.bot.trim() : "";
      const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
      if (!name) throw new ConfigError("gateway job missing `name`");
      if (!bot) throw new ConfigError(`gateway job "${name}" missing \`bot\``);
      if (!prompt) throw new ConfigError(`gateway job "${name}" missing \`prompt\``);
      if (seen.has(name)) throw new ConfigError(`duplicate job name "${name}"`);
      seen.add(name);
      const scheduleSpec = {
        every: typeof entry.every === "string" ? entry.every : undefined,
        cron: typeof entry.cron === "string" ? entry.cron : undefined,
      };
      parseSchedule(scheduleSpec);
      settings.jobs.push({
        name,
        bot,
        prompt,
        postTo: typeof entry.postTo === "string" ? entry.postTo : undefined,
        scheduleSpec,
      });
    }
  }

  const rawTg = gw.telegram;
  if (rawTg !== undefined && rawTg !== null) {
    if (typeof rawTg !== "object") throw new ConfigError("gateway.telegram must be a mapping");
    const tg = rawTg as Record<string, unknown>;
    const enabled = tg.enabled === true;
    const allowedUsers = Array.isArray(tg.allowedUsers)
      ? (tg.allowedUsers as unknown[]).map((u) => {
          if (typeof u !== "number") throw new ConfigError("gateway.telegram.allowedUsers must be numeric ids");
          return u;
        })
      : [];
    if (enabled && allowedUsers.length === 0) {
      throw new ConfigError(
        "gateway.telegram.enabled requires a non-empty allowedUsers allowlist (security)",
      );
    }
    settings.telegram = {
      enabled,
      defaultBot: typeof tg.defaultBot === "string" ? tg.defaultBot : undefined,
      allowedUsers,
    };
  }

  return settings;
}
