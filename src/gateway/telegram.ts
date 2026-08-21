import { ConfigError } from "../config/types";
import type { Channel, ChannelInbound } from "./channel";

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  defaultBot: string;
  allowedUsers: number[];
  pollTimeoutSec?: number;
  adminChatId?: number;
  /** Max inbound messages per chat id per sliding window. 0 disables the limit. Default 20. */
  rateLimitMax?: number;
  /** Sliding-window length for `rateLimitMax`, in ms. Default 60_000. */
  rateLimitWindowMs?: number;
  /** Max accepted inbound text length; longer messages are rejected politely. 0 disables. Default 4096. */
  maxMessageLength?: number;
  /** Accept voice notes and transcribe them (#137). Off by default. */
  voiceEnabled?: boolean;
  /** Injected audio->text transcriber. When undefined, enabled voice messages get a hint. */
  transcribe?: (audio: Blob, filename: string) => Promise<string>;
  /** Called after a successful transcription (audit / cost trace). */
  onTranscribed?: (info: {
    userId: number;
    chatId: number;
    fileId: string;
    text: string;
  }) => void;
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
  voice?: { file_id: string; duration?: number };
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

function mentionedBot(text: string): { name: string; rest: string } | null {
  const mention = /^@([a-z0-9-]+)\s+([\s\S]+)$/i.exec(text.trim());
  if (!mention || !mention[1] || mention[2] === undefined) return null;
  return { name: mention[1].toLowerCase(), rest: mention[2].trim() };
}

export function routeText(
  text: string,
  defaultBot: string,
  availableBots: string[],
): { bot: string; rest: string } {
  const mention = mentionedBot(text);
  if (mention && availableBots.includes(mention.name)) {
    return { bot: mention.name, rest: mention.rest };
  }
  return { bot: defaultBot, rest: text.trim() };
}

/** Merge a bot's own allowlist with the gateway binding for that bot. */
export function mergeBotAllowlist(
  fromBot?: number[],
  fromGateway?: number[],
): number[] | undefined {
  if (fromBot === undefined && fromGateway === undefined) return undefined;
  return [...new Set([...(fromBot ?? []), ...(fromGateway ?? [])])];
}

/**
 * Bots this sender may reach. A missing allowlist means "any globally
 * allowed user"; an explicit list is a per-bot restriction.
 */
export function botsAllowedForUser(
  userId: number,
  availableBots: string[],
  allowlists: Record<string, number[] | undefined>,
): string[] {
  return availableBots.filter((bot) => {
    const list = allowlists[bot];
    if (list === undefined) return true;
    return list.includes(userId);
  });
}

export type BoundRoute =
  | { ok: true; bot: string; rest: string }
  | { ok: false; error: string };

/** Route a Telegram message through a sender's allowed-bot set. */
export function routeBoundText(
  text: string,
  defaultBot: string,
  availableBots: string[],
  allowedBots: string[],
): BoundRoute {
  if (allowedBots.length === 0) {
    return { ok: false, error: "you are not allowed to talk to any bot on this gateway" };
  }
  const mention = mentionedBot(text);
  if (mention && availableBots.includes(mention.name) && !allowedBots.includes(mention.name)) {
    return { ok: false, error: `you are not allowed to talk to bot ${mention.name}` };
  }
  const fallback = allowedBots.includes(defaultBot) ? defaultBot : allowedBots[0]!;
  const routed = routeText(text, fallback, allowedBots);
  return { ok: true, bot: routed.bot, rest: routed.rest };
}

export class TelegramChannel implements Channel {
  readonly name = "telegram" as const;
  private offset = 0;
  private rateHits = new Map<number, number[]>();
  private handler?: (msg: InboundMessage) => Promise<string | null>;
  private own = new AbortController();

  constructor(
    private opts: TelegramOptions,
    onMessage?: (msg: ChannelInbound) => Promise<string | null>,
    private log: (line: string) => void = () => {},
  ) {
    if (!opts.token) throw new ConfigError("telegram token is empty");
    if (!opts.defaultBot) throw new ConfigError("telegram defaultBot is not set");
    if (onMessage) this.handler = onMessage;
  }

  onMessage(handler: (msg: ChannelInbound) => Promise<string | null>): void {
    this.handler = handler;
  }

