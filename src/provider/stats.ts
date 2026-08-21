import type { Provider } from "./types";

/**
 * A provider whose most recent outcome is older than this is no longer reported
 * `up: true` — cached reachability must expire rather than claim a provider is
 * healthy on a 6-hour-old success (#194).
 */
export const PROVIDER_STALE_MS = 10 * 60 * 1000;

/**
 * Per-provider failure/success accounting for observability (#135).
 *
 * The gateway's `ProviderRegistry` wraps every obtained provider with
 * `monitoredProvider`, which reports each chat outcome here. The counters are
 * process-lifetime (a Prometheus-style counter resets on restart, which is
 * expected). Reachability is derived from the *last* outcome: a provider whose
 * most recent chat call succeeded is considered reachable, so `/api/health`
 * can answer without making a live probe on every request ("cached").
 */
export interface ProviderReachability {
  /** Number of failed chat calls for this provider since boot. */
  errors: number;
  /** Epoch ms of the most recent successful call, when any. */
  lastSuccessAtMs?: number;
  /** Epoch ms of the most recent failed call, when any. */
  lastErrorAtMs?: number;
  /**
   * Cached reachability: `true` when the last outcome was a success,
   * `false` when it was a failure, and `null` when we have no data yet.
   */
  up: boolean | null;
}

interface ProviderEntry {
  errors: number;
  lastSuccessAtMs?: number;
  lastErrorAtMs?: number;
  /** The most recent chat outcome. Timestamps alone can tie within one ms. */
  lastOutcome?: "success" | "error";
}

export class ProviderStats {
  private perProvider = new Map<string, ProviderEntry>();
  private totalErrors = 0;

  recordError(provider: string): void {
    this.totalErrors++;
    const e = this.entry(provider);
    e.errors++;
    e.lastErrorAtMs = Date.now();
    e.lastOutcome = "error";
  }

  recordSuccess(provider: string): void {
    const e = this.entry(provider);
    e.lastSuccessAtMs = Date.now();
    e.lastOutcome = "success";
  }

  /** Total failed provider chat calls across all providers since boot. */
  total(): number {
    return this.totalErrors;
  }

  /** Per-provider error counts + cached reachability. */
  reachability(now: number = Date.now()): Record<string, ProviderReachability> {
    const out: Record<string, ProviderReachability> = {};
    for (const [name, e] of this.perProvider) {
      // #194: cached reachability must expire. If the most recent outcome is
      // older than PROVIDER_STALE_MS, report `up: null` (unknown) instead of
      // claiming a success we can no longer trust.
      let up: boolean | null = e.lastOutcome === undefined ? null : e.lastOutcome === "success";
      if (up !== null) {
        const atMs = e.lastOutcome === "success" ? e.lastSuccessAtMs : e.lastErrorAtMs;
        if (atMs !== undefined && now - atMs > PROVIDER_STALE_MS) up = null;
      }
      out[name] = {
        errors: e.errors,
        ...(e.lastSuccessAtMs !== undefined
          ? { lastSuccessAtMs: e.lastSuccessAtMs }
          : {}),
        ...(e.lastErrorAtMs !== undefined
          ? { lastErrorAtMs: e.lastErrorAtMs }
          : {}),
        up,
      };
    }
    return out;
  }

  private entry(provider: string): ProviderEntry {
    let e = this.perProvider.get(provider);
    if (!e) {
      e = { errors: 0 };
      this.perProvider.set(provider, e);
    }
    return e;
  }
}

/**
 * Wrap a provider so its chat outcomes are recorded into `stats`. A failed
 * call (including a non-retryable provider error) is counted and re-thrown; a
 * successful call updates the cached reachability. The wrapper is stateless
 * apart from the shared stats object, so it can be cached like the underlying
 * provider.
 */
export function monitoredProvider(provider: Provider, stats: ProviderStats): Provider {
  return {
    name: provider.name,
    async chat(req, callbacks, signal) {
      try {
        const res = await provider.chat(req, callbacks, signal);
        stats.recordSuccess(provider.name);
        return res;
      } catch (err) {
        stats.recordError(provider.name);
        throw err;
      }
    },
  };
}
