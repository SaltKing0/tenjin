import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot, botDir } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";
import {
  createAskBotAsyncTool,
  createBotTaskStatusTool,
  listTasks,
  type BotTask,
} from "../src/bots/tasks";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig, ProviderName } from "../src/config/types";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-task-"));
  createBot(home, "researcher", { soul: "You are researcher. Be terse." });
  createBot(home, "writer", { soul: "You are writer." });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const globalConfig = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  budgetUSD: 5,
  approval: {},
  ...over,
});

/** A provider that resolves after `delayMs` ms (0 = instantly). */
function delayedProvider(delayMs: number, reply = "ASYNC ANSWER"): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "async-mock",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
  };
}

/** A provider that only resolves when aborted (for timeout tests). */
function hangProvider(): Provider {
  return {
    name: "hang",
    async chat(_req: ChatRequest, _callbacks?: unknown, signal?: AbortSignal): Promise<ChatResponse> {
      await new Promise<void>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        // never resolves on its own
      });
      return { stopReason: "end_turn", content: [], usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function makeAsyncTool(opts: { provider?: Provider; timeoutMs?: number } = {}) {
  return createAskBotAsyncTool({
    home,
    fromBot: "writer",
    cwd: home,
    getProvider: (_n: ProviderName) => opts.provider ?? delayedProvider(0),
    globalConfig: globalConfig(),
    defaultTimeoutMs: opts.timeoutMs,
  });
}

function makeStatusTool() {
  return createBotTaskStatusTool({ home });
}

const call = (tool: any, name: string, args: any) => dispatch([tool], name, args, { cwd: home });

describe("ask_bot_async", () => {
  test("returns a task id immediately (fire-and-forget) with status pending", async () => {
    const tool = makeAsyncTool({ provider: delayedProvider(50) });
    const r = await call(tool, "ask_bot_async", { bot: "researcher", message: "hello" });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(r.output);
    expect(parsed.task_id).toBeTruthy();
    expect(["pending", "running"]).toContain(parsed.status);
  });

  test("task transitions to done with the result and persists under the target bot", async () => {
    const provider = delayedProvider(20, "ASYNC ANSWER");
    const { settled, task_id, targetBot } = startAsyncForTest(provider);
    const finalTask = await settled;
    expect(finalTask.status).toBe("done");
    expect(finalTask.result).toContain("ASYNC ANSWER");
    expect(finalTask.id).toBe(task_id);

    // persisted under the target bot's tasks dir
    const persisted = listTasks(home, targetBot);
    expect(persisted.some((t) => t.id === task_id)).toBe(true);
  });

  test("task status tool reports the current state, then done", async () => {
    const provider = delayedProvider(30);
    const { settled, task_id } = startAsyncForTest(provider);

    // while running, status is pending/running and no result yet
    const mid = await call(makeStatusTool(), "bot_task_status", { task_id });
    expect(mid.ok).toBe(true);
    const midState = JSON.parse(mid.output);
    expect(midState.status).toMatch(/pending|running/);

    await settled;
    const done = await call(makeStatusTool(), "bot_task_status", { task_id });
    const doneState = JSON.parse(done.output);
    expect(doneState.status).toBe("done");
    expect(doneState.result).toContain("ASYNC ANSWER");
  });

  test("timeout aborts the run and ends the task in error state", async () => {
    const tool = makeAsyncTool({ provider: hangProvider(), timeoutMs: 40 });
    const r = await call(tool, "ask_bot_async", { bot: "researcher", message: "long job" });
    const parsed = JSON.parse(r.output);
    // wait for the task's timeout to elapse
    const final = await waitForStatus(home, "researcher", parsed.task_id, 2000);
    expect(final.status).toBe("error");
    expect(final.error).toMatch(/timeout|abort/i);
  });

  test("unknown bot rejected", async () => {
    const r = await call(makeAsyncTool(), "ask_bot_async", { bot: "ghost", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('unknown bot "ghost"');
  });

  test("self-delegation rejected", async () => {
    const tool = createAskBotAsyncTool({
      home,
      fromBot: "researcher",
      cwd: home,
      getProvider: () => delayedProvider(0),
      globalConfig: globalConfig(),
    });
    const r = await call(tool, "ask_bot_async", { bot: "researcher", message: "x" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("yourself");
  });

  test("empty message rejected", async () => {
    const r = await call(makeAsyncTool(), "ask_bot_async", { bot: "researcher", message: "  " });
    expect(r.ok).toBe(false);
  });

  test("unknown task id reports not found", async () => {
    const r = await call(makeStatusTool(), "bot_task_status", { task_id: "nope-123" });
    expect(r.ok).toBe(false);
    expect(r.output).toContain("unknown task");
  });
});

/* ------------------------------------------------------------------ *
 * Test helpers — reach into the module to start a task and await it,
 * and to poll persisted status when a timeout must elapse.
 * ------------------------------------------------------------------ */

import {
  startAsyncTask,
  readTaskForStatus,
} from "../src/bots/tasks";

function startAsyncForTest(provider: Provider) {
  return startAsyncTask(
    {
      home,
      fromBot: "writer",
      cwd: home,
      getProvider: () => provider,
      globalConfig: globalConfig(),
      defaultTimeoutMs: 5000,
    },
    { targetBot: "researcher", message: "do the thing" },
  );
}

function waitForStatus(
  home: string,
  bot: string,
  taskId: string,
  maxWaitMs: number,
): Promise<BotTask> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const t = readTaskForStatus(home, bot, taskId);
      if (t && t.status !== "pending" && t.status !== "running") return resolve(t);
      if (Date.now() - started > maxWaitMs) return reject(new Error("task never reached terminal state"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