  private url(method: string): string {
    const base = (this.opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
    return `${base}/bot${this.opts.token}/${method}`;
  }

  send(chatId: number, text: string): Promise<void>;
  send(text: string): Promise<void>;
  async send(chatIdOrText: number | string, maybeText?: string): Promise<void> {
    if (typeof chatIdOrText === "number") {
      await this.postMessage(chatIdOrText, maybeText as string);
      return;
    }
    if (this.opts.adminChatId === undefined) {
      throw new ConfigError("telegram channel needs adminChatId to send()");
    }
    await this.postMessage(this.opts.adminChatId, chatIdOrText);
  }

  private async postMessage(chatId: number, text: string): Promise<void> {
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
      if (!msg?.from) continue;
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!this.opts.allowedUsers.includes(userId)) {
        this.log(`telegram: ignored unauthorized user ${userId}`);
        this.opts.onRejected?.({ userId, chatId, reason: "unauthorized" });
        continue;
      }

      // Voice notes carry no `text`: download + transcribe, then treat the
      // transcript as the message (#137). Returns null when the message was
      // already answered with a hint or failed to transcribe.
      let text = msg.text;
      if (!text && msg.voice) {
        const voiceText = await this.handleVoice(chatId, userId, msg.voice);
        if (voiceText === null) continue;
        text = voiceText;
      }
      if (!text) continue; // non-text, non-voice message (photo, sticker, …)

      const maxLen = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
      if (maxLen > 0 && text.length > maxLen) {
        this.log(`telegram: rejected ${text.length}-char message from user ${userId} (max ${maxLen})`);
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
        const reply = await this.handler?.({
          chatId,
          userId,
          username: msg.from.username,
          text,
        });
        if (reply) await this.send(chatId, reply);
      } catch (e) {
        this.log(`telegram: handler error: ${(e as Error).message}`);
        await this.send(chatId, `error: something went wrong handling that.`).catch(() => {});
      }
    }
    return handled;
  }

  private voiceHint(chatId: number, text: string): Promise<void> {
    return this.send(chatId, text).catch(() => {});
  }

  /**
   * Voice-message pipeline (#137): enforces the on/off switch, falls back with
   * a clear hint when no transcriber (audio model) is configured, and otherwise
   * downloads the audio, transcribes it and returns the transcript. Returns
   * null when the message should be dropped (hint already sent / failure).
   */
  private async handleVoice(
    chatId: number,
    userId: number,
    voice: { file_id: string; duration?: number },
  ): Promise<string | null> {
    if (!this.opts.voiceEnabled) {
      this.log(`telegram: voice message ignored (voice off) from user ${userId}`);
      await this.voiceHint(
        chatId,
        "voice messages are disabled — enable gateway.telegram.voice to send audio notes.",
      );
      return null;
    }
    if (!this.opts.transcribe) {
      this.log(`telegram: voice message from user ${userId} but no audio model configured`);
      await this.voiceHint(
        chatId,
        "voice transcription is on, but an audio model / provider key is not configured — set gateway.telegram.voice.model and an OpenAI-compatible API key.",
      );
      return null;
    }
    try {
      const audio = await this.downloadVoice(voice.file_id);
      const text = await this.opts.transcribe(audio, `voice_${voice.file_id}.ogg`);
      if (!text || !text.trim()) throw new Error("empty transcription");
      this.opts.onTranscribed?.({ userId, chatId, fileId: voice.file_id, text });
      return text.trim();
    } catch (e) {
      this.log(`telegram: transcription failed for user ${userId}: ${(e as Error).message}`);
      await this.voiceHint(chatId, "could not transcribe that voice message — please try again.");
      return null;
    }
  }

  private async downloadVoice(fileId: string): Promise<Blob> {
    const getFile = await fetch(
      this.url(`getFile?file_id=${encodeURIComponent(fileId)}`),
    );
    if (!getFile.ok) {
      throw new Error(`telegram getFile ${getFile.status}: ${(await getFile.text()).slice(0, 200)}`);
    }
    const data = (await getFile.json()) as { result?: { file_path?: string } };
    const filePath = data.result?.file_path;
    if (!filePath) throw new Error("telegram getFile returned no file_path");
    const base = (this.opts.apiBase || DEFAULT_API_BASE).replace(/\/$/, "");
    const fileRes = await fetch(`${base}/file/bot${this.opts.token}/${filePath}`);
    if (!fileRes.ok) {
      throw new Error(`telegram file download ${fileRes.status}`);
    }
    return await fileRes.blob();
  }

  async start(signal: AbortSignal): Promise<void> {
    const onAbort = () => this.own.abort();
    if (signal.aborted) this.own.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.run(this.own.signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  stop(): void {
    this.own.abort();
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
