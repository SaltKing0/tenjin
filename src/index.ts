#!/usr/bin/env bun
import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { dirname, basename, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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
import { formatUSD } from "./agent/budget";
import { runAgentTurn } from "./agent/loop";
import { runHeadless, capPolicy, applyDenyTools } from "./agent/headless";
import { startRepl } from "./ui/repl";
import { SessionLog } from "./session/log";
import { rebuildMessages, sumUsage } from "./session/events";
import { generatePendingSummaries, listSummaries } from "./memory/summaries";
import { buildMemorySection } from "./memory/inject";
import { indexPendingSessions } from "./memory/indexer";
import { VectorStore, vectorsFilePath } from "./memory/vector-store";
import { createEmbeddings } from "./provider/embeddings";
import { vectorEnabled } from "./config/loader";
import { createRecallTool, createRememberTool, createRecordLearningTool, readFacts } from "./tools/memory";
import { readLearnings } from "./memory/learnings";
import { createUseSkillTool } from "./skills/activate";
import { createSaveSkillTool } from "./tools/skill-writer";
import { createListSkillsTool } from "./tools/skill-lister";
import {
  resolveBot,
  botModelRef,
  botBudgetUSD,
  createBot,
  listBots,
  EXAMPLE_BOTS,
  type BotProfile,
  type BotSecurityConfig,
} from "./bots/profile";
import { createSendMessageTool, createCheckInboxTool } from "./bots/tools";
import { createAskBotTool } from "./bots/delegate";
import { Gateway } from "./gateway/gateway";
import {
  SecurityGuard,
  announceGuardDisabled,
  buildGuardStatus,
  guardForBot,
} from "./security/guard";
import { Redactor } from "./security/redact";
import { AuditLog, formatAudit, auditPath } from "./audit/log";
import { aggregateSpend, renderSpend } from "./audit/spend";
import { TelegramChannel } from "./gateway/telegram";
import { createMessageHandler, chatStreamResponse, type HandleContext } from "./gateway/handler";
import { startHttpServer } from "./gateway/http";
import { createConsoleApi } from "./gateway/console-api";
import {
  createRequest,
  resolveRequest,
  waitApproval,
  summarizeInput,
} from "./gateway/approvals";
import { inboxPolicyFromConfig, leaveUserMessage, unreadMessages } from "./bots/inbox";
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
  home: string;
  memoryDir: string;
  guard: ReturnType<typeof SecurityGuard.fromConfig>;
  botSecurity?: BotSecurityConfig;
}

