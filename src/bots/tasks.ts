import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { ConfigError } from "../config/types";
import { resolveBot, botModelRef, botBudgetUSD, botDir, listBots } from "./profile";
import { runHeadless, capPolicy } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { formatUSD } from "../agent/budget";
import type { ToolDef } from "../tools/registry";
import type { Budget } from "../agent/budget";

/**
 * Async delegation: fire-and-forget `ask_bot` with a task id, persisted status
 * transitions, and a per-task timeout. This is the #29 task abstraction on top
 * of `runHeadless` — it lives in its own file so it does NOT entangle with the
 * sync `ask_bot` tool in `delegate.ts`.
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
}

export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

export function tasksDir(home: string, bot: string): string {
  return join(botDir(home, bot), "tasks");
}

function taskPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function readTask(home: string, bot: string, id: string): BotTask | null {
  const p = taskPath(tasksDir(home, bot), id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as BotTask;
}

function writeTask(home: string, bot: string, task: BotTask): void {
  const dir = tasksDir(home, bot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(taskPath(dir, task.id), JSON.stringify(task, null, 2), "utf8");
}

export function listTasks(home: string, bot: string): BotTask[] {
  const dir = tasksDir(home, bot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BotTask)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Read a task for status purposes across all bots (task ids are unique). */
export function readTaskForStatus(home: string, bot: string, taskId: string): BotTask | null {
  return readTask(home, bot, taskId);
}

export interface AsyncTaskDeps {
  home: string;
  fromBot: string;
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
  guard?: import("../security/guard").SecurityGuard | null;
  audit?: (kind: "delegation" | "write_exec" | "budget_halt", detail: string, correlationId?: string) => void;
  defaultTimeoutMs?: number;
}

export interface StartedTask {
  task_id: string;
  targetBot: string;
  /** Resolves with the task once it reaches a terminal state. */
  settled: Promise<BotTask>;
}

/**
 * Kick off an async delegation. Creates a `pending` task, then runs the target
 * bot headless in the background, transitioning it to `running` and persisting
 * it under the target bot. Returns immediately with the task id.
 */
export function startAsyncTask(deps: AsyncTaskDeps, args: {
  targetBot: string;
  message: string;
  timeoutMs?: number;
}): StartedTask {
  const targetName = String(args.targetBot ?? "").trim();
  if (targetName === deps.fromBot) {
    throw new ConfigError("cannot delegate to yourself");
  }
  const profile = resolveBot(deps.home, targetName);
  const message = String(args.message ?? "").trim();
  if (!message) throw new ConfigError("message must not be empty");

  const id = randomUUID();
  const timeoutMs = args.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
  const now = new Date().toISOString();
  const task: BotTask = {
    id,
    bot: targetName,
    message,
    status: "pending",
    timeoutMs,
    createdAt: now,
  };
  writeTask(deps.home, targetName, task);

  const correlationId = randomUUID();
  deps.audit?.("delegation", `ask_bot_async -> ${targetName}: ${message.slice(0, 120)}`, correlationId);

  const settled = (async (): Promise<BotTask> => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs > 0 ? timeoutMs : DEFAULT_TASK_TIMEOUT_MS,
    );
    try {
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

      const result = await runHeadless({
        provider,
        model: ref.model,
        soulText: profile.soulText,
        cwd: deps.cwd,
        message,
        maxTokens: deps.globalConfig.maxTokens,
        capUSD: cap,
        pricing: deps.globalConfig.pricing,
        policy: capPolicy("read-only", profile.config.security?.policy),
        denyTools: profile.config.security?.denyTools,
        home: deps.home,
        memoryDir: profile.memoryDir,
        guard: guardForBot(deps.globalConfig.security, profile.config.security, deps.guard?.onBlock),
        correlationId,
        audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
        sessionLogDir: profile.sessionsDir,
        sessionBot: profile.name,
        signal: controller.signal,
      });

      const meta = `[delegated to ${profile.name} (${ref.provider}:${ref.model}), ${formatUSD(result.costUSD)}]`;
      const text = result.text ? `${result.text}\n\n${meta}` : `The ${profile.name} bot returned no text (${result.stopReason}). ${meta}`;

      task.status = "done";
      task.result = text;
      task.finishedAt = new Date().toISOString();
    } catch (err) {
      task.status = "error";
      task.error = controller.signal.aborted
        ? `timeout after ${timeoutMs}ms`
        : `delegation failed: ${(err as Error).message}`;
      task.finishedAt = new Date().toISOString();
    } finally {
      clearTimeout(timer);
      writeTask(deps.home, targetName, task);
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
      "Ask another bot a question WITHOUT waiting for its answer. Returns a task_id immediately; poll bot_task_status to read the result. The target bot runs headless with its own model and soul, read-only.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Target bot name" },
        message: { type: "string", description: "What you want to know or done" },
        timeoutMs: { type: "number", description: "Optional per-task timeout in ms" },
      },
      required: ["bot", "message"],
    },
    async handler(args) {
      const started = startAsyncTask(deps, {
        targetBot: String(args.bot ?? "").trim(),
        message: String(args.message ?? "").trim(),
        timeoutMs: args.timeoutMs == null ? undefined : Number(args.timeoutMs),
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
