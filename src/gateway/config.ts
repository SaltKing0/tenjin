import { ConfigError } from "../config/types";
import { parseSchedule, parseEvery } from "./schedule";

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
  adminChatId?: number;
  allowWrites?: boolean;
  approvalTimeoutMs?: number;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  maxMessageLength?: number;
}

export interface HeartbeatConfig {
  bot: string;
  intervalMs: number;
}

export interface ListenConfig {
  port: number;
  host: string;
  token: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export interface GatewaySettings {
  jobs: JobConfig[];
  telegram: TelegramChannelConfig | null;
  heartbeat: HeartbeatConfig | null;
  listen: ListenConfig | null;
  allowWrites: boolean;
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
    return { jobs: [], telegram: null, heartbeat: null, listen: null, allowWrites: false };
  }
  if (typeof raw !== "object") {
    throw new ConfigError("gateway config must be a mapping");
  }
  const gw = raw as Record<string, unknown>;
  const settings: GatewaySettings = {
    jobs: [],
    telegram: null,
    heartbeat: null,
    listen: null,
    allowWrites: gw.allowWrites === true || undefined,
  } as GatewaySettings;

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
    if (enabled && (typeof tg.defaultBot !== "string" || !tg.defaultBot.trim())) {
      throw new ConfigError("gateway.telegram.enabled requires a defaultBot");
    }
    settings.telegram = {
      enabled,
      defaultBot: typeof tg.defaultBot === "string" ? tg.defaultBot : undefined,
      allowedUsers,
      adminChatId: typeof tg.adminChatId === "number" ? tg.adminChatId : undefined,
      allowWrites: tg.allowWrites === true,
      approvalTimeoutMs:
        typeof tg.approvalTimeoutMs === "number" ? tg.approvalTimeoutMs : undefined,
      rateLimitMax: typeof tg.rateLimitMax === "number" ? tg.rateLimitMax : undefined,
      rateLimitWindowMs:
        typeof tg.rateLimitWindowMs === "number" ? tg.rateLimitWindowMs : undefined,
      maxMessageLength:
        typeof tg.maxMessageLength === "number" ? tg.maxMessageLength : undefined,
    };
  }

  const rawHb = gw.heartbeat;
  if (rawHb !== undefined && rawHb !== null) {
    if (typeof rawHb !== "object") throw new ConfigError("gateway.heartbeat must be a mapping");
    const hb = rawHb as Record<string, unknown>;
    if (hb.enabled !== true) return settings;
    const bot = typeof hb.bot === "string" ? hb.bot.trim() : "";
    if (!bot) throw new ConfigError("gateway.heartbeat.enabled requires a `bot`");
    const every = typeof hb.every === "string" ? hb.every : "30m";
    settings.heartbeat = { bot, intervalMs: parseEvery(every) };
  }

  const rawListen = gw.listen;
  if (rawListen !== undefined && rawListen !== null) {
    if (typeof rawListen !== "object") throw new ConfigError("gateway.listen must be a mapping");
    const l = rawListen as Record<string, unknown>;
    const port = typeof l.port === "number" ? l.port : NaN;
    const token = typeof l.token === "string" ? l.token.trim() : "";
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ConfigError("gateway.listen.port must be a valid port number");
    }
    if (!token) throw new ConfigError("gateway.listen.token is required");
    settings.listen = {
      port,
      host: typeof l.host === "string" ? l.host : "127.0.0.1",
      token,
      rateLimitMax: typeof l.rateLimitMax === "number" ? l.rateLimitMax : undefined,
      rateLimitWindowMs:
        typeof l.rateLimitWindowMs === "number" ? l.rateLimitWindowMs : undefined,
    };
  }

  if (settings.allowWrites === undefined) {
    settings.allowWrites = settings.telegram?.allowWrites === true;
  }

  return settings;
}
