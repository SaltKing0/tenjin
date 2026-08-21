import { ConfigError } from "../config/types";
import { parseSchedule, parseEvery } from "./schedule";
import { knownChannel } from "./channel";

export interface JobConfig {
  name: string;
  bot: string;
  prompt: string;
  postTo?: string;
  /** Optional hard cap on a single run (ms). A hung run is released after this. */
  timeoutMs?: number;
  /** Tool policy for this job. Default: read-only (or gateway allowWrites if set). */
  policy?: "read-only" | "full";
  scheduleSpec: { every?: string; cron?: string; tz?: string };
}

export interface TelegramChannelConfig {
  enabled: boolean;
  defaultBot?: string;
  allowedUsers: number[];
  /** Per-bot Telegram sender allowlists (bot name → user ids). */
  bindings?: Record<string, number[]>;
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

/** Catch-up of scheduled runs missed while the gateway was down. */
export interface CatchUpConfig {
  /** Master switch; catch-up is on by default. */
  enabled: boolean;
  /** Max runs caught up per boot. */
  max: number;
}

export interface GatewaySettings {
  jobs: JobConfig[];
  telegram: TelegramChannelConfig | null;
  channels: string[];
  heartbeat: HeartbeatConfig | null;
  listen: ListenConfig | null;
  allowWrites: boolean;
  catchUp: CatchUpConfig;
}

interface RawJob {
  name?: unknown;
  bot?: unknown;
  prompt?: unknown;
  postTo?: unknown;
  every?: unknown;
  cron?: unknown;
  tz?: unknown;
  timeoutMs?: unknown;
  policy?: unknown;
}

const DEFAULT_CATCH_UP: CatchUpConfig = { enabled: true, max: 50 };

function parseCatchUp(cfg: unknown): CatchUpConfig {
  const c = cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>) : {};
  const enabled = c.enabled === undefined ? true : c.enabled === true;
  let max = DEFAULT_CATCH_UP.max;
  if (c.max !== undefined && c.max !== null) {
    if (typeof c.max !== "number" || !Number.isInteger(c.max) || c.max < 1) {
      throw new ConfigError("gateway.catchUp.max must be a positive integer");
    }
    max = c.max;
  }
  return { enabled, max };
}

export function parseGatewaySettings(raw: unknown): GatewaySettings {
  if (raw === null || raw === undefined) {
    return {
      jobs: [],
      telegram: null,
      channels: [],
      heartbeat: null,
      listen: null,
      allowWrites: false,
      catchUp: { ...DEFAULT_CATCH_UP },
    };
  }
  if (typeof raw !== "object") {
    throw new ConfigError("gateway config must be a mapping");
  }
  const gw = raw as Record<string, unknown>;
  const settings: GatewaySettings = {
    jobs: [],
    telegram: null,
    channels: [],
    heartbeat: null,
    listen: null,
    allowWrites: gw.allowWrites === true || undefined,
    catchUp: parseCatchUp(gw.catchUp),
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
      if (entry.tz !== undefined && entry.tz !== null && typeof entry.tz !== "string") {
        throw new ConfigError(`gateway job "${name}" tz must be an IANA time zone name`);
      }
      const tz =
        typeof entry.tz === "string" && entry.tz.trim() !== "" ? entry.tz.trim() : undefined;
      const scheduleSpec = {
        every: typeof entry.every === "string" ? entry.every : undefined,
        cron: typeof entry.cron === "string" ? entry.cron : undefined,
        tz,
      };
      parseSchedule(scheduleSpec);
      let timeoutMs: number | undefined;
      if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
        const t = entry.timeoutMs;
        if (typeof t !== "number" || !Number.isInteger(t) || t < 1) {
          throw new ConfigError(
            `gateway job "${name}" timeoutMs must be a positive integer (ms)`,
          );
        }
        timeoutMs = t;
      }
      let policy: "read-only" | "full" | undefined;
      if (entry.policy !== undefined && entry.policy !== null) {
        if (entry.policy !== "read-only" && entry.policy !== "full") {
          throw new ConfigError(
            `gateway job "${name}" policy must be "read-only" or "full"`,
          );
        }
        policy = entry.policy;
      }
      settings.jobs.push({
        name,
        bot,
        prompt,
        postTo: typeof entry.postTo === "string" ? entry.postTo : undefined,
        timeoutMs,
        policy,
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
    let bindings: Record<string, number[]> | undefined;
    if (tg.bindings !== undefined && tg.bindings !== null) {
      if (typeof tg.bindings !== "object" || Array.isArray(tg.bindings)) {
        throw new ConfigError("gateway.telegram.bindings must be a mapping of bot name → user ids");
      }
      bindings = {};
      for (const [bot, ids] of Object.entries(tg.bindings as Record<string, unknown>)) {
        if (!Array.isArray(ids) || ids.some((u) => typeof u !== "number")) {
          throw new ConfigError(`gateway.telegram.bindings.${bot} must be a list of numeric ids`);
        }
        bindings[bot] = ids as number[];
      }
    }
    settings.telegram = {
      enabled,
      defaultBot: typeof tg.defaultBot === "string" ? tg.defaultBot : undefined,
      allowedUsers,
      bindings,
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

  const rawChannels = gw.channels;
  if (rawChannels !== undefined && rawChannels !== null) {
    if (!Array.isArray(rawChannels)) {
      throw new ConfigError("gateway.channels must be a list");
    }
    const list: string[] = [];
    for (const c of rawChannels as unknown[]) {
      if (typeof c !== "string" || !c.trim()) {
        throw new ConfigError("gateway.channels entries must be non-empty strings");
      }
      const name = c.trim();
      if (!knownChannel(name)) {
        throw new ConfigError(`gateway.channels: unknown channel "${name}"`);
      }
      list.push(name);
    }
    settings.channels = list;
  } else {
    settings.channels = settings.telegram?.enabled ? ["telegram"] : [];
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
