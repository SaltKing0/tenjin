#!/usr/bin/env bun
import { stdout, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { dirname, basename, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  ensureGlobalDir,
  loadConfig,
  validateConfig,
  tenjinHome,
  sessionsDir,
  memoryDir,
  memoryEnabled,
  webSearchEnabled,
  researchEnabled,
  ConfigError,
  type HarnessConfig,
} from "./config/loader";
import { createProvider } from "./provider/factory";
import { ProviderRegistry } from "./provider/registry";
import { defaultModelRef, cheapModelRef, resolveModelRef, type ModelRef } from "./config/models";
import { loadSoul, loadAgentsMd, buildSystemPrompt } from "./agent/prompt";
import { buildLayeredMemory } from "./memory/layers";
import { formatUSD } from "./agent/budget";
import { runAgentTurn } from "./agent/loop";
import { runHeadless, capPolicy, applyDenyTools } from "./agent/headless";
import { runHeadlessNdjson } from "./cli/headless-ndjson";
import type { EffortLevel } from "./agent/effort";
import { runArena, renderArena, type ArenaEntry } from "./arena";
import { startRepl } from "./ui/repl";
import { startTui } from "./ui/tui";
import { SessionLog } from "./session/log";
import { rebuildMessages, sumUsage } from "./session/events";
import { generatePendingSummaries, listSummaries } from "./memory/summaries";
import { buildMemorySection, loadCoreBlocks, renderCoreMemory } from "./memory/inject";
import { indexPendingSessions } from "./memory/indexer";
import { VectorStore, vectorsFilePath } from "./memory/vector-store";
import { createEmbeddings } from "./provider/embeddings";
import { vectorEnabled } from "./config/loader";
import { createRecallTool, createRememberTool, createRecordLearningTool, createCoreMemoryTool, readFacts } from "./tools/memory";
import { createRetrieveTool } from "./tools/retrieve";
import { readLearnings } from "./memory/learnings";
import { createUseSkillTool } from "./skills/activate";
import { listSkills } from "./skills/loader";
import { usageStats, analyzeUsage } from "./skills/usage";
import { pendingRefines } from "./skills/refine";
import { createSaveSkillTool } from "./tools/skill-writer";
import { createListSkillsTool } from "./tools/skill-lister";
import {
  resolveBot,
  botModelRef,
  botBudgetUSD,
  listBots,
  type BotSecurityConfig,
} from "./bots/profile";
import { createSendMessageTool, createCheckInboxTool } from "./bots/tools";
import { loadTeam, buildTeamSection, teamPath, TEAM_TEMPLATE } from "./bots/team";
import { SecurityGuard, announceGuardDisabled, guardForBot } from "./security/guard";
import { resolveParanoid } from "./security/injection";
import { Redactor } from "./security/redact";
import { initKeyring, keyringEnabled, keyringPath, ENC_PREFIX } from "./security/keyring";
import { AuditLog, formatAudit, auditPath } from "./audit/log";
import { aggregateSpend, renderSpend } from "./audit/spend";
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
import { applyPatchTool } from "./tools/apply-patch";
import { bashTool } from "./tools/bash";
import { webFetchTool } from "./tools/web-fetch";
import { createWebSearchTool } from "./tools/web-search";
import { createResearchSearchTool } from "./tools/research";
import { createMcpTools } from "./tools/mcp";
import type { ToolDef } from "./tools/registry";
import { parseArgs, HELP, type CliArgs } from "./cli/args";
import { listJobs, addJob, removeJob, findJob, runJob, renderJob } from "./cli/jobs";
import { gatewayCommand } from "./cli/gateway";
import { botCommand } from "./cli/bot";
import { pluginCommand } from "./cli/plugin";
import { runOnboard, usage as onboardUsage } from "./cli/onboard";
import { mcpServeCommand } from "./cli/mcp-serve";
import { initWorkspace, renderWorkspaceStatus, workspaceDir } from "./cli/workspace";
import { PRODUCT, VERSION } from "./version";
import { backupHome, restoreHome, buildExportTarArgs } from "./backup";

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
  /** #142: effective effort for this run (CLI flag overrides the bot's config). */
  effort?: EffortLevel;
}

