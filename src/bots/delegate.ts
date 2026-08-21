import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { resolveBot, listBots, botModelRef, botBudgetUSD } from "./profile";
import { loadTeam, resolveTeamTarget } from "./team";
import { runHeadless, capPolicy } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid } from "../security/injection";
import { Budget, formatUSD } from "../agent/budget";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../tools/registry";

export interface AskBotDeps {
  home: string;
  fromBot: string;
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
  guard?: import("../security/guard").SecurityGuard | null;
  audit?: (
    kind: "delegation" | "write_exec" | "budget_halt" | "budget_exceeded" | "prompt_injection",
    detail: string,
    correlationId?: string,
  ) => void;
}

const DEFAULT_DELEGATION_CAP_USD = 1.0;

export function createAskBotTool(deps: AskBotDeps): ToolDef {
  return {
    name: "ask_bot",
    group: "write",
    description:
      "Ask another bot a question and wait for its answer. The target bot runs headless with its own model and soul, read-only, under a small spend cap. `bot` may be a bot name or a team role (team.yaml). Effort vs tree budget: a subagent's effort dial scales how many iterations it may use, and every iteration counts against the shared delegation-tree cap — so a high/max-effort subagent can exhaust the whole tree budget, after which later siblings stop immediately with tree_budget_exceeded. The tree cap is authoritative across the chain.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Target bot name or team role" },
        message: { type: "string", description: "What you want to know or done" },
      },
      required: ["bot", "message"],
    },
    async handler(args, ctx) {
      const rawTarget = String(args.bot ?? "").trim();
      if (rawTarget === deps.fromBot) throw new Error("cannot delegate to yourself");
      // Resolve a team role (e.g. "the writer") to a concrete bot, unless the
      // target is already a valid bot name.
      let targetName = rawTarget;
      if (!listBots(deps.home).includes(rawTarget)) {
        const team = loadTeam(deps.home);
        const resolved = team ? resolveTeamTarget(team, rawTarget) : null;
        if (resolved) targetName = resolved;
      }
      const profile = resolveBot(deps.home, targetName);
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("message must not be empty");

      const correlationId = randomUUID();

      deps.audit?.(
        "delegation",
        `ask_bot -> ${targetName}: ${message.slice(0, 120)}`,
        correlationId,
      );
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
        pricing: deps.globalConfig.pricing,
        globalBudget: deps.globalConfig.globalBudget,
        policy: capPolicy("read-only", profile.config.security?.policy),
        denyTools: profile.config.security?.denyTools,
        home: deps.home,
        memoryDir: profile.memoryDir,
        guard: guardForBot(
          deps.globalConfig.security,
          profile.config.security,
          deps.guard?.onBlock,
        ),
        paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
        effort: profile.config.effort,
        correlationId,
        audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
        sessionLogDir: profile.sessionsDir,
        sessionBot: profile.name,
        context: deps.globalConfig.context,
        // #154: inherit the caller's shared tree budget so this subagent counts
        // against the same counter as the rest of the delegation tree.
        treeBudget: ctx.treeBudget,
      });

      const text = result.text;

      // #154: the shared tree cap was hit (this run or one it delegated to).
      if (result.stopReason === "tree_budget_exceeded") {
        deps.audit?.(
          "budget_exceeded",
          `delegation tree budget exhausted during ${profile.name} run`,
          correlationId,
        );
        return `Delegation to ${profile.name} stopped: shared tree budget exhausted (${ctx.treeBudget?.usedIterations ?? 0} iteration(s) across the tree).`;
      }

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
