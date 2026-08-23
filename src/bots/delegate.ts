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
  /** Quality-gate review (B): a reviewer bot's verdict on the worker's output. */
  review?: { verdict: "approved" | "needs_work"; reason?: string; attempts: number };
  /** issue_bot (#450): isolated git worktree the worker operated in. */
  worktreePath?: string;
  /** issue_bot (#450): fresh branch created from `main` for the work. */
  branch?: string;
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
export function boundedSummary(framed: string): string {
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
  if (c.worktreePath) lines.push(`worktree: ${c.worktreePath}`);
  if (c.branch) lines.push(`branch: ${c.branch}`);
  lines.push(`diff_summary: ${c.diffSummary ?? "n/a"}`);
  if (c.review) {
    lines.push(`review: ${c.review.verdict}${c.review.reason ? ` — ${c.review.reason}` : ""} (after ${c.review.attempts} attempt(s))`);
  }
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

/** Quality-gate (B): max worker → review → retry rounds a handoff runs. */
const MAX_HANDOFF_ATTEMPTS = 2;

/** Run a strict reviewer (read-only) over a worker's output; parse APPROVED /
 *  NEEDS_WORK. The reviewer is a quality gate the handoff result passes
 *  through before it is accepted back into the parent transcript. */
async function runReviewer(
  deps: AskBotDeps,
  profile: ReturnType<typeof resolveBot>,
  task: string,
  workerOutput: string,
  correlationId: string,
): Promise<{ verdict: "approved" | "needs_work"; reason?: string }> {
  const ref = botModelRef(profile, deps.globalConfig);
  const provider = deps.getProvider(ref.provider);
  const result = await runHeadless({
    provider,
    model: ref.model,
    soulText:
      "You are a strict quality reviewer. Judge whether the worker's output satisfies the task. Reply with exactly one line starting VERDICT: APPROVED or VERDICT: NEEDS_WORK, then a brief reason.",
    cwd: deps.cwd,
    message: `TASK:\n${task}\n\nWORKER OUTPUT:\n${workerOutput.slice(0, 6000)}`,
    maxTokens: deps.globalConfig.maxTokens,
    capUSD: 0.1,
    pricing: deps.globalConfig.pricing,
    globalBudget: deps.globalConfig.globalBudget,
    policy: capPolicy("read-only"),
    home: deps.home,
    memoryDir: profile.memoryDir,
    guard: guardForBot(deps.globalConfig.security, profile.config.security, deps.guard?.onBlock),
    paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
    correlationId,
    audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
    sessionLogDir: profile.sessionsDir,
    sessionBot: profile.name,
    context: deps.globalConfig.context,
  });
  const text = (result.text ?? "").trim();
  const verdict: "approved" | "needs_work" = /NEEDS_WORK/i.test(text) ? "needs_work" : "approved";
  const reason = text.replace(/^VERDICT:\s*(APPROVED|NEEDS_WORK)\s*/i, "").trim().slice(0, 200);
  return { verdict, reason: reason || undefined };
}

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

/**
 * Handoff (A): run a target bot WRITE-capable so it can actually take over and
 * complete a task, then block on its reply. Shares ask_bot's B11-2 context
 * firewall (bounded contract + sidecar, never auto-loaded) and tree-budget
 * accounting — the only difference is the write policy so the target may edit
 * files / run commands. This is the "@-handoff + block-on-reply" primitive.
 */
export function createHandoffBotTool(deps: AskBotDeps): ToolDef {
  return {
    name: "handoff_bot",
    group: "write",
    description:
      "Hand a task off to another named bot and block on its reply. The target runs headless with its own model and soul, write-capable, and retries up to a quality-gate limit when a reviewer marks its output NEEDS_WORK; the final bounded contract reports the review verdict. Use for work you want another bot to take over end-to-end; use ask_bot for a read-only question.",
    inputSchema: {
      type: "object",
      properties: {
        bot: { type: "string", description: "Target bot name or team role" },
        message: { type: "string", description: "The task to hand off" },
      },
      required: ["bot", "message"],
    },
    async handler(args, ctx) {
      const rawTarget = String(args.bot ?? "").trim();
      if (rawTarget === deps.fromBot) throw new Error("cannot hand off to yourself");
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
      deps.audit?.("delegation", `handoff_bot -> ${targetName}: ${message.slice(0, 120)}`, correlationId);
      const ref = botModelRef(profile, deps.globalConfig);
      const provider = deps.getProvider(ref.provider);

      // Quality gate (B): worker → reviewer → retry, up to MAX_HANDOFF_ATTEMPTS.
      let task = message;
      let finalText = "";
      let finalStatus: DelegationStatus = "success";
      let totalCost = 0;
      let attempts = 0;
      let reviewVerdict: "approved" | "needs_work" = "needs_work";
      let reviewReason: string | undefined;

      for (let i = 0; i < MAX_HANDOFF_ATTEMPTS; i++) {
        attempts = i + 1;
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
          message: task,
          maxTokens: deps.globalConfig.maxTokens,
          capUSD: cap,
          pricing: deps.globalConfig.pricing,
          globalBudget: deps.globalConfig.globalBudget,
          policy: capPolicy("full", profile.config.security?.policy),
          denyTools: profile.config.security?.denyTools,
          home: deps.home,
          memoryDir: profile.memoryDir,
          guard: guardForBot(deps.globalConfig.security, profile.config.security, deps.guard?.onBlock),
          paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
          effort: profile.config.effort,
          correlationId,
          audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
          sessionLogDir: profile.sessionsDir,
          sessionBot: profile.name,
          context: deps.globalConfig.context,
          treeBudget: ctx.treeBudget,
        });
        totalCost += result.costUSD;
        finalText = result.text ?? "";
        if (result.stopReason === "tree_budget_exceeded") {
          finalStatus = "tree_budget_exceeded";
          break;
        }
        if (result.stopReason === "budget_exhausted") {
          finalStatus = "budget_exhausted";
          break;
        }
        if (!finalText) break;
        const review = await runReviewer(deps, profile, message, finalText, correlationId);
        reviewVerdict = review.verdict;
        reviewReason = review.reason;
        if (review.verdict === "approved" || i === MAX_HANDOFF_ATTEMPTS - 1) break;
        task = `${message}\n\nREVIEW FEEDBACK (attempt ${attempts} not approved): ${review.reason ?? "improve the result"}`;
      }

      const framed = finalText
        ? hardenUntrustedInput(finalText, {
            paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
            audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
            correlationId,
          })
        : finalText;

      const sidecarPath = framed
        ? writeDelegationSidecar(deps.home, profile.name, framed, correlationId)
        : undefined;

      const status: DelegationStatus = finalText ? finalStatus : "no_text";
      const fallback = `The ${profile.name} bot returned no text (${finalStatus}).`;

      return renderDelegationContract({
        target: profile.name,
        model: `${ref.provider}:${ref.model}`,
        status,
        costUSD: totalCost,
        summary: framed && framed.length > 0 ? boundedSummary(framed) : fallback,
        sidecarPath,
        diffSummary: "write handoff — full output in sidecar",
        review: { verdict: reviewVerdict, reason: reviewReason, attempts },
      });
    },
  };
}
