import { createHmac } from "node:crypto";
import { ConfigError } from "../config/types";
import { subscribe, emit, type GatewayEvent } from "./events";

/**
 * Outbound event webhooks (#148): on gateway events (approval.created,
 * approval.resolved, job.failed, budget.exceeded, task.done) POST a signed
 * JSON payload to configured webhook URLs. Signing (HMAC-SHA256) lets the
 * receiver trust the sender; delivery retries with backoff and dead-letters
 * after the final attempt.
 */

export const DEFAULT_WEBHOOK_RETRIES = 3;
export const DEFAULT_WEBHOOK_RETRY_BASE_MS = 500;

export interface WebhookTarget {
  url: string;
  secret: string;
  /** Event types this webhook receives (e.g. ["approval.created", "job.failed"]). */
  events: string[];
  retries?: number;
  retryBaseMs?: number;
}

/** The canonical event types webhooks can subscribe to. */
export const WEBHOOK_EVENT_TYPES: readonly string[] = [
  "approval.created",
  "approval.resolved",
  "job.failed",
  "budget.exceeded",
  "task.done",
];

export function isWebhookTarget(v: unknown): v is WebhookTarget {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.url === "string" &&
    o.url.length > 0 &&
    typeof o.secret === "string" &&
    Array.isArray(o.events) &&
    o.events.every((e) => typeof e === "string")
  );
}

/** Parse + validate the `events.webhooks` config list. */
export function parseWebhooks(raw: unknown): WebhookTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError("events.webhooks must be a list");
  }
  const out: WebhookTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError("each events.webhooks entry must be a mapping { url, secret, events }");
    }
    const o = item as Record<string, unknown>;
    if (typeof o.url !== "string" || o.url.length === 0) {
      throw new ConfigError("events.webhooks entry missing string `url`");
    }
    if (typeof o.secret !== "string" || o.secret.length === 0) {
      throw new ConfigError("events.webhooks entry missing string `secret`");
    }
    if (!Array.isArray(o.events) || o.events.some((e) => typeof e !== "string")) {
      throw new ConfigError("events.webhooks entry `events` must be a list of strings");
    }
    const unknown = (o.events as string[]).filter((e) => !WEBHOOK_EVENT_TYPES.includes(e));
    if (unknown.length > 0) {
      throw new ConfigError(
        `events.webhooks entry subscribes to unknown event(s): ${unknown.join(", ")} ` +
          `(known: ${WEBHOOK_EVENT_TYPES.join(", ")})`,
      );
    }
    const target: WebhookTarget = {
      url: o.url,
      secret: o.secret,
      events: [...new Set(o.events as string[])],
    };
    if (o.retries !== undefined) {
      if (typeof o.retries !== "number" || !Number.isInteger(o.retries) || o.retries < 1) {
        throw new ConfigError("events.webhooks entry `retries` must be a positive integer");
      }
      target.retries = o.retries;
    }
    if (o.retryBaseMs !== undefined) {
      if (typeof o.retryBaseMs !== "number" || o.retryBaseMs < 0) {
        throw new ConfigError("events.webhooks entry `retryBaseMs` must be a number >= 0");
      }
      target.retryBaseMs = o.retryBaseMs;
    }
    out.push(target);
  }
  return out;
}

/** Whether a target receives a given event type. */
export function targetWants(target: WebhookTarget, type: string): boolean {
  return target.events.includes(type);
}

/** HMAC-SHA256 signature over the raw body, hex-encoded. */
export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  dead: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

async function postOnce(url: string, body: string, signature: string, fetchFn: Fetcher): Promise<boolean> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenjin-signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Deliver one event to one target. Retries with exponential backoff
 * (retryBaseMs * 2^attempt), dead-letters after the final attempt.
 */
export async function deliver(
  target: WebhookTarget,
  ev: GatewayEvent,
  fetchFn: Fetcher = fetch,
): Promise<DeliveryResult> {
  const body = JSON.stringify({ id: ev.id, type: ev.type, ts: ev.ts, payload: ev.payload });
  const signature = signPayload(target.secret, body);
  const max = target.retries ?? DEFAULT_WEBHOOK_RETRIES;
  const baseMs = target.retryBaseMs ?? DEFAULT_WEBHOOK_RETRY_BASE_MS;
  for (let i = 0; i < max; i++) {
    const ok = await postOnce(target.url, body, signature, fetchFn);
    if (ok) return { ok: true, attempts: i + 1, dead: false };
    if (i < max - 1) await sleep(baseMs * 2 ** i);
  }
  return { ok: false, attempts: max, dead: true };
}

export interface AttachHooksOpts {
  fetch?: Fetcher;
  /** Called on each delivery result (e.g. to surface dead-letters as audit). */
  onResult?: (target: WebhookTarget, ev: GatewayEvent, r: DeliveryResult) => void;
}

/**
 * Subscribe to the gateway event bus and forward matching events to webhooks.
 * Returns an unsubscribe function. Dead-letters re-emit a `webhook.dead_letter`
 * event so operators see delivery failures.
 */
export function attachWebhooks(targets: WebhookTarget[], opts: AttachHooksOpts = {}): () => void {
  const fetchFn = opts.fetch ?? fetch;
  const off = subscribe((ev) => {
    for (const target of targets) {
      if (!targetWants(target, ev.type)) continue;
      void deliver(target, ev, fetchFn).then((r) => {
        opts.onResult?.(target, ev, r);
        if (r.dead) {
          emit("webhook.dead_letter", { target: target.url, type: ev.type, attempts: r.attempts });
        }
      });
    }
  });
  return () => off();
}

/** Refused-to-parse helper typing (kept for a clean import in tests). */
