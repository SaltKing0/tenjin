import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot, botDir } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";
import {
  createAskBotAsyncTool,
  createBotTaskStatusTool,
  listTasks,
  startAsyncTask,
  readTaskForStatus,
  writeTask,
  findTaskById,
  type BotTask,
  type AsyncTaskDeps,
} from "../src/bots/tasks";
import { listMessages } from "../src/bots/inbox";
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
 * Delegation chains (#128): dependsOn, notifyBot, cycle rejection,
 * dependency-timeout cascade.
 * ------------------------------------------------------------------ */

function deps(provider: Provider, over: Partial<AsyncTaskDeps> = {}): AsyncTaskDeps {
  return {
    home,
    fromBot: "writer",
    cwd: home,
    getProvider: () => provider,
    globalConfig: globalConfig(),
    defaultTimeoutMs: 5000,
    ...over,
  };
}

/** Provider that records every request and answers with a fixed reply. */
function capturingProvider(reply: string): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    name: "capture",
    requests,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      requests.push(req);
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

/**
 * Provider that resolves after `delayMs` but aborts (rejects) if the abort
 * signal fires first — like a real provider that honors the signal. Used to
 * prove the dependent's run actually gets its full budget after the wait.
 */
function abortableDelayed(delayMs: number, reply: string): Provider {
  return {
    name: "abortable",
    async chat(_req: ChatRequest, _callbacks?: unknown, signal?: AbortSignal): Promise<ChatResponse> {
      return await new Promise<ChatResponse>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({
              stopReason: "end_turn",
              content: [{ type: "text", text: reply }],
              usage: { inputTokens: 1, outputTokens: 1 },
            }),
          delayMs,
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    },
  };
}

describe("delegation chains", () => {
  test("dependsOn waits for the dependency and injects its result into the prompt", async () => {
    const dep = startAsyncTask(deps(delayedProvider(0, "RESULT_A")), {
      targetBot: "researcher",
      message: "step A",
    });
    const depFinal = await dep.settled;
    expect(depFinal.status).toBe("done");
    expect(depFinal.result).toContain("RESULT_A");

    const capture = capturingProvider("CHAIN_ANSWER");
    const chain = startAsyncTask(deps(capture), {
      targetBot: "researcher",
      message: "step B",
      dependsOn: dep.task_id,
    });
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("done");
    expect(chainFinal.result).toContain("CHAIN_ANSWER");

    // the dependency's result was placed into the dependent's prompt
    const userMsg = capture.requests[0]?.messages[0]?.content;
    expect(String(userMsg)).toContain("RESULT_A");
    expect(String(userMsg)).toContain("step B");
  });

  test("a huge dependency result is capped in the successor's prompt (#176)", async () => {
    const big = "X".repeat(10000);
    const dep = startAsyncTask(deps(delayedProvider(0, big)), {
      targetBot: "researcher",
      message: "produce big result",
    });
    const depFinal = await dep.settled;
    expect(depFinal.status).toBe("done");
    expect(depFinal.result!.length).toBeGreaterThan(4000);

    const capture = capturingProvider("OK");
    const chain = startAsyncTask(deps(capture), {
      targetBot: "researcher",
      message: "step B",
      dependsOn: dep.task_id,
    });
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("done");

    const userMsg = String(capture.requests[0]?.messages[0]?.content ?? "");
    expect(userMsg).toContain("step B");
    // result is capped and the full text is referenced for retrieval
    expect(userMsg).not.toContain("X".repeat(4001));
    expect(userMsg.length).toBeLessThan(9000);
    expect(userMsg).toMatch(/bot_task_status|truncated/i);
  });

  test("a cycle is rejected at creation", () => {
    // Fabricate two persisted tasks that reference each other via dependsOn.
    const base = {
      bot: "researcher",
      message: "x",
      status: "pending" as const,
      timeoutMs: 1000,
      createdAt: new Date().toISOString(),
    };
    writeTask(home, "researcher", { ...base, id: "T1", dependsOn: "T2" });
    writeTask(home, "researcher", { ...base, id: "T2", dependsOn: "T1" });

    expect(() =>
      startAsyncTask(deps(delayedProvider(0, "x")), {
        targetBot: "researcher",
        message: "m",
        dependsOn: "T1",
      }),
    ).toThrow(/circular dependency/);
  });

  test("an unknown dependency is rejected", () => {
    expect(() =>
      startAsyncTask(deps(delayedProvider(0, "x")), {
        targetBot: "researcher",
        message: "m",
        dependsOn: "does-not-exist",
      }),
    ).toThrow(/unknown dependency/);
  });

  test("a dependency timeout cascades to the dependent task", async () => {
    // dependency hangs and times out on its own
    const dep = startAsyncTask(deps(hangProvider(), { defaultTimeoutMs: 30 }), {
      targetBot: "researcher",
      message: "never finishes",
      timeoutMs: 30,
    });
    const depFinal = await dep.settled;
    expect(depFinal.status).toBe("error");

    // dependent sees the failed dependency and fails instead of running
    const chain = startAsyncTask(deps(delayedProvider(0, "SHOULD NOT RUN")), {
      targetBot: "researcher",
      message: "after dep",
      dependsOn: dep.task_id,
    });
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("error");
    expect(chainFinal.error).toMatch(/dependency/);
  });

  // #182: the wait phase and the run phase are budgeted separately — the run
  // gets its own full budget after a slow dependency finally resolves, instead
  // of whatever remained of a single shared deadline.
  test("slow dependency + short run — the run gets its own full budget", async () => {
    // Dependency resolves in ~20ms, but the dependent polls every DEP_POLL_MS
    // (100ms), so the wait phase visibly consumes ~100ms of a 200ms budget. The
    // run then needs (and must get) its own ~150ms — a total that would exceed
    // the old single 200ms deadline and abort the run in flight.
    const dep = startAsyncTask(deps(delayedProvider(20, "SLOW_RESULT")), {
      targetBot: "researcher",
      message: "slow dep",
    });
    const chain = startAsyncTask(deps(abortableDelayed(150, "FULL_RUN")), {
      targetBot: "researcher",
      message: "after slow dep",
      dependsOn: dep.task_id,
      timeoutMs: 200,
    });
    // Old single-deadline behaviour: wait(~100) + run(~150) = ~250 > 200 would
    // abort the run (its provider honors the signal); the fix gives the run a
    // fresh 200ms budget so it completes.
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("done");
    expect(chainFinal.result).toContain("FULL_RUN");
    expect(chainFinal.error).toBeUndefined();
  });

  // #182: the run-phase timeout error is distinct from a dependency-wait timeout.
  test("run-phase timeout reports 'timeout during run'", async () => {
    // Dependency completes instantly so the task reaches the run phase, then the
    // provider hangs and the run-phase budget trips.
    const dep = startAsyncTask(deps(delayedProvider(0, "OK")), {
      targetBot: "researcher",
      message: "quick dep",
    });
    await dep.settled;
    const chain = startAsyncTask(deps(hangProvider(), { defaultTimeoutMs: 30 }), {
      targetBot: "researcher",
      message: "hangs in run",
      dependsOn: dep.task_id,
      timeoutMs: 30,
    });
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("error");
    expect(chainFinal.error).toMatch(/timeout during run/);
  });

  // #182: the dependency-wait timeout error is distinct from a run timeout.
  test("dependency-wait timeout reports 'timed out waiting for dependency task'", async () => {
    // A dependency that takes longer than the dependent's wait budget to finish.
    const pending = startAsyncTask(deps(delayedProvider(600, "later")), {
      targetBot: "researcher",
      message: "still slow",
    });
    const chain = startAsyncTask(deps(delayedProvider(0, "SHOULD NOT RUN")), {
      targetBot: "researcher",
      message: "after pending dep",
      dependsOn: pending.task_id,
      timeoutMs: 40,
    });
    const chainFinal = await chain.settled;
    expect(chainFinal.status).toBe("error");
    expect(chainFinal.error).toMatch(/timed out waiting for dependency task/);
  });

  test("notifyBot writes a completion message to that bot's inbox", async () => {
    const started = startAsyncTask(deps(delayedProvider(0, "HELLO_NOTIFY")), {
      targetBot: "researcher",
      message: "ping",
      notifyBot: "writer",
    });
    const final = await started.settled;
    expect(final.status).toBe("done");

    const notes = listMessages(join(botDir(home, "writer"), "inbox"));
    const note = notes.find((m) => m.from === "researcher");
    expect(note).toBeTruthy();
    expect(note!.body).toContain("HELLO_NOTIFY");
  });
});

/* ------------------------------------------------------------------ *
 * Test helpers — reach into the module to start a task and await it,
 * and to poll persisted status when a timeout must elapse.
 * ------------------------------------------------------------------ */

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

describe("task delegation tree budget (#154)", () => {
  function toolCallingProvider(calls: { n: number }): Provider {
    return {
      name: "tc",
      async chat(): Promise<ChatResponse> {
        calls.n += 1;
        return {
          stopReason: "tool_use",
          content: [
            { type: "tool_use", id: "tc", name: "read_file", input: { path: "." } },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as Provider;
  }

  test("a per-task maxTreeIterations seeds its own tree, stops the run, and reports usage", async () => {
    const calls = { n: 0 };
    const started = startAsyncTask(deps(toolCallingProvider(calls)), {
      targetBot: "researcher",
      message: "m",
      maxTreeIterations: 1,
    });
    const task = await started.settled;
    expect(task.status).toBe("error");
    expect(task.error).toContain("delegation tree budget exhausted");
    // the task snapshot records the shared tree it created (+ the tripping iteration)
    expect(task.treeMaxIterations).toBe(1);
    expect(task.treeUsedIterations ?? 0).toBeGreaterThan(0);
    expect(calls.n).toBeGreaterThan(0);
  });

  test("independent tasks seed independent trees and do not share a limit", async () => {
    const ca = { n: 0 };
    const cb = { n: 0 };
    const a = startAsyncTask(deps(toolCallingProvider(ca)), {
      targetBot: "researcher",
      message: "a",
      maxTreeIterations: 1,
    });
    const b = startAsyncTask(deps(toolCallingProvider(cb)), {
      targetBot: "researcher",
      message: "b",
      maxTreeIterations: 1,
    });
    const [ta, tb] = await Promise.all([a.settled, b.settled]);
    expect(ta.status).toBe("error");
    expect(tb.status).toBe("error");
    // each is capped by its OWN tree counter, independently
    expect(ta.treeMaxIterations).toBe(1);
    expect(tb.treeMaxIterations).toBe(1);
  });

  test("a tree-budget stop preserves the partial text in result and reports stopReason (#193)", async () => {
    // provider emits a text block (partial answer) plus a tool_use on its only
    // iteration; the next iteration trips the shared tree cap (max=1).
    const calls = { n: 0 };
    const p = {
      name: "tc-text",
      async chat(): Promise<ChatResponse> {
        calls.n += 1;
        return {
          stopReason: "tool_use",
          content: [
            { type: "text", text: "PARTIAL RESULT before budget stop" },
            { type: "tool_use", id: "tc", name: "read_file", input: { path: "." } },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as Provider;
    const started = startAsyncTask(deps(p), {
      targetBot: "researcher",
      message: "m",
      maxTreeIterations: 1,
    });
    const task = await started.settled;
    expect(task.status).toBe("error");
    expect(task.error).toContain("delegation tree budget exhausted");
    expect(task.error).toContain("stopReason: tree_budget_exceeded");
    // the partial text produced before the stop is preserved, not discarded
    expect(task.result).toContain("PARTIAL RESULT before budget stop");
    expect(calls.n).toBe(1);
  });
});

describe("corrupted task files (#183)", () => {
  const baseTask = (over: Partial<import("../src/bots/tasks").BotTask> = {}) => ({
    id: "T",
    bot: "researcher",
    message: "hi",
    status: "pending" as const,
    timeoutMs: 1000,
    createdAt: new Date().toISOString(),
    ...over,
  });

  test("writeTask is atomic: no .tmp residue and a valid file on disk", () => {
    writeTask(home, "researcher", baseTask({ id: "T-ok", status: "done", result: "ok" }));
    const dir = join(botDir(home, "researcher"), "tasks");
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
    const persisted = JSON.parse(readFileSync(join(dir, "T-ok.json"), "utf8")) as {
      status: string;
      result: string;
    };
    expect(persisted.status).toBe("done");
    expect(persisted.result).toBe("ok");
  });

  test("a corrupt task file is surfaced as an error task instead of throwing", () => {
    const dir = join(botDir(home, "researcher"), "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "BROKEN.json"), "{ this is not valid json", "utf8");

    // status lookup by id returns an error task, never throws
    const byId = readTaskForStatus(home, "researcher", "BROKEN");
    expect(byId?.status).toBe("error");
    expect(byId?.error).toMatch(/corrupt task file/);

    // findTaskById (across all bots) surfaces it too
    const found = findTaskById(home, "BROKEN");
    expect(found?.status).toBe("error");

    // listTasks shows the broken file as an error entry
    const listed = listTasks(home, "researcher");
    expect(listed.some((t) => t.id === "BROKEN" && t.status === "error")).toBe(true);

    // the system keeps working afterwards: a valid task round-trips
    writeTask(home, "researcher", baseTask({ id: "T-ok", status: "pending" }));
    expect(readTaskForStatus(home, "researcher", "T-ok")?.status).toBe("pending");
  });

  test("a valid task next to a corrupt one is unaffected", () => {
    writeTask(home, "researcher", baseTask({ id: "GOOD", status: "done", result: "r" }));
    const dir = join(botDir(home, "researcher"), "tasks");
    writeFileSync(join(dir, "BAD.json"), "not json at all", "utf8");

    const listed = listTasks(home, "researcher");
    const good = listed.find((t) => t.id === "GOOD");
    expect(good?.status).toBe("done");
    expect(good?.result).toBe("r");
    const bad = listed.find((t) => t.id === "BAD");
    expect(bad?.status).toBe("error");
  });
});
