import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../config/types";
import type { Channel, ChannelInbound } from "./channel";
import { chunkMessage, ChannelSendError } from "./chunk";

export type SlackRejectReason = "unauthorized" | "rate_limited" | "too_long";

export interface SlackRejection {
  channelId: string;
  userId: string;
  reason: SlackRejectReason;
}

export interface SlackOptions {
  botToken: string;
  signingSecret: string;
  defaultBot: string;
  allowedChannels: string[];
  webhookPath?: string;
  port?: number;
  host?: string;
  apiBase?: string;
  adminChannel?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  maxMessageLength?: number;
  /** Max outbound chars per message before chunking. Default 40000 (Slack limit). */
  maxOutboundLength?: number;
  onRejected?: (info: SlackRejection) => void;
}

const DEFAULT_SLACK_API = "https://slack.com/api";
const DEFAULT_RATE_LIMIT_MAX = 20;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_MAX_OUTBOUND_LENGTH = 40_000;
const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

function hmacPayload(signingSecret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
}

export function verifySlackSignature(
  signingSecret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > MAX_SIGNATURE_AGE_MS) {
    return false;
  }
  const expected = `v0=${hmacPayload(signingSecret, timestamp, rawBody)}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export class SlackChannel implements Channel {
  readonly name = "slack" as const;
  private handler?: (msg: ChannelInbound) => Promise<string | null>;
  private server?: ReturnType<typeof Bun.serve>;
  private rateHits = new Map<string, number[]>();
  private channelId = new Map<string, number>();
  private channelById = new Map<number, string>();
  private nextId = 100_000;
  private seenEvents = new Map<string, number>(); // event_id -> expiry (idempotency, #200)
  private lastDedupSweep = 0;
  private port = 0;

  constructor(
    private opts: SlackOptions,
    private log: (line: string) => void = () => {},
  ) {
    if (!opts.botToken) throw new ConfigError("slack botToken is empty");
    if (!opts.signingSecret) throw new ConfigError("slack signingSecret is empty");
    if (!opts.defaultBot) throw new ConfigError("slack defaultBot is not set");
    if (opts.allowedChannels.length === 0) {
      throw new ConfigError("slack requires a non-empty allowedChannels allowlist (security)");
    }
  }

  get webhookUrl(): string {
    if (!this.server) return "";
    const path = this.opts.webhookPath ?? "/slack/events";
    return `http://${this.opts.host ?? "127.0.0.1"}:${this.port}${path}`;
  }

  onMessage(handler: (msg: ChannelInbound) => Promise<string | null>): void {
    this.handler = handler;
  }

  private apiBase(): string {
    return (this.opts.apiBase || DEFAULT_SLACK_API).replace(/\/$/, "");
  }

  private numericChannel(ch: string): number {
    let id = this.channelId.get(ch);
    if (id === undefined) {
      id = this.nextId++;
      this.channelId.set(ch, id);
      this.channelById.set(id, ch);
    }
    return id;
  }

  private numericUser(u: string): number {
    let id = this.channelId.get(u);
    if (id === undefined) {
      id = this.nextId++;
      this.channelId.set(u, id);
      this.channelById.set(id, u);
    }
    return id;
  }

  private channel(numeric: number): string | undefined {
    return this.channelById.get(numeric);
  }

  async send(text: string): Promise<void> {
    const ch = this.opts.adminChannel;
    if (!ch) throw new ConfigError("slack channel needs adminChannel to send()");
    await this.postMessage(ch, text);
  }

  async sendTo(chatId: number, text: string): Promise<void> {
    const ch = this.channel(chatId);
    if (!ch) throw new ConfigError(`slack chat ${chatId} is not bound to a channel`);
    await this.postMessage(ch, text);
  }

  async postMessage(channel: string, text: string): Promise<void> {
    const max = this.opts.maxOutboundLength ?? DEFAULT_MAX_OUTBOUND_LENGTH;
    for (const part of chunkMessage(text, max)) {
      const res = await fetch(`${this.apiBase()}/chat.postMessage`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.botToken}`,
        },
        body: JSON.stringify({ channel, text: part }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        throw new ChannelSendError(
          `slack chat.postMessage ${res.status}: ${data.error ?? "failed"}`,
        );
      }
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

  /** Idempotency (#200): true when `eventId` was already handled within the
   * freshness window — a Slack redelivery must not re-run the agent. */
  private isDuplicate(eventId: string, now = Date.now()): boolean {
    const expiry = this.seenEvents.get(eventId);
    if (expiry !== undefined && now < expiry) return true;
    this.seenEvents.set(eventId, now + MAX_SIGNATURE_AGE_MS);
    if (now - this.lastDedupSweep > 60_000 || this.seenEvents.size > 1000) {
      this.lastDedupSweep = now;
      for (const [k, e] of this.seenEvents) if (now >= e) this.seenEvents.delete(k);
    }
    return false;
  }

  /** Run the agent handler fire-and-forget and post the reply/error. Never
   * awaited by the HTTP handler, so the 2xx ack is sent immediately (#200). */
  private async runMessage(channel: string, user: string, text: string, username?: string): Promise<void> {
    try {
      const reply = await this.handler?.({
        text,
        chatId: this.numericChannel(channel),
        userId: this.numericUser(user),
        username,
      });
      if (reply) await this.postMessage(channel, reply);
    } catch (e) {
      if (e instanceof ChannelSendError) {
        this.log(`slack: answer generated but delivery failed: ${(e as Error).message}`);
        return;
      }
      this.log(`slack: handler error: ${(e as Error).message}`);
      await this.postMessage(channel, `error: something went wrong handling that.`).catch(() => {});
    }
  }

  private eventHandler = async (req: Request): Promise<Response> => {
    const rawBody = await req.text();
    const signature = req.headers.get("x-slack-signature");
    const timestamp = req.headers.get("x-slack-request-timestamp");
    if (!verifySlackSignature(this.opts.signingSecret, rawBody, signature, timestamp)) {
      this.log("slack: signature verification failed");
      return new Response("bad signature", { status: 401 });
    }
    const ct = req.headers.get("content-type") ?? "";
    let payload: Record<string, unknown>;
    try {
      payload = ct.includes("application/x-www-form-urlencoded")
        ? JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "{}")
        : JSON.parse(rawBody);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (payload.type === "url_verification") {
      return new Response(String(payload.challenge ?? ""), { status: 200 });
    }
    const event = payload.event as Record<string, unknown> | undefined;
    const eventId = typeof payload.event_id === "string" ? payload.event_id : "";
    if (event?.type === "message" && typeof event.text === "string") {
      const channel = typeof event.channel === "string" ? event.channel : "";
      const user = typeof event.user === "string" ? event.user : "";
      if (event.subtype || event.bot_id) return new Response("ok", { status: 200 });
      if (!this.opts.allowedChannels.includes(channel)) {
        this.log(`slack: ignored unauthorized channel ${channel}`);
        this.opts.onRejected?.({ channelId: channel, userId: user, reason: "unauthorized" });
        return new Response("ok", { status: 200 });
      }
      const maxLen = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
      if (user && maxLen > 0 && event.text.length > maxLen) {
        this.opts.onRejected?.({ channelId: channel, userId: user, reason: "too_long" });
        await this.postMessage(channel, `message too long (max ${maxLen} characters) — please shorten it.`).catch(() => {});
        return new Response("ok", { status: 200 });
      }
      if (this.isRateLimited(channel)) {
        this.opts.onRejected?.({ channelId: channel, userId: user, reason: "rate_limited" });
        await this.postMessage(channel, "too many messages — please slow down a moment.").catch(() => {});
        return new Response("ok", { status: 200 });
      }
      if (this.handler && user) {
        // Idempotency (#200): a redelivered event_id must not re-run the agent.
        if (eventId && this.isDuplicate(eventId)) {
          return new Response("ok", { status: 200 });
        }
        // Fire-and-forget (#200): ack immediately; the long run happens async.
        void this.runMessage(
          channel,
          user,
          event.text,
          typeof event.username === "string" ? event.username : undefined,
        );
      }
    }
    return new Response("ok", { status: 200 });
  };

  async start(signal: AbortSignal): Promise<void> {
    const path = this.opts.webhookPath ?? "/slack/events";
    const onAbort = () => {
      this.server?.stop(true);
      this.server = undefined;
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    this.server = Bun.serve({
      port: this.opts.port ?? 0,
      hostname: this.opts.host ?? "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === path) return this.eventHandler(req);
        return new Response("not found", { status: 404 });
      },
    });
    this.port = this.server.port ?? this.opts.port ?? 0;
    signal.addEventListener("abort", onAbort, { once: true });
    this.log(`slack: webhook listening on :${this.port}${path}`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }
}
