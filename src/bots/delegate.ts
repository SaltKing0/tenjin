import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { resolveBot, listBots, botModelRef, botBudgetUSD } from "./profile";
import { loadTeam, resolveTeamTarget } from "./team";
import { runHeadless, capPolicy } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid, hardenUntrustedInput } from "../security/injection";
import { Budget, formatUSD } from "../agent/budget";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../tools/registry";

// B11-2 delegation context firewall: the full subagent output is persisted to a
// sidecar artifact; the parent transcript only receives a BOUNDED contract
// (summary + sidecar_path + status + diff_summary), so parent context stays
// O(k) across k delegations regardless of subagent workload. The parent never
// auto-loads the sidecar — it reads it explicitly via read_file on demand.

/** Cap on the inline contract summary (~2000 tokens at chars/4). */
export const CONTRACT_SUMMARY_MAX_CHARS = 8000;

/** Directory where delegation sidecar artifacts are written. */
export function delegationArtifactsDir(home: string): string {
  return join(home, "artifacts");
}

export type DelegationStatus = "success" | "budget_exhausted" | "tree_budget_exceeded" | "no_text";

export interface DelegationContract {
  target: string;
  model: string;
  status: DelegationStatus;
  costUSD: number;
  summary: string;
  sidecarPath?: string;
  diffSummary?: string;
  treeIterations?: number;
}

function sanitizeFilename(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "delegation";
}

/**
 * Persist the full (framed/hardened) subagent output to
 * `artifacts/<target>-<corr>.md` and return its path. Nothing is ever
 * auto-loaded back into the parent prompt.
 */
export function writeDelegationSidecar(
  home: string,
  target: string,
  content: string,
  correlationId: string,
): string {
  const dir = delegationArtifactsDir(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sanitizeFilename(target)}-${correlationId.slice(0, 8)}.md`);
  const header = `# delegation ${target} · ${correlationId}\n\n`;
  writeFileSync(path, `${header}${content}\n`, "utf8");
  return path;
}

/** Bound the inline summary: keep the full framed text when short, else a
 * truncated head with a pointer to the sidecar. */
function boundedSummary(framed: string): string {
  if (framed.length <= CONTRACT_SUMMARY_MAX_CHARS) return framed;
  return `${framed.slice(0, CONTRACT_SUMMARY_MAX_CHARS)}\n…[truncated — full detail in sidecar]`;
}

/** Render the contract block that lands in the parent transcript. */
export function renderDelegationContract(c: DelegationContract): string {
  const lines: string[] = [
    "[delegation contract]",
    `status: ${c.status}`,
    `target: ${c.target} (${c.model})`,
    `cost: ${formatUSD(c.costUSD)}`,
  ];
  if (c.treeIterations !== undefined) lines.push(`tree_iterations: ${c.treeIterations}`);
  if (c.sidecarPath) lines.push(`sidecar: ${c.sidecarPath}`);
  lines.push(`diff_summary: ${c.diffSummary ?? "n/a"}`);
  lines.push(`summary: ${c.summary}`);
  if (c.sidecarPath) {
    lines.push(`(Full detail is in the sidecar — read_file ${c.sidecarPath} to load it on demand.)`);
  }
  return lines.join("\n");
}

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

      // #316: the delegated bot's output is untrusted data (it runs with its own
      // soul/model and may be hostile or steered) — scan, audit and frame it
      // before persisting, mirroring the task-path hardening (#189).
      const framed = text
        ? hardenUntrustedInput(text, {
            paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
            audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
            correlationId,
          })
        : text;

      // #154: the shared tree cap was hit (this run or one it delegated to).
      if (result.stopReason === "tree_budget_exceeded") {
        deps.audit?.(
          "budget_exceeded",
          `delegation tree budget exhausted during ${profile.name} run`,
          correlationId,
        );
      }

      // B11-2 delegation context firewall: write the FULL output to a sidecar
      // artifact and return only a bounded contract (summary + sidecar_path +
      // status + diff_summary). The parent never auto-loads the sidecar — it
      // reads it explicitly via read_file on demand — so the parent transcript
      // stays O(k) across k delegations regardless of subagent workload.
      const sidecarPath = framed
        ? writeDelegationSidecar(deps.home, profile.name, framed, correlationId)
        : undefined;

      const status: DelegationStatus =
        result.stopReason === "tree_budget_exceeded"
          ? "tree_budget_exceeded"
          : result.stopReason === "budget_exhausted"
            ? "budget_exhausted"
            : !text
              ? "no_text"
              : "success";

      const fallback =
        result.stopReason === "tree_budget_exceeded"
          ? `Delegation to ${profile.name} stopped: shared tree budget exhausted (${ctx.treeBudget?.usedIterations ?? 0} iteration(s) across the tree).`
          : `The ${profile.name} bot returned no text (${result.stopReason}).`;

      return renderDelegationContract({
        target: profile.name,
        model: `${ref.provider}:${ref.model}`,
        status,
        costUSD: result.costUSD,
        summary: framed && framed.length > 0 ? boundedSummary(framed) : fallback,
        sidecarPath,
        diffSummary: "none (read-only delegation)",
        treeIterations:
          result.stopReason === "tree_budget_exceeded"
            ? ctx.treeBudget?.usedIterations
            : undefined,
      });
    },
  };
}
