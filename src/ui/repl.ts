import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { ChatMessage, Provider } from "../provider/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveModelRef, formatModelRef, type ModelRef } from "../config/models";
import { ConfigError } from "../config/types";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/loader";
import { Budget, formatUSD } from "../agent/budget";
import { runAgentTurn, type TurnEvent } from "../agent/loop";
import type { EventLogger, SessionEvent } from "../session/events";
import { rebuildMessages, sumUsage } from "../session/events";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";
import { buildSkillsSection, summarizeSkills } from "../skills/activate";
import { getSkill, listSkills, scaffoldSkill } from "../skills/loader";
import { listSummaries, sessionsWithoutSummary } from "../memory/summaries";
import { loadChunks, indexedSessionIds } from "../memory/vector-store";
import { readFacts } from "../tools/memory";
import { memoryEnabled } from "../config/loader";
import { VERSION } from "../version";

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
  const rl = createInterface({ input: stdin, output: stdout });
  const state = {
    messages: [...(opts.initialMessages ?? [])],
    budget: new Budget(opts.config.budgetUSD, opts.config.pricing),
    logger: opts.logger,
    sessionId: opts.sessionId,
    active: opts.defaultRef,
    pinnedSkills: new Set<string>(),
  };
  state.budget.spentUSD = opts.initialSpentUSD ?? 0;
  const sessionAllowed = new Set<string>();

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
        const handled = await handleCommand(line, rl, opts, state, sessionAllowed);
        if (handled === "exit") break;
        continue;
      }

      state.messages.push({ role: "user", content: line });
      logEvent(state.logger, { t: "message", role: "user", content: line, ts: now() });

      controller = new AbortController();
      turnActive = true;
      stdout.write("\n");
      const skillsSection = buildSkillsSection(opts.home, opts.cwd, state.pinnedSkills);
      const turnSystem = skillsSection ? `${opts.system}\n\n${skillsSection}` : opts.system;
      try {
        const result = await runAgentTurn({
          provider: activeProvider(opts, state),
          model: state.active.model,
          system: turnSystem,
          tools: opts.tools,
          messages: state.messages,
          budget: state.budget,
          maxTokens: opts.config.maxTokens,
          cwd: opts.cwd,
          approve: (name, group, input) =>
            approve(name, group, input, opts.config, rl, sessionAllowed),
          onTextDelta: (d) => stdout.write(d),
          onEvent: (e) => forwardEvent(e, state.logger, state.budget),
          signal: controller.signal,
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
  logger: SessionLog | undefined;
  sessionId: string;
  active: ModelRef;
  pinnedSkills: Set<string>;
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
          "/tools           list available tools",
          "/sessions        list saved sessions",
          "/resume <id>     continue a previous session",
          "/fork [n]        branch current conversation at event n",
          "/replay          print trajectory of this session",
          "/memory          memory layer status",
          "/whoami          current identity and model",
          "/skills          list installed skills",
          "/skill <n> [off] pin a skill into every turn",
          "",
        ].join("\n"),
      );
      return;
    case "/exit":
    case "/quit":
      return "exit";
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
    default:
      stdout.write(red(`unknown command ${cmd} — /help\n`));
      return;
  }
}

async function approve(
  name: string,
  group: "read" | "write",
  _input: unknown,
  config: HarnessConfig,
  rl: Interface,
  sessionAllowed: Set<string>,
): Promise<boolean> {
  if (sessionAllowed.has(name)) return true;
  const policy = config.approval[name] ?? (group === "write" ? "ask" : "allow");
  if (policy === "allow") return true;
  if (policy === "deny") {
    stdout.write(dim(`  (blocked by policy: ${name})\n`));
    return false;
  }
  const answer = (await rl.question(green(`  approve ${name}? [y/N/a] `))).trim().toLowerCase();
  if (answer === "a") {
    sessionAllowed.add(name);
    return true;
  }
  return answer === "y" || answer === "yes";
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
