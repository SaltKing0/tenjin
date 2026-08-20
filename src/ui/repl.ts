import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Provider } from "../provider/types";
import type { ChatMessage } from "../provider/types";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/loader";
import { Budget, formatUSD, pricingFor, type Pricing } from "../agent/budget";
import { runAgentTurn, type TurnEvent } from "../agent/loop";
import type { EventLogger, SessionEvent } from "../session/events";
import { VERSION } from "../version";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

export interface ReplOptions {
  config: HarnessConfig;
  provider: Provider;
  system: string;
  tools: ToolDef[];
  cwd: string;
  sessionId: string;
  logger?: EventLogger;
  initialMessages?: ChatMessage[];
  initialSpentUSD?: number;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const messages: ChatMessage[] = [...(opts.initialMessages ?? [])];
  const budget = new Budget(opts.config.budgetUSD, pricingOf(opts));
  budget.spentUSD = opts.initialSpentUSD ?? 0;
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

  logEvent(opts.logger, {
    t: "session_start",
    id: opts.sessionId,
    ts: now(),
    provider: opts.provider.name,
    model: opts.config.model,
  });

  printBanner(opts);

  try {
    while (true) {
      const line = (await rl.question(bold("you> "))).trim();
      if (!line) continue;

      if (line.startsWith("/")) {
        const handled = await handleCommand(line, rl, opts, budget, sessionAllowed);
        if (handled === "exit") break;
        continue;
      }

      messages.push({ role: "user", content: line });
      logEvent(opts.logger, { t: "message", role: "user", content: line, ts: now() });

      controller = new AbortController();
      turnActive = true;
      stdout.write("\n");
      try {
        const result = await runAgentTurn({
          provider: opts.provider,
          model: opts.config.model,
          system: opts.system,
          tools: opts.tools,
          messages,
          budget,
          maxTokens: opts.config.maxTokens,
          cwd: opts.cwd,
          approve: (name, group, input) =>
            approve(name, group, input, opts.config, rl, sessionAllowed),
          onTextDelta: (d) => stdout.write(d),
          onEvent: (e) => forwardEvent(e, opts.logger, budget),
          signal: controller.signal,
        });
        stdout.write("\n");
        if (result.stopReason === "budget_exhausted") {
          stdout.write(red(`\nbudget cap reached (${formatUSD(budget.spentUSD)}). raise budgetUSD or /cost.\n`));
        } else if (result.stopReason === "max_iterations") {
          stdout.write(red(`\nstopped after ${25} tool iterations.\n`));
        }
        stdout.write(
          dim(
            `  [in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)} turn · ${formatUSD(budget.spentUSD)} total]\n`,
          ),
        );
      } catch (e) {
        stdout.write("\n");
        if ((e as Error)?.name === "AbortError") {
          stdout.write(dim("(interrupted)\n"));
        } else {
          const msg = (e as Error)?.message ?? String(e);
          stdout.write(red(`error: ${msg}\n`));
          logEvent(opts.logger, { t: "error", message: msg, ts: now() });
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

function pricingOf(opts: ReplOptions): Pricing {
  return pricingFor(opts.config.model, opts.config.pricing);
}

async function handleCommand(
  line: string,
  rl: Interface,
  opts: ReplOptions,
  budget: Budget,
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
          "",
        ].join("\n"),
      );
      return;
    case "/exit":
    case "/quit":
      return "exit";
    case "/cost":
      stdout.write(
        dim(
          `spent ${formatUSD(budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "no cap"}\n`,
        ),
      );
      return;
    case "/model":
      if (rest[0]) {
        opts.config.model = rest[0];
        stdout.write(dim(`model → ${rest[0]} (this session)\n`));
      } else {
        stdout.write(dim(`${opts.provider.name}:${opts.config.model}\n`));
      }
      return;
    case "/tools":
      for (const t of opts.tools) {
        stdout.write(dim(`${t.name.padEnd(12)} ${t.group}${sessionAllowed.has(t.name) ? " (approved this session)" : ""}\n`));
      }
      return;
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

function printBanner(opts: ReplOptions): void {
  stdout.write(
    bold(`Tenjin v${VERSION}`) +
      dim(` · ${opts.provider.name}:${opts.config.model}`) +
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
