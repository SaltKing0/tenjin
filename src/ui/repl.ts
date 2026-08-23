import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { ChatMessage, Provider } from "../provider/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveModelRef, formatModelRef, type ModelRef } from "../config/models";
import { ConfigError } from "../config/types";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/loader";
import { Budget, createBudget, formatUSD, TreeBudget } from "../agent/budget";
import { runAgentTurn, type TurnEvent, type ApproveDecision } from "../agent/loop";
import { checkGlobalBudget } from "../audit/global-budget";
import type { EventLogger, SessionEvent } from "../session/events";
import { rebuildMessages, sumUsage } from "../session/events";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";
import { resolveContextGuard } from "../session/context";
import { buildSkillsSection, summarizeSkills } from "../skills/activate";
import { buildVolatileTail } from "../agent/prompt";
import { createAskBotTool, createHandoffBotTool } from "../bots/delegate";
import { createAskBotAsyncTool, createBotTaskStatusTool, reconcileOrphanedTasks } from "../bots/tasks";
import { listBots, resolveBot } from "../bots/profile";
import { AuditLog, formatAudit, auditPath } from "../audit/log";
import { inboxPolicyFromConfig, leaveUserMessage, unreadMessages } from "../bots/inbox";
import { getSkill, listSkills, scaffoldSkill } from "../skills/loader";
import { listSummaries, sessionsWithoutSummary } from "../memory/summaries";
import { loadChunks, indexedSessionIds } from "../memory/vector-store";
import { readFacts } from "../tools/memory";
import { memoryEnabled } from "../config/loader";
import { VERSION } from "../version";
import { classifyRisk, isT2 } from "../security/guard";
// B13-5 (#437): mode ladder — the higher-level approval default.
import {
  decideModeAction,
  DEFAULT_MODE,
  isIsolationEnvReady,
  RecentlyDeniedList,
  validateMode,
  type ModeLadder,
} from "../security/mode-ladder";
import { FrameBatcher } from "./stream-ux";
import {
  ApprovalQueue,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  denyFeedback,
  parseApprovalAnswer,
  persistScope,
  renderApprovalBlock,
  timeoutVerdict,
  withTimeout,
} from "./approval";

