import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../config/types";
import type { Channel, ChannelInbound } from "./channel";

/**
 * Generic webhook channel (#130).
 *
 * Registers a signed HTTP endpoint (`POST <webhookPath>`) that accepts agent
 * messages from any system able to speak HTTP with an HMAC signature, turning
 * Tenjin into a target for arbitrary inbound/outbound webhooks (n8n, Discord
 * bridges, own apps). Replies are either returned as JSON in the HTTP response
 * or, when `outboundWebhookUrl` is set, POSTed out-of-band to that URL.
 *
 * The signature scheme mirrors the Slack adapter: `x-webhook-signature` is
 * `sha256=<hex hmac-sha256(secret, "<timestamp>:<rawBody>")>` and
 * `x-webhook-timestamp` guards against replay within a freshness window.
 *
 * Pre-auth hardening (#203): before the body is read or any HMAC/parse work,
 * the handler applies a per-connection-IP rate limit and a `content-length`
 * cap, so unsigned garbage can't cost unbounded memory/CPU. Valid signed
 * messages are deduped on `hash(timestamp:rawBody)` so re-sending the identical
 * message within the validity window does not re-run the agent.
 */

export type WebhookRejectReason =
  | "bad_signature"
  | "unauthorized"
  | "rate_limited"
  | "too_long"
  | "bad_json";

export interface WebhookRejection {
  sender: string;
  reason: WebhookRejectReason;
}

export interface WebhookOptions {
  secret: string;
  defaultBot: string;
  /** If non-empty, only these sender ids are accepted (HMAC alone already authenticates the holder). */
  allowedSenders: string[];
  /** When set, bot replies are POSTed here as JSON instead of returned in the HTTP response. */
  outboundWebhookUrl?: string;
  webhookPath?: string;
  port?: number;
  host?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  maxMessageLength?: number;
  onRejected?: (info: WebhookRejection) => void;
}

const DEFAULT_PATH = "/channel/webhook";
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_MESSAGE_LENGTH = 8192;
const MAX_SIGNATURE_AGE_MS = 5 * 60_000;
/** Evict stale rate/ip entries once the maps grow past this bound (#317). */
export const WEBHOOK_MAP_SWEEP_THRESHOLD = 1000;

/** Compute the `sha256=<hex>` webhook signature for a raw body at `timestamp` (epoch s). */
export function webhookSignature(secret: string, timestamp: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest("hex");
  return `sha256=${hex}`;
}

/** Constant-time verification of `x-webhook-signature` + freshness of the timestamp. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  nowMs = Date.now(),
): boolean {
  if (!signature || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > MAX_SIGNATURE_AGE_MS) {
    return false;
  }
  const expected = webhookSignature(secret, timestamp, rawBody);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Stable numeric id for a sender string (used as both chatId and userId). */
export function hashId(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h === 0 ? 1 : h;
}

interface InboundPayload {
  text?: unknown;
  sender?: unknown;
  username?: unknown;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

export class WebhookChannel implements Channel {
  readonly name = "webhook" as const;
  private handler?: (msg: ChannelInbound) => Promise<string | null>;
  private server?: ReturnType<typeof Bun.serve>;
  private rateHits = new Map<string, number[]>();
  private ipHits = new Map<string, RateWindow>();
  private recentMessages = new Map<string, number>(); // signature -> expiry (replay dedup)
  private port = 0;

  constructor(
    private opts: WebhookOptions,
    private log: (line: string) => void = () => {},
  ) {
    if (!opts.secret) throw new ConfigError("webhook secret is empty");
    if (!opts.defaultBot) throw new ConfigError("webhook defaultBot is not set");
  }

  get webhookUrl(): string {
    if (!this.server) return "";
    return `http://${this.opts.host ?? "127.0.0.1"}:${this.port}${this.webhookPath()}`;
  }

  onMessage(handler: (msg: ChannelInbound) => Promise<string | null>): void {
    this.handler = handler;
  }