type CommandHandler = (args: string[]) => number | Promise<number>;

/**
 * Top-level subcommand dispatch. Kept as a plain record (not a framework):
 * each entry maps `tenjin <name>` to its handler with the same semantics the
 * old if-chain had — including the two handlers that set `process.exitCode`
 * (forget, onboard) and doctor, which takes no args.
 */
const COMMANDS: Record<string, CommandHandler> = {
  bot: (a) => botCommand(a),
  tell: (a) => tellCommand(a),
  gateway: (a) => gatewayCommand(a),
  audit: (a) => auditCommand(a),
  spend: (a) => spendCommand(a),
  job: (a) => jobCommand(a),
  doctor: () => doctorCommand(),
  export: (a) => exportCommand(a),
  forget: async (a) => {
    process.exitCode = await forgetCommand(a);
    return process.exitCode;
  },
  onboard: async (a) => {
    if (a.includes("--help") || a.includes("-h")) {
      stdout.write(onboardUsage());
      return 0;
    }
    process.exitCode = await runOnboard(a, { home: tenjinHome() });
    return process.exitCode;
  },
  arena: (a) => arenaCommand(a),
  backup: (a) => backupCommand(a),
  restore: (a) => restoreCommand(a),
  team: (a) => teamCommand(a),
  keyring: (a) => keyringCommand(a),
  skills: (a) => skillsCommand(a),
  plugin: (a) => pluginCommand(a),
  workspace: (a) => workspaceCommand(a),
};

