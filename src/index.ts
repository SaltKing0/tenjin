#!/usr/bin/env bun
import { stdout } from "node:process";
import { randomUUID } from "node:crypto";
import {
  ensureGlobalDir,
  loadConfig,
  tenjinHome,
  ConfigError,
  type HarnessConfig,
} from "./config/loader";
import { createProvider } from "./provider/factory";
import type { Provider } from "./provider/types";
import { loadSoul, loadAgentsMd, buildSystemPrompt } from "./agent/prompt";
import { Budget, formatUSD, pricingFor } from "./agent/budget";
import { runAgentTurn } from "./agent/loop";
import { startRepl } from "./ui/repl";
import { readTool } from "./tools/read";
import { globTool } from "./tools/glob";
import { grepTool } from "./tools/grep";
import type { ToolDef } from "./tools/registry";
import { VERSION, PRODUCT } from "./version";

const HELP = `${PRODUCT} v${VERSION} — personal agent harness

Usage:
  tenjin                     interactive REPL in current directory
  tenjin -p "<prompt>"       one-shot: answer and exit
  tenjin --model <id>        override configured model
  tenjin --provider <name>   anthropic | openai
  tenjin --budget <usd>      session spend cap

Options:
  -h, --help                 show this help
`;

interface CliArgs {
  help: boolean;
  print?: string;
  model?: string;
  provider?: string;
  budget?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "-p":
      case "--print": {
        const rest = argv.slice(i + 1).join(" ").trim();
        if (!rest) throw new ConfigError(`-p requires a prompt string`);
        args.print = rest;
        return args;
      }
      case "--model":
        args.model = argv[++i];
        break;
      case "--provider":
        args.provider = argv[++i];
        break;
      case "--budget":
        args.budget = Number(argv[++i]);
        break;
      default:
        throw new ConfigError(`Unknown argument: ${a}\n\n${HELP}`);
    }
  }
  return args;
}

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
    const { config } = loadConfig(cwd, home);
    applyOverrides(config, cli);
    const provider = createProvider(config);
    const soul = loadSoul(home, cwd);
    const system = buildSystemPrompt({
      soulText: soul.text,
      agentsMd: loadAgentsMd(cwd),
      cwd,
    });
    const tools: ToolDef[] = [readTool, globTool, grepTool];
    const ctx: AppContext = { config, provider, system, tools, cwd };

    if (cli.print !== undefined) {
      return await oneShot(ctx, cli.print);
    }

    await startRepl({ ...ctx, sessionId: randomUUID().slice(0, 8) });
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
