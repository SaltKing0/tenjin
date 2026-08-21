#!/usr/bin/env bun
import { stdout } from "node:process";
import { mkdirSync } from "node:fs";
import {
  ensureGlobalDir,
  loadConfig,
  validateConfig,
  tenjinHome,
  sessionsDir,
  memoryDir,
  memoryEnabled,
  ConfigError,
  type HarnessConfig,
} from "./config/loader";
import { createProvider } from "./provider/factory";
import { ProviderRegistry } from "./provider/registry";
import { defaultModelRef, cheapModelRef, resolveModelRef, type ModelRef } from "./config/models";
import { loadSoul, loadAgentsMd, buildSystemPrompt } from "./agent/prompt";
import { Budget, formatUSD, pricingFor } from "./agent/budget";
import { runAgentTurn } from "./agent/loop";
import { runHeadless } from "./agent/headless";
import { startRepl } from "./ui/repl";
import { SessionLog } from "./session/log";
import { rebuildMessages, sumUsage } from "./session/events";
import { generatePendingSummaries, listSummaries } from "./memory/summaries";
import { buildMemorySection } from "./memory/inject";
import { indexPendingSessions } from "./memory/indexer";
import { createEmbeddings } from "./provider/embeddings";
import { vectorEnabled } from "./config/loader";
import { createRecallTool, createRememberTool, readFacts } from "./tools/memory";
import { createUseSkillTool } from "./skills/activate";
import { createSaveSkillTool } from "./tools/skill-writer";
import {
  resolveBot,
  botModelRef,
  botBudgetUSD,
  createBot,
  listBots,
  EXAMPLE_BOTS,
  type BotProfile,
} from "./bots/profile";
import { createSendMessageTool, createCheckInboxTool } from "./bots/tools";
import { createAskBotTool } from "./bots/delegate";
import { Gateway } from "./gateway/gateway";
import { TelegramChannel, routeText } from "./gateway/telegram";
import { unreadMessages } from "./bots/inbox";
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
  registry: ProviderRegistry;
  defaultRef: ModelRef;
  cheapRef: ModelRef | null;
  system: string;
  tools: ToolDef[];
  cwd: string;
}

