/**
 * Routing core (Roadmap §13 B10-1/B10-4, #402).
 *
 * SINGLE-PATH LAW (§20 #45): this is the ONLY routing logic in the harness —
 * B14-5's privacy axis plugs in here later, never beside it. Everything a task
 * needs to reach a model goes through {@link Router}.
 *
 *   - Tiers Frontier / Mid / Budget map to NAMED ALIASES via a deterministic
 *     `tasks` table in config (a debuggable plain-object table, no magic).
 *     The Budget tier hosts the helper utilities (B2-5, B9-3 consolidation).
 *   - Each alias is a failover CHAIN of deployments, tried in array order.
 *   - `select(alias, RouteCtx)` returns the deployment to use: stickiness pins
 *     one provider+model per session/task (prompt-cache protection per B2-1);
 *     arena mode and image-bearing turns route per-turn instead.
 *   - `withFailover` walks the chain: retryable errors (per B3-9 #371
 *     `classifyError`) back off and retry the same deployment; non-retryable
 *     errors move to the next deployment; exhaustion dead-letters.
 *
 * Providers are created lazily through an injectable `ProviderRegistry` (the
 * runtime-extensible BYOM hook) — the router never constructs one itself.
 */

import { classifyError } from "../provider/retry";
import type { ProviderRegistry } from "../provider/registry";
import type { Provider } from "../provider/types";
import { ConfigError, type ModelTier, type RouterConfig, type DeploymentConfig } from "./types";

/** Per-call context influencing routing decisions. */
export interface RouteCtx {
  task_id?: string;
  session_id?: string;
  has_images?: boolean;
  /** Remaining budget in USD; a low budget prefers the Budget tier. */
  budget?: number;
  /** Arena mode: per-turn routing, fresh arms, no stickiness. */
  arena_mode?: boolean;
}

/** A resolved, runnable deployment — what `select` returns. */
export interface Deployment {
  provider_id: string;
  model: string;
  options?: Record<string, unknown>;
  base_url?: string;
  key?: string;
  priority?: number;
  tags?: string[];
  tier?: ModelTier;
}

/** A routing-layer failure (unknown alias / empty chain / no registry). */
export class RouterError extends Error {}

/** All deployments in a failover chain failed (exhaustion). */
export class DeadLetterError extends RouterError {
  constructor(
    alias: string,
    readonly attempts: Array<{ deployment: Deployment; error: unknown }>,
  ) {
    super(
      `all deployments failed for alias "${alias}" (${attempts.length} attempt(s) dead-lettered)`,
    );
    this.name = "DeadLetterError";
  }
}

