// ===========================================================================
// #450 Autonomous Issue Workflow
// ---------------------------------------------------------------------------
// Take an issue/task, create an ISOLATED git worktree on a fresh lowercase
// branch from `main`, hand the fix to a write-capable worker bot scoped to
// that worktree, run the work through the quality gate (worker -> reviewer ->
// retry, the same loop as handoff_bot), and write a correlated audit chain
// (issue_started -> delegation -> issue_completed) sharing one correlationId.
// The parent transcript receives only a bounded contract (worktree path,
// branch, status, diff summary) via renderDelegationContract — the B11-2
// context firewall reused from delegation.
// ===========================================================================

import type { Provider } from "../provider/types";
import type { HarnessConfig, ProviderName } from "../config/types";
import { resolveBot, listBots, botModelRef, botBudgetUSD } from "./profile";
import { loadTeam, resolveTeamTarget } from "./team";
import { runHeadless, capPolicy } from "../agent/headless";
import { guardForBot } from "../security/guard";
import { resolveParanoid, hardenUntrustedInput } from "../security/injection";
import { Budget } from "../agent/budget";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../tools/registry";
import type { AuditKind } from "../audit/log";
import { ConfigError } from "../config/types";
import {
  renderDelegationContract,
  writeDelegationSidecar,
  boundedSummary,
  type DelegationContract,
  type DelegationStatus,
} from "./delegate";

const DEFAULT_ISSUE_CAP_USD = 1.0;

/** Quality-gate: max worker -> review -> retry rounds an issue run performs. */
const MAX_ISSUE_ATTEMPTS = 2;

export interface IssueBotDeps {
  home: string;
  fromBot: string;
  /** Parent's working directory; used as the default repo when none is given. */
  cwd: string;
  getProvider: (name: ProviderName) => Provider;
  globalConfig: HarnessConfig;
  sessionBudget?: Budget;
  guard?: import("../security/guard").SecurityGuard | null;
  audit?: (kind: AuditKind, detail: string, correlationId?: string) => void;
}

/** Root where per-issue worktrees live, inside the target repo: <repo>/.tenjin/issues/. */
export function issuesWorktreesDir(repo: string): string {
  return join(repo, ".tenjin", "issues");
}

/**
 * Lowercase branch name derived from a title or explicit branch arg. Lowercasing
 * avoids the macOS case-collision hazard (a worktree dir and branch sharing a
 * name that differs only in case).
 */
export function normalizeBranch(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new ConfigError("branch name must be non-empty after sanitizing");
  return slug;
}

/** Run git in `dir`, surfacing failures as a ConfigError. Returns trimmed stdout. */
function git(dir: string, args: string[], msg: string): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0 || r.error) {
    const err = (r.stderr || r.stdout || "").trim().split("\n").pop() ?? "unknown error";
    throw new ConfigError(`${msg}: ${err}`);
  }
  return (r.stdout || "").trim();
}

/** Fail with a clean error when `repo` is not an existing git working tree. */
function ensureGitRepo(repo: string): void {
  const r = spawnSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0 || r.error) {
    throw new ConfigError(`not a git repository: ${repo}`);
  }
}

/** Create the isolated worktree on a fresh lowercase branch from `main`. */
function createWorktree(repo: string, branch: string): string {
  const root = issuesWorktreesDir(repo);
  mkdirSync(root, { recursive: true });
  const wtDir = join(root, branch);
  git(repo, ["rev-parse", "--verify", "main"], `no "main" branch in ${repo}`);
  git(repo, ["worktree", "add", "-b", branch, wtDir, "main"], `git worktree add for ${branch} failed`);
  return wtDir;
}

/** Bounded diff summary: uncommitted stat + any commits ahead of `main`. */
function diffSummary(wtDir: string): string {
  const stat = git(wtDir, ["diff", "--stat"], "");
  const commits = git(wtDir, ["log", "--oneline", "main..HEAD"], "");
  const parts: string[] = [];
  if (stat) parts.push(stat);
  if (commits) parts.push(`commits: ${commits.replace(/\n/g, "; ")}`);
  return parts.length ? parts.join(" · ") : "none";
}

