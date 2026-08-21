import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { ConfigError } from "../config/types";
import { resolveBot, botModelRef, botBudgetUSD, botDir, listBots } from "./profile";
import { runHeadless, capPolicy } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid, hardenUntrustedInput } from "../security/injection";
import { formatUSD } from "../agent/budget";
import { sendMessage, atomicWriteJson } from "./inbox";
import { emit } from "../gateway/events";
import type { ToolDef } from "../tools/registry";
import { TreeBudget, type Budget } from "../agent/budget";
import type { EffortLevel } from "../agent/effort";

/**
 * Async delegation: fire-and-forget `ask_bot` with a task id, persisted status
 * transitions, and a per-task timeout. This is the #29 task abstraction on top
 * of `runHeadless` — it lives in its own file so it does NOT entangle with the
 * sync `ask_bot` tool in `delegate.ts`.
 *
 * #128 adds dependency chains: a task may `dependsOn` another task (it only
 * starts once the dependency is `done`, receiving its result in the prompt) and
 * may `notifyBot` another bot's inbox on completion.
 */

export type TaskStatus = "pending" | "running" | "done" | "error";

export interface BotTask {
  id: string;
  bot: string;
  message: string;
  status: TaskStatus;
  result?: string;
  error?: string;
  timeoutMs: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** #128: this task only starts once the referenced task is `done`. */
  dependsOn?: string;
  /** #128: bot inbox notified on completion instead of only the caller. */
  notifyBot?: string;
  /** #142: effort dial; overrides the target bot's configured effort. */
  effort?: EffortLevel;
  /** #154: snapshot of the shared delegation-tree budget usage after the run. */
  treeUsedIterations?: number;
  treeMaxIterations?: number;
  treeUsedUsd?: number;
  treeMaxUsd?: number;
}

export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;
/** Poll interval while a dependent task waits for its dependency. */
const DEP_POLL_MS = 100;
/**
 * #176: cap on a dependency's result injected into a successor's opening
 * prompt. The Context-Guard cannot compress the opening user message, so an
 * unbounded result would overflow the prompt (provider-400 / cost spike).
 * Kept consistent with the notifyCompletion inbox-note cap; the full result
 * stays queryable via `bot_task_status`.
 */
export const DEP_RESULT_MAX_CHARS = 4000;

export function tasksDir(home: string, bot: string): string {
  return join(botDir(home, bot), "tasks");
}

function taskPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

/**
 * A synthetic, terminal error task describing a task JSON file that could not
 * be parsed. Mirrors the inbox's skip-corrupted policy, but surfaces the
 * broken task as `error` so it stays visible in `bot_task_status` and any
 * dependent fails promptly instead of timing out.
 */
function corruptTask(bot: string, id: string, err: unknown): BotTask {
  return {
    id,
    bot,
    message: "",
    status: "error",
    error: `corrupt task file: ${(err as Error).message}`,
    timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    createdAt: new Date(0).toISOString(),
  };
}

function readTask(home: string, bot: string, id: string): BotTask | null {
  const p = taskPath(tasksDir(home, bot), id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as BotTask;
  } catch (err) {
    return corruptTask(bot, id, err);
  }
}

/** @internal — exported so tests can fabricate a dependency graph. */
export function writeTask(home: string, bot: string, task: BotTask): void {
  const dir = tasksDir(home, bot);
  mkdirSync(dir, { recursive: true });
  // Atomic write (tmp + rename) so a crash mid-write never leaves a corrupt
  // task file behind (#183).
  atomicWriteJson(taskPath(dir, task.id), task);
}