  private webhookPath(): string {
    return this.opts.webhookPath ?? DEFAULT_PATH;
  }

  private isRateLimited(sender: string): boolean {
    const max = this.opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    if (max <= 0) return false;
    const windowMs = this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const now = Date.now();
    const hits = (this.rateHits.get(sender) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      this.rateHits.set(sender, hits);
      return true;
    }
    hits.push(now);
    this.rateHits.set(sender, hits);
    return false;
  }

  /** Per-connection-IP rate limit, applied BEFORE auth so an unsigned flood is
   * throttled regardless of the (attacker-controlled) `sender` payload field. */
  private isIpLimited(ip: string): boolean {
    const max = this.opts.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX;
    if (max <= 0) return false;
    const windowMs = this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    const now = Date.now();
    const entry = this.ipHits.get(ip);
    if (!entry || now >= entry.resetAt) {
      this.ipHits.set(ip, { count: 1, resetAt: now + windowMs });
      return false;
    }
    entry.count += 1;
    return entry.count > max;
  }

  /** Replay dedup: returns true when `signature` (HMAC over timestamp:rawBody)
   * was already processed within the signature-validity window — so re-sending
   * the identical signed message does not re-run the agent (#203). */
  private isReplay(signature: string, nowMs = Date.now()): boolean {
    const expiry = this.recentMessages.get(signature);
    if (expiry !== undefined && nowMs < expiry) return true;
    this.recentMessages.set(signature, nowMs + MAX_SIGNATURE_AGE_MS);
    if (this.recentMessages.size > 1000) {
      for (const [k, e] of this.recentMessages) {
        if (nowMs >= e) this.recentMessages.delete(k);
      }
    }
    return false;
  }

  /** Current size of the rate-limit / replay maps (observability + tests). */
  mapSizes(): { rateHits: number; ipHits: number; recentMessages: number } {
    return {
      rateHits: this.rateHits.size,
      ipHits: this.ipHits.size,
      recentMessages: this.recentMessages.size,
    };
  }

  /**
   * Drop rate/ip entries whose window has fully elapsed so a long-running
   * gateway doesn't accumulate one entry per distinct sender/IP forever (#317).
   * `recentMessages` is already swept inside {@link isReplay} past its bound.
   */
  sweep(now = Date.now()): void {
    const windowMs = this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS;
    for (const [sender, hits] of this.rateHits) {
      if (hits.length === 0) {
        this.rateHits.delete(sender);
        continue;
      }
      const last = hits[hits.length - 1];
      if (last === undefined) {
        this.rateHits.delete(sender);
        continue;
      }
      if (now - last >= windowMs) this.rateHits.delete(sender);
    }
    for (const [ip, entry] of this.ipHits) {
      if (now >= entry.resetAt) this.ipHits.delete(ip);
    }
  }

  private reject(info: WebhookRejection, status: number, body: unknown): Response {
    this.opts.onRejected?.(info);
    return Response.json(body, { status });
  }

  /** Deliver `text` to the configured outbound webhook. */
  private async postOutbound(text: string): Promise<void> {
    const url = this.opts.outboundWebhookUrl;
    if (!url) throw new ConfigError("webhook outboundWebhookUrl is not configured");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`webhook outbound POST ${res.status}`);
  }

  /** Deliver a bot reply: out-of-band via outboundWebhookUrl when set, else return it for the HTTP JSON body. */
  private async deliverReply(reply: string): Promise<unknown> {
    if (this.opts.outboundWebhookUrl) {
      await this.postOutbound(reply);
      return { ok: true };
    }
    return { reply };
  }

