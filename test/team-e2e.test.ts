import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHeadless } from "../src/agent/headless";
import { createBot, resolveBot, botDir } from "../src/bots/profile";
import { createAskBotAsyncTool, createBotTaskStatusTool, listTasks, readTaskForStatus } from "../src/bots/tasks";
import { listMessages } from "../src/bots/inbox";
import { aggregateSpend } from "../src/audit/spend";
import { SessionLog } from "../src/session/log";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig } from "../src/config/types";

/*
 * Executable team scenario (#153) — "Researcher investigates overnight,
 * Writer drafts in the morning."
 *
 * This is a deliberately runnable story, not a unit test: it wires the REAL
 * modules together the way the product promises they compose, so a broken
 * interaction between features fails loudly instead of quietly drifting.
 *
 *  1. The user leaves a task with `tenjin tell researcher "<task>"` — the
 *     real CLI path that drops a user message into the Researcher's inbox.
 *  2. The Researcher routine runs headless (full policy) and, as its first
 *     action, delegates drafting to the Writer via `ask_bot_async`
 *     (fire-and-forget, #119) and asks the Writer to `notifyBot` the
 *     Researcher's inbox when it is done (#128 chain).
 *  3. The Writer task runs headless in the background (read-only, its own
 *     model/soul), produces a draft, persists as `done` under the Writer's
 *     tasks dir, and leaves a completion note in the Researcher's inbox.
 *  4. Next morning the Researcher routine resumes: it reads the task result
 *     via `bot_task_status`, writes the deliverable (a file — this is the
 *     write step that must pass the approval gate), and returns the user
 *     answer that incorporates the Writer's draft.
 *  5. Along the way we assert the things a team setup must not get wrong:
 *     approval gating fires for the write step, spend is attributed to each
 *     bot separately, and each bot has its own session history.
 *
 * Use this file as the template for new team patterns: add a bot, fake its
 * provider replies, and keep the assertions about observable side effects
 * (inbox, tasks dir, spend, session logs) rather than internal function calls.
 */

const R_MODEL = "researcher-model";
const W_MODEL = "writer-model";
const USER_TASK = "Draft a migration plan for the API-key refactor";
const WRITER_DRAFT = "DRAFT-marker: move API keys into a machine-local OS keyring";
const USER_ANSWER = "USER-ANSWER-marker";

function textReply(text: string): ChatResponse {
  return {
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 120, outputTokens: 60 },
  };
}

function toolUse(name: string, input: unknown): ChatResponse {
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: name, name, input }],
    usage: { inputTokens: 120, outputTokens: 60 },
  };
}

function globalConfig(over: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    provider: "anthropic",
    model: R_MODEL,
    maxTokens: 1024,
    budgetUSD: 10,
    approval: {},
    ...over,
  };
}

