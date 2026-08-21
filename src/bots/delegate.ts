import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { resolveBot, botModelRef, botBudgetUSD } from "./profile";
import { buildSystemPrompt } from "../agent/prompt";
import { runAgentTurn } from "../agent/loop";
import { Budget, formatUSD } from "../agent/budget";
import { readTool } from "../tools/read";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import type { ToolDef } from "../tools/registry";

export interface AskBotDeps {
  home: string;
  fromBot: string;
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
}

const DEFAULT_DELEGATION_CAP_USD = 1.0;

export function createAskBotTool(deps: AskBotDeps): ToolDef {
  return {
    name: "ask_bot",
    group: "write",
    description:
      "Ask another bot a question and wait for its answer. The target bot runs headless with its own model and soul, read-only, under a small spend cap.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Target bot name" },
        message: { type: "string", description: "What you want to know or done" },
      },
      required: ["bot", "message"],
    },
    async handler(args, _ctx) {
      const targetName = String(args.bot ?? "").trim();
      if (targetName === deps.fromBot) throw new Error("cannot delegate to yourself");
      const profile = resolveBot(deps.home, targetName);
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("message must not be empty");

      const ref = botModelRef(profile, deps.globalConfig);
      const provider = deps.getProvider(ref.provider);

      let cap = botBudgetUSD(profile, DEFAULT_DELEGATION_CAP_USD);
      if (cap <= 0) cap = DEFAULT_DELEGATION_CAP_USD;
      if (deps.sessionBudget && deps.sessionBudget.capUSD > 0) {
        const remaining = deps.sessionBudget.capUSD - deps.sessionBudget.spentUSD;
        cap = Math.min(cap, Math.max(0.01, remaining));
      }

      const delegatedTools: ToolDef[] = [readTool, globTool, grepTool];
      const system = buildSystemPrompt({
        soulText: profile.soulText,
        agentsMd: null,
        cwd: deps.cwd,
      });
      const budget = new Budget(cap);

      const result = await runAgentTurn({
        provider,
        model: ref.model,
        system,
        tools: delegatedTools,
        messages: [{ role: "user", content: message }],
        budget,
        maxTokens: deps.globalConfig.maxTokens,
        cwd: deps.cwd,
        approve: async () => false,
      });

      const text = result.text;

      const meta = `[delegated to ${profile.name} (${ref.provider}:${ref.model}), ${formatUSD(result.costUSD)}]`;
      if (!text) {
        return `The ${profile.name} bot returned no text (${result.stopReason}). ${meta}`;
      }
      if (result.stopReason === "budget_exhausted") {
        return `${text}\n\n(note: hit its spend cap mid-thought) ${meta}`;
      }
      return `${text}\n\n${meta}`;
    },
  };
}
