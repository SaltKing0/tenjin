import { describe, test, expect } from "bun:test";
import {
  Router,
  RouterError,
  DeadLetterError,
  type Deployment,
} from "../src/config/router";
import { ConfigError, type DeploymentConfig, type HarnessConfig, type RouterConfig } from "../src/config/types";
import { validateConfig } from "../src/config/loader";
import { ProviderRegistry } from "../src/provider/registry";
import type { Provider, ChatResponse } from "../src/provider/types";

function retryableErr(): Error {
  const e = new Error("rate limited (transient)");
  (e as { status?: number }).status = 429;
  return e;
}
function nonRetryableErr(): Error {
  const e = new Error("bad request (permanent)");
  (e as { status?: number }).status = 400;
  return e;
}

function baseCfg(): RouterConfig {
  return {
    aliases: {
      default: {
        deployments: [
          { provider: "openai", model: "frontier", tier: "frontier" },
          { provider: "openai", model: "budget", tier: "budget" },
        ],
      },
      single: { deployments: [{ provider: "openai", model: "only" }] },
    },
    tasks: { code: "default", helper: "single" },
  };
}

describe("B10-1/B10-4 alias resolution", () => {
  test("task→alias resolution is deterministic; unknown task errors cleanly", () => {
    const r = new Router(baseCfg());
    expect(r.resolveTask("code")).toBe("default");
    expect(r.resolveTask("helper")).toBe("single");
    expect(r.selectForTask("code", {}).model).toBe("frontier");
    expect(() => r.resolveTask("nope")).toThrow(RouterError);
    expect(() => r.resolveTask("nope")).toThrow(/no route for task/);
  });

  test("unknown alias is a clean ConfigError listing known aliases", () => {
    const r = new Router(baseCfg());
    expect(() => r.select("nope", {})).toThrow(ConfigError);
    expect(() => r.select("nope", {})).toThrow(/unknown routing alias/);
  });

  test("selection is deterministic across runs and routers", () => {
    const a = new Router(baseCfg());
    const b = new Router(baseCfg());
    const ca = a.aliasChain("default");
    const cb = b.aliasChain("default");
    expect(ca.map((d) => d.model)).toEqual(cb.map((d) => d.model));
    expect(a.select("default", { task_id: "t" }).provider_id).toBe("openai");
    expect(b.select("default", { task_id: "t" }).provider_id).toBe("openai");
  });

  test("an alias with an empty chain is rejected at construction", () => {
    expect(() => new Router({ aliases: { bad: { deployments: [] } } })).toThrow(
      /non-empty deployments chain/,
    );
  });
});

