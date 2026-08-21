import { ConfigError } from "../config/types";
import type { Channel, ChannelInbound } from "./channel";

/**
 * Native Discord channel adapter (#139) — zero-dep.
 *
 * Receive: a Discord Gateway WebSocket client (raw JSON protocol, no
 * discord.js). It connects to the gateway, sends IDENTIFY with the bot token,
 * keeps a heart-beat alive, and turns incoming MESSAGE_CREATE events into
 * `ChannelInbound` messages. On a dropped connection it reconnects with
 * exponential backoff and re-identifies.
 *
 * Send: Discord REST `POST /channels/:id/messages` with `Authorization: Bot
 * <token>`, honouring 429 retry_after and an optional client-side rate limit.
 *
 * Security: like Telegram/Slack, an allowlist is mandatory — only
 * `allowedChannels` (and, when set, `allowedGuilds`) are handled; anything
 * else is ignored silently and reported through `onRejected`.
 */

export type DiscordRejectReason = "unauthorized" | "rate_limited" | "too_long";

export interface DiscordRejection {
  channelId: string;
  userId: string;
  reason: DiscordRejectReason;
}

export interface DiscordOptions {
  botToken: string;
  defaultBot: string;
  /** When non-empty, only messages from these guild ids are handled. */
  allowedGuilds: string[];
  /** Mandatory allowlist of channel ids that are handled. */
  allowedChannels: string[];
  /** Channel used by `send()` (e.g. job postTo / no-chat-context pushes). */
  adminChannel?: string;
  /** Gateway WebSocket URL override (tests point at a fake gateway). */
  gatewayUrl?: string;
  /** Discord REST API base override (tests point at a fake REST server). */
  apiBase?: string;
  /** Gateway intents. Default: GUILD_MESSAGES | MESSAGE_CONTENT. */
  intents?: number;
  /** Optional client-side rate limit (max sends per window per channel). */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  maxMessageLength?: number;
  /** Reconnect backoff base/ceiling in ms (tiny values in tests). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  onRejected?: (info: DiscordRejection) => void;
}

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_REST_BASE = "https://discord.com/api/v10";
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

// Discord gateway opcodes.
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RECONNECT: 7, HELLO: 10, HEARTBEAT_ACK: 11 } as const;

// Guild messages (1<<9) + message content (1<<15).
const DEFAULT_INTENTS = (1 << 9) | (1 << 15);

const WS_OPEN = 1;

export class DiscordChannel implements Channel {
  readonly name = "discord" as const;

  private handler?: (msg: ChannelInbound) => Promise<string | null>;
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatIntervalMs = 0;
  private awaitingAck = false;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private seq: number | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private log: (line: string) => void;

  // String Discord ids -> numeric ids the Channel interface needs, and back.
  private channelId = new Map<string, number>();
  private channelById = new Map<number, string>();
  private userId = new Map<string, number>();
  private nextId = 100_000;

  private rateHits = new Map<string, number[]>();

  constructor(
    private opts: DiscordOptions,
    log: (line: string) => void = () => {},
  ) {
    this.log = log;
    if (!opts.botToken) throw new ConfigError("discord botToken is empty");
    if (!opts.defaultBot) throw new ConfigError("discord defaultBot is not set");
    if (opts.allowedChannels.length === 0) {
      throw new ConfigError(
        "discord requires a non-empty allowedChannels allowlist (security)",
      );
    }
  }

  onMessage(handler: (msg: ChannelInbound) => Promise<string | null>): void {
    this.handler = handler;
  }

  private gatewayUrl(): string {
    return this.opts.gatewayUrl || DEFAULT_GATEWAY_URL;
  }

  private apiBase(): string {
    return (this.opts.apiBase || DEFAULT_REST_BASE).replace(/\/$/, "");
  }

  private numeric(channel: Map<string, number>, mapById: Map<number, string>, key: string): number {
    let id = channel.get(key);
    if (id === undefined) {
      id = this.nextId++;
      channel.set(key, id);
      mapById.set(id, key);
    }
    return id;
  }

  private numericChannel(chan: string): number {
    return this.numeric(this.channelId, this.channelById, chan);
  }

  private channel(chatId: number): string | undefined {
    return this.channelById.get(chatId);
  }

  private numericUser(user: string): number {
    let id = this.userId.get(user);
    if (id === undefined) {
      id = this.nextId++;
      this.userId.set(user, id);
    }
    return id;
  }

  async send(text: string): Promise<void> {
    const ch = this.opts.adminChannel;
    if (!ch) throw new ConfigError("discord channel needs adminChannel to send()");
    await this.postMessage(ch, text);
  }

  async sendTo(chatId: number, text: string): Promise<void> {
    const ch = this.channel(chatId);
    if (!ch) throw new ConfigError(`discord chat ${chatId} is not bound to a channel`);
    await this.postMessage(ch, text);
  }

  /** Discord REST `POST /channels/:id/messages`, retrying 429 after retry_after. */
  async postMessage(channel: string, content: string): Promise<void> {
    const body = JSON.stringify({ content });
    const doPost = async (): Promise<Response> =>
      await fetch(`${this.apiBase()}/channels/${channel}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bot ${this.opts.botToken}`,
        },
        body,
      });
    let res = await doPost();
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const waitMs = Math.ceil((data.retry_after ?? 1) * 1000);
      this.log(`discord: rate limited, retrying after ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
      res = await doPost();
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 120);
      throw new Error(`discord POST /channels/${channel}/messages ${res.status}: ${text}`);
    }
  }

  private isRateLimited(channel: string): boolean {
    const max = this.opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    if (max <= 0) return false;
    const windowMs = this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const now = Date.now();
    const hits = (this.rateHits.get(channel) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      this.rateHits.set(channel, hits);
      return true;
    }
    hits.push(now);
    this.rateHits.set(channel, hits);
    return false;
  }

  private isAllowed(guildId: string | null, channelId: string): boolean {
    if (this.opts.allowedGuilds.length > 0) {
      if (!guildId || !this.opts.allowedGuilds.includes(guildId)) return false;
    }
    return this.opts.allowedChannels.includes(channelId);
  }

  private sendHeartbeat(): void {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.seq }));
      this.armAckWatchdog();
    }
  }

  /**
   * #202: after sending a heartbeat, expect a HEARTBEAT_ACK (op 11) within the
   * heartbeat interval. A half-open connection buffers writes silently but
   * never acks, so without a watchdog a dead socket would look alive forever.
   * Missing the ack terminates the connection (triggering a reconnect).
   */
  private armAckWatchdog(): void {
    if (this.heartbeatIntervalMs <= 0) return;
    this.clearAckTimer();
    this.awaitingAck = true;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = undefined;
      if (this.awaitingAck && !this.stopped) {
        this.log("discord: no heartbeat ack — terminating connection");
        this.ws?.close();
      }
    }, this.heartbeatIntervalMs);
  }

  private clearAckTimer(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
    this.awaitingAck = false;
  }

  private checkAndDispatch(payload: Record<string, unknown>): void {
    const op = payload.op as number;
    switch (op) {
      case OP.HELLO: {
        const interval = Number((payload.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval ?? 0);
        this.heartbeatIntervalMs = interval;
        this.identify();
        this.clearHeartbeat();
        this.clearAckTimer();
        if (interval > 0) {
          this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), interval);
        }
        // A fresh HELLO means a live gateway session — reset the reconnect
        // backoff so an established connection doesn't keep paying the last
        // (growing) delay (#202).
        this.reconnectAttempt = 0;
        break;
      }
      case OP.HEARTBEAT_ACK:
        // #202: an ack clears the watchdog armed on the last heartbeat.
        this.clearAckTimer();
        break;
      case OP.DISPATCH: {
        const seq = payload.s;
        if (typeof seq === "number") this.seq = seq;
        this.handleEvent(payload.t as string, payload.d as Record<string, unknown> | null);
        break;
      }
      case OP.RECONNECT:
        this.log("discord: gateway requested reconnect");
        this.ws?.close();
        break;
      default:
        break;
    }
  }

  private identify(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const intents = this.opts.intents ?? DEFAULT_INTENTS;
    this.ws.send(
      JSON.stringify({
        op: OP.IDENTIFY,
        d: {
          token: this.opts.botToken,
          intents,
          properties: { os: "tenjin", browser: "tenjin", device: "tenjin" },
        },
      }),
    );
  }

  private handleEvent(t: string, d: Record<string, unknown> | null): void {
    if (t !== "MESSAGE_CREATE" || !d) return;
    const channelId = typeof d.channel_id === "string" ? d.channel_id : "";
    const guildId = typeof d.guild_id === "string" ? d.guild_id : null;
    const author = d.author && typeof d.author === "object" ? (d.author as Record<string, unknown>) : null;
    const authorId = typeof author?.id === "string" ? author.id : "";
    const isBot = author?.bot === true;
    const content = typeof d.content === "string" ? d.content : "";
    const username = typeof author?.username === "string" ? author.username : undefined;

    // Ignore own echoes and empty messages.
    if (isBot || !content.trim()) return;
    if (!this.isAllowed(guildId, channelId) || !authorId) {
      this.log(`discord: ignored message from unauthorized channel ${channelId}`);
      this.opts.onRejected?.({ channelId, userId: authorId, reason: "unauthorized" });
      return;
    }
    const maxLen = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    if (maxLen > 0 && content.length > maxLen) {
      this.opts.onRejected?.({ channelId, userId: authorId, reason: "too_long" });
      return;
    }
    if (this.isRateLimited(channelId)) {
      this.opts.onRejected?.({ channelId, userId: authorId, reason: "rate_limited" });
      return;
    }
    if (!this.handler) return;
    this.handler({
      text: content,
      chatId: this.numericChannel(channelId),
      userId: this.numericUser(authorId),
      username,
    })
      .then((reply) => {
        if (reply) return this.postMessage(channelId, reply);
      })
      .catch((e) => {
        this.log(`discord: handler error: ${(e as Error).message}`);
        this.postMessage(channelId, "error: something went wrong handling that.").catch(() => {});
      });
  }

  private async dataToText(data: unknown): Promise<string> {
    if (typeof data === "string") return data;
    if (data instanceof Blob) return data.text();
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    return String(data ?? "");
  }

  private connect(): void {
    if (this.stopped) return;
    // A fresh IDENTIFY begins a new gateway session; the heartbeat sequence
    // starts again from scratch.
    this.seq = null;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.gatewayUrl());
    } catch (e) {
      this.log(`discord: connect failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.log("discord: gateway connected");
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      this.dataToText(ev.data).then((raw) => {
        try {
          this.checkAndDispatch(JSON.parse(raw) as Record<string, unknown>);
        } catch (e) {
          this.log(`discord: bad gateway payload: ${(e as Error).message}`);
        }
      });
    });

    ws.addEventListener("close", () => {
      this.clearHeartbeat();
      this.clearAckTimer();
      if (this.stopped) return;
      this.log("discord: gateway closed — reconnecting");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close fires next; nothing else to do here.
    });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = this.opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const cap = this.opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    const delay = Math.min(base * 2 ** this.reconnectAttempt, cap);
    this.reconnectAttempt += 1;
    this.log(`discord: reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private disconnectCleanup(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();
    this.clearAckTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // already closed
      }
      this.ws = undefined;
    }
  }

  async start(signal: AbortSignal): Promise<void> {
    const onAbort = () => this.stop();
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  stop(): void {
    this.disconnectCleanup();
  }
}