export interface RouterOptions {
  /** Injectable clock for stickiness TTL tests. */
  now?: () => number;
  /** Injectable sleep for failover backoff tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable backoff delay (ms) given the retry attempt (1-based). */
  backoff?: (attempt: number) => number;
  /** Retry attempts on a deployment before failing over. Default 2. */
  retriesPerDeployment?: number;
  /** Stickiness TTL in ms. Default 60_000. */
  ttlMs?: number;
  /** Registry that lazily creates providers (BYOM hook). */
  registry?: ProviderRegistry;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RETRIES = 2;
/** RouteCtx.budget below this (USD) prefers a Budget-tier deployment. */
const BUDGET_FLOOR_USD = 0.1;

interface StickinessPin {
  dep: Deployment;
  at: number;
}

function normalizeDeployment(d: DeploymentConfig): Deployment {
  return {
    provider_id: d.provider,
    model: d.model,
    options: d.options,
    base_url: d.baseUrl,
    key: d.key,
    priority: d.priority,
    tags: d.tags,
    tier: d.tier,
  };
}

function sameDeployment(a: Deployment, b: Deployment): boolean {
  return a.provider_id === b.provider_id && a.model === b.model;
}

/** Best-effort HTTP status from a thrown provider error, if it carries one. */
function httpStatus(e: unknown): number | undefined {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export class Router {
  private readonly aliases: Map<string, Deployment[]>;
  private readonly tasks: Map<string, string>;
  private readonly sticky = new Map<string, StickinessPin>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly backoff: (attempt: number) => number;
  private readonly retriesPerDeployment: number;
  private readonly ttlMs: number;
  private readonly registry?: ProviderRegistry;

  constructor(cfg: RouterConfig, opts: RouterOptions = {}) {
    this.aliases = new Map();
    for (const [name, alias] of Object.entries(cfg.aliases ?? {})) {
      if (!alias || !Array.isArray(alias.deployments) || alias.deployments.length === 0) {
        throw new RouterError(`alias "${name}" must define a non-empty deployments chain`);
      }
      this.aliases.set(name, alias.deployments.map(normalizeDeployment));
    }
    this.tasks = new Map(Object.entries(cfg.tasks ?? {}));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.backoff = opts.backoff ?? ((attempt) => 100 * Math.pow(2, attempt - 1));
    this.retriesPerDeployment = opts.retriesPerDeployment ?? cfg.retriesPerDeployment ?? DEFAULT_RETRIES;
    this.ttlMs = opts.ttlMs ?? cfg.stickyTtlMs ?? DEFAULT_TTL_MS;
    this.registry = opts.registry;
  }

  /** Deterministic task_id → alias-name resolution. Unknown task is a clean error. */
  resolveTask(taskId: string): string {
    const alias = this.tasks.get(taskId);
    if (alias === undefined) {
      throw new RouterError(`no route for task "${taskId}" (known tasks: ${[...this.tasks.keys()].join(", ") || "none"})`);
    }
    return alias;
  }

  /** The failover chain (in configured order) for an alias. Unknown alias errors. */
  aliasChain(alias: string): Deployment[] {
    const chain = this.aliases.get(alias);
    if (!chain) {
      throw new ConfigError(`unknown routing alias "${alias}" (aliases: ${[...this.aliases.keys()].join(", ") || "none"})`);
    }
    return chain;
  }

  /** The deployment a task should use, given the per-call context. */
  selectForTask(taskId: string, ctx: RouteCtx = {}): Deployment {
    return this.select(this.resolveTask(taskId), ctx);
  }

  /**
   * Select the deployment for an alias. Deterministic: the chain's configured
   * order wins; stickiness pins one provider+model per session/task within the
   * TTL (prompt-cache protection). Arena mode and image-bearing turns bypass
   * stickiness and route per-turn.
   */
  select(alias: string, ctx: RouteCtx = {}): Deployment {
    const chain = this.aliasChain(alias);
    const stickyKey = !ctx.arena_mode && !ctx.has_images ? (ctx.session_id ?? ctx.task_id) : undefined;
    if (stickyKey) {
      const pin = this.sticky.get(stickyKey);
      if (pin && this.now() - pin.at < this.ttlMs && chain.some((d) => sameDeployment(d, pin.dep))) {
        return pin.dep;
      }
    }
    const dep = chooseForCtx(chain, ctx);
    if (stickyKey) this.sticky.set(stickyKey, { dep, at: this.now() });
    return dep;
  }

  /**
   * Run `call(deployment)` across the failover chain. A retryable error (per
   * B3-9 classifyError) backs off and retries the same deployment; a
   * non-retryable error moves to the next deployment; exhaustion dead-letters.
   */
  async withFailover<T>(
    alias: string,
    ctx: RouteCtx,
    call: (deployment: Deployment) => Promise<T>,
  ): Promise<T> {
    const chain = this.aliasChain(alias);
    const attempts: Array<{ deployment: Deployment; error: unknown }> = [];
    for (const dep of chain) {
      let attempt = 0;
      while (attempt < this.retriesPerDeployment) {
        attempt++;
        try {
          return await call(dep);
        } catch (e) {
          const decision = classifyError(e, httpStatus(e));
          if (decision.retry && attempt < this.retriesPerDeployment) {
            await this.sleep(this.backoff(attempt));
            continue;
          }
          // Non-retryable, or retries exhausted → fail over to the next hop.
          attempts.push({ deployment: dep, error: e });
          break;
        }
      }
    }
    throw new DeadLetterError(alias, attempts);
  }

  /** Lazily create (or fetch from cache) the provider behind a deployment. */
  providerFor(dep: Deployment): Provider {
    if (!this.registry) {
      throw new RouterError(`no provider registry configured on this router`);
    }
    return this.registry.get(dep.provider_id);
  }

  /** Forget stickiness pins (called after a provider/model change, or in tests). */
  clearStickiness(): void {
    this.sticky.clear();
  }
}

/**
 * Pick the deployment for a fresh selection. Defaults to the chain's first
 * deployment; a low remaining budget prefers a Budget-tier deployment when one
 * is present (the helper-utility tier).
 */
function chooseForCtx(chain: Deployment[], ctx: RouteCtx): Deployment {
  const head = chain[0];
  if (!head) throw new RouterError("alias chain is empty");
  if (ctx.budget !== undefined && ctx.budget < BUDGET_FLOOR_USD) {
    const budgetDep = chain.find((d) => d.tier === "budget" || d.tags?.includes("budget"));
    if (budgetDep) return budgetDep;
  }
  return head;
}
