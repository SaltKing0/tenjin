import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effortLimits,
  isEffortLevel,
  EFFORT_LEVELS,
  EFFORT_DEFAULT_MAX_ITERATIONS,
} from "../src/agent/effort";
import { runHeadless } from "../src/agent/headless";
import { createBot, botDir, resolveBot } from "../src/bots/profile";
import { startAsyncTask, type AsyncTaskDeps } from "../src/bots/tasks";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";

describe("effortLimits", () => {
  test("low caps iterations, halves tokens, forces read-only", () => {
    const l = effortLimits("low", 1000);
    expect(l.maxIterations).toBe(3);
    expect(l.maxTokens).toBe(500);
    expect(l.toolPolicy).toBe("read-only");
  });

  test("medium is the baseline", () => {
    const m = effortLimits("medium", 1000);
    expect(m.maxIterations).toBe(EFFORT_DEFAULT_MAX_ITERATIONS);
    expect(m.maxTokens).toBe(1000);
    expect(m.toolPolicy).toBeUndefined();
  });

  test("high and max scale iterations and tokens", () => {
    const h = effortLimits("high", 1000);
    expect(h.maxIterations).toBe(75);
    expect(h.maxTokens).toBe(3000);
    const x = effortLimits("max", 1000);
    expect(x.maxIterations).toBe(200);
    expect(x.maxTokens).toBe(6000);
  });

  test("undefined / unknown defaults to medium", () => {
    expect(effortLimits(undefined, 800)).toEqual(effortLimits("medium", 800));
  });

  test("isEffortLevel validates the four levels", () => {
    for (const l of EFFORT_LEVELS) expect(isEffortLevel(l)).toBe(true);
    expect(isEffortLevel("ultra")).toBe(false);
    expect(isEffortLevel(42)).toBe(false);
  });
});

describe("effort affects a run", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tj-effort-"));
    createBot(home, "researcher", { soul: "You are researcher." });
    createBot(home, "writer", { soul: "You are writer." });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** Provider that always asks to read a file, forcing iteration until the cap. */
  function loopingProvider(): Provider & { calls: ChatRequest[] } {
    const calls: ChatRequest[] = [];
    return {
      name: "loop",
      calls,
      async chat(req: ChatRequest): Promise<ChatResponse> {
        calls.push(req);
        return {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `t${calls.length}`,
              name: "read_file",
              input: { path: join(import.meta.dir, "effort.test.ts") },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
  }

  function instant(reply = "DONE"): Provider {
    return {
      name: "instant",
      async chat(): Promise<ChatResponse> {
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: reply }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
  }

  function depsForTask(provider: Provider): AsyncTaskDeps {
    const globalConfig: HarnessConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      maxTokens: 256,
      budgetUSD: 1,
      approval: {},
    };
    return {
      home,
      fromBot: "writer",
      cwd: home,
      getProvider: (_n: ProviderName) => provider,
      globalConfig,
      defaultTimeoutMs: 3000,
    };
  }

  function sessionEffort(h: string, bot: string): string | undefined {
    const dir = join(botDir(h, bot), "sessions");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
    if (!file) return undefined;
    const start = JSON.parse(readFileSync(join(dir, file), "utf8").split("\n")[0]!);
    return start.effort;
  }

  test("low breaks earlier than high on the same task", async () => {
    const lowP = loopingProvider();
    const low = await runHeadless({
      provider: lowP,
      model: "m",
      soulText: "",
      cwd: import.meta.dir,
      message: "read stuff",
      maxTokens: 1000,
      capUSD: 10,
      policy: "full",
      effort: "low",
    });
    expect(low.stopReason).toBe("max_iterations");
    expect(lowP.calls.length).toBe(3);

    const highP = loopingProvider();
    const high = await runHeadless({
      provider: highP,
      model: "m",
      soulText: "",
      cwd: import.meta.dir,
      message: "read stuff",
      maxTokens: 1000,
      capUSD: 10,
      policy: "full",
      effort: "high",
    });
    expect(high.stopReason).toBe("max_iterations");
    expect(highP.calls.length).toBe(75);
    expect(lowP.calls.length).toBeLessThan(highP.calls.length);
  });

  test("session_start event carries the effort level", async () => {
    const res = await runHeadless({
      provider: instant(),
      model: "m",
      soulText: "",
      cwd: home,
      message: "hi",
      maxTokens: 100,
      capUSD: 1,
      home,
      sessionLogDir: join(botDir(home, "researcher"), "sessions"),
      sessionBot: "researcher",
      effort: "high",
    });
    expect(res.text).toContain("DONE");

    const dir = join(botDir(home, "researcher"), "sessions");
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const start = JSON.parse(readFileSync(join(dir, file), "utf8").split("\n")[0]!);
    expect(start.t).toBe("session_start");
    expect(start.effort).toBe("high");
  });

  test("a task effort overrides the bot's configured effort", async () => {
    writeFileSync(join(botDir(home, "researcher"), "config.yaml"), "effort: low\n");
    const run = startAsyncTask(depsForTask(instant("X")), {
      targetBot: "researcher",
      message: "do it",
      effort: "high",
    });
    const final = await run.settled;
    expect(final.status).toBe("done");
    expect(sessionEffort(home, "researcher")).toBe("high");
  });

  test("without a task effort, the bot's configured effort is used", async () => {
    writeFileSync(join(botDir(home, "researcher"), "config.yaml"), "effort: low\n");
    const run = startAsyncTask(depsForTask(instant("X")), {
      targetBot: "researcher",
      message: "do it",
    });
    const final = await run.settled;
    expect(final.status).toBe("done");
    expect(sessionEffort(home, "researcher")).toBe("low");
  });

  test("an invalid bot effort is rejected at parse time", () => {
    writeFileSync(join(botDir(home, "researcher"), "config.yaml"), "effort: ultra\n");
    expect(() => resolveBot(home, "researcher")).toThrow(/effort/);
  });
});