describe("B10-1/B10-4 failover", () => {
  test("retryable error retries same deployment; non-retryable fails over to the next", async () => {
    const r = new Router(
      { aliases: { a: { deployments: [{ provider: "openai", model: "m1" }, { provider: "openai", model: "m2" }] } } },
      { retriesPerDeployment: 2, sleep: async () => {}, backoff: () => 1 },
    );
    const calls: string[] = [];
    let n = 0;
    const res = await r.withFailover("a", {}, async (dep) => {
      calls.push(dep.model);
      n++;
      if (dep.model === "m1") {
        if (n === 1) throw retryableErr(); // attempt 1 → retry
        throw nonRetryableErr(); // attempt 2 → fail over
      }
      return `ok-${dep.model}`;
    });
    expect(res).toBe("ok-m2");
    expect(calls).toEqual(["m1", "m1", "m2"]);
  });

  test("exhaustion dead-letters with a clean RouterError subclass", async () => {
    const r = new Router(
      { aliases: { a: { deployments: [{ provider: "openai", model: "m1" }, { provider: "openai", model: "m2" }] } } },
      { retriesPerDeployment: 1, sleep: async () => {} },
    );
    const err = await r
      .withFailover("a", {}, async () => {
        throw retryableErr();
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(DeadLetterError);
    expect(err).toBeInstanceOf(RouterError);
    expect((err as DeadLetterError).message).toContain("dead-lettered");
    // both deployments were attempted
    expect((err as DeadLetterError).attempts.length).toBe(2);
  });

  test("a single success short-circuits the chain", async () => {
    const r = new Router(
      { aliases: { a: { deployments: [{ provider: "openai", model: "m1" }] } } },
      { retriesPerDeployment: 3, sleep: async () => {} },
    );
    await expect(r.withFailover("a", {}, async () => "done")).resolves.toBe("done");
  });
});

describe("B10-1/B10-4 stickiness", () => {
  const ttlMs = 1000;

  test("same session returns the same deployment within TTL; TTL expiry re-selects", () => {
    let t = 0;
    const r = new Router(baseCfg(), { now: () => t, ttlMs });
    // high budget selects frontier and pins it for s1
    expect(r.select("default", { session_id: "s1", budget: 0.5 }).model).toBe("frontier");
    // within TTL a low budget still returns the pinned frontier (stickiness wins)
    expect(r.select("default", { session_id: "s1", budget: 0.01 }).model).toBe("frontier");
    // expire the pin → re-select honours the low budget → budget tier
    t = ttlMs + 1;
    expect(r.select("default", { session_id: "s1", budget: 0.01 }).model).toBe("budget");
  });

  test("different sessions do not share a sticky pin", () => {
    let t = 0;
    const r = new Router(baseCfg(), { now: () => t, ttlMs });
    expect(r.select("default", { session_id: "s1", budget: 0.5 }).model).toBe("frontier");
    // a fresh session with low budget is not bound by s1's pin
    expect(r.select("default", { session_id: "s2", budget: 0.01 }).model).toBe("budget");
  });
});

describe("B10-1/B10-4 arena mode + per-turn routing", () => {
  test("arena mode bypasses stickiness and routes fresh each turn", () => {
    let t = 0;
    const r = new Router(baseCfg(), { now: () => t, ttlMs: 1000 });
    // pin frontier for s1 in the normal path
    expect(r.select("default", { session_id: "s1", budget: 0.5 }).model).toBe("frontier");
    // arena mode ignores the pin and the low budget → fresh budget selection
    expect(r.select("default", { session_id: "s1", budget: 0.01, arena_mode: true }).model).toBe("budget");
    // the arena turn did not overwrite the normal path's pin
    expect(r.select("default", { session_id: "s1", budget: 0.01 }).model).toBe("frontier");
  });

  test("image-bearing turns route per-turn (no stickiness)", () => {
    let t = 0;
    const r = new Router(baseCfg(), { now: () => t, ttlMs: 1000 });
    expect(r.select("default", { session_id: "s1", budget: 0.5, has_images: true }).model).toBe("frontier");
    // no pin is written for the image turn
    expect(r.select("default", { session_id: "s1", budget: 0.01, has_images: true }).model).toBe("budget");
  });
});

describe("B10-1/B10-4 budget tier + BYOM registry", () => {
  test("low remaining budget prefers the Budget tier", () => {
    const r = new Router(baseCfg());
    expect(r.select("default", { budget: 0.5 }).model).toBe("frontier");
    expect(r.select("default", { budget: 0.01 }).model).toBe("budget");
  });

  test("providerFor lazily resolves a registered BYOM factory through the registry", () => {
    const fakeChat = async (): Promise<ChatResponse> => ({
      stopReason: "end_turn",
      content: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const reg = new ProviderRegistry();
    reg.register({
      name: "byom",
      create: (): Provider => ({ name: "byom", chat: fakeChat }),
    });
    const r = new Router(
      { aliases: { a: { deployments: [{ provider: "byom", model: "x" }] } } },
      { registry: reg },
    );
    const dep: Deployment = r.aliasChain("a")[0]!;
    expect(r.providerFor(dep).name).toBe("byom");
    // unknown provider id errors cleanly
    const bad: Deployment = { provider_id: "nope", model: "x" };
    expect(() => r.providerFor(bad)).toThrow(/unknown provider/);
  });

  test("providerFor without a registry is a clean RouterError", () => {
    const r = new Router(baseCfg());
    const dep: Deployment = r.aliasChain("default")[0]!;
    expect(() => r.providerFor(dep)).toThrow(RouterError);
    expect(() => r.providerFor(dep)).toThrow(/no provider registry/);
  });
});

describe("B10-1/B10-4 routing config validation", () => {
  const base: HarnessConfig = {
    provider: "openai",
    model: "gpt-4o",
    maxTokens: 1024,
    budgetUSD: 5,
    approval: {},
  };

  test("a well-formed routing section validates", () => {
    expect(() =>
      validateConfig({
        ...base,
        routing: {
          aliases: { a: { deployments: [{ provider: "openai", model: "gpt-4o", tier: "frontier" }] } },
          tasks: { code: "a" },
          stickyTtlMs: 5000,
          retriesPerDeployment: 2,
        },
      }),
    ).not.toThrow();
  });

  test("an empty deployments chain is rejected", () => {
    expect(() => validateConfig({ ...base, routing: { aliases: { a: { deployments: [] } } } })).toThrow(
      /must not be empty/,
    );
  });

  test("a deployment missing model is rejected", () => {
    const dep = { provider: "openai" } as DeploymentConfig;
    expect(() =>
      validateConfig({ ...base, routing: { aliases: { a: { deployments: [dep] } } } }),
    ).toThrow(/model must be a non-empty string/);
  });

  test("a non-positive retriesPerDeployment is rejected", () => {
    expect(() => validateConfig({ ...base, routing: { retriesPerDeployment: 0 } })).toThrow(/>= 1/);
  });

  test("routing.default naming an existing alias validates", () => {
    expect(() =>
      validateConfig({
        ...base,
        routing: { default: "a", aliases: { a: { deployments: [{ provider: "openai", model: "gpt-4o" }] } } },
      }),
    ).not.toThrow();
  });

  test("routing.default naming a missing alias is rejected", () => {
    expect(() =>
      validateConfig({
        ...base,
        routing: { default: "nope", aliases: { a: { deployments: [{ provider: "openai", model: "gpt-4o" }] } } },
      }),
    ).toThrow(/routing.default "nope" must name an existing alias/);
  });
});

