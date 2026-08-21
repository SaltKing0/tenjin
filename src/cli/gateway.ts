import { stdout } from "node:process";
import { join } from "node:path";
import { ConfigError } from "../config/types";
import { loadConfig, tenjinHome } from "../config/loader";
import { ProviderRegistry } from "../provider/registry";
import { ProviderStats } from "../provider/stats";
import { buildHealth, buildMetrics } from "../gateway/observability";
import { listBots } from "../bots/profile";
import { AuditLog, auditPath } from "../audit/log";
import { SecurityGuard, announceGuardDisabled, buildGuardStatus } from "../security/guard";
import { TelegramChannel } from "../gateway/telegram";
import { transcribeAudio, type TranscriptionConfig } from "../gateway/stt";
import { SlackChannel } from "../gateway/slack";
import { WebhookChannel } from "../gateway/webhook";
import { DiscordChannel } from "../gateway/discord";
import { Gateway } from "../gateway/gateway";
import { registerChannel, channelFactory, type Channel } from "../gateway/channel";
import { createMessageHandler, chatStreamResponse, type HandleContext } from "../gateway/handler";
import { startHttpServer } from "../gateway/http";
import { createConsoleApi } from "../gateway/console-api";
import { attachWebhooks, parseWebhooks } from "../gateway/webhooks";
import { attachNtfy, parseNtfy } from "../gateway/ntfy";

