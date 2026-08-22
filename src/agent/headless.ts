import type { Provider, Usage } from "../provider/types";
import { join } from "node:path";
import { buildSystemPrompt } from "./prompt";
import { createBudget, TreeBudget, type Budget } from "./budget";
import type { PricingConfig } from "../config/loader";
import { runAgentTurn } from "./loop";
import { checkGlobalBudget } from "../audit/global-budget";
import type { GlobalBudgetConfig } from "../config/types";
import { SessionLog } from "../session/log";
import { resolveContextGuard } from "../session/context";
import { effortLimits, type EffortLevel } from "./effort";
import type { TurnEvent } from "./loop";
import { readTool } from "../tools/read";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { writeTool } from "../tools/write";
import { editTool } from "../tools/edit";
import { applyPatchTool } from "../tools/apply-patch";
import { bashTool } from "../tools/bash";
import { webFetchTool } from "../tools/web-fetch";
import type { ToolDef } from "../tools/registry";
import { Redactor } from "../security/redact";
import { readFacts, createRecordLearningTool } from "../tools/memory";
import { buildMemorySection } from "../memory/inject";
import { listSummaries } from "../memory/summaries";
import { readLearnings } from "../memory/learnings";
import { listSkills } from "../skills/loader";
import { createUseSkillTool, summarizeSkills } from "../skills/activate";
import { createSaveSkillTool } from "../tools/skill-writer";
import { createListSkillsTool } from "../tools/skill-lister";
import { loadTeam, buildTeamSection } from "../bots/team";

export type ToolPolicy = "read-only" | "none" | "full";

const POLICY_RANK: Record<ToolPolicy, number> = { none: 0, "read-only": 1, full: 2 };

/** A bot policy can only tighten the caller's policy, never upgrade it. */
export function capPolicy(base: ToolPolicy, botCap?: ToolPolicy): ToolPolicy {
  if (!botCap) return base;
  return POLICY_RANK[botCap] < POLICY_RANK[base] ? botCap : base;
}

export function applyDenyTools(defs: ToolDef[], deny?: string[]): ToolDef[] {
  if (!deny?.length) return defs;
  const blocked = new Set(deny);
  return defs.filter((d) => !blocked.has(d.name));
}

export interface HeadlessOptions {
  provider: Provider;
  model: string;
  soulText: string;
  cwd: string;
  message: string;
  maxTokens: number;
  capUSD: number;
  pricing?: PricingConfig;
  /** Shared budget to draw from (e.g. across parallel arena runs). When absent, a fresh per-run budget is created from capUSD. */
  budget?: Budget;
  policy?: ToolPolicy;
  denyTools?: string[];
  agentsMd?: string | null;
  extraTools?: ToolDef[];
  home?: string;
  memoryDir?: string;
  /** Entries kept per learnings.md file (#204); defaults to DEFAULT_MAX_LEARNINGS. */
  maxLearnings?: number;
  sessionLogDir?: string;
  sessionBot?: string;
  guard?: import("../security/guard").SecurityGuard | null;
  redactor?: Redactor | null;
  audit?: (kind: "write_exec" | "budget_halt" | "budget_exceeded" | "prompt_injection", detail: string, correlationId?: string) => void;
  /** Mask suspected prompt-injection tool output before it reaches the model. */
  paranoid?: boolean;
  /** Shared id threaded into this run's audit events (e.g. a delegation correlation id). */
  correlationId?: string;
  /** Global spend cap (solo + all bots) enforced before each provider call. */
  globalBudget?: GlobalBudgetConfig;
  approve?: (toolName: string, group: "read" | "write", input: unknown) => Promise<boolean>;
  onTextDelta?: (delta: string) => void;
  /** Live side-channel invoked when the agent invokes a tool (name only). */
  onToolActivity?: (name: string) => void;
  /** Context-window guard config (`context` in config.yaml, #101). */
  context?: import("../config/loader").ContextConfig | null;
  /** Abort the run (e.g. a per-task timeout). Propagates to provider calls. */
  signal?: AbortSignal;
  /** #142: low/medium/high/max dial overriding iteration/token/tool limits. */
  effort?: EffortLevel;
  /** #154: inherit a shared delegation-tree budget (a subagent run receives its
   * parent's counter, so the whole tree counts against one cap). */
  treeBudget?: TreeBudget;
  /** #154: when no `treeBudget` is inherited, start a NEW tree with this
   * per-tree iteration cap (`0` = unlimited). Acts as a global safety-net. */
  maxTreeIterations?: number;
  /** #154: optional shared USD cap for a new tree (`0` = unlimited). */
  maxTreeUsd?: number;
  /** B2-3/B2-4: override the per-session archive dir (default `<memoryDir>/archives`). */
  archiveDir?: string;
  /** B2-3/B2-4: cheap-model summarizer for stage-4 compaction (optional). */
  summarize?: (segment: string) => Promise<string>;
}