function waitForStatus(
  home: string,
  bot: string,
  taskId: string,
  maxWaitMs: number,
): Promise<{ status: string; result?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const t = readTaskForStatus(home, bot, taskId);
      if (t && t.status !== "pending" && t.status !== "running") {
        resolve({ status: t.status, result: t.result, error: t.error });
        return;
      }
      if (Date.now() - started > maxWaitMs) {
        reject(new Error("writer task never reached a terminal state"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Spawn the real CLI (`tenjin tell ...`) against a temp TENJIN_HOME. */
function spawnCli(home: string, args: string[]) {
  return Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TENJIN_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitExit(proc: Bun.Subprocess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("team e2e CLI timed out")), 20_000);
    proc.exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("e2e: team scenario — Researcher investigates, Writer drafts (#153)", () => {
  let home: string;

  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("tell → delegate chain → writer result → user answer (approval, per-bot spend & sessions)", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-team-e2e-"));

    // Two fake-provider bots, each pinning its own model so one routing
    // provider can serve them both.
    createBot(home, "researcher", { soul: "You are Researcher. Be terse." });
    createBot(home, "writer", { soul: "You are Writer. Be terse." });
    writeFileSync(join(botDir(home, "researcher"), "config.yaml"), `model: "${R_MODEL}"\n`);
    writeFileSync(join(botDir(home, "writer"), "config.yaml"), `model: "${W_MODEL}"\n`);

    // 1. The user leaves the task via the real `tenjin tell` CLI.
    const tell = spawnCli(home, ["tell", "researcher", USER_TASK]);
    expect(await waitExit(tell)).toBe(0);

    const researcher = resolveBot(home, "researcher");
    const userMsg = listMessages(researcher.inboxDir).find((m) => m.from === "user");
    expect(userMsg).toBeTruthy();
    expect(userMsg!.body).toContain(USER_TASK);

    // A provider that answers differently per model, so the Researcher and
    // the delegated Writer each follow their own scripted turn sequence.
    const seq: Record<string, ChatResponse[]> = { [R_MODEL]: [], [W_MODEL]: [] };
    const counters: Record<string, number> = {};
    const approvals: Array<{ tool: string; group: string }> = [];
    const auditEvents: Array<{ kind: string }> = [];

    const provider: Provider = {
      name: "mock-team",
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const model = req.model;
        const i = counters[model] ?? 0;
        counters[model] = i + 1;
        const next = seq[model]?.[i];
        if (!next) throw new Error(`team e2e script exhausted for ${model} at call ${i}`);
        return next;
      },
    };

    const delegateTool = createAskBotAsyncTool({
      home,
      fromBot: "researcher",
      cwd: home,
      getProvider: () => provider,
      globalConfig: globalConfig(),
      defaultTimeoutMs: 15_000,
    });
    const statusTool = createBotTaskStatusTool({ home });

    const researcherRun = (message: string) =>
      runHeadless({
        provider,
        model: R_MODEL,
        soulText: researcher.soulText,
        cwd: home,
        message,
        maxTokens: 1024,
        capUSD: 10,
        policy: "full",
        home,
        memoryDir: researcher.memoryDir,
        sessionLogDir: researcher.sessionsDir,
        sessionBot: "researcher",
        extraTools: [delegateTool, statusTool],
        audit: (kind) => auditEvents.push({ kind }),
        approve: async (tool, group) => {
          approvals.push({ tool, group });
          return true;
        },
      });

    // The Writer only ever answers with its draft (delegations run read-only).
    seq[W_MODEL]!.push(textReply(WRITER_DRAFT));

    // 2. Overnight — the Researcher routine delegates drafting to the Writer.
    seq[R_MODEL]!.push(
      toolUse("ask_bot_async", {
        bot: "writer",
        message: `Write the draft for: ${USER_TASK}`,
        notifyBot: "researcher",
      }),
      textReply("Delegated the draft to Writer overnight. Will report in the morning."),
    );
    await researcherRun(userMsg!.body);

    // 3. The Writer task runs headless, persists as done, and notifies the
    //    Researcher inbox ("Writer draftet morgens").
    const writerTasks = listTasks(home, "writer");
    expect(writerTasks).toHaveLength(1);
    const tid = writerTasks[0]!.id;

    const writerDone = await waitForStatus(home, "writer", tid, 15_000);
    expect(writerDone.status).toBe("done");
    expect(writerDone.result).toContain(WRITER_DRAFT);

    const writerNotes = listMessages(researcher.inboxDir).filter((m) => m.from === "writer");
    expect(writerNotes).toHaveLength(1);
    expect(writerNotes[0]!.body).toContain("completed");
    expect(writerNotes[0]!.body).toContain(WRITER_DRAFT);

    // 4. Morning — the Researcher reads the result, writes the deliverable
    //    (approval-gated write step), and hands the user the answer.
    seq[R_MODEL]!.push(
      toolUse("bot_task_status", { task_id: tid, bot: "writer" }),
      toolUse("write_file", {
        path: "auth-refactor.md",
        content: `# Migration plan\n\n${WRITER_DRAFT}`,
      }),
      textReply(`${USER_ANSWER} ${WRITER_DRAFT}`),
    );
    const answer = await researcherRun(
      "Compile the Writer's draft and hand the migration plan to the user.",
    );
    expect(answer.text).toContain(USER_ANSWER);
    expect(answer.text).toContain(WRITER_DRAFT);

    // 5. Observability: approval fired on the write step + write_exec audit.
    const writeApproval = approvals.find((a) => a.tool === "write_file" && a.group === "write");
    expect(writeApproval).toBeTruthy();
    expect(auditEvents.some((e) => e.kind === "write_exec")).toBe(true);

    // Spend is attributed to each bot separately.
    const rows = aggregateSpend(home);
    const rRow = rows.find((x) => x.scope === "researcher");
    const wRow = rows.find((x) => x.scope === "writer");
    expect(rRow).toBeTruthy();
    expect(rRow!.costUSD).toBeGreaterThan(0);
    expect(rRow!.sessions).toBeGreaterThanOrEqual(2); // night + morning
    expect(wRow).toBeTruthy();
    expect(wRow!.costUSD).toBeGreaterThan(0);
    expect(wRow!.sessions).toBeGreaterThanOrEqual(1);

    // Session history is kept per bot.
    expect(SessionLog.list(researcher.sessionsDir).length).toBeGreaterThanOrEqual(2);
    expect(SessionLog.list(join(botDir(home, "writer"), "sessions")).length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
