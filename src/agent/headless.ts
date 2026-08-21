import type { Provider, Usage } from "../provider/types";
import { buildSystemPrompt } from "./prompt";
import { Budget } from "./budget";
import { runAgentTurn } from "./loop";
import { readTool } from "../tools/read";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import type { ToolDef } from "../tools/registry";

export type ToolPolicy = "read-only" | "none";

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
  const result = await runAgentTurn({
    provider: opts.provider,
    model: opts.model,
    system,
    tools: [...toolsForPolicy(policy), ...(opts.extraTools ?? [])],
    messages: [{ role: "user", content: opts.message }],
    budget: new Budget(opts.capUSD),
    maxTokens: opts.maxTokens,
    cwd: opts.cwd,
    approve: async (_name, group) => group === "read",
  });
  return {
    text: result.text,
    stopReason: result.stopReason,
    costUSD: result.costUSD,
    usage: result.usage,
  };
}