export function listTasks(home: string, bot: string): BotTask[] {
  const dir = tasksDir(home, bot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const id = f.slice(0, -".json".length);
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8")) as BotTask;
      } catch (err) {
        return corruptTask(bot, id, err);
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Read a single persisted task (by target bot + task id). */
export function readTaskForStatus(home: string, bot: string, taskId: string): BotTask | null {
  return readTask(home, bot, taskId);
}

/** Task ids are globally unique (UUIDs); locate a task across every bot. */
export function findTaskById(home: string, taskId: string): BotTask | null {
  for (const bot of listBots(home)) {
    const t = readTask(home, bot, taskId);
    if (t) return t;
  }
  return null;
}

export interface AsyncTaskDeps {
  home: string;
  fromBot: string;
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
  guard?: import("../security/guard").SecurityGuard | null;
  audit?: (kind: "delegation" | "write_exec" | "budget_halt" | "budget_exceeded" | "prompt_injection", detail: string, correlationId?: string) => void;
  defaultTimeoutMs?: number;
}

export interface StartedTask {
  task_id: string;
  targetBot: string;
  /** Resolves with the task once it reaches a terminal state. */
  settled: Promise<BotTask>;
}

export interface StartTaskArgs {
  targetBot: string;
  message: string;
  timeoutMs?: number;
  /** #128: only start once this task is `done`; its result is injected into the prompt. */
  dependsOn?: string;
  /** #128: bot expected to have an inbox that is notified on completion. */
  notifyBot?: string;
  /** #142: effort dial; overrides the target bot's configured effort. */
  effort?: EffortLevel;
  /** #154: inherit the caller's shared tree budget (threaded from the tool ctx). */
  treeBudget?: TreeBudget;
  /** #154: per-task tree cap; when no `treeBudget` is inherited, starts a NEW
   * tree for this task with at most this many iterations. */
  maxTreeIterations?: number;
  /** #154: optional per-task shared USD cap for a new tree. */
  maxTreeUsd?: number;
}

/** True when `dependsOnId` (directly or transitively) forms a cycle with `newId`. */
function assertNoCycle(home: string, newId: string, dependsOnId: string): void {
  const seen = new Set<string>([dependsOnId]);
  let cur = findTaskById(home, dependsOnId);
  while (cur?.dependsOn) {
    const next = cur.dependsOn;
    if (next === newId || seen.has(next)) {
      throw new ConfigError(
        `circular dependency: task ${newId} depends on itself (via ${dependsOnId})`,
      );
    }
    seen.add(next);
    cur = findTaskById(home, next);
  }
}

/**
 * Poll for a dependency until it reaches a terminal state. Resolves with the
 * dependency task, or null once `deadlineMs` passes or the signal aborts.
 */
async function waitForTask(
  home: string,
  depId: string,
  controller: AbortController,
  deadlineMs: number,
): Promise<BotTask | null> {
  while (Date.now() < deadlineMs && !controller.signal.aborted) {
    const dep = findTaskById(home, depId);
    if (dep && (dep.status === "done" || dep.status === "error")) return dep;
    await new Promise((r) => setTimeout(r, DEP_POLL_MS));
  }
  return null;
}

/** Leave a completion note in `notifyBot`'s inbox (from the task's target bot). */
function notifyCompletion(home: string, task: BotTask): void {
  if (!task.notifyBot) return;
  const inboxDir = join(botDir(home, task.notifyBot), "inbox");
  const done = task.status === "done";
  const body = done
    ? `Task ${task.id} completed.\n\n${(task.result ?? "").slice(0, DEP_RESULT_MAX_CHARS)}`
    : `Task ${task.id} failed: ${task.error ?? task.status}`;
  try {
    sendMessage(inboxDir, {
      from: task.bot,
      to: task.notifyBot,
      subject: `Delegation task ${done ? "done" : "failed"}: ${task.message.slice(0, 80)}`,
      body,
    });
  } catch {
    // Best-effort: a notification must never fail the task itself.
  }
}

/**
 * Kick off an async delegation. Creates a `pending` task, then runs the target
 * bot headless in the background, transitioning it to `running` and persisting
 * it under the target bot. Returns immediately with the task id. When
 * `dependsOn` is set the run is deferred until that task is `done`.
 */
export function startAsyncTask(deps: AsyncTaskDeps, args: StartTaskArgs): StartedTask {
  const targetName = String(args.targetBot ?? "").trim();
  if (targetName === deps.fromBot) {
    throw new ConfigError("cannot delegate to yourself");
  }
  const profile = resolveBot(deps.home, targetName);
  const message = String(args.message ?? "").trim();
  if (!message) throw new ConfigError("message must not be empty");
  // #142: a per-task effort overrides the bot's configured effort.
  const effort = args.effort ?? profile.config.effort;

  // #128: notifyBot must be a real, distinct bot (its inbox is written on completion).
  const notifyBot = args.notifyBot ? String(args.notifyBot).trim() : "";
  if (notifyBot) {
    if (notifyBot === targetName) {
      throw new ConfigError("notifyBot must be a different bot");
    }
    resolveBot(deps.home, notifyBot); // throws when unknown
  }

  const id = randomUUID();
  const timeoutMs = args.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const now = new Date().toISOString();

  // #128: validate the dependency exists and reject cycles at creation time.
  let dependsOnId = "";
  if (args.dependsOn !== undefined && args.dependsOn !== null && String(args.dependsOn).trim() !== "") {
    dependsOnId = String(args.dependsOn).trim();
    if (dependsOnId === id) {
      throw new ConfigError("circular dependency: task cannot depend on itself");
    }
    if (!findTaskById(deps.home, dependsOnId)) {
      throw new ConfigError(`unknown dependency "${dependsOnId}"`);
    }
    assertNoCycle(deps.home, id, dependsOnId);
  }

  const task: BotTask = {
    id,
    bot: targetName,
    message,
    status: "pending",
    timeoutMs,
    createdAt: now,
    ...(dependsOnId ? { dependsOn: dependsOnId } : {}),
    ...(notifyBot ? { notifyBot } : {}),
  };
  writeTask(deps.home, targetName, task);

  const correlationId = randomUUID();
  const depNote = dependsOnId ? ` (dependsOn ${dependsOnId})` : "";
  deps.audit?.("delegation", `ask_bot_async -> ${targetName}: ${message.slice(0, 120)}${depNote}`, correlationId);

  const settled = (async (): Promise<BotTask> => {
    const controller = new AbortController();
    // #182: budget the dependency-wait phase and the run phase separately.
    const duration = timeoutMs > 0 ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS;
    let timer = setTimeout(() => controller.abort(), duration);
    try {
      // #128: wait for the dependency before starting.
      let runMessage = message;
      if (dependsOnId) {
        const deadline = Date.now() + duration;
        const dep = await waitForTask(deps.home, dependsOnId, controller, deadline);
        if (!dep || dep.status !== "done") {
          task.status = "error";
          task.error = controller.signal.aborted
            ? `timed out waiting for dependency task ${dependsOnId} (after ${duration}ms)`
            : dep?.status === "error"
              ? `dependency task ${dependsOnId} failed: ${dep.error ?? "error"}`
              : `dependency task ${dependsOnId} did not complete`;
          task.finishedAt = new Date().toISOString();
          return task; // persisted + notified in finally
        }
        // #176: cap the dependency result injected into this successor's
        // opening prompt (the Context-Guard cannot compress it), and point to
        // bot_task_status for the full text.
        const depResult = dep.result ?? "(no result)";
        const truncated = depResult.length > DEP_RESULT_MAX_CHARS;
        // #189: dependency results are untrusted data — scan, audit and frame
        // them before they reach the successor's prompt (a hostile bot could
        // otherwise steer the run via a planted instruction).
        const depText = hardenUntrustedInput(
          truncated
            ? `${depResult.slice(0, DEP_RESULT_MAX_CHARS)}\n\n(Result truncated; full text via bot_task_status)`
            : depResult,
          {
            paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
            audit: deps.audit,
            correlationId,
          },
        );

        // #182: dependency resolved within budget — reset the timer so the run
        // phase gets its own full budget instead of whatever the wait left over.
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), duration);
        runMessage =
          `Result from dependency task ${dependsOnId} (${dep.bot}):\n${depText}\n\n` +
          `Now handle the original request:\n${message}`;
      }

      // mark running
      task.status = "running";
      task.startedAt = new Date().toISOString();
      writeTask(deps.home, targetName, task);

      const ref = botModelRef(profile, deps.globalConfig);
      const provider = deps.getProvider(ref.provider);
      let cap = botBudgetUSD(profile, 1.0);
      if (cap <= 0) cap = 1.0;
      if (deps.sessionBudget && deps.sessionBudget.capUSD > 0) {
        const remaining = deps.sessionBudget.capUSD - deps.sessionBudget.spentUSD;
        cap = Math.min(cap, Math.max(0.01, remaining));
      }

      // #154: inherit the caller's shared tree budget, or start a fresh tree
      // for this task when a per-task cap is set (independent tasks that set
      // their own cap do not share a counter).
      const tb =
        args.treeBudget ??
        (args.maxTreeIterations || args.maxTreeUsd
          ? new TreeBudget(args.maxTreeIterations ?? 0, args.maxTreeUsd ?? 0)
          : undefined);

      const result = await runHeadless({
        provider,
        model: ref.model,
        soulText: profile.soulText,
        cwd: deps.cwd,
        message: runMessage,
        maxTokens: deps.globalConfig.maxTokens,
        capUSD: cap,
        pricing: deps.globalConfig.pricing,
        policy: capPolicy("read-only", profile.config.security?.policy),
        denyTools: profile.config.security?.denyTools,
        home: deps.home,
        memoryDir: profile.memoryDir,
        guard: guardForBot(deps.globalConfig.security, profile.config.security, deps.guard?.onBlock),
        paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
        correlationId,
        audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
        sessionLogDir: profile.sessionsDir,
        sessionBot: profile.name,
        signal: controller.signal,
        effort,
        treeBudget: tb,
      });

      // #154: report tree-budget usage on the task for status/console display.
      if (tb) {
        task.treeUsedIterations = tb.usedIterations;
        task.treeMaxIterations = tb.maxIterations;
        task.treeUsedUsd = tb.usedUSD;
        task.treeMaxUsd = tb.maxUSD;
      }
      if (result.stopReason === "tree_budget_exceeded") {
        deps.audit?.(
          "budget_exceeded",
          `delegation tree budget exhausted during task ${id}`,
          correlationId,
        );
        // #193: preserve the partial text a tree-budget stop produced instead
        // of discarding it (analogous to the sync ask_bot path), and surface
        // stopReason in the error text so callers/dependents can tell it apart
        // from a hard failure.
        if (result.text) task.result = result.text;
        throw new Error(
          `delegation tree budget exhausted (${tb?.usedIterations ?? 0}/${tb?.maxIterations ?? "∞"} iterations) (stopReason: tree_budget_exceeded)`,
        );
      }

      const meta = `[delegated to ${profile.name} (${ref.provider}:${ref.model}), ${formatUSD(result.costUSD)}]`;
      const text = result.text ? `${result.text}\n\n${meta}` : `The ${profile.name} bot returned no text (${result.stopReason}). ${meta}`;

      task.status = "done";
      task.result = text;
      task.finishedAt = new Date().toISOString();
    } catch (err) {
      task.status = "error";
      task.error = controller.signal.aborted
        ? `timeout during run after ${duration}ms`
        : `delegation failed: ${(err as Error).message}`;
      task.finishedAt = new Date().toISOString();
    } finally {
      clearTimeout(timer);
      writeTask(deps.home, targetName, task);
      notifyCompletion(deps.home, task);
      emit("task.done", { id: task.id, bot: task.bot, status: task.status });
    }
    return task;
  })();

  return { task_id: id, targetBot: targetName, settled };
}

