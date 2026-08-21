import type { Provider, Usage } from "../provider/types";
import { buildSystemPrompt } from "./prompt";
import { createBudget } from "./budget";
import type { PricingConfig } from "../config/loader";
import { runAgentTurn } from "./loop";
import { SessionLog } from "../session/log";
import type { TurnEvent } from "./loop";
import { readTool } from "../tools/read";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { writeTool } from "../tools/write";
import { editTool } from "../tools/edit";
import { bashTool } from "../tools/bash";
import type { ToolDef } from "../tools/registry";
import { Redactor } from "../security/redact";
import { readFacts } from "../tools/memory";
import { buildMemorySection } from "../memory/inject";
import { listSummaries } from "../memory/summaries";
import { listSkills } from "../skills/loader";
import { createUseSkillTool, summarizeSkills } from "../skills/activate";
import { createSaveSkillTool } from "../tools/skill-writer";

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
  policy?: ToolPolicy;
  denyTools?: string[];
  agentsMd?: string | null;
  extraTools?: ToolDef[];
  home?: string;
  memoryDir?: string;
  sessionLogDir?: string;
  sessionBot?: string;
  guard?: import("../security/guard").SecurityGuard | null;
  redactor?: Redactor | null;
  audit?: (kind: "write_exec" | "budget_halt", detail: string) => void;
  approve?: (toolName: string, group: "read" | "write", input: unknown) => Promise<boolean>;
  onTextDelta?: (delta: string) => void;
}

export interface HeadlessResult {
  text: string;
  stopReason: string;
  costUSD: number;
  usage: Usage;
}

export interface SkillDirs {
  home: string;
  projectDir: string;
}

export function toolsForPolicy(policy: ToolPolicy, skill?: SkillDirs): ToolDef[] {
  const skillTools: ToolDef[] = [];
  if (skill && policy !== "none") {
    skillTools.push(createUseSkillTool({ home: skill.home, projectDir: skill.projectDir }));
    if (policy === "full") {
      skillTools.push(createSaveSkillTool({ projectDir: skill.projectDir }));
    }
  }
  switch (policy) {
    case "read-only":
      return [readTool, globTool, grepTool, ...skillTools];
    case "full":
      return [readTool, globTool, grepTool, writeTool, editTool, bashTool, ...skillTools];
    case "none":
      return [];
  }
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const policy = opts.policy ?? "read-only";
  const redactor = opts.redactor ?? new Redactor();
  const skills = opts.home ? listSkills(opts.home, opts.cwd) : [];
  const system = buildSystemPrompt({
    soulText: opts.soulText,
    agentsMd: opts.agentsMd ?? null,
    cwd: opts.cwd,
    facts: opts.memoryDir ? readFacts(opts.memoryDir) : null,
    memorySection: opts.memoryDir
      ? buildMemorySection(listSummaries(opts.memoryDir), { currentProject: opts.cwd })
      : null,
    skillsSummary: skills.length > 0 ? summarizeSkills(skills) : null,
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
    });
    logger.append({ t: "message", role: "user", content: opts.message, ts: new Date().toISOString() });
  }
  const budget = createBudget(opts.capUSD, opts.pricing);

  const result = await runAgentTurn({
    provider: opts.provider,
    model: opts.model,
    system,
    tools: applyDenyTools(
      [...toolsForPolicy(policy, skillDirs), ...(opts.extraTools ?? [])],
      opts.denyTools,
    ),
    messages: [{ role: "user", content: opts.message }],
    budget,
    maxTokens: opts.maxTokens,
    cwd: opts.cwd,
    approve:
      opts.approve ??
      (async (_name, group) => group === "read"),
    guard: opts.guard,
    onTextDelta: opts.onTextDelta,
    audit: opts.audit,
    onEvent: logger
      ? (e: TurnEvent) => {
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
              costUSD: e.costUSD,
              spentUSD: budget.spentUSD,
              ts,
            });
          }
        }
      : undefined,
  });
  return {
    text: result.text,
    stopReason: result.stopReason,
    costUSD: result.costUSD,
    usage: result.usage,
  };
}
