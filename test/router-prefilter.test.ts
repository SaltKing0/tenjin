import { describe, test, expect } from "bun:test";
import { evaluatePreFilter, buildDecisionLogEntry } from "../src/config/router-prefilter";
import { Router, type RouteCtx } from "../src/config/router";
import type { RouterConfig } from "../src/config/types";
import { ProviderRegistry } from "../src/provider/registry";
import type { Provider, ChatResponse } from "../src/provider/types";

const fakeChat = async (): Promise<ChatResponse> => ({
  stopReason: "end_turn",
  content: [],
  usage: { inputTokens: 0, outputTokens: 0 },
});

describe("B10-2 pre-filter signal routing", () => {
  test("has_images routes to the multimodal (frontier) tier", () => {
    expect(evaluatePreFilter({ has_images: true }).decision).toEqual({ tier: "frontier", signal: "images" });
  });

  test("oversized context routes to the larger-window (frontier) tier", () => {
    expect(evaluatePreFilter({ contextTokens: 300_000 }).decision).toEqual({
      tier: "frontier",
      signal: "context",
    });
  });

  test("tool-heavy turns (count or schema bytes) route to Mid tier", () => {
    expect(evaluatePreFilter({ toolCount: 15 }).decision).toEqual({ tier: "mid", signal: "tools" });
    expect(evaluatePreFilter({ toolSchemaBytes: 50_000 }).decision).toEqual({ tier: "mid", signal: "tools" });
    // just below the thresholds → no tool signal
    expect(evaluatePreFilter({ toolCount: 5, toolSchemaBytes: 1000 }).decision).not.toEqual(
      expect.objectContaining({ signal: "tools" }),
    );
  });

  test("task-type keywords give deterministic tier hints", () => {
    expect(evaluatePreFilter({ taskType: "implement the parser" }).decision).toEqual({
      tier: "frontier",
      signal: "task-type",
    });
    expect(evaluatePreFilter({ taskType: "review the pull request" }).decision).toEqual({
      tier: "mid",
      signal: "task-type",
    });
    expect(evaluatePreFilter({ taskType: "summarize the conversation" }).decision).toEqual({
      tier: "budget",
      signal: "task-type",
    });
    expect(evaluatePreFilter({ taskType: "chat about the weather" }).decision).toEqual({
      tier: "budget",
      signal: "task-type",
    });
  });
});

describe("B10-2 ambiguous fall-through", () => {
  test("no signal firing yields no tier decision (pre-filter never guesses)", () => {
    const res = evaluatePreFilter({});
    expect(res.decision).toBeNull();
    // every signal was evaluated and fell through
    expect(res.evaluations.every((e) => e.tier === null)).toBe(true);
    expect(res.evaluations.map((e) => e.signal)).toEqual(["images", "context", "tools", "task-type"]);
  });

  test("an unrecognised task type falls through, not to a guessed tier", () => {
    expect(evaluatePreFilter({ taskType: "hello there friend" }).decision).toBeNull();
  });
});

describe("B10-2 decision log + no provider call", () => {
  const cfg: RouterConfig = {
    aliases: {
      default: {
        deployments: [
          { provider: "openai", model: "frontier", tier: "frontier" },
          { provider: "openai", model: "mid", tier: "mid" },
          { provider: "openai", model: "budget", tier: "budget" },
        ],
      },
    },
  };

  test("decision log entry carries the triggering signal + routing-decision-id", () => {
    const r = new Router(cfg, { prefilter: true });
    r.select("default", { task_id: "t1", has_images: true });
    expect(r.decisionLog.length).toBe(1);
    const entry = r.decisionLog[0]!;
    expect(entry.signal).toBe("images");
    expect(entry.tier).toBe("frontier");
    expect(entry.task_id).toBe("t1");
    expect(entry.routing_decision_id).toContain("t1");
  });

  test("runPrefilter is pure — it never creates a provider (spy)", () => {
    let created = 0;
    const reg = new ProviderRegistry();
    reg.register({
      name: "spy",
      create: (): Provider => {
        created++;
        return { name: "spy", chat: fakeChat };
      },
    });
    const r = new Router({ ...cfg }, { prefilter: true, registry: reg });
    const res = r.runPrefilter("default", { task_id: "t", has_images: true });
    expect(res.decision?.signal).toBe("images");
    // neither the pre-filter nor select touches the provider layer
    r.select("default", { task_id: "t", has_images: true });
    expect(created).toBe(0);
  });

  test("buildDecisionLogEntry is stable and joinable", () => {
    const e = buildDecisionLogEntry({
      routing_decision_id: "default:t1:1",
      alias: "default",
      decision: { tier: "mid", signal: "tools" },
      task_id: "t1",
    });
    expect(e.signal).toBe("tools");
    expect(e.tier).toBe("mid");
    expect(e.routing_decision_id).toBe("default:t1:1");
  });
});

describe("B10-2 integration with Router.select", () => {
  const cfg: RouterConfig = {
    aliases: {
      default: {
        deployments: [
          { provider: "openai", model: "frontier", tier: "frontier" },
          { provider: "openai", model: "mid", tier: "mid" },
          { provider: "openai", model: "budget", tier: "budget" },
        ],
      },
    },
  };

  test("a fired signal shapes the selected deployment", () => {
    const r = new Router(cfg, { prefilter: true });
    expect(r.select("default", { has_images: true }).model).toBe("frontier");
    expect(r.select("default", { toolCount: 20 }).model).toBe("mid");
    expect(r.select("default", { taskType: "summarize" }).model).toBe("budget");
  });

  test("pre-filter disabled → signals are ignored (plain chain selection)", () => {
    const r = new Router(cfg); // no prefilter option
    expect(r.select("default", { has_images: true }).model).toBe("frontier"); // chain[0]
    expect(r.select("default", { taskType: "summarize" }).model).toBe("frontier"); // chain[0]
    expect(r.decisionLog.length).toBe(0);
  });

  test("fell-through pre-filter leaves the default selection intact", () => {
    const r = new Router(cfg, { prefilter: true });
    expect(r.select("default", { taskType: "unmatched thing" }).model).toBe("frontier"); // chain[0]
  });
});