async function main(): Promise<number> {
  if (process.argv[2] === "bot") {
    return botCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "gateway") {
    return gatewayCommand(process.argv.slice(3));
  }

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
    const { config } = loadConfig(cwd, home, {
      skipModelCheck: !!cli.model || !!cli.bot,
    });
    const profile = cli.bot ? resolveBot(home, cli.bot) : null;
    applyOverrides(config, cli);
    validateConfig(config);
    if (profile) {
      mkdirSync(profile.sessionsDir, { recursive: true });
      mkdirSync(profile.memoryDir, { recursive: true });
      mkdirSync(profile.inboxDir, { recursive: true });
      config.budgetUSD = botBudgetUSD(profile, config.budgetUSD);
    }
    const registry = new ProviderRegistry(config.providers?.openai?.baseUrl);
    const defaultRef = cli.model
      ? resolveModelRef(cli.model, config.provider)
      : profile
        ? botModelRef(profile, config)
        : defaultModelRef(config);
    const cheapRef = cheapModelRef(config);

    const dir = profile ? profile.sessionsDir : sessionsDir(home);
    const memDir = profile ? profile.memoryDir : memoryDir(home);
    const embeddings = vectorEnabled(config)
      ? createEmbeddings({ model: config.memory?.vector?.model })
      : null;
    if (memoryEnabled(config) && cli.print === undefined && !cli.fork && !cli.resume) {
      try {
        const sumRef = cheapRef ?? defaultRef;
        const report = await generatePendingSummaries({
          sessionsDirPath: dir,
          memoryDirPath: memDir,
          provider: registry.get(sumRef.provider),
          model: sumRef.model,
          maxTokens: config.maxTokens,
          projectPath: cwd,
        });
        for (const err of report.errors) {
          stdout.write(`memory: ${err}\n`);
        }
      } catch (e) {
        stdout.write(`memory: skipped (${(e as Error).message})\n`);
      }

      if (embeddings) {
        try {
          const report = await indexPendingSessions({
            sessionsDirPath: dir,
            memoryDirPath: memDir,
            projectPath: cwd,
            embeddings,
          });
          for (const err of report.errors) {
            stdout.write(`memory: ${err}\n`);
          }
        } catch (e) {
          stdout.write(`memory: vector index skipped (${(e as Error).message})\n`);
        }
      } else if (config.memory?.vector?.enabled === true) {
        stdout.write("memory: vector layer requested but OPENAI_API_KEY is not set\n");
      }
    }

    if (profile) {
      const unread = unreadMessages(profile.inboxDir);
      if (unread.length > 0) {
        stdout.write(
          `inbox: ${unread.length} unread from ${[...new Set(unread.map((m) => m.from))].join(", ")} — check_inbox to read\n`,
        );
      }
    }

    const soul = profile
      ? { text: profile.soulText, source: "bot" as const }
      : loadSoul(home, cwd);
    const system = buildSystemPrompt({
      soulText: soul.text,
      agentsMd: loadAgentsMd(cwd),
      cwd,
      facts: readFacts(memDir),
      memorySection:
        memoryEnabled(config)
          ? buildMemorySection(listSummaries(memDir), { currentProject: cwd })
          : null,
    });
    const tools: ToolDef[] = [
      readTool,
      globTool,
      grepTool,
      writeTool,
      editTool,
      bashTool,
    ];
    if (memoryEnabled(config)) {
      tools.push(createRememberTool({ memoryDirPath: memDir }));
      tools.push(createRecallTool({ memoryDirPath: memDir, projectPath: cwd, embeddings }));
    }
    tools.push(createUseSkillTool({ home, projectDir: cwd }));
    tools.push(createSaveSkillTool({ projectDir: cwd }));
    if (profile) {
      tools.push(createSendMessageTool({ home, fromBot: profile.name }));
      tools.push(createCheckInboxTool({ profile }));
    }
    const ctx: AppContext = { config, registry, defaultRef, cheapRef, system, tools, cwd };

    if (cli.print !== undefined) {
      return await oneShot(ctx, cli.print);
    }

    if (cli.fork) {
      const log = SessionLog.fork(dir, cli.fork.id, cli.fork.uptoEvent);
      stdout.write(`forked ${cli.fork.id} → ${log.id}\n`);
      await continueSession(ctx, dir, log, memDir);
      return 0;
    }
    if (cli.resume) {
      const log = SessionLog.resolve(dir, cli.resume);
      await continueSession(ctx, dir, log, memDir);
      return 0;
    }

    const log = SessionLog.create(dir);
    await startRepl({
      ...ctx,
      sessionId: log.id,
      logger: log,
      sessionsDir: dir,
      memoryDir: memDir,
      home,
      bot: profile?.name,
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

function botCommand(args: string[]): number {
  const [sub, name] = args;
  const home = tenjinHome();
  try {
    switch (sub) {
      case "new": {
        if (!name) {
          stdout.write("usage: tenjin bot new <name>\n");
          return 2;
        }
        const dir = createBot(home, name);
        stdout.write(`created bot at ${dir} — edit SOUL.md to give it a role\n`);
        return 0;
      }
      case "list": {
        const bots = listBots(home);
        if (bots.length === 0) {
          stdout.write("no bots yet — tenjin bot init-examples or tenjin bot new <name>\n");
          return 0;
        }
        for (const b of bots) stdout.write(`${b}\n`);
        return 0;
      }
      case "init-examples": {
        let created = 0;
        for (const ex of EXAMPLE_BOTS) {
          try {
            createBot(home, ex.name, { soul: ex.soul });
            created++;
          } catch {
            // already exists
          }
        }
        stdout.write(
          created > 0
            ? `created ${created} example bot(s): ${EXAMPLE_BOTS.map((b) => b.name).join(", ")}\n`
            : "example bots already exist\n",
        );
        return 0;
      }
      default:
        stdout.write("usage: tenjin bot new|list|init-examples\n");
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

async function gatewayCommand(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const home = tenjinHome();
  const cwd = process.cwd();
  try {
    const { config } = loadConfig(cwd, home, { skipModelCheck: dryRun });
    if (!dryRun) validateConfig(config);
    const registry = new ProviderRegistry(config.providers?.openai?.baseUrl);
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    const log = (l: string) => stdout.write(`${l}\n`);
    const gateway = new Gateway({ home, cwd, config, registry, log });

    const channels: Record<string, (text: string) => Promise<void>> = {};
    let telegramRun: Promise<void> | null = null;
    const tg = gateway.settings.telegram;
    if (tg?.enabled) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new ConfigError("gateway.telegram enabled but TELEGRAM_BOT_TOKEN is not set");
      const defaultBot = tg.defaultBot as string;
      const available = listBots(home);
      if (!available.includes(defaultBot)) {
        throw new ConfigError(`telegram defaultBot "${defaultBot}" does not exist`);
      }
      const channel = new TelegramChannel(
        {
          token,
          defaultBot,
          allowedUsers: tg.allowedUsers,
          apiBase: process.env.TELEGRAM_API_BASE,
        },
        async (msg) => {
          const { bot: botName, rest } = routeText(msg.text, defaultBot, available);
          const profile = resolveBot(home, botName);
          const ref = botModelRef(profile, config);
          const result = await runHeadless({
            provider: registry.get(ref.provider),
            model: ref.model,
            soulText: profile.soulText,
            cwd,
            message: rest,
            maxTokens: config.maxTokens,
            capUSD: botBudgetUSD(profile, config.budgetUSD),
            policy: "read-only",
            agentsMd: loadAgentsMd(cwd),
            sessionLogDir: profile.sessionsDir,
            sessionBot: profile.name,
          });
          log(`telegram: handled for ${botName} (${formatUSD(result.costUSD)})`);
          return result.text || null;
        },
        log,
      );
      channels["telegram"] = async (text) => {
        if (!tg.adminChatId) throw new ConfigError("postTo telegram requires gateway.telegram.adminChatId");
        await channel.send(tg.adminChatId, text);
      };
      telegramRun = channel.run(controller.signal);
    }

    if (dryRun) {
      stdout.write("gateway dry-run:\n");
      for (const line of gateway.describe()) stdout.write(`  ${line}\n`);
      return 0;
    }

    stdout.write(`gateway running — Ctrl-C to stop\n`);
    await Promise.all([gateway.run(controller.signal), ...(telegramRun ? [telegramRun] : [])]);
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

async function continueSession(
  ctx: AppContext,
  dir: string,
  log: SessionLog,
  memDir?: string,
): Promise<void> {
  const events = log.events();
  await startRepl({
    ...ctx,
    sessionId: log.id,
    logger: log,
    sessionsDir: dir,
    memoryDir: memDir,
    home: tenjinHome(),
    initialMessages: rebuildMessages(events),
    initialSpentUSD: sumUsage(events).spentUSD,
  });
}

function applyOverrides(config: HarnessConfig, cli: CliArgs): void {
  if (cli.model) {
    config.model = cli.model;
    if (config.models) delete config.models.default;
  }
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
  const result = await runHeadless({
    provider: ctx.registry.get(ctx.defaultRef.provider),
    model: ctx.defaultRef.model,
    soulText: loadSoul(tenjinHome(), ctx.cwd).text,
    cwd: ctx.cwd,
    message: prompt,
    maxTokens: ctx.config.maxTokens,
    capUSD: ctx.config.budgetUSD,
    policy: "read-only",
    agentsMd: loadAgentsMd(ctx.cwd),
  });
  stdout.write(`${result.text}\n`);
  stdout.write(
    `  [in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)}]\n`,
  );
  return result.stopReason === "end_turn" ? 0 : 1;
}

process.exitCode = await main();