/** Strict reviewer (read-only) over the worker's output; the quality gate. */
async function runReviewer(
  deps: IssueBotDeps,
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

/**
 * `issue_bot` tool (#450): orchestrate an autonomous issue-resolution workflow.
 * Creates an isolated git worktree on a fresh lowercase branch from `main`,
 * hands the task to a write-capable worker bot scoped to that worktree (per-call
 * `cwd` override, since the handoff path otherwise uses the parent's deps.cwd),
 * runs the quality gate, and records a correlated audit chain.
 */
export function createIssueBotTool(deps: IssueBotDeps): ToolDef {
  return {
    name: "issue_bot",
    group: "write",
    description:
      "Autonomously resolve an issue/task: creates an isolated git worktree on a fresh lowercase branch from `main`, hands the fix to a write-capable worker bot scoped to that worktree, runs it through the quality gate (worker -> reviewer -> retry), and returns a bounded contract (worktree path, branch, status, diff summary). Use for end-to-end issue fixes you want isolated from the main working tree.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Path to the git repository to work in (defaults to the current working directory).",
        },
        branch: {
          type: "string",
          description: "Fresh branch name created from main (lowercased). Defaults to a slug of `title`.",
        },
        title: {
          type: "string",
          description: "Issue title used to derive the branch name when `branch` is omitted.",
        },
        bot: { type: "string", description: "Target worker bot name or team role." },
        task: { type: "string", description: "The issue/fix to hand off to the worker." },
      },
      required: ["bot", "task"],
    },
    async handler(args, ctx) {
      const rawTarget = String(args.bot ?? "").trim();
      if (rawTarget === deps.fromBot) throw new Error("cannot hand an issue to yourself");
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("task must not be empty");

      // Repo defaults to the caller's cwd; a non-git dir fails cleanly.
      const repo = args.repo ? String(args.repo).trim() : deps.cwd;
      ensureGitRepo(repo);

      const branch = normalizeBranch(
        args.branch ? String(args.branch) : args.title ? String(args.title) : "issue",
      );

      // Resolve a team role (e.g. "the implementer") to a concrete bot, unless
      // the target is already a valid bot name.
      let targetName = rawTarget;
      if (!listBots(deps.home).includes(rawTarget)) {
        const team = loadTeam(deps.home);
        const resolved = team ? resolveTeamTarget(team, rawTarget) : null;
        if (resolved) targetName = resolved;
      }
      const profile = resolveBot(deps.home, targetName);

      // Correlated audit chain: issue_started -> delegation -> issue_completed.
      const correlationId = randomUUID();
      deps.audit?.(
        "issue_started",
        `issue_bot ${branch} in ${repo}: ${task.slice(0, 120)}`,
        correlationId,
      );
      deps.audit?.(
        "delegation",
        `issue_bot worker -> ${targetName}: ${task.slice(0, 120)}`,
        correlationId,
      );

      // Isolated worktree on a fresh lowercase branch from main.
      let wtDir: string;
      try {
        wtDir = createWorktree(repo, branch);
      } catch (e) {
        deps.audit?.(
          "issue_completed",
          `issue_bot ${branch}: worktree creation failed — ${(e as Error).message}`,
          correlationId,
        );
        throw e;
      }

      const ref = botModelRef(profile, deps.globalConfig);
      const provider = deps.getProvider(ref.provider);

      // Quality gate loop (mirrors handoff_bot): worker -> reviewer -> retry.
      let loopTask = task;
      let finalText = "";
      let finalStatus: DelegationStatus = "success";
      let totalCost = 0;
      let attempts = 0;
      let reviewVerdict: "approved" | "needs_work" = "needs_work";
      let reviewReason: string | undefined;

      for (let i = 0; i < MAX_ISSUE_ATTEMPTS; i++) {
        attempts = i + 1;
        let cap = botBudgetUSD(profile, DEFAULT_ISSUE_CAP_USD);
        if (cap <= 0) cap = DEFAULT_ISSUE_CAP_USD;
        if (deps.sessionBudget && deps.sessionBudget.capUSD > 0) {
          const remaining = deps.sessionBudget.capUSD - deps.sessionBudget.spentUSD;
          cap = Math.min(cap, Math.max(0.01, remaining));
        }
        // Per-call cwd override: the worker is scoped to the worktree, not deps.cwd.
        const result = await runHeadless({
          provider,
          model: ref.model,
          soulText: profile.soulText,
          cwd: wtDir,
          message: loopTask,
          maxTokens: deps.globalConfig.maxTokens,
          capUSD: cap,
          pricing: deps.globalConfig.pricing,
          globalBudget: deps.globalConfig.globalBudget,
          policy: capPolicy("full", profile.config.security?.policy),
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
        const review = await runReviewer(deps, profile, task, finalText, correlationId);
        reviewVerdict = review.verdict;
        reviewReason = review.reason;
        if (review.verdict === "approved" || i === MAX_ISSUE_ATTEMPTS - 1) break;
        loopTask = `${task}\n\nREVIEW FEEDBACK (attempt ${attempts} not approved): ${review.reason ?? "improve the result"}`;
      }

      // The worker's output is untrusted (it ran with its own soul/model) —
      // harden and frame it before persisting, mirroring the delegation path.
      const framed = finalText
        ? hardenUntrustedInput(finalText, {
            paranoid: resolveParanoid(deps.globalConfig.security, profile.config.security),
            audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
            correlationId,
          })
        : finalText;

      const sidecarPath = framed
        ? writeDelegationSidecar(deps.home, `issue-${branch}`, framed, correlationId)
        : undefined;

      const status: DelegationStatus = finalText ? finalStatus : "no_text";
      const fallback = `The ${profile.name} bot returned no text (${finalStatus}).`;

      const contract: DelegationContract = {
        target: profile.name,
        model: `${ref.provider}:${ref.model}`,
        status,
        costUSD: totalCost,
        summary: framed && framed.length > 0 ? boundedSummary(framed) : fallback,
        sidecarPath,
        diffSummary: diffSummary(wtDir),
        worktreePath: wtDir,
        branch,
        review: { verdict: reviewVerdict, reason: reviewReason, attempts },
      };

      deps.audit?.(
        "issue_completed",
        `issue_bot ${branch}: status ${status} — worktree ${wtDir}`,
        correlationId,
      );
      return renderDelegationContract(contract);
    },
  };
}