export async function gatewayCommand(args: string[]): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const home = tenjinHome();
  const cwd = process.cwd();
  try {
    const { config } = loadConfig(cwd, home, { skipModelCheck: true });
    // #135: the gateway shares one provider-outcome counter across every
    // provider the registry hands out and the /api/health + /metrics endpoints.
    const providerStats = new ProviderStats();
    const registry = new ProviderRegistry(
      config.providers?.openai?.baseUrl,
      {
        anthropic: config.providers?.anthropic?.apiKey,
        openai: config.providers?.openai?.apiKey,
      },
      config.retry,
      config.providers?.anthropic?.caching,
      config.providers?.anthropic?.baseUrl,
      providerStats,
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
    // #148: outbound event webhooks from events.webhooks config.
    const webhookTargets = parseWebhooks(config.events?.webhooks);
    if (webhookTargets.length > 0) {
      attachWebhooks(webhookTargets);
      log(`webhooks: ${webhookTargets.length} target(s) subscribed`);
    }
    // #149: ntfy push notifications from events.ntfy config.
    const ntfyConfig = parseNtfy(config.events?.ntfy);
    if (ntfyConfig) {
      attachNtfy(ntfyConfig);
      log(`ntfy: pushing to ${ntfyConfig.topicUrl}`);
    }

    // Hot-reload job changes (made via `tenjin job add/rm`) on SIGHUP, without
    // a restart. Re-reads config.yaml and rebuilds the job schedule.
    process.on("SIGHUP", () => {
      try {
        const { config: fresh } = loadConfig(cwd, home, { skipModelCheck: true });
        gateway.reload(fresh);
        log("gateway: job config reloaded (SIGHUP)");
        for (const line of gateway.describe()) log(`  ${line}`);
      } catch (e) {
        log(`gateway: reload failed (${(e as Error).message}) — keeping previous jobs`);
      }
    });

    const tg = gateway.settings.telegram;
    const sl = gateway.settings.slack;
    const wh = gateway.settings.webhook;
    const dc = gateway.settings.discord;
    let telegramHandle:
      | ((
          text: string,
          opts?: { onDelta?: (d: string) => void },
        ) => Promise<string | null>)
      | null = null;
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

    registerChannel("telegram", () => {
      if (!tg?.enabled) throw new ConfigError("gateway.telegram is not enabled");
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
      // Voice transcription (#137): enabled only when a model AND an API key are
      // available, so an unconfigured voice toggle still gets the clear hint.
      const voiceEnabled = tg.voice?.enabled === true;
      const audioModel = tg.voice?.model;
      const openaiKey = config.providers?.openai?.apiKey || process.env.OPENAI_API_KEY;
      const openaiBaseUrl = config.providers?.openai?.baseUrl;
      let transcribe: ((audio: Blob, filename: string) => Promise<string>) | undefined;
      if (voiceEnabled && audioModel && openaiKey) {
        const tCfg: TranscriptionConfig = {
          apiKey: openaiKey,
          model: audioModel,
          baseUrl: openaiBaseUrl,
        };
        transcribe = async (audio, filename) =>
          (await transcribeAudio(tCfg, audio, filename)).text;
      }
      channel = new TelegramChannel(
        {
          token,
          defaultBot,
          allowedUsers: tg.allowedUsers,
          apiBase: process.env.TELEGRAM_API_BASE,
          adminChatId: tg.adminChatId,
          rateLimitMax: tg.rateLimitMax,
          rateLimitWindowMs: tg.rateLimitWindowMs,
          maxMessageLength: tg.maxMessageLength,
          voiceEnabled,
          transcribe,
          onTranscribed: (info) =>
            audit.append(
              "transcribe",
              String(info.userId),
              `voice ${info.fileId}: ${info.text.slice(0, 80)}${info.text.length > 80 ? "…" : ""}`,
            ),
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
      return channel;
    });

    registerChannel("slack", () => {
      if (!sl?.enabled) throw new ConfigError("gateway.slack is not enabled");
      const botToken = sl.botToken;
      if (!botToken) throw new ConfigError("gateway.slack.enabled requires botToken");
      const signingSecret = sl.signingSecret;
      if (!signingSecret) throw new ConfigError("gateway.slack.enabled requires signingSecret");
      const defaultBot = sl.defaultBot as string;
      const available = listBots(home);
      const allowWrites = sl.allowWrites === true;
      const approvalTimeoutMs = sl.approvalTimeoutMs ?? 120_000;
      let channel: SlackChannel;
      const notifyApproval =
        sl.adminChannel !== undefined
          ? async (chatId: number, text: string) => channel.sendTo(chatId, text)
          : undefined;
      const handleForSlack = createMessageHandler({
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
      });
      channel = new SlackChannel(
        {
          botToken,
          signingSecret,
          defaultBot,
          allowedChannels: sl.allowedChannels,
          adminChannel: sl.adminChannel,
          port: process.env.SLACK_WEBHOOK_PORT
            ? Number(process.env.SLACK_WEBHOOK_PORT)
            : undefined,
          rateLimitMax: sl.rateLimitMax,
          rateLimitWindowMs: sl.rateLimitWindowMs,
          maxMessageLength: sl.maxMessageLength,
          onRejected: (info) =>
            audit.append(
              "channel_reject",
              info.userId,
              `slack message rejected (${info.reason})`,
            ),
        },
        log,
      );
      channel.onMessage((msg) =>
        handleForSlack(msg.text, {
          actor: String(msg.userId),
          source: "slack",
          chatId: msg.chatId,
          userId: msg.userId,
        }),
      );
      return channel;
    });

    registerChannel("webhook", () => {
      if (!wh?.enabled) throw new ConfigError("gateway.webhook is not enabled");
      if (!wh.secret) throw new ConfigError("gateway.webhook.enabled requires a secret");
      const defaultBot = wh.defaultBot as string;
      const available = listBots(home);
      let channel: WebhookChannel;
      // Approvals and job postTo deliver out-of-band through the outbound
      // webhook; without one they cannot be pushed anywhere.
      const notifyApproval = wh.outboundWebhookUrl
        ? async (_chatId: number, text: string) => channel.send(text)
        : undefined;
      const handleForWebhook = createMessageHandler({
        home,
        cwd,
        config,
        registry,
        availableBots: available,
        defaultBot,
        allowWrites: wh.allowWrites === true,
        approvalTimeoutMs: wh.approvalTimeoutMs ?? 120_000,
        guard,
        audit,
        log,
        notifyApproval,
      });
      channel = new WebhookChannel(
        {
          secret: wh.secret,
          defaultBot,
          allowedSenders: wh.allowedSenders,
          outboundWebhookUrl: wh.outboundWebhookUrl,
          webhookPath: wh.webhookPath,
          rateLimitMax: wh.rateLimitMax,
          rateLimitWindowMs: wh.rateLimitWindowMs,
          maxMessageLength: wh.maxMessageLength,
          onRejected: (info) =>
            audit.append(
              "channel_reject",
              info.sender,
              `webhook message rejected (${info.reason})`,
            ),
        },
        log,
      );
      channel.onMessage((msg) =>
        handleForWebhook(msg.text, {
          actor: String(msg.userId),
          source: "webhook",
          chatId: msg.chatId,
          userId: msg.userId,
        }),
      );
      return channel;
    });

    registerChannel("discord", () => {
      if (!dc?.enabled) throw new ConfigError("gateway.discord is not enabled");
      const botToken = process.env.DISCORD_BOT_TOKEN || dc.botToken;
      if (!botToken) {
        throw new ConfigError(
          "gateway.discord.enabled requires botToken (config or DISCORD_BOT_TOKEN)",
        );
      }
      const defaultBot = dc.defaultBot as string;
      const available = listBots(home);
      const allowWrites = dc.allowWrites === true;
      const approvalTimeoutMs = dc.approvalTimeoutMs ?? 120_000;
      let channel: DiscordChannel;
      const notifyApproval =
        dc.adminChannel !== undefined
          ? async (chatId: number, text: string) => channel.sendTo(chatId, text)
          : undefined;
      const handleForDiscord = createMessageHandler({
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
      });
      channel = new DiscordChannel(
        {
          botToken,
          defaultBot,
          allowedGuilds: dc.allowedGuilds,
          allowedChannels: dc.allowedChannels,
          adminChannel: dc.adminChannel,
          gatewayUrl: process.env.DISCORD_GATEWAY_URL || undefined,
          apiBase: process.env.DISCORD_API_BASE || undefined,
          rateLimitMax: dc.rateLimitMax,
          rateLimitWindowMs: dc.rateLimitWindowMs,
          maxMessageLength: dc.maxMessageLength,
          onRejected: (info) =>
            audit.append(
              "channel_reject",
              info.userId,
              `discord message rejected (${info.reason})`,
            ),
        },
        log,
      );
      channel.onMessage((msg) =>
        handleForDiscord(msg.text, {
          actor: String(msg.userId),
          source: "discord",
          chatId: msg.chatId,
          userId: msg.userId,
        }),
      );
      return channel;
    });

    const channels: Record<string, (text: string) => Promise<void>> = {};
    const builtChannels: Channel[] = [];
    for (const kind of gateway.settings.channels) {
      const factory = channelFactory(kind);
      if (!factory) {
        throw new ConfigError(`gateway.channels: no factory for channel "${kind}"`);
      }
      const ch = factory({});
      builtChannels.push(ch);
      channels[kind] = (text) => ch.send(text);
    }

    if (dryRun) {
      stdout.write("gateway dry-run:\n");
      for (const line of gateway.describe()) stdout.write(`  ${line}\n`);
      return 0;
    }

    const runners: Promise<void>[] = [gateway.run(controller.signal)];
    for (const ch of builtChannels) runners.push(ch.start(controller.signal));

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
        // #135: observability — cached view of spend, jobs, sessions and the
        // providers' live outcome counter, no per-request provider probe.
        health: () =>
          buildHealth(Date.now(), {
            home,
            stats: providerStats,
            jobs: gateway.listJobs(),
          }),
        metrics: () =>
          buildMetrics(Date.now(), {
            home,
            stats: providerStats,
            jobs: gateway.listJobs(),
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
        consoleDir: join(import.meta.dir, "..", "gateway", "console"),
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