/** `ask_bot_async` tool: returns { task_id, status } immediately. */
export function createAskBotAsyncTool(deps: AsyncTaskDeps): ToolDef {
  return {
    name: "ask_bot_async",
    group: "write",
    description:
      "Ask another bot a question WITHOUT waiting for its answer. Returns a task_id immediately; poll bot_task_status to read the result. The target bot runs headless with its own model and soul, read-only. Optionally dependsOn another async task (start only once that task is done, with its result in the prompt) and/or notifyBot (a bot inbox that is messaged on completion). Effort vs tree budget: a subagent's effort dial scales how many iterations it may use, and every iteration counts against the shared delegation-tree cap — so a high/max-effort subagent can exhaust the whole tree budget, after which later siblings stop immediately with tree_budget_exceeded. The tree cap is authoritative across the chain; per-task effort only widens one subagent's own share.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Target bot name" },
        message: { type: "string", description: "What you want to know or done" },
        timeoutMs: { type: "number", description: "Optional per-task timeout in ms" },
        dependsOn: { type: "string", description: "Optional task_id this task waits for before starting" },
        notifyBot: { type: "string", description: "Optional bot inbox to notify on completion" },
        effort: { type: "string", description: "Optional effort level: low/medium/high/max (overrides the bot's)" },
        maxTreeIterations: { type: "number", description: "Optional per-task delegation-tree iteration cap (0 = unlimited). When set and no shared tree budget is inherited, this task starts its own tree." },
      },
      required: ["bot", "message"],
    },
    async handler(args, ctx) {
      const started = startAsyncTask(deps, {
        targetBot: String(args.bot ?? "").trim(),
        message: String(args.message ?? "").trim(),
        timeoutMs: args.timeoutMs == null ? undefined : Number(args.timeoutMs),
        dependsOn: args.dependsOn == null ? undefined : String(args.dependsOn).trim(),
        notifyBot: args.notifyBot == null ? undefined : String(args.notifyBot).trim(),
        effort: args.effort == null ? undefined : (args.effort as EffortLevel),
        // #154: a task inherits the caller's shared tree budget so a chain of
        // delegations counts against one counter; else honors a per-task cap.
        treeBudget: ctx.treeBudget,
        maxTreeIterations:
          args.maxTreeIterations == null ? undefined : Math.max(0, Number(args.maxTreeIterations)),
      });
      return JSON.stringify({ task_id: started.task_id, status: "pending" });
    },
  };
}

/** `bot_task_status` tool: reads a task's current state and result. */
export function createBotTaskStatusTool(deps: { home: string }): ToolDef {
  return {
    name: "bot_task_status",
    group: "read",
    description:
      "Read the status and result of an async delegation task started by ask_bot_async. Returns pending/running/done/error plus the result once done.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id returned by ask_bot_async" },
        bot: { type: "string", description: "Optional target bot name (speeds lookup)" },
      },
      required: ["task_id"],
    },
    async handler(args) {
      const taskId = String(args.task_id ?? "").trim();
      if (!taskId) throw new ConfigError("task_id must not be empty");

      // try the given bot first, else scan all bots (task ids are unique)
      const given = args.bot ? String(args.bot).trim() : "";
      if (given) {
        const t = readTask(deps.home, given, taskId);
        if (t) return JSON.stringify(t);
      }
      for (const bot of listBots(deps.home)) {
        const t = readTask(deps.home, bot, taskId);
        if (t) return JSON.stringify(t);
      }
      throw new ConfigError(`unknown task ${taskId}`);
    },
  };
}
