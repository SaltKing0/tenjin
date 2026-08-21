import { ConfigError } from "../config/types";

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  defaultBot: string;
  allowedUsers: number[];
  pollTimeoutSec?: number;
  /** Max inbound messages per chat id per sliding window. 0 disables the limit. Default 20. */
  rateLimitMax?: number;
  /** Sliding-window length for `rateLimitMax`, in ms. Default 60_000. */
  rateLimitWindowMs?: number;
  /** Max accepted inbound text length; longer messages are rejected politely. 0 disables. Default 4096. */
  maxMessageLength?: number;
  /** Called for every rejected inbound message, with the reason. */
  onRejected?: (info: TelegramRejection) => void;
}

export type TelegramRejectReason = "unauthorized" | "rate_limited" | "too_long";

export interface TelegramRejection {
  userId: number;
  chatId: number;
  reason: TelegramRejectReason;
}

export interface TgUser {
  id: number;
  username?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface InboundMessage {
  chatId: number;
  userId: number;
  username?: string;
  text: string;
}

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 4096;

export function routeText(
  text: string,
  defaultBot: string,
  availableBots: string[],
): { bot: string; rest: string } {
  const trimmed = text.trim();
  const mention = /^@([a-z0-9-]+)\s+([\s\S]+)$/i.exec(trimmed);
  if (mention && mention[1] && mention[2] !== undefined) {
    const name = mention[1].toLowerCase();
    if (availableBots.includes(name)) {
      return { bot: name, rest: mention[2].trim() };
    }
  }
  return { bot: defaultBot, rest: trimmed };
}

export class TelegramChannel {
  private offset = 0;
  private rateHits = new Map<number, number[]>();

  constructor(
    private opts: TelegramOptions,
    private onMessage: (msg: InboundMessage) => Promise<string | null>,
    private log: (line: string) => void,
  ) {
    if (!opts.token) throw new ConfigError("telegram token is empty");
    if (!opts.defaultBot) throw new ConfigError("telegram defaultBot is not set");
  }

  private url(method: string): string {
    const base = (this.opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
    return `${base}/bot${this.opts.token}/${method}`;
  }

  async send(chatId: number, text: string): Promise<void> {
    const res = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      throw new Error(`telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  async getUpdates(timeoutSec: number): Promise<TgUpdate[]> {
    const res = await fetch(
      this.url(`getUpdates?offset=${this.offset}&timeout=${timeoutSec}`),
    );
    if (!res.ok) {
      throw new Error(`telegram getUpdates ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { result?: TgUpdate[] };
    return data.result ?? [];
  }

  private isRateLimited(chatId: number): boolean {
    const max = this.opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    if (max <= 0) return false;
    const windowMs = this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const now = Date.now();
    const hits = (this.rateHits.get(chatId) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      this.rateHits.set(chatId, hits);
      return true;
    }
    hits.push(now);
    this.rateHits.set(chatId, hits);
    return false;
  }

  async pollOnce(): Promise<number> {
    const updates = await this.getUpdates(this.opts.pollTimeoutSec ?? 25);
    let handled = 0;
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
      const msg = update.message;
      if (!msg?.text || !msg.from) continue;
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!this.opts.allowedUsers.includes(userId)) {
        this.log(`telegram: ignored unauthorized user ${userId}`);
        this.opts.onRejected?.({ userId, chatId, reason: "unauthorized" });
        continue;
      }

      const maxLen = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
      if (maxLen > 0 && msg.text.length > maxLen) {
        this.log(`telegram: rejected ${msg.text.length}-char message from user ${userId} (max ${maxLen})`);
        this.opts.onRejected?.({ userId, chatId, reason: "too_long" });
        await this.send(chatId, `message too long (max ${maxLen} characters) — please shorten it.`).catch(
          () => {},
        );
        continue;
      }

      if (this.isRateLimited(chatId)) {
        this.log(`telegram: rate-limited chat ${chatId} (user ${userId})`);
        this.opts.onRejected?.({ userId, chatId, reason: "rate_limited" });
        await this.send(chatId, "too many messages — please slow down a moment.").catch(() => {});
        continue;
      }

      handled++;
      try {
        const reply = await this.onMessage({
          chatId,
          userId,
          username: msg.from.username,
          text: msg.text,
        });
        if (reply) await this.send(chatId, reply);
      } catch (e) {
        this.log(`telegram: handler error: ${(e as Error).message}`);
        await this.send(chatId, `error: something went wrong handling that.`).catch(() => {});
      }
    }
    return handled;
  }

  async run(signal: AbortSignal): Promise<void> {
    this.log("telegram: polling started");
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.log(`telegram: poll error: ${(e as Error).message}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
    this.log("telegram: polling stopped");
  }
}