/** #406: one approval visible at a time (FIFO lock) + persistent always-rules. */
const approvalQueue = new ApprovalQueue();
const alwaysRules = new Set<string>();
// B13-5 (#437): bounded 'recently denied' review list for tuning the mode.
const recentlyDenied = new RecentlyDeniedList(50);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export interface ReplOptions {
  config: HarnessConfig;
  registry: ProviderRegistry;
  defaultRef: ModelRef;
  cheapRef: ModelRef | null;
  home: string;
  bot?: string;
  guard?: import("../security/guard").SecurityGuard | null;
  system: string;
  tools: ToolDef[];
  cwd: string;
  sessionId: string;
  logger?: SessionLog;
  sessionsDir?: string;
  memoryDir?: string;
  initialMessages?: ChatMessage[];
  initialSpentUSD?: number;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  // #180: fail tasks orphaned by a previous process's exit so their dependents
  // fail fast instead of burning a full timeout.
  reconcileOrphanedTasks(opts.home);
  const rl = createInterface({ input: stdin, output: stdout });
  const audit = new AuditLog(auditPath(opts.home));
  const state = {
    messages: [...(opts.initialMessages ?? [])],
    budget: createBudget(opts.config.budgetUSD, opts.config.pricing),
    // #184: the interactive turn (and any ask_bot / ask_bot_async delegate it
    // spawns) counts against the configured delegation-tree safety-net, the
    // same way the gateway and one-shot runner do.
    treeBudget: opts.config.maxTreeIterations
      ? new TreeBudget(opts.config.maxTreeIterations ?? 0, 0)
      : undefined,
    logger: opts.logger,
    sessionId: opts.sessionId,
    active: opts.defaultRef,
    pinnedSkills: new Set<string>(),
    audit,
  };
  if (opts.bot) {
    opts.tools.push(
      createAskBotTool({
        home: opts.home,
        fromBot: opts.bot,
        cwd: opts.cwd,
        getProvider: (name) => opts.registry.get(name),
        globalConfig: opts.config,
        sessionBudget: state.budget,
        guard: opts.guard ?? null,
        audit: (kind, detail, correlationId) =>
          audit.append(kind, "user", detail, opts.bot, correlationId),
      }),
      createHandoffBotTool({
        home: opts.home,
        fromBot: opts.bot,
        cwd: opts.cwd,
        getProvider: (name) => opts.registry.get(name),
        globalConfig: opts.config,
        sessionBudget: state.budget,
        guard: opts.guard ?? null,
        audit: (kind, detail, correlationId) =>
          audit.append(kind, "user", detail, opts.bot, correlationId),
      }),
      createAskBotAsyncTool({
        home: opts.home,
        fromBot: opts.bot,
        cwd: opts.cwd,
        getProvider: (name) => opts.registry.get(name),
        globalConfig: opts.config,
        sessionBudget: state.budget,
        guard: opts.guard ?? null,
        audit: (kind, detail, correlationId) =>
          audit.append(kind, "user", detail, opts.bot, correlationId),
      }),
      createBotTaskStatusTool({ home: opts.home }),
    );
  }
  state.budget.spentUSD = opts.initialSpentUSD ?? 0;
  const sessionAllowed = new Set<string>();
  // B13-5 (#437): session-scoped mode override — `/mode <rung>` switches it for
  // THIS session only (never written to config, never silently global).
  const sessionMode = { current: DEFAULT_MODE as ModeLadder };

  let turnActive = false;
  let controller: AbortController | null = null;

  const onSigint = () => {
    if (turnActive && controller) {
      controller.abort();
    } else {
      stdout.write("\n");
      process.exit(0);
    }
  };
  process.on("SIGINT", onSigint);

  logEvent(state.logger, {
    t: "session_start",
    id: opts.sessionId,
    ts: now(),
    provider: state.active.provider,
    model: state.active.model,
    ...(opts.bot ? { bot: opts.bot } : {}),
  });

  printBanner(opts, state);

  try {
    while (true) {
      let raw: string | null;
      try {
        raw = await rl.question(bold("you> "));
      } catch {
        break;
      }
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith("/")) {
        const handled = await handleCommand(line, rl, opts, state, sessionAllowed, sessionMode);
        if (handled === "exit") break;
        continue;
      }

      state.messages.push({ role: "user", content: line });
      logEvent(state.logger, { t: "message", role: "user", content: line, ts: now() });

      controller = new AbortController();
      turnActive = true;
      stdout.write("\n");
      // B13-1 (#383): append-only streaming — provider deltas are buffered and
      // flushed in ~30ms frames, never per-token, so slow/free models don't
      // flicker and already-emitted lines are never rewritten.
      const stream = new FrameBatcher({
        frameMs: 30,
        now: Date.now,
        write: (s) => stdout.write(s),
      });
      const ticker = setInterval(() => stream.tick(), 30);
      // B2-1 cache-shape (#353): keep the system prompt as the byte-stable
      // prefix. Per-turn data (clock + pinned skills) goes into the volatile
      // TAIL after the transcript — never appended to the system prefix — so
      // the provider's prompt cache on the prefix survives across turns.
      const skillsSection = buildSkillsSection(opts.home, opts.cwd, state.pinnedSkills);
      const volatileTail = buildVolatileTail({
        now: new Date().toISOString().slice(0, 10),
        statusLines: skillsSection ? [skillsSection] : [],
      });
      try {
        const result = await runAgentTurn({
          provider: activeProvider(opts, state),
          model: state.active.model,
          system: opts.system,
          volatileTail,
          tools: opts.tools,
          messages: state.messages,
          budget: state.budget,
          treeBudget: state.treeBudget,
          maxTokens: opts.config.maxTokens,
          cwd: opts.cwd,
          globalBudgetGate:
            opts.config.globalBudget
              ? () => checkGlobalBudget(opts.home, opts.config.globalBudget!)
              : undefined,
          approve: (name, group, input) =>
            approve(name, group, input, opts.config, rl, sessionAllowed, audit, opts.bot, sessionMode),
          guard: opts.guard,
          audit: (kind, detail, correlationId) =>
            audit.append(kind, "user", detail, opts.bot, correlationId),
          onTextDelta: (d) => stream.push(d),
          onEvent: (e) => forwardEvent(e, state.logger, state.budget),
          signal: controller.signal,
          contextGuard: resolveContextGuard(state.active.model, opts.config.context),
        });
        stdout.write("\n");
        if (result.stopReason === "budget_exhausted") {
          stdout.write(red(`\nbudget cap reached (${formatUSD(state.budget.spentUSD)}). raise budgetUSD or /cost.\n`));
        } else if (result.stopReason === "max_iterations") {
          stdout.write(red(`\nstopped after ${25} tool iterations.\n`));
        }
        stdout.write(
          dim(
            `  [${result.model} · in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)} turn · ${formatUSD(state.budget.spentUSD)} total]\n`,
          ),
        );
      } catch (e) {
        stdout.write("\n");
        if ((e as Error)?.name === "AbortError") {
          stdout.write(dim("(interrupted)\n"));
        } else {
          const msg = (e as Error)?.message ?? String(e);
          stdout.write(red(`error: ${msg}\n`));
          logEvent(state.logger, { t: "error", message: msg, ts: now() });
        }
      } finally {
        clearInterval(ticker);
        stream.flush();
        turnActive = false;
        controller = null;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    rl.close();
  }
}

interface ReplState {
  messages: ChatMessage[];
  budget: Budget;
  treeBudget?: TreeBudget;
  logger: SessionLog | undefined;
  sessionId: string;
  active: ModelRef;
  pinnedSkills: Set<string>;
  audit: AuditLog;
}

function activeProvider(opts: ReplOptions, state: ReplState): Provider {
  return opts.registry.get(state.active.provider);
}

async function handleCommand(
  line: string,
  rl: Interface,
  opts: ReplOptions,
  state: ReplState,
  sessionAllowed: Set<string>,
  sessionMode: { current: ModeLadder },
): Promise<"exit" | void> {
  const [cmd, ...rest] = line.split(/\s+/);
  switch (cmd) {
    case "/help":
      stdout.write(
        [
          "/help            this text",
          "/exit, /quit     leave",
          "/cost            spend so far vs cap",
          "/model [id]      show or switch model",
          "/mode [rung]     show/switch session mode (manual|acceptEdits|auto|dontAsk|bypass)",
          "/tools           list available tools",
          "/sessions        list saved sessions",
          "/resume <id>     continue a previous session",
          "/fork [n]        branch current conversation at event n",
          "/replay          print trajectory of this session",
          "/memory          memory layer status",
          "/whoami          current identity and model",
          "/bots            list bots and unread inbox counts",
          "/tell <bot> text leave a user message in a bot's inbox",
          "/audit [n]       recent security-relevant events",
          "/skills          list installed skills",
          "/skill <n> [off] pin a skill into every turn",
          "",
        ].join("\n"),
      );
      return;
    case "/exit":
    case "/quit":
      return "exit";
    case "/mode": {
      // B13-5 (#437): show or switch the session mode ladder (session-scoped,
      // never written to config — the next session starts from config again).
      const rung = rest[0];
      if (rung === undefined) {
        stdout.write(`${sessionMode.current} (session; config default ${opts.config.mode?.ladder ?? DEFAULT_MODE})\n`);
        return;
      }
      try {
        sessionMode.current = validateMode(rung);
        stdout.write(`mode → ${sessionMode.current}\n`);
      } catch (e) {
        stdout.write(dim(`  ${(e as Error).message}\n`));
      }
      return;
    }
    case "/bots": {
      const bots = listBots(opts.home);
      if (bots.length === 0) {
        stdout.write(dim("no bots — tenjin bot init-examples\n"));
        return;
      }
      for (const b of bots) {
        const unread = unreadMessages(
          join(opts.home, "bots", b, "inbox"),
          inboxPolicyFromConfig(opts.config.inbox),
        ).length;
        const marker = b === opts.bot ? green(" <- you") : "";
        const note = unread ? dim(` ${unread} unread`) : "";
        stdout.write(`${b.padEnd(20)}${note}${marker}\n`);
      }
      return;
    }
    case "/tell": {
      const bot = rest[0];
      const text = rest.slice(1).join(" ");
      if (!bot || !text.trim()) {
        stdout.write("usage: /tell <bot> <text>\n");
        return;
      }
      try {
        const profile = resolveBot(opts.home, bot);
        const msg = leaveUserMessage(
          profile.inboxDir,
          profile.name,
          text,
          inboxPolicyFromConfig(opts.config.inbox),
        );
        stdout.write(`left message for ${profile.name} (id ${msg.id})\n`);
      } catch (e) {
        stdout.write(`error: ${(e as Error).message}\n`);
      }
      return;
    }
    case "/handoff": {
      const bot = rest[0];
      const text = rest.slice(1).join(" ");
      if (!bot || !text.trim()) {
        stdout.write("usage: /handoff <bot> <message>\n");
        return;
      }
      try {
        const tool = createHandoffBotTool({
          home: opts.home,
          fromBot: opts.bot ?? "solo",
          cwd: opts.cwd,
          getProvider: (name) => opts.registry.get(name),
          globalConfig: opts.config,
          sessionBudget: state.budget,
          guard: opts.guard ?? null,
          audit: (kind, detail, correlationId) =>
            state.audit.append(kind, "user", detail, opts.bot, correlationId),
        });
        const out = await tool.handler({ bot, message: text }, { treeBudget: state.treeBudget } as never);
        stdout.write(`${out}\n`);
      } catch (e) {
        stdout.write(`error: ${(e as Error).message}\n`);
      }
      return;
    }
    case "/whoami":
      stdout.write(
        dim(
          `${opts.bot ?? "solo"} · ${state.active.provider}:${state.active.model} · cwd ${opts.cwd}\n`,
        ),
      );
      return;
    case "/cost": {
      stdout.write(
        dim(
          `spent ${formatUSD(state.budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "no cap"}\n`,
        ),
      );
      for (const entry of state.budget.breakdown()) {
        stdout.write(dim(`  ${entry.model}: ${formatUSD(entry.usd)}\n`));
      }
      return;
    }
    case "/model": {
      if (!rest[0]) {
        stdout.write(dim(`${formatModelRef(state.active)}${opts.cheapRef ? dim("  (tiers: default, cheap)") : ""}\n`));
        return;
      }
      const arg = rest[0];
      try {
        if (arg === "default") {
          state.active = opts.defaultRef;
        } else if (arg === "cheap") {
          if (!opts.cheapRef) throw new ConfigError("no cheap tier configured (set models.cheap)");
          state.active = opts.cheapRef;
        } else {
          state.active = resolveModelRef(rest.join(" "), opts.config.provider);
        }
        stdout.write(dim(`model → ${formatModelRef(state.active)}\n`));
      } catch (e) {
        stdout.write(red(`${(e as Error).message}\n`));
      }
      return;
    }
    case "/tools":
      for (const t of opts.tools) {
        stdout.write(dim(`${t.name.padEnd(12)} ${t.group}${sessionAllowed.has(t.name) ? " (approved this session)" : ""}\n`));
      }
      return;
    case "/skills": {
      const all = listSkills(opts.home, opts.cwd);
      if (all.length === 0) {
        stdout.write(dim("no skills installed (~/.tenjin/skills or .tenjin/skills)\n"));
        return;
      }
      for (const s of all) {
        const pin = state.pinnedSkills.has(s.name) ? green(" ●") : "";
        stdout.write(`${s.name.padEnd(20)}${dim(` ${s.source}  ${s.description}`)}${pin}\n`);
      }
      return;
    }
    case "/skill": {
      const name = rest[0];
      if (!name) {
        stdout.write(red("usage: /skill <name> [off] | /skill new <name>\n"));
        return;
      }
      if (name === "new") {
        if (!rest[1]) {
          stdout.write(red("usage: /skill new <name>\n"));
          return;
        }
        try {
          const path = scaffoldSkill(opts.cwd, rest[1]);
          stdout.write(dim(`scaffolded ${path} — edit to taste\n`));
        } catch (e) {
          stdout.write(red(`${(e as Error).message}\n`));
        }
        return;
      }
      if (rest[1] === "off") {
        state.pinnedSkills.delete(name);
        stdout.write(dim(`unpinned ${name}\n`));
        return;
      }
      const skill = getSkill(opts.home, opts.cwd, name);
      if (!skill) {
        stdout.write(red(`unknown skill "${name}" — /skills to list\n`));
        return;
      }
      state.pinnedSkills.add(skill.name);
      stdout.write(
        dim(`pinned ${skill.name} — active from next message (/skill ${skill.name} off to unpin)\n`),
      );
      return;
    }
    case "/sessions": {
      if (!opts.sessionsDir) {
        stdout.write(red("sessions not available\n"));
        return;
      }
      const all = SessionLog.list(opts.sessionsDir);
      if (all.length === 0) {
        stdout.write(dim("no sessions yet\n"));
        return;
      }
      for (const s of all.slice(0, 15)) {
        const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(0, 16);
        const lineage = s.parentId ? dim(` ↳ forked from ${s.parentId}`) : "";
        stdout.write(`${s.id}  ${dim(`${when}  ${s.preview}`)}${lineage}\n`);
      }
      return;
    }
    case "/resume": {
      if (!opts.sessionsDir || !rest[0]) {
        stdout.write(red("usage: /resume <id>\n"));
        return;
      }
      try {
        const log = SessionLog.resolve(opts.sessionsDir, rest[0]);
        adoptLog(state, log, sessionAllowed);
        stdout.write(
          dim(`resumed ${log.id} — ${state.messages.length} messages restored\n`),
        );
      } catch (e) {
        stdout.write(red(`${(e as Error).message}\n`));
      }
      return;
    }
    case "/fork": {
      if (!opts.sessionsDir) {
        stdout.write(red("sessions not available\n"));
        return;
      }
      const n = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
      try {
        const log = SessionLog.fork(opts.sessionsDir, state.sessionId, n);
        adoptLog(state, log, sessionAllowed);
        stdout.write(dim(`forked → ${log.id} (${state.messages.length} messages)\n`));
      } catch (e) {
        stdout.write(red(`${(e as Error).message}\n`));
      }
      return;
    }
    case "/replay": {
      if (!state.logger) {
        stdout.write(red("no session log active\n"));
        return;
      }
      for (const line of renderTrajectory(state.logger.events())) {
        stdout.write(dim(line) + "\n");
      }
      return;
    }
    case "/memory": {
      if (!opts.memoryDir || !opts.sessionsDir) {
        stdout.write(red("memory not available\n"));
        return;
      }
      const summaries = listSummaries(opts.memoryDir);
      const projectSummaries = summaries.filter((s) => s.meta.projectPath === opts.cwd);
      const total = SessionLog.list(opts.sessionsDir).length;
      const pending = sessionsWithoutSummary(opts.sessionsDir, opts.memoryDir).length;
      const on = memoryEnabled(opts.config);
      const chunks = loadChunks(join(opts.memoryDir, "vectors.jsonl"));
      const facts = readFacts(opts.memoryDir);
      const factCount = facts ? facts.split("\n").length : 0;
      stdout.write(
        dim(
          `memory ${on ? "on" : "off"} · ${summaries.length} summaries (${projectSummaries.length} this project) · ${total} sessions · ${pending} pending\n`,
        ),
      );
      if (on) {
        stdout.write(
          dim(
            `vector: ${chunks.length} chunks indexed${chunks.length ? ` (${indexedSessionIds(chunks).size} sessions)` : ""} · facts: ${factCount}\n`,
          ),
        );
      }
      return;
    }
    case "/audit": {
      const tail = rest[0] !== undefined && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 20;
      for (const line of formatAudit(state.audit.query({ tail })).split("\n")) {
        stdout.write(dim(line) + "\n");
      }
      return;
    }
    default:
      stdout.write(red(`unknown command ${cmd} — /help\n`));
      return;
  }
}

async function approve(
  name: string,
  group: "read" | "write",
  input: unknown,
  config: HarnessConfig,
  rl: Interface,
  sessionAllowed: Set<string>,
  audit?: AuditLog,
  bot?: string,
  sessionMode?: { current: ModeLadder },
): Promise<ApproveDecision> {
  // B13-3 (#401): a T2 (irreversible/credential) call is NEVER auto-approved —
  // not via a policy "allow", not via a session-wide allow, and never
  // remembered for the session. It always prompts with the strongest shape.
  const tier = classifyRisk(name, input);
  const strong = isT2(tier);

  // B13-5 (#437): the mode ladder is the higher-level default. A session-scoped
  // override (`/mode`) wins over the config default; explicit per-tool policy
  // (config.approval) still wins where set; T2 stays vetoed by EVERY mode
  // (dontAsk denies it fast, others prompt — never auto-approve).
  const mode = sessionMode?.current ?? config.mode?.ladder ?? DEFAULT_MODE;
  const askRules = config.mode?.askRules ?? [];
  const bypassEnvReady = isIsolationEnvReady(config.mode?.bypassEnv);

  const policy = config.approval[name] ?? (group === "write" ? "ask" : "allow");
  if (policy === "deny") {
    stdout.write(dim(`  (blocked by policy: ${name})\n`));
    audit?.append("approval", "user", `${name} denied by policy`, bot);
    return false;
  }
  if (!strong && policy === "allow") return true;
  if (!strong && (sessionAllowed.has(name) || alwaysRules.has(name))) return true;

  // T2 veto: no mode auto-approves a T2 call. dontAsk denies fast (headless
  // fail-fast); every other mode falls through to the strong prompt below.
  if (strong && mode === "dontAsk") {
    recentlyDenied.add({ tool: name, tier, reason: "T2 in dontAsk" });
    stdout.write(dim(`  (dontAsk: ${name} auto-denied, no prompt)\n`));
    audit?.append("approval", "user", `${name} auto-denied (dontAsk mode)`, bot);
    return false;
  }

  // Mode ladder decides the default for T1 (and ASKs on T2 via the veto above).
  const preAllowed = new Set<string>([...sessionAllowed, ...alwaysRules]);
  const ladder = decideModeAction({ mode, tier, tool: name, input, askRules, preAllowed, bypassEnvReady });
  if (ladder.action === "DENY" || ladder.action === "REFUSE") {
    recentlyDenied.add({ tool: name, tier, reason: ladder.reason });
    stdout.write(dim(`  (${ladder.reason})\n`));
    audit?.append("approval", "user", `${name} ${ladder.action === "DENY" ? "denied by mode" : "refused by mode"} (${ladder.reason})`, bot);
    return false;
  }
  if (ladder.action === "ALLOW" && !strong) return true;

  // #406: one approval visible at a time — concurrent prompts serialize FIFO.
  return approvalQueue.run(async () => {
    const what = formatApprovalWhat(name, input);
    stdout.write("\n" + renderApprovalBlock({ tool: name, tier, what }) + "\n");
    const answered = await askApproval(rl, DEFAULT_APPROVAL_TIMEOUT_MS);
    if (answered === null) {
      // #406: timeout AUTO-DENIES — never allows.
      const verdict = timeoutVerdict();
      stdout.write(dim(`\n  (approval timed out — auto-${verdict.kind})\n`));
      audit?.append("approval", "user", `${name} auto-denied (timeout)`, bot);
      return false;
    }
    const parsed = parseApprovalAnswer(answered, { tier });
    if (parsed.kind === "comment") {
      // #406: tab-to-comment — the denial reason is fed back to the model.
      const comment = await askApproval(
        rl,
        DEFAULT_APPROVAL_TIMEOUT_MS,
        "  comment (reason for denial): ",
      );
      audit?.append("approval", "user", `${name} denied: ${comment ?? ""}`, bot);
      return { allowed: false, reason: denyFeedback(name, comment ?? undefined) };
    }
    const verdict = parsed.verdict;
    if (verdict.kind === "deny") {
      audit?.append("approval", "user", `${name} denied`, bot);
      return false;
    }
    if (verdict.scope === "session") sessionAllowed.add(name);
    if (verdict.scope === "always") {
      // always = NARROWEST scope: a rule for the exact tool, never a group.
      const rule = persistScope("always", name);
      if (rule) alwaysRules.add(rule.tool);
    }
    audit?.append("approval", "user", `${name} approved (${verdict.scope})`, bot);
    return true;
  });
}

/** #406: derive the literal command/path shown as the approval WHAT. */
function formatApprovalWhat(name: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const rec = input as Record<string, unknown>;
    if (typeof rec.command === "string") return rec.command;
    if (typeof rec.path === "string") return rec.path;
  }
  try {
    const s = JSON.stringify(input);
    return s ? s.slice(0, 300) : String(input);
  } catch {
    return String(input);
  }
}