  private eventHandler = async (req: Request): Promise<Response> => {
    // Opportunistically evict stale rate/ip entries once the maps get large, so
    // a long-running gateway stays bounded (#317).
    if (this.rateHits.size + this.ipHits.size > WEBHOOK_MAP_SWEEP_THRESHOLD) {
      this.sweep();
    }
    // Pre-auth guards run BEFORE the body is read or any HMAC/parse work, so
    // unsigned garbage can't cost unbounded memory or CPU (DoS, #203): per-IP
    // rate limit + content-length cap, keyed by the connection IP (not the
    // attacker-controlled `sender` payload field).
    const ip = this.server?.requestIP(req)?.address ?? "unknown";
    if (this.isIpLimited(ip)) {
      return this.reject({ sender: "unknown", reason: "rate_limited" }, 429, {
        error: "too many requests",
        "retry-after": String(Math.ceil((this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS) / 1000)),
      });
    }
    const maxBytes = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return this.reject({ sender: "unknown", reason: "too_long" }, 413, {
        error: `payload too large (max ${maxBytes} bytes)`,
      });
    }
    const rawBody = await req.text();
    // #307: the header cap above is skipped when `content-length` is absent
    // (chunked / HTTP-2), so also enforce the cap on the actual body size after
    // reading it — closes the pre-auth memory-exhaustion bypass for unsigned
    // flood traffic.
    if (rawBody.length > maxBytes) {
      return this.reject({ sender: "unknown", reason: "too_long" }, 413, {
        error: `payload too large (max ${maxBytes} bytes)`,
      });
    }
    const signature = req.headers.get("x-webhook-signature");
    const timestamp = req.headers.get("x-webhook-timestamp");
    if (!verifyWebhookSignature(this.opts.secret, rawBody, signature, timestamp)) {
      this.log("webhook: signature verification failed");
      return this.reject({ sender: "unknown", reason: "bad_signature" }, 401, {
        error: "bad signature",
      });
    }
    // Only dedup messages that actually authenticate (a re-sent signed message
    // within the validity window must not re-run the agent, #203).
    if (signature && this.isReplay(signature)) {
      this.log("webhook: duplicate signed message ignored (replay)");
      return Response.json({ reply: null });
    }
    let payload: InboundPayload;
    try {
      payload = JSON.parse(rawBody) as InboundPayload;
    } catch {
      return this.reject({ sender: "unknown", reason: "bad_json" }, 400, {
        error: "bad json",
      });
    }
    const sender = typeof payload.sender === "string" && payload.sender.trim()
      ? payload.sender.trim()
      : "unknown";
    if (this.opts.allowedSenders.length > 0 && !this.opts.allowedSenders.includes(sender)) {
      this.log(`webhook: ignored unauthorized sender ${sender}`);
      return this.reject({ sender, reason: "unauthorized" }, 401, { error: "unauthorized" });
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    const maxLen = this.opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
    if (maxLen > 0 && text.length > maxLen) {
      return this.reject({ sender, reason: "too_long" }, 413, {
        error: `message too long (max ${maxLen} characters)`,
      });
    }
    if (this.isRateLimited(sender)) {
      return this.reject({ sender, reason: "rate_limited" }, 429, {
        error: "too many requests",
        "retry-after": String(Math.ceil((this.opts.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS) / 1000)),
      });
    }
    if (!this.handler || !text.trim()) {
      return Response.json({ reply: null });
    }
    const id = hashId(sender);
    try {
      const reply = await this.handler({
        text,
        chatId: id,
        userId: id,
        username: typeof payload.username === "string" ? payload.username : undefined,
      });
      if (!reply) return Response.json({ reply: null });
      return Response.json(await this.deliverReply(reply));
    } catch (e) {
      this.log(`webhook: handler error: ${(e as Error).message}`);
      return Response.json({ error: "handler failed" }, { status: 500 });
    }
  };

  async send(text: string): Promise<void> {
    await this.postOutbound(text);
  }

  async start(signal: AbortSignal): Promise<void> {
    const path = this.webhookPath();
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
    this.log(`webhook: listening on :${this.port}${path}`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
  }
}