export interface HeadlessResult {
  text: string;
  stopReason: string;
  costUSD: number;
  usage: Usage;
  /** Session log id for this run, when session logging was enabled (#151). */
  sessionId?: string;
}

export interface SkillDirs {
  home: string;
  projectDir: string;
}

export function toolsForPolicy(policy: ToolPolicy, skill?: SkillDirs): ToolDef[] {
  const skillTools: ToolDef[] = [];
  if (skill && policy !== "none") {
    skillTools.push(createUseSkillTool({ home: skill.home, projectDir: skill.projectDir }));
    skillTools.push(createListSkillsTool({ home: skill.home, projectDir: skill.projectDir }));
    if (policy === "full") {
      skillTools.push(createSaveSkillTool({ projectDir: skill.projectDir }));
    }
  }
  switch (policy) {
    case "read-only":
      return [readTool, globTool, grepTool, webFetchTool, ...skillTools];
    case "full":
      return [readTool, globTool, grepTool, writeTool, editTool, applyPatchTool, bashTool, webFetchTool, ...skillTools];
    case "none":
      return [];
  }
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const redactor = opts.redactor ?? new Redactor();
  // #142: resolve the effort dial first — it caps iterations, tokens, and (for
  // low) the tool policy, overriding what the caller passed.
  const eff = effortLimits(opts.effort, opts.maxTokens);
  const basePolicy = opts.policy ?? "read-only";
  const policy = eff.toolPolicy ? capPolicy(basePolicy, eff.toolPolicy) : basePolicy;
  const globalBudgetGate =
    opts.home && opts.globalBudget
      ? () => checkGlobalBudget(opts.home!, opts.globalBudget!)
      : undefined;
  const skills = opts.home ? listSkills(opts.home, opts.cwd) : [];
  const team = opts.home ? loadTeam(opts.home) : null;
  const system = buildSystemPrompt({
    soulText: opts.soulText,
    agentsMd: opts.agentsMd ?? null,
    cwd: opts.cwd,
    facts: opts.memoryDir ? readFacts(opts.memoryDir) : null,
    memorySection: opts.memoryDir
      ? buildMemorySection(listSummaries(opts.memoryDir), {
          currentProject: opts.cwd,
          learnings: readLearnings(opts.memoryDir, opts.cwd),
        })
      : null,
    skillsSummary: skills.length > 0 ? summarizeSkills(skills) : null,
    teamSection: team ? buildTeamSection(team) : null,
  });
  const skillDirs = opts.home ? { home: opts.home, projectDir: opts.cwd } : undefined;
  let logger: SessionLog | undefined;
  if (opts.sessionLogDir) {
    logger = SessionLog.create(opts.sessionLogDir);
    logger.append({
      t: "session_start",
      id: logger.id,
      ts: new Date().toISOString(),
      provider: opts.provider.name,
      model: opts.model,
      ...(opts.sessionBot ? { bot: opts.sessionBot } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    });
    logger.append({ t: "message", role: "user", content: opts.message, ts: new Date().toISOString() });
  }
  const budget = opts.budget ?? createBudget(opts.capUSD, opts.pricing);

  // #154: inherit the parent's tree budget, or seed a fresh tree when caps are
  // configured. A cap-less run with no inherited budget just has no tree cap.
  const treeBudget =
    opts.treeBudget ??
    (opts.maxTreeIterations || opts.maxTreeUsd
      ? new TreeBudget(opts.maxTreeIterations ?? 0, opts.maxTreeUsd ?? 0)
      : undefined);

  const tools = applyDenyTools(
    [...toolsForPolicy(policy, skillDirs), ...(opts.extraTools ?? [])],
    opts.denyTools,
  );
  // Tier-2 memory (#99): expose record_learning when a memory dir is in scope,
  // attributing the learning to the just-created session log id when present.
  if (opts.memoryDir) {
    tools.push(
      createRecordLearningTool({
        memoryDirPath: opts.memoryDir,
        projectPath: opts.cwd,
        sessionId: logger?.id,
        maxEntries: opts.maxLearnings,
      }),
    );
  }

  const result = await runAgentTurn({
    provider: opts.provider,
    model: opts.model,
    system,
    tools,
    messages: [{ role: "user", content: opts.message }],
    budget,
    maxTokens: eff.maxTokens,
    maxIterations: eff.maxIterations,
    treeBudget,
    cwd: opts.cwd,
    signal: opts.signal,
    globalBudgetGate,
    approve:
      opts.approve ??
      (async (_name, group) => group === "read"),
    guard: opts.guard,
    audit: opts.audit,
    paranoid: opts.paranoid,
    correlationId: opts.correlationId,
    onTextDelta: opts.onTextDelta,
    contextGuard: resolveContextGuard(opts.model, opts.context ?? undefined),
    sessionKey: logger?.id,
    compaction: opts.context?.compaction,
    archiveDir: opts.archiveDir ?? (opts.memoryDir ? join(opts.memoryDir, "archives") : undefined),
    summarize: opts.summarize,
    onEvent: (e: TurnEvent) => {
      if (e.t === "tool_call") opts.onToolActivity?.(e.name);
      if (!logger) return;
      const ts = new Date().toISOString();
      if (e.t === "assistant_message") {
        logger?.append({ t: "message", role: "assistant", content: e.content, ts });
      } else if (e.t === "tool_call") {
        logger?.append({
          t: "tool_call",
          id: e.id,
          name: e.name,
          input: redactor.redactValue(e.input),
          ts,
        });
      } else if (e.t === "tool_result") {
        logger?.append({
          t: "tool_result",
          id: e.id,
          name: e.name,
          ok: e.ok,
          output: redactor.redact(e.output),
          ts,
        });
      } else if (e.t === "usage") {
        logger?.append({
          t: "usage",
          inputTokens: e.usage.inputTokens,
          outputTokens: e.usage.outputTokens,
          cacheReadInputTokens: e.usage.cacheReadInputTokens,
          costUSD: e.costUSD,
          spentUSD: budget.spentUSD,
          ts,
        });
      } else if (e.t === "compression") {
        logger?.append({
          t: "compression",
          beforeTokens: e.beforeTokens,
          afterTokens: e.afterTokens,
          elidedTokens: e.elidedTokens,
          ...(e.stage !== undefined ? { stage: e.stage } : {}),
          ...(e.archivePath ? { archivePath: e.archivePath } : {}),
          ...(e.skipped ? { skipped: e.skipped } : {}),
          ts,
        });
      }
    },
  });
  return {
    text: result.text,
    stopReason: result.stopReason,
    costUSD: result.costUSD,
    usage: result.usage,
    sessionId: logger?.id,
  };
}
