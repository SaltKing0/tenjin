import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { resolveBot, botModelRef, botBudgetUSD } from "./profile";
import { runHeadless } from "../agent/headless";
import { Budget, formatUSD } from "../agent/budget";
import type { ToolDef } from "../tools/registry";

export interface AskBotDeps {
  home: string;
  fromBot: string;
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
  guard?: import("../security/guard").SecurityGuard | null;
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

      const result = await runHeadless({
        provider,
        model: ref.model,
        soulText: profile.soulText,
        cwd: deps.cwd,
        message,
        maxTokens: deps.globalConfig.maxTokens,
        capUSD: cap,
        policy: "read-only",
        guard: deps.guard,
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
