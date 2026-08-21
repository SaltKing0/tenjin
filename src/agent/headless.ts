import type { Provider, Usage } from "../provider/types";
import { buildSystemPrompt } from "./prompt";
import { Budget } from "./budget";
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

export type ToolPolicy = "read-only" | "none" | "full";

export interface HeadlessOptions {
  provider: Provider;
  model: string;
  soulText: string;
  cwd: string;
  message: string;
  maxTokens: number;
  capUSD: number;
  policy?: ToolPolicy;
  agentsMd?: string | null;
  extraTools?: ToolDef[];
  sessionLogDir?: string;
  sessionBot?: string;
  guard?: import("../security/guard").SecurityGuard | null;
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

export function toolsForPolicy(policy: ToolPolicy): ToolDef[] {
  switch (policy) {
    case "read-only":
      return [readTool, globTool, grepTool];
    case "full":
      return [readTool, globTool, grepTool, writeTool, editTool, bashTool];
    case "none":
      return [];
  }
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const policy = opts.policy ?? "read-only";
  const system = buildSystemPrompt({
    soulText: opts.soulText,
    agentsMd: opts.agentsMd ?? null,
    cwd: opts.cwd,
  });
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
  const budget = new Budget(opts.capUSD);

  const result = await runAgentTurn({
    provider: opts.provider,
    model: opts.model,
    system,
    tools: [...toolsForPolicy(policy), ...(opts.extraTools ?? [])],
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
            logger?.append({ t: "tool_call", id: e.id, name: e.name, input: e.input, ts });
          } else if (e.t === "tool_result") {
            logger?.append({ t: "tool_result", id: e.id, name: e.name, ok: e.ok, output: e.output, ts });
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