/** #406: write a prompt and read one line, auto-denying (null) on timeout. */
async function askApproval(
  rl: Interface,
  timeoutMs: number,
  prompt = "  answer> ",
): Promise<string | null> {
  stdout.write(prompt);
  const line = new Promise<string>((resolve) => {
    const onLine = (l: string) => {
      rl.off("line", onLine);
      resolve(l);
    };
    rl.on("line", onLine);
  });
  const result = await withTimeout(line, timeoutMs);
  return result.ok ? result.value.trim() : null;
}

function adoptLog(state: ReplState, log: SessionLog, sessionAllowed: Set<string>): void {
  const events = log.events();
  state.messages = rebuildMessages(events);
  state.budget.spentUSD = sumUsage(events).spentUSD;
  state.logger = log;
  state.sessionId = log.id;
  sessionAllowed.clear();
}

function forwardEvent(e: TurnEvent, logger?: EventLogger, budget?: Budget): void {
  if (!logger) return;
  switch (e.t) {
    case "assistant_message":
      logger.append({ t: "message", role: "assistant", content: e.content, ts: now() });
      break;
    case "tool_call":
      logger.append({ t: "tool_call", id: e.id, name: e.name, input: e.input, ts: now() });
      break;
    case "tool_result":
      logger.append({ t: "tool_result", id: e.id, name: e.name, ok: e.ok, output: e.output, ts: now() });
      break;
    case "usage":
      logger.append({
        t: "usage",
        inputTokens: e.usage.inputTokens,
        outputTokens: e.usage.outputTokens,
        costUSD: e.costUSD,
        spentUSD: budget?.spentUSD ?? -1,
        ts: now(),
      });
      break;
    case "compression":
      logger.append({
        t: "compression",
        beforeTokens: e.beforeTokens,
        afterTokens: e.afterTokens,
        elidedTokens: e.elidedTokens,
        ts: now(),
      });
      break;
  }
}

function logEvent(logger: EventLogger | undefined, event: SessionEvent): void {
  logger?.append(event);
}

function printBanner(opts: ReplOptions, state: ReplState): void {
  const identity = opts.bot ? `${opts.bot} (bot)` : "solo";
  stdout.write(
    bold(`Tenjin v${VERSION}`) +
      dim(` · ${identity} · ${state.active.provider}:${state.active.model}`) +
      "\n",
  );
  stdout.write(
    dim(
      `budget ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "none"} · type /help for commands\n\n`,
    ),
  );
}

function now(): string {
  return new Date().toISOString();
}
