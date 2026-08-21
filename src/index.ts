#!/usr/bin/env bun
import { stdout } from "node:process";
import {
  ensureGlobalDir,
  loadConfig,
  validateConfig,
  tenjinHome,
  sessionsDir,
  ConfigError,
  type HarnessConfig,
} from "./config/loader";
import { createProvider } from "./provider/factory";
import type { Provider } from "./provider/types";
import { loadSoul, loadAgentsMd, buildSystemPrompt } from "./agent/prompt";
import { Budget, formatUSD, pricingFor } from "./agent/budget";
import { runAgentTurn } from "./agent/loop";
import { startRepl } from "./ui/repl";
import { SessionLog } from "./session/log";
import { rebuildMessages, sumUsage } from "./session/events";
import { readTool } from "./tools/read";
import { globTool } from "./tools/glob";
import { grepTool } from "./tools/grep";
import { writeTool } from "./tools/write";
import { editTool } from "./tools/edit";
import { bashTool } from "./tools/bash";
import type { ToolDef } from "./tools/registry";
import { parseArgs, HELP, type CliArgs } from "./cli/args";
import { PRODUCT } from "./version";

interface AppContext {
  config: HarnessConfig;
  provider: Provider;
  system: string;
  tools: ToolDef[];
  cwd: string;
}

async function main(): Promise<number> {
  let cli: CliArgs;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (e) {
    stdout.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (cli.help) {
    stdout.write(HELP);
    return 0;
  }

  const cwd = process.cwd();
  const home = tenjinHome();
  const { created } = ensureGlobalDir(home);
  if (created) {
    stdout.write(
      `Welcome to ${PRODUCT}. Created ${home} — set your model in ${home}/config.yaml\nand add your SOUL.md to give it a personality.\n\n`,
    );
  }

  try {
    const { config } = loadConfig(cwd, home, { skipModelCheck: !!cli.model });
    applyOverrides(config, cli);
    validateConfig(config);
    const provider = createProvider(config);
    const soul = loadSoul(home, cwd);
    const system = buildSystemPrompt({
      soulText: soul.text,
      agentsMd: loadAgentsMd(cwd),
      cwd,
    });
    const tools: ToolDef[] = [
      readTool,
      globTool,
      grepTool,
      writeTool,
      editTool,
      bashTool,
    ];
    const ctx: AppContext = { config, provider, system, tools, cwd };

    if (cli.print !== undefined) {
      return await oneShot(ctx, cli.print);
    }

    const dir = sessionsDir(home);
    if (cli.resume) {
      const log = SessionLog.resolve(dir, cli.resume);
      const events = log.events();
      await startRepl({
        ...ctx,
        sessionId: log.id,
        logger: log,
        sessionsDir: dir,
        initialMessages: rebuildMessages(events),
        initialSpentUSD: sumUsage(events).spentUSD,
      });
      return 0;
    }

    const log = SessionLog.create(dir);
    await startRepl({
      ...ctx,
      sessionId: log.id,
      logger: log,
      sessionsDir: dir,
    });
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}

function applyOverrides(config: HarnessConfig, cli: CliArgs): void {
  if (cli.model) config.model = cli.model;
  if (cli.provider) {
    if (cli.provider !== "anthropic" && cli.provider !== "openai") {
      throw new ConfigError(`--provider must be anthropic or openai`);
    }
    config.provider = cli.provider;
  }
  if (cli.budget !== undefined && !Number.isNaN(cli.budget)) {
    config.budgetUSD = cli.budget;
  }
}

async function oneShot(ctx: AppContext, prompt: string): Promise<number> {
  const budget = new Budget(
    ctx.config.budgetUSD,
    pricingFor(ctx.config.model, ctx.config.pricing),
  );
  const messages = [{ role: "user" as const, content: prompt }];
  let deniedOnce = false;

  const result = await runAgentTurn({
    provider: ctx.provider,
    model: ctx.config.model,
    system: ctx.system,
    tools: ctx.tools,
    messages,
    budget,
    maxTokens: ctx.config.maxTokens,
    cwd: ctx.cwd,
    approve: async (name, group) => {
      void group;
      if (!deniedOnce) {
        stdout.write(`(note: tool "${name}" needs approval — not available in -p mode)\n`);
        deniedOnce = true;
      }
      return false;
    },
    onTextDelta: (d) => stdout.write(d),
  });
  stdout.write("\n");
  stdout.write(
    `  [in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)}]\n`,
  );
  return result.stopReason === "end_turn" ? 0 : 1;
}

process.exitCode = await main();