async function main(): Promise<number> {
  if (process.argv[2] === "bot") {
    return botCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "tell") {
    return tellCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "gateway") {
    return gatewayCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "audit") {
    return auditCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "spend") {
    return spendCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "doctor") {
    return doctorCommand();
  }

  if (process.argv[2] === "export") {
    return exportCommand(process.argv.slice(3));
  }

  if (process.argv[2] === "forget") {
    process.exitCode = await forgetCommand(process.argv.slice(3));
    return process.exitCode;
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
    const audit = new AuditLog(auditPath(home));
    announceGuardDisabled({
      security: config.security,
      log: (line) => stdout.write(`${line}\n`),
      audit,
    });
    if (profile) {
      mkdirSync(profile.sessionsDir, { recursive: true });
      mkdirSync(profile.memoryDir, { recursive: true });
      mkdirSync(profile.inboxDir, { recursive: true });
      config.budgetUSD = botBudgetUSD(profile, config.budgetUSD);
    }
    const registry = new ProviderRegistry(
      config.providers?.openai?.baseUrl,
      undefined,
      config.retry,
      config.providers?.anthropic?.caching,
      config.providers?.anthropic?.baseUrl,
    );
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
    // In-memory vector index, loaded (and compacted) once at boot. Shared by the
    // boot index pass and the recall tool so neither re-reads the whole log.
    let vectorStore: VectorStore | null = null;
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
          vectorStore = VectorStore.open(vectorsFilePath(memDir));
          // Compaction removes duplicate/stale chunks so the log stays bounded.
          const compacted = vectorStore.compact();
          if (compacted.removed > 0) {
            stdout.write(
              `memory: compacted vector store (${compacted.removed} duplicate/stale chunk(s) removed)\n`,
            );
          }
          const report = await indexPendingSessions({
            sessionsDirPath: dir,
            memoryDirPath: memDir,
            projectPath: cwd,
            embeddings,
            store: vectorStore,
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

    const inboxPolicy = inboxPolicyFromConfig(config.inbox);
    if (profile) {
      const unread = unreadMessages(profile.inboxDir, inboxPolicy);
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
          ? buildMemorySection(listSummaries(memDir), {
              currentProject: cwd,
              learnings: readLearnings(memDir, cwd),
            })
          : null,
    });
    let tools: ToolDef[] = [
      readTool,
      globTool,
      grepTool,
      writeTool,
      editTool,
      bashTool,
    ];
    if (memoryEnabled(config)) {
      tools.push(createRememberTool({ memoryDirPath: memDir }));
      tools.push(createRecordLearningTool({ memoryDirPath: memDir, projectPath: cwd }));
      tools.push(createRecallTool({ memoryDirPath: memDir, projectPath: cwd, embeddings, store: vectorStore ?? undefined }));
    }
    tools.push(createUseSkillTool({ home, projectDir: cwd }));
    tools.push(createSaveSkillTool({ projectDir: cwd }));
    tools.push(createListSkillsTool({ home, projectDir: cwd }));
    if (profile) {
      tools.push(createSendMessageTool({ home, fromBot: profile.name, policy: inboxPolicy }));
      tools.push(createCheckInboxTool({ profile, policy: inboxPolicy }));
      const policy = capPolicy("full", profile.config.security?.policy);
      if (policy === "none") tools = [];
      else if (policy === "read-only") tools = tools.filter((t) => t.group === "read");
      tools = applyDenyTools(tools, profile.config.security?.denyTools);
    }
    const guard = guardForBot(config.security, profile?.config.security, (detail) =>
      audit.append("tool_block", "user", detail),
    );
    const ctx: AppContext = {
      config,
      registry,
      defaultRef,
      cheapRef,
      system,
      tools,
      cwd,
      home,
      memoryDir: memDir,
      guard,
      botSecurity: profile?.config.security,
    };

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

function tellCommand(args: string[]): number {
  const name = args[0];
  const text = args.slice(1).join(" ");
  if (!name || !text.trim()) {
    stdout.write("usage: tenjin tell <bot> <text>\n");
    return 2;
  }
  const home = tenjinHome();
  try {
    const profile = resolveBot(home, name);
    const msg = leaveUserMessage(profile.inboxDir, profile.name, text);
    stdout.write(`left message for ${profile.name} (id ${msg.id})\n`);
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

function spendCommand(args: string[]): number {
  let days = 0;
  let bot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--days") days = Number(args[++i]);
    else if (args[i] === "--bot") bot = args[++i];
  }
  const rows = aggregateSpend(tenjinHome(), { days, bot });
  stdout.write(renderSpend(rows) + "\n");
  return 0;
}

function auditCommand(args: string[]): number {
  let tail = 50;
  let bot: string | undefined;
  let kind: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tail") tail = Number(args[++i]);
    else if (args[i] === "--bot") bot = args[++i];
    else if (args[i] === "--kind") kind = args[++i];
  }
  const audit = new AuditLog(auditPath(tenjinHome()));
  stdout.write(
    formatAudit(audit.query({ tail, bot, kind: kind as never })) + "\n",
  );
  return 0;
}

async function gatewayCommand(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const home = tenjinHome();
  const cwd = process.cwd();
  try {
    const { config } = loadConfig(cwd, home, { skipModelCheck: true });
    const registry = new ProviderRegistry(
      config.providers?.openai?.baseUrl,
      {
        anthropic: config.providers?.anthropic?.apiKey,
        openai: config.providers?.openai?.apiKey,
      },
      config.retry,
      config.providers?.anthropic?.caching,
      config.providers?.anthropic?.baseUrl,
    );
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    const log = (l: string) => stdout.write(`${l}\n`);
    const audit = new AuditLog(auditPath(home));
    announceGuardDisabled({
      security: config.security,
      log,
      audit,
    });
    const guard = SecurityGuard.fromConfig(config.security, (detail) =>
      audit.append("tool_block", "gateway", detail),
    );
    const gateway = new Gateway({ home, cwd, config, registry, log, guard });

    const channels: Record<string, (text: string) => Promise<void>> = {};
    let telegramRun: Promise<void> | null = null;
    let telegramHandle:
      | ((
          text: string,
          opts?: { onDelta?: (d: string) => void },
        ) => Promise<string | null>)
      | null = null;
    const tg = gateway.settings.telegram;
    if (tg?.enabled || gateway.settings.listen) {
      const available = listBots(home);
      const defaultBot = tg?.defaultBot ?? available[0];
      if (!defaultBot) {
        throw new ConfigError("gateway needs at least one bot (tenjin bot new <name>)");
      }
      if (tg?.enabled && !available.includes(defaultBot)) {
        throw new ConfigError(`telegram defaultBot "${defaultBot}" does not exist`);
      }
      const handleMessage = createMessageHandler({
        home,
        cwd,
        config,
        registry,
        availableBots: available,
        defaultBot,
        allowWrites: gateway.settings.allowWrites,
        approvalTimeoutMs: tg?.approvalTimeoutMs ?? 120_000,
        guard,
        audit,
        log,
      });
      telegramHandle = (text, opts) =>
        handleMessage(text, { actor: "http", source: "http", onDelta: opts?.onDelta });
    }
    if (tg?.enabled) {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new ConfigError("gateway.telegram enabled but TELEGRAM_BOT_TOKEN is not set");
      const defaultBot = tg.defaultBot as string;
      const available = listBots(home);
      const allowWrites = tg.allowWrites === true;
      const approvalTimeoutMs = tg.approvalTimeoutMs ?? 120_000;
      let channel: TelegramChannel;
      const notifyApproval =
        tg.adminChatId !== undefined
          ? async (chatId: number, text: string) => channel.send(chatId, text)
          : undefined;
      const handleForTelegram = createMessageHandler({
        home,
        cwd,
        config,
        registry,
        availableBots: available,
        defaultBot,
        allowWrites,
        approvalTimeoutMs,
        guard,
        audit,
        log,
        notifyApproval,
        telegramBindings: tg.bindings,
      });
      channel = new TelegramChannel(
        {
          token,
          defaultBot,
          allowedUsers: tg.allowedUsers,
          apiBase: process.env.TELEGRAM_API_BASE,
          rateLimitMax: tg.rateLimitMax,
          rateLimitWindowMs: tg.rateLimitWindowMs,
          maxMessageLength: tg.maxMessageLength,
          onRejected: (info) =>
            audit.append(
              "channel_reject",
              String(info.userId),
              `telegram message rejected (${info.reason})`,
            ),
        },
        (msg) =>
          handleForTelegram(msg.text, {
            actor: String(msg.userId),
            source: "telegram",
            chatId: msg.chatId,
            userId: msg.userId,
          }),
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

    const runners: Promise<void>[] = [gateway.run(controller.signal)];
    if (telegramRun) runners.push(telegramRun);

    if (gateway.settings.listen) {
      const listen = gateway.settings.listen;
      const http = startHttpServer({
        config: listen,
        handleMessage: (text) =>
          telegramHandle
            ? telegramHandle(text)
            : Promise.resolve(null),
        status: () => ({
          jobs: gateway.jobs.map((j) => ({
            name: j.name,
            bot: j.botName,
            nextDueMs: j.nextDueMs,
          })),
          channels: Object.keys(channels),
          guard: buildGuardStatus(
            config.security,
            audit.query({ kind: "tool_block" }).length,
          ),
        }),
        api: createConsoleApi({
          home,
          cwd,
          config,
          registry,
          audit,
          jobs: {
            list: () => gateway.listJobs(),
            runNow: (name) => gateway.runNow(name),
          },
        }),
        streamChat: async (req) => {
          if (!telegramHandle) return null;
          let body: { text?: unknown; bot?: unknown };
          try {
            body = (await req.json()) as { text?: unknown; bot?: unknown };
          } catch {
            return Response.json({ error: "invalid json" }, { status: 400 });
          }
          if (typeof body.text !== "string" || !body.text.trim()) {
            return Response.json({ error: "text is required" }, { status: 400 });
          }
          const text = body.bot
            ? `@${String(body.bot)} ${body.text}`
            : body.text;
          const ctx: HandleContext = { actor: "console", source: "http" };
          return chatStreamResponse(
            (t, handleCtx) => telegramHandle!(t, { onDelta: handleCtx.onDelta }),
            text,
            ctx,
          );
        },
        consoleDir: join(import.meta.dir, "gateway", "console"),
        log,
      });
      stdout.write(`http api listening on ${listen.host}:${http.port}\n`);
      stdout.write(`web console: http://${listen.host === "0.0.0.0" ? "localhost" : listen.host}:${http.port}/?token=<gateway.listen.token>\n`);
      controller.signal.addEventListener("abort", () => http.stop(), { once: true });
    }

    stdout.write(`gateway running — Ctrl-C to stop\n`);
    await Promise.all(runners);
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
    soulText: loadSoul(ctx.home, ctx.cwd).text,
    cwd: ctx.cwd,
    message: prompt,
    maxTokens: ctx.config.maxTokens,
    capUSD: ctx.config.budgetUSD,
    pricing: ctx.config.pricing,
    globalBudget: ctx.config.globalBudget,
    policy: capPolicy("read-only", ctx.botSecurity?.policy),
    denyTools: ctx.botSecurity?.denyTools,
    agentsMd: loadAgentsMd(ctx.cwd),
    home: ctx.home,
    memoryDir: ctx.memoryDir,
    guard: ctx.guard,
    audit: (kind, detail, correlationId) =>
      new AuditLog(auditPath(ctx.home)).append(kind, "user", detail, undefined, correlationId),
    redactor: Redactor.fromConfig(ctx.config.security),
  });
  stdout.write(`${result.text}\n`);
  stdout.write(
    `  [in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)}]\n`,
  );
  return result.stopReason === "end_turn" ? 0 : 1;
}

process.exitCode = await main();

function doctorCommand(): number {
  const home = tenjinHome();
  const cwd = process.cwd();
  const checks: Array<{ state: "ok" | "warn" | "fail"; label: string; detail?: string }> = [];
  const add = (state: "ok" | "warn" | "fail", label: string, detail?: string) =>
    checks.push({ state, label, detail });

  let config: HarnessConfig | null = null;
  try {
    const loaded = loadConfig(cwd, home, { skipModelCheck: true });
    config = loaded.config;
    add("ok", "config loads");
  } catch (e) {
    add("fail", "config loads", (e as Error).message);
  }

  if (config) {
    const ref = defaultModelRef(config);
    if (ref.model) add("ok", `model ${ref.provider}:${ref.model}`);
    else add("warn", "no model configured", "set model in ~/.tenjin/config.yaml");

    const needsAnthropic =
      ref.provider === "anthropic" || cheapModelRef(config)?.provider === "anthropic";
    const needsOpenai =
      ref.provider === "openai" || cheapModelRef(config)?.provider === "openai";
    if (needsAnthropic) {
      if (process.env.ANTHROPIC_API_KEY) add("ok", "ANTHROPIC_API_KEY set");
      else add("fail", "ANTHROPIC_API_KEY missing", "required by anthropic model tier");
    }
    if (needsOpenai) {
      if (process.env.OPENAI_API_KEY) add("ok", "OPENAI_API_KEY set");
      else add("warn", "OPENAI_API_KEY missing", "needed for openai tiers + vector memory");
    }
    if (vectorEnabled(config)) {
      if (process.env.OPENAI_API_KEY) add("ok", "vector memory ready");
      else add("warn", "vector memory on but no OPENAI_API_KEY", "recall will be unavailable");
    }
    if (config.security?.disabled) {
      add("warn", "security guard DISABLED", "security.disabled: true — tools run without policy");
    } else {
      add("ok", "security guard active");
    }
    if (config.gateway && typeof config.gateway === "object") {
      const tg = (config.gateway as Record<string, unknown>).telegram;
      if (
        tg &&
        typeof tg === "object" &&
        (tg as Record<string, unknown>).enabled === true &&
        !process.env.TELEGRAM_BOT_TOKEN
      ) {
        add("fail", "TELEGRAM_BOT_TOKEN missing", "gateway.telegram is enabled");
      } else {
        add("ok", "gateway telegram token present or disabled");
      }
    }
  }

  try {
    ensureGlobalDir(home);
    const probe = join(home, ".doctor-probe");
    writeFileSync(probe, "x");
    rmSync(probe);
    add("ok", `${home} writable`);
  } catch (e) {
    add("fail", `${home} writable`, (e as Error).message);
  }

  const bots = listBots(home);
  add(bots.length ? "ok" : "warn", `${bots.length} bot(s)`, bots.join(", ") || undefined);

  for (const c of checks) {
    const icon = c.state === "ok" ? "✅" : c.state === "warn" ? "⚠️ " : "❌";
    stdout.write(`${icon} ${c.label}${c.detail ? ` — ${c.detail}` : ""}\n`);
  }
  return checks.some((c) => c.state === "fail") ? 1 : 0;
}

function exportCommand(args: string[]): number {
  const home = tenjinHome();
  let out = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i] ?? "";
  }
  if (!out) out = `tenjin-export-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  const parent = dirname(home);
  const name = basename(home);
  const result = spawnSync("tar", ["-czf", resolve(out), "-C", parent, name]);
  if (result.status !== 0) {
    stdout.write(`export failed: ${result.stderr?.toString().slice(0, 300)}\n`);
    return 1;
  }
  stdout.write(`exported ${home} → ${resolve(out)}\n`);
  return 0;
}

async function forgetCommand(args: string[]): Promise<number> {
  const home = tenjinHome();
  let bot: string | null = null;
  let sessions = false;
  let memory = false;
  let all = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bot") bot = args[++i] ?? null;
    else if (args[i] === "--sessions") sessions = true;
    else if (args[i] === "--memory") memory = true;
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--yes") yes = true;
  }
  if (!bot) {
    stdout.write("usage: tenjin forget --bot <name> [--sessions|--memory|--all] [--yes]\n");
    return 2;
  }
  const profile = resolveBot(home, bot);
  const targets: string[] = [];
  if (all || sessions) targets.push(profile.sessionsDir);
  if (all || memory) targets.push(profile.memoryDir);
  if (targets.length === 0) {
    stdout.write("nothing selected — pass --sessions, --memory, or --all\n");
    return 2;
  }

  if (!yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`delete ${targets.join(", ")}? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      stdout.write("aborted\n");
      return 0;
    }
  }

  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    stdout.write(`deleted ${target}\n`);
  }
  new AuditLog(auditPath(home)).append(
    "data_delete",
    "user",
    `forgot bot "${profile.name}": ${targets.map((t) => basename(t)).join(", ")}`,
    profile.name,
  );
  return 0;
}