async function main(): Promise<number> {
  // `tenjin tui` runs the split-pane TUI instead of the line REPL.
  const raw = process.argv.slice(2);
  const useTui = raw[0] === "tui";
  const argv = useTui ? raw.slice(1) : raw;
  const handler = COMMANDS[argv[0] ?? ""];
  if (handler && !useTui) {
    return handler(argv.slice(1));
  }

  let cli: CliArgs;
  try {
    cli = parseArgs(argv);
  } catch (e) {
    stdout.write(`${(e as Error).message}\n`);
    return 2;
  }
  if (cli.help) {
    stdout.write(HELP);
    return 0;
  }
  if (cli.version) {
    stdout.write(`${PRODUCT} v${VERSION}\n`);
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
    const team = loadTeam(home);
    const system = buildSystemPrompt({
      soulText: soul.text,
      agentsMd: loadAgentsMd(cwd, home),
      cwd,
      facts: readFacts(memDir),
      memorySection:
        memoryEnabled(config)
          ? buildMemorySection(listSummaries(memDir), {
              currentProject: cwd,
              learnings: readLearnings(memDir, cwd),
            })
          : null,
      coreMemory: renderCoreMemory(loadCoreBlocks(memDir)),
      teamSection: team ? buildTeamSection(team) : null,
    });
    let tools: ToolDef[] = [
      readTool,
      globTool,
      grepTool,
      writeTool,
      editTool,
      applyPatchTool,
      bashTool,
      webFetchTool,
    ];
    if (webSearchEnabled(config)) {
      tools.push(createWebSearchTool(config.webSearch));
    }
    if (researchEnabled(config)) {
      tools.push(createResearchSearchTool(config.research));
    }
    if (memoryEnabled(config)) {
      tools.push(createRememberTool({ memoryDirPath: memDir }));
      tools.push(createCoreMemoryTool({ memoryDirPath: memDir }));
      tools.push(createRecordLearningTool({ memoryDirPath: memDir, projectPath: cwd, maxEntries: config.memory?.learnings?.maxEntries }));
      tools.push(createRecallTool({ memoryDirPath: memDir, projectPath: cwd, embeddings, store: vectorStore ?? undefined }));
      // B9-14 (#394): retrieval as an explicit, on-demand tool (never auto-inject).
      tools.push(createRetrieveTool({ memoryDirPath: memDir, projectPath: cwd, embeddings, store: vectorStore ?? undefined }));
    }
    tools.push(createUseSkillTool({ home, projectDir: cwd }));
    tools.push(createSaveSkillTool({ projectDir: cwd }));
    tools.push(createListSkillsTool({ home, projectDir: cwd }));
    // MCP stdio servers (WPs 3.1+3.2) — default OFF; no-op with empty config.
    const mcpTools = await createMcpTools(config, {
      redactor: Redactor.fromConfig(config.security),
    });
    if (mcpTools.length) tools.push(...mcpTools);
    if (profile) {
      tools.push(createSendMessageTool({ home, fromBot: profile.name, policy: inboxPolicy }));
      tools.push(createCheckInboxTool({
        profile,
        policy: inboxPolicy,
        paranoid: resolveParanoid(config.security, profile.config.security),
        audit: (kind, detail, correlationId) =>
          audit.append(kind, "user", detail, profile.name, correlationId),
      }));
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
      effort: cli.effort ?? profile?.config.effort,
    };

    // B15-7 (#439): serve our own tools/skills to external MCP clients.
    // Intercepted here (after tools + guard are built) so the server wires to
    // the real dispatch; deny-by-default via config.mcpServer.expose[].
    if (process.argv[2] === "mcp-serve") {
      return mcpServeCommand(process.argv.slice(3), { config, tools, ctx });
    }

    if (cli.print !== undefined) {
      return cli.json ? await oneShotNdjson(ctx, cli.print) : await oneShot(ctx, cli.print);
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
    const replOpts = {
      ...ctx,
      sessionId: log.id,
      logger: log,
      sessionsDir: dir,
      memoryDir: memDir,
      home,
      bot: profile?.name,
    };
    if (useTui) await startTui(replOpts);
    else await startRepl(replOpts);
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

/** `tenjin team init` — write a starter team.yaml into the home (#141). */
function teamCommand(args: string[]): number {
  const sub = args[0];
  if (sub && sub !== "init") {
    stdout.write("usage: tenjin team init\n");
    return 2;
  }
  const home = tenjinHome();
  const p = teamPath(home);
  if (existsSync(p)) {
    stdout.write(`team.yaml already exists at ${p} — edit roles and rerun to apply\n`);
    return 0;
  }
  ensureGlobalDir(home);
  writeFileSync(p, TEAM_TEMPLATE);
  stdout.write(`wrote team manifest to ${p} — edit roles, then bot prompts pick it up on next run\n`);
  return 0;
}

function backupStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function backupCommand(args: string[]): number {
  const home = tenjinHome();
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "-o") {
      out = args[i + 1];
      if (!out) {
        stdout.write("usage: tenjin backup [--out <file>]\n");
        return 2;
      }
      i++;
    } else if (a === "-h" || a === "--help") {
      stdout.write("usage: tenjin backup [--out <file>]\n");
      return 0;
    } else {
      stdout.write(`unknown backup option: ${a}\n`);
      return 2;
    }
  }
  const file = out ?? join(process.cwd(), `tenjin-backup-${backupStamp()}.tar.gz`);
  try {
    const res = backupHome(home, file);
    stdout.write(`backed up ${res.count} file(s) to ${file}\n`);
    if (res.count > 0) stdout.write(`  ${res.files.join(", ")}\n`);
    stdout.write(
      "  note: providers.yaml (API keys) and secrets/ are never backed up\n",
    );
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

function restoreCommand(args: string[]): number {
  const file = args.find((a) => a && !a.startsWith("-"));
  if (!file) {
    stdout.write("usage: tenjin restore <backup.tar.gz>\n");
    return 2;
  }
  const home = tenjinHome();
  try {
    const res = restoreHome(home, file);
    stdout.write(`restored ${res.count} file(s) into ${home}\n`);
    if (res.count > 0) stdout.write(`  ${res.files.join(", ")}\n`);
    stdout.write(
      "  note: providers.yaml (API keys) and secrets/ are never restored\n",
    );
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

/** Manages the machine-local keyring for secrets at rest (#132). */
function keyringCommand(args: string[]): number {
  const home = tenjinHome();
  const sub = args[0];
  if (sub === "init") {
    if (keyringEnabled(home)) {
      stdout.write(`keyring already initialized (${keyringPath(home)})\n`);
      return 0;
    }
    const p = initKeyring(home);
    stdout.write(`keyring initialized at ${p} (0600, machine-local)\n`);
    stdout.write("  existing plaintext keys are encrypted on their next save (re-enter or re-save via the console)\n");
    return 0;
  }
  if (sub === "status") {
    const provPath = join(home, "providers.yaml");
    const on = keyringEnabled(home);
    const raw = existsSync(provPath) ? readFileSync(provPath, "utf8") : "";
    const plain = raw
      .split("\n")
      .some((l) => /^\s*apiKey:\s*\S/.test(l) && !l.includes(ENC_PREFIX));
    stdout.write(`keyring: ${on ? "ENABLED" : "disabled (plaintext mode)"}\n`);
    if (on) stdout.write(`  secret file: ${keyringPath(home)}\n`);
    if (on && plain) stdout.write("  warning: providers.yaml still holds plaintext apiKeys — re-save to encrypt\n");
    else if (on) stdout.write("  providers.yaml keys: encrypted at rest\n");
    return 0;
  }
  stdout.write("usage: tenjin keyring init|status\n");
  return 2;
}

function workspaceCommand(args: string[]): number {
  const home = tenjinHome();
  if (args[0] === "init") {
    const force = args.includes("--force");
    const r = initWorkspace(home, { force });
    stdout.write(`workspace: ${workspaceDir(home)}\n`);
    stdout.write(`  created: ${r.created.join(", ") || "(none)"}\n`);
    if (r.skipped.length) stdout.write(`  kept (already present): ${r.skipped.join(", ")}\n`);
    stdout.write(`  daily log: ${r.daily}\n`);
    return 0;
  }
  if (args[0] === "--help" || args[0] === "-h") {
    stdout.write("usage: tenjin workspace [init [--force]]\n  init   scaffold SOUL.md/USER.md/AGENTS.md/MEMORY.md/HEARTBEAT.md + daily log\n  (no args)  show workspace status\n");
    return 0;
  }
  stdout.write(`${renderWorkspaceStatus(home)}\n`);
  return 0;
}

/** Skill self-improvement surface (#133): usage stats + refine analysis. */
function skillsCommand(args: string[]): number {
  const [sub, name] = args;
  const cwd = process.cwd();
  const skills = listSkills(tenjinHome(), cwd).map((s) => s.name);
  if (sub === "analyze") {
    const candidates = analyzeUsage(cwd, skills);
    const pending = pendingRefines(cwd, skills);
    stdout.write(`skills: ${skills.length} installed; ${candidates.length} flagged for refinement\n`);
    for (const c of candidates) {
      const pct = Math.round(c.errorRate * 100);
      stdout.write(`  ${c.skill}: ${c.uses} use(s), ${c.errors} error(s) (${pct}%) — refine candidate\n`);
    }
    if (pending.length) {
      stdout.write("pending refine proposals (activation requires approval):\n");
      for (const p of pending) {
        stdout.write(`  ${p.skill}#v${p.version}: ${p.reason || p.description}\n`);
      }
    }
    return 0;
  }
  if (sub === "stat") {
    if (!name) {
      stdout.write("usage: tenjin skills stat <skill>\n");
      return 2;
    }
    const st = usageStats(cwd, name);
    const pct = Math.round(st.errorRate * 100);
    stdout.write(
      `${name}: ${st.uses} use(s), ${st.errors} error(s) (${pct}%), last used ${st.lastUsed ?? "never"}\n`,
    );
    return 0;
  }
  stdout.write("usage: tenjin skills analyze | stat <skill>\n");
  return 2;
}

async function arenaCommand(args: string[]): Promise<number> {
  try {
    return await arenaRun(args);
  } catch (e) {
    if (e instanceof ConfigError) {
      stdout.write(`config error: ${e.message}\n`);
      return 2;
    }
    stdout.write(`error: ${(e as Error)?.message ?? e}\n`);
    return 1;
  }
}

async function arenaRun(args: string[]): Promise<number> {
  let prompt = "";
  let modelsList: string[] = [];
  let budget: number | undefined;
  let winnerIndex: number | undefined;
  let judgeRef: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) break;
    if (a === "--models" || a === "-m") {
      const rest = args[i + 1];
      if (!rest) {
        throw new ConfigError(
          "arena --models requires a comma-separated list of provider:model refs (e.g. anthropic:claude-opus-4,openai:gpt-4o)",
        );
      }
      modelsList = rest
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (a === "--judge") {
      const ref = args[++i];
      if (!ref) {
        throw new ConfigError(
          "arena --judge requires a provider:model ref (e.g. anthropic:claude-opus-4)",
        );
      }
      judgeRef = ref.trim();
    } else if (a === "--budget") {
      const raw = args[++i];
      if (raw === undefined || !Number.isFinite(Number(raw))) {
        throw new ConfigError("arena --budget requires a number (USD spend cap)");
      }
      budget = Number(raw);
    } else if (a === "--winner") {
      const raw = args[++i];
      if (raw === undefined) {
        throw new ConfigError("arena --winner requires a 1-based entry index");
      }
      winnerIndex = Number(raw);
    } else if (a.startsWith("-")) {
      throw new ConfigError(`unknown arena option: ${a}`);
    } else {
      prompt = prompt ? `${prompt} ${a}` : a;
    }
  }
  if (!prompt.trim()) {
    throw new ConfigError('arena requires a prompt: tenjin arena "<prompt>" --models ...');
  }
  if (modelsList.length === 0) {
    throw new ConfigError('arena requires --models <ref1,ref2,...>');
  }
  if (winnerIndex !== undefined && (!Number.isInteger(winnerIndex) || winnerIndex < 1)) {
    throw new ConfigError("arena --winner must be a positive integer (1-based entry index)");
  }

  const home = tenjinHome();
  const cwd = process.cwd();
  const { config } = loadConfig(cwd, home, { skipModelCheck: true });
  const registry = new ProviderRegistry(
    config.providers?.openai?.baseUrl,
    {
      anthropic: config.providers?.anthropic?.apiKey,
      openai: config.providers?.openai?.apiKey,
    },
    config.retry,
  );
  const entries: ArenaEntry[] = modelsList.map((ref) => {
    const mref = resolveModelRef(ref, config.provider);
    return { ref: mref, provider: registry.get(mref.provider) };
  });
  const judge = judgeRef
    ? (() => {
        const mref = resolveModelRef(judgeRef, config.provider);
        return {
          provider: registry.get(mref.provider),
          model: mref.model,
          capUSD: budget ?? config.budgetUSD ?? 0,
        };
      })()
    : undefined;
  const result = await runArena({
    entries,
    message: prompt,
    soulText: loadSoul(home, cwd).text,
    cwd,
    maxTokens: config.maxTokens,
    capUSD: budget ?? config.budgetUSD ?? 0,
    pricing: config.pricing,
    policy: "read-only",
    winnerIndex,
    judge,
    // #178: adhere to the same security guard + redaction every other path uses.
    guard: guardForBot(config.security, undefined, (detail) =>
      stdout.write(`[security] ${detail}\n`),
    ),
    redactor: Redactor.fromConfig(config.security),
  });
  stdout.write(renderArena(result, prompt) + "\n");
  return 0;
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

async function jobCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const home = tenjinHome();
  const cwd = process.cwd();
  try {
    switch (sub) {
      case "list": {
        const views = listJobs(home);
        if (views.length === 0) {
          stdout.write("no jobs — tenjin job add <bot> \"<cron>\" \"<prompt>\"\n");
          return 0;
        }
        for (const v of views) stdout.write(renderJob(v));
        return 0;
      }
      case "add": {
        const [bot, cron, ...promptParts] = rest;
        const prompt = promptParts.join(" ").trim();
        if (!bot || !cron || !prompt) {
          stdout.write("usage: tenjin job add <bot> \"<cron>\" \"<prompt>\"\n");
          return 2;
        }
        const name = addJob(home, { bot, cron, prompt });
        stdout.write(
          `added job ${name} (bot=${bot.trim()} cron "${cron.trim()}") — restart the gateway or send SIGHUP to reload\n`,
        );
        return 0;
      }
      case "rm": {
        const id = rest[0];
        if (!id) {
          stdout.write("usage: tenjin job rm <id>\n");
          return 2;
        }
        const removed = removeJob(home, id);
        if (!removed) {
          stdout.write(`unknown job \"${id}\" — tenjin job list to see jobs\n`);
          return 1;
        }
        stdout.write(`removed job ${id}\n`);
        return 0;
      }
      case "run": {
        const id = rest[0];
        if (!id) {
          stdout.write("usage: tenjin job run <id>\n");
          return 2;
        }
        return await runJobCommand(home, cwd, id);
      }
      default:
        stdout.write("usage: tenjin job list|add <bot> \"<cron>\" \"<prompt>\"|rm <id>|run <id>\n");
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

async function runJobCommand(home: string, cwd: string, id: string): Promise<number> {
  const { config } = loadConfig(cwd, home, { skipModelCheck: true });
  const registry = new ProviderRegistry(
    config.providers?.openai?.baseUrl,
    {
      anthropic: config.providers?.anthropic?.apiKey,
      openai: config.providers?.openai?.apiKey,
    },
    config.retry,
  );
  const job = findJob(home, id);
  const profile = resolveBot(home, job.bot);
  const ref = botModelRef(profile, config);
  const result = await runJob(home, id, {
    home,
    cwd,
    config,
    provider: registry.get(ref.provider),
    audit: (kind, detail) =>
      new AuditLog(auditPath(home)).append(kind, "cli", detail, profile.name),
  });
  if (!result.ok) {
    stdout.write(`job ${id} failed: ${result.error}\n`);
    return 1;
  }
  const output = result.text.trim();
  if (output) stdout.write(`${output}\n`);
  stdout.write(
    `  [job ${id} · ${result.stopReason} · ${formatUSD(result.costUSD)}]\n`,
  );
  return result.stopReason === "end_turn" ? 0 : 1;
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
    layeredMemory: buildLayeredMemory(workspaceDir(ctx.home), ctx.config.memory),
    maxTreeIterations: ctx.config.maxTreeIterations ?? 0,
    capUSD: ctx.config.budgetUSD,
    pricing: ctx.config.pricing,
    globalBudget: ctx.config.globalBudget,
    policy: capPolicy("read-only", ctx.botSecurity?.policy),
    denyTools: ctx.botSecurity?.denyTools,
    agentsMd: loadAgentsMd(ctx.cwd, ctx.home),
    home: ctx.home,
    memoryDir: ctx.memoryDir,
    guard: ctx.guard,
    paranoid: resolveParanoid(ctx.config.security, ctx.botSecurity),
    audit: (kind, detail, correlationId) =>
      new AuditLog(auditPath(ctx.home)).append(kind, "user", detail, undefined, correlationId),
    redactor: Redactor.fromConfig(ctx.config.security),
    context: ctx.config.context,
    effort: ctx.effort,
  });
  stdout.write(`${result.text}\n`);
  stdout.write(
    `  [in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)}]\n`,
  );
  return result.stopReason === "end_turn" ? 0 : 1;
}

/** B13-7: `--json -p "<prompt>"` — one-shot run emitting pure ndjson (events + stats). */
async function oneShotNdjson(ctx: AppContext, prompt: string): Promise<number> {
  return runHeadlessNdjson({
    provider: ctx.registry.get(ctx.defaultRef.provider),
    model: ctx.defaultRef.model,
    soulText: loadSoul(ctx.home, ctx.cwd).text,
    cwd: ctx.cwd,
    message: prompt,
    maxTokens: ctx.config.maxTokens,
    maxTreeIterations: ctx.config.maxTreeIterations ?? 0,
    capUSD: ctx.config.budgetUSD,
    pricing: ctx.config.pricing,
    globalBudget: ctx.config.globalBudget,
    policy: capPolicy("read-only", ctx.botSecurity?.policy),
    denyTools: ctx.botSecurity?.denyTools,
    agentsMd: loadAgentsMd(ctx.cwd, ctx.home),
    home: ctx.home,
    memoryDir: ctx.memoryDir,
    guard: ctx.guard,
    paranoid: resolveParanoid(ctx.config.security, ctx.botSecurity),
    audit: (kind, detail, correlationId) =>
      new AuditLog(auditPath(ctx.home)).append(kind, "user", detail, undefined, correlationId),
    redactor: Redactor.fromConfig(ctx.config.security),
    context: ctx.config.context,
    effort: ctx.effort,
    heartbeatMs: 5_000,
  });
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

  const provPath = join(home, "providers.yaml");
  const keyLines = (existsSync(provPath) ? readFileSync(provPath, "utf8") : "")
    .split("\n")
    .filter((l) => /^\s*apiKey:\s*\S/.test(l));
  const plain = keyLines.some((l) => !l.includes(ENC_PREFIX));
  const encrypted = keyLines.some((l) => l.includes(ENC_PREFIX));
  if (keyLines.length === 0) {
    add("ok", "no provider apiKeys stored", "none in providers.yaml");
  } else if (plain) {
    add(
      "warn",
      "provider apiKeys stored in plaintext",
      encrypted ? "some keys still plaintext — re-save to encrypt all" : "`tenjin keyring init` then re-save to encrypt",
    );
  } else {
    add("ok", "provider apiKeys encrypted at rest", "keyring active");
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
  // #307: reuse the backup exclusion list so portable exports never carry
  // providers.yaml (API keys), secrets/, or the machine-local .tenjin-keyring.
  const result = spawnSync("tar", buildExportTarArgs(resolve(out), parent, name));
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
  let inbox = false;
  let tasks = false;
  let all = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bot") bot = args[++i] ?? null;
    else if (args[i] === "--sessions") sessions = true;
    else if (args[i] === "--memory") memory = true;
    else if (args[i] === "--inbox") inbox = true;
    else if (args[i] === "--tasks") tasks = true;
    else if (args[i] === "--all") all = true;
    else if (args[i] === "--yes") yes = true;
  }
  if (!bot) {
    stdout.write(
      "usage: tenjin forget --bot <name> [--sessions|--memory|--inbox|--tasks|--all] [--yes]\n",
    );
    return 2;
  }
  const profile = resolveBot(home, bot);
  const targets: string[] = [];
  if (all || sessions) targets.push(profile.sessionsDir);
  if (all || memory) targets.push(profile.memoryDir);
  if (all || inbox) targets.push(profile.inboxDir);
  if (all || tasks) targets.push(profile.tasksDir);
  if (targets.length === 0) {
    stdout.write("nothing selected — pass --sessions, --memory, --inbox, --tasks, or --all\n");
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
