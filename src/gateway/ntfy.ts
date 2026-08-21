import { ConfigError } from "../config/types";
import { subscribe, type GatewayEvent } from "./events";

/**
 * ntfy push notifications (#149): a lightweight mobile-push outbound target.
 * ntfy is a simple pub/sub service over plain HTTP — POST the message body to a
 * topic URL and subscribers (e.g. the ntfy app on a phone) get a push. This is
 * intentionally simpler than the signed webhooks (#148): the topic URL is the
 * credential, with an optional priority header per event type.
 */

export const DEFAULT_NTFY_PRIORITY = "default";
export const NTFY_PRIORITIES: readonly string[] = [
  "min",
  "low",
  "default",
  "high",
  "urgent",
];

export interface NtfyConfig {
  /** e.g. https://ntfy.sh/mytopic */
  topicUrl: string;
  /** Base priority for all events; overridden by `priorities` per type. */
  priority?: string;
  /** Priority override per event type, e.g. { "job.failed": "high" }. */
  priorities?: Record<string, string>;
}

export function isNtfyPriority(v: unknown): v is string {
  return typeof v === "string" && NTFY_PRIORITIES.includes(v);
}

/** Parse + validate the `events.ntfy` config. Returns null when unset. */
export function parseNtfy(raw: unknown): NtfyConfig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("events.ntfy must be a mapping");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.topicUrl !== "string" || o.topicUrl.trim() === "") {
    throw new ConfigError(
      "events.ntfy `topicUrl` must be a non-empty string (e.g. https://ntfy.sh/mytopic)",
    );
  }
  const cfg: NtfyConfig = { topicUrl: o.topicUrl.trim() };

  const priority = o.priority === undefined || o.priority === null ? undefined : String(o.priority);
  if (priority !== undefined && !isNtfyPriority(priority)) {
    throw new ConfigError(`events.ntfy priority must be one of ${NTFY_PRIORITIES.join(", ")}`);
  }
  if (priority !== undefined) cfg.priority = priority;

  if (o.priorities !== undefined && o.priorities !== null) {
    if (typeof o.priorities !== "object" || Array.isArray(o.priorities)) {
      throw new ConfigError("events.ntfy `priorities` must be a mapping of event type -> priority");
    }
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.priorities as Record<string, unknown>)) {
      if (!isNtfyPriority(v)) {
        throw new ConfigError(
          `events.ntfy priorities[${k}] must be one of ${NTFY_PRIORITIES.join(", ")}`,
        );
      }
      map[k] = v;
    }
    cfg.priorities = map;
  }
  return cfg;
}

/** Compact human-readable push body for a gateway event. */
export function ntfyMessage(ev: GatewayEvent): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "approval.created":
      return `Approval needed: ${p.id} — approve in the Tenjin console`;
    case "approval.resolved":
      return `Approval ${p.status}: ${p.id}`;
    case "job.failed":
      return `Job failed: ${p.name} (${p.bot}): ${p.error ?? "see console"}`;
    case "budget.exceeded":
      return `Budget exceeded: ${p.reason ?? "cap reached"}`;
    case "task.done":
      return `Task ${p.status}: ${p.id}${p.bot ? ` (${p.bot})` : ""}`;
    default:
      return `${ev.type}: ${JSON.stringify(p)}`;
  }
}

/** The priority for a given event, honouring the per-type override. */
export function ntfyPriority(cfg: NtfyConfig, type: string): string {
  return cfg.priorities?.[type] ?? cfg.priority ?? DEFAULT_NTFY_PRIORITY;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST a compact push for `ev` to the ntfy topic. Returns success. ntfy treats
 * the topic URL as the credential — no signing needed; priority is carried in
 * the `Priority` header (ntfy's own convention).
 */
export async function deliverNtfy(
  cfg: NtfyConfig,
  ev: GatewayEvent,
  fetchFn: Fetcher = fetch,
): Promise<boolean> {
  const message = ntfyMessage(ev);
  const priority = ntfyPriority(cfg, ev.type);
  const headers: Record<string, string> = {
    "content-type": "text/plain",
    Title: "Tenjin",
  };
  if (priority !== DEFAULT_NTFY_PRIORITY) headers["Priority"] = priority;
  try {
    const res = await fetchFn(cfg.topicUrl, {
      method: "POST",
      headers,
      body: message,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Subscribe to the gateway event bus and push every event to the ntfy topic. */
export function attachNtfy(cfg: NtfyConfig, opts: { fetch?: Fetcher } = {}): () => void {
  const fetchFn = opts.fetch ?? fetch;
  const off = subscribe((ev) => {
    void deliverNtfy(cfg, ev, fetchFn);
  });
  return () => off();
}
