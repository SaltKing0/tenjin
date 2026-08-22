// ===========================================================================
// B11-1 Subagent definition schema + built-in roles (#438)
// ---------------------------------------------------------------------------
// A subagent is a named, validated ROLE definition that can be delegated to.
// Schema is validated at definition time; built-in roles Explore (read/search
// only, cheap model) and general-purpose (full executor) ship by default.
//
// VETO BOUNDARY: there is NO heavy "Plan" role. Planning surfaces are tasks +
// delegation (§20 #25/#45). A definition that smells like a Plan role is
// rejected with a pointer to the veto.
//
// Roles integrate with the delegation context firewall (#370): the subagent's
// full output lands in a sidecar artifact and the parent receives only a
// bounded contract — no parent inheritance of subagent internals. Depth is
// bounded via the shared delegation tree budget (max_depth=1: a subagent does
// not spawn further subagents).
// ===========================================================================

import { ConfigError } from "../config/types";
import {
  defaultModelRef,
  cheapModelRef,
  resolveModelRef,
  type ModelRef,
} from "../config/models";
import type { HarnessConfig, ProviderName } from "../config/types";
import type { Provider } from "../provider/types";
import type { ToolDef } from "../tools/registry";
import { runHeadless, capPolicy } from "../agent/headless";
import { Budget, type TreeBudget } from "../agent/budget";
import { guardForBot } from "../security/guard";
import { resolveParanoid, hardenUntrustedInput } from "../security/injection";
import {
  writeDelegationSidecar,
  CONTRACT_SUMMARY_MAX_CHARS,
  type DelegationContract,
  type DelegationStatus,
} from "./delegate";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Tool classification (used for toolset enforcement)
// ---------------------------------------------------------------------------

/** Tools that mutate state / execute — a read-only role must never hold these. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "bash",
  "save_skill",
  "checkpoint",
]);

/** Tools that only read / search / retrieve. */
export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "retrieve",
  "list_skills",
  "recall",
]);

export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface SubagentPermissions {
  /** false forbids write tools entirely (enforced at run + definition time). */
  write?: boolean;
}

export interface SubagentBudget {
  capUSD?: number;
}

export interface SubagentRole {
  id: string;
  name: string;
  systemPrompt: string;
  /** Allowlisted tool names (validated against known tools at definition). */
  tools: string[];
  permissions?: SubagentPermissions;
  /** Optional provider:model override; defaults to cheap for Explore. */
  model?: string;
  budget?: SubagentBudget;
}

export interface SubagentValidationCtx {
  /** The registered tool names a role may reference. */
  knownTools?: string[];
}

/** VETO: no heavy Plan role — planning is tasks + delegation, never a role. */
const PLAN_VETO_HINT = /\b(plan|planner|planning)\b/i;
export const PLAN_VETO_MESSAGE =
  "role looks like a heavy 'Plan' role, which is vetoed (B11-1 §20 #25/#45): planning is done via tasks + delegation, not a plan-mode subagent. Split planning into a task or delegate the concrete steps instead.";

function looksLikePlanRole(def: {
  id: string;
  name: string;
  systemPrompt: string;
}): boolean {
  return PLAN_VETO_HINT.test(`${def.id} ${def.name} ${def.systemPrompt}`);
}

function badBudget(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "number") return true;
  return !Number.isFinite(v) || v < 0;
}

/** Validate a subagent role definition at definition time. Throws ConfigError
 *  on missing fields, unknown tools, a bad budget, a Plan-role veto, or an
 *  Explore role that tries to hold write tools. */
export function validateSubagentRole(
  raw: unknown,
  ctx: SubagentValidationCtx = {},
): SubagentRole {
  if (!raw || typeof raw !== "object")
    throw new ConfigError("subagent role must be an object");
  const def = raw as Record<string, unknown>;

  const id = typeof def.id === "string" ? def.id.trim() : "";
  const name = typeof def.name === "string" ? def.name.trim() : "";
  const systemPrompt = typeof def.systemPrompt === "string" ? def.systemPrompt : "";
  if (!id) throw new ConfigError("subagent role is missing an id");
  if (!name) throw new ConfigError(`subagent role "${id}" is missing a name`);
  if (!systemPrompt.trim())
    throw new ConfigError(`subagent role "${id}" is missing a systemPrompt`);
  if (!Array.isArray(def.tools))
    throw new ConfigError(`subagent role "${id}" must declare a tools[] allowlist`);

  const tools = def.tools.map((t) => (typeof t === "string" ? t : "")).filter(Boolean);
  if (tools.length === 0)
    throw new ConfigError(`subagent role "${id}" must allow at least one tool`);

  const known = ctx.knownTools ? new Set(ctx.knownTools) : null;
  if (known) {
    const unknownTools = tools.filter((t) => !known.has(t));
    if (unknownTools.length > 0) {
      throw new ConfigError(
        `subagent role "${id}" references unknown tool(s): ${unknownTools.join(", ")}`,
      );
    }
  }

  // budget validation
  const budgetRaw = def.budget as Record<string, unknown> | undefined;
  const capUSD = budgetRaw?.capUSD;
  if (badBudget(capUSD))
    throw new ConfigError(`subagent role "${id}" has an invalid budget.capUSD`);
  const budget: SubagentBudget | undefined =
    typeof capUSD === "number" ? { capUSD } : undefined;

  const permissions = def.permissions as Record<string, unknown> | undefined;
  const write =
    permissions && typeof permissions.write === "boolean" ? permissions.write : true;

  const role: SubagentRole = {
    id,
    name,
    systemPrompt,
    tools,
    permissions: { write },
    model: typeof def.model === "string" && def.model.trim() ? def.model.trim() : undefined,
    budget,
  };

  // VETO: no Plan role.
  if (looksLikePlanRole(role)) throw new ConfigError(PLAN_VETO_MESSAGE);

  // Explore-style read-only roles must not hold write tools (toolset enforced).
  if (id === "explore" || id === "Explore" || write === false) {
    const writeTools = tools.filter(isWriteTool);
    if (writeTools.length > 0) {
      throw new ConfigError(
        `subagent role "${id}" is read-only but allows write tool(s): ${writeTools.join(", ")}`,
      );
    }
  }

  return role;
}

// ---------------------------------------------------------------------------
// Built-in roles
// ---------------------------------------------------------------------------

export const EXPLORE_ROLE: SubagentRole = {
  id: "explore",
  name: "Explore",
  systemPrompt:
    "You are an Explore subagent. Your job is research and reconnaissance only: read, search and fetch to answer the question. You never write, edit or execute. Return a concise, source-anchored answer.",
  tools: [...READ_TOOL_NAMES],
  permissions: { write: false },
  budget: { capUSD: 0.25 },
};

export const GENERAL_PURPOSE_ROLE: SubagentRole = {
  id: "general-purpose",
  name: "General-purpose",
  systemPrompt:
    "You are a general-purpose executor subagent. You may read, write, edit, apply patches and run commands to accomplish the task, within the security guard's policy. Return a concise summary of what you changed and why.",
  tools: [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES],
  permissions: { write: true },
  budget: { capUSD: 1.0 },
};

/** Built-in roles by id — `explore` and `general-purpose`. */
export const BUILTIN_ROLES: Readonly<Record<string, SubagentRole>> = {
  explore: EXPLORE_ROLE,
  "general-purpose": GENERAL_PURPOSE_ROLE,
};

// ---------------------------------------------------------------------------
// Toolset enforcement
// ---------------------------------------------------------------------------

/**
 * The actual tools a role may use: the allowlisted names from `knownTools`,
 * further constrained so a read-only role (write:false) can never hold a write
 * tool — even if one sneaked into its allowlist.
 */
export function roleToolset(role: SubagentRole, knownTools: ToolDef[]): ToolDef[] {
  const allowed = new Set(role.tools);
  let out = knownTools.filter((t) => allowed.has(t.name));
  if (role.permissions?.write === false) {
    out = out.filter((t) => !isWriteTool(t.name));
  }
  return out;
}

/** Resolve the model ref for a role: explicit override, else cheap for Explore
 *  and the default for a general executor. */
export function roleModelRef(role: SubagentRole, config: HarnessConfig): ModelRef {
  if (role.model) return resolveModelRef(role.model, config.provider);
  if (role.permissions?.write === false) {
    return cheapModelRef(config) ?? defaultModelRef(config);
  }
  return defaultModelRef(config);
}

// ---------------------------------------------------------------------------
// Delegation (one real headless turn -> bounded contract)
// ---------------------------------------------------------------------------

export interface SubagentRunDeps {
  home: string;
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
  /** The full tool registry to derive the role's toolset from. */
  knownTools: ToolDef[];
}

const DEFAULT_SUBAGENT_CAP_USD = 1.0;

/**
 * Run a validated subagent role end-to-end: one headless delegation turn with
 * the role's systemPrompt, model, budget and ENFORCED toolset. The full output
 * is hardened + written to a sidecar; the parent receives only a bounded
 * contract (context firewall #370). Depth is bounded by an inherited
 * delegation-tree budget (max_depth=1 — a subagent never spawns further
 * subagents).
 */
export async function runSubagent(
  deps: SubagentRunDeps,
  role: SubagentRole,
  message: string,
  opts: { correlationId?: string; treeBudget?: TreeBudget } = {},
): Promise<DelegationContract> {
  validateSubagentRole(role, { knownTools: deps.knownTools.map((t) => t.name) });

  const correlationId = opts.correlationId ?? randomUUID();
  const ref = roleModelRef(role, deps.globalConfig);
  const provider = deps.getProvider(ref.provider);

  let cap = role.budget?.capUSD ?? DEFAULT_SUBAGENT_CAP_USD;
  if (deps.sessionBudget && deps.sessionBudget.capUSD > 0) {
    const remaining = deps.sessionBudget.capUSD - deps.sessionBudget.spentUSD;
    cap = Math.min(cap, Math.max(0.01, remaining));
  }

  const policy = role.permissions?.write === false ? "read-only" : "full";
  const tools = roleToolset(role, deps.knownTools);

  deps.audit?.("delegation", `subagent ${role.id} <- ${message.slice(0, 120)}`, correlationId);

  const result = await runHeadless({
    provider,
    model: ref.model,
    soulText: role.systemPrompt,
    cwd: deps.cwd,
    message,
    maxTokens: deps.globalConfig.maxTokens,
    capUSD: cap,
    pricing: deps.globalConfig.pricing,
    globalBudget: deps.globalConfig.globalBudget,
    policy: capPolicy(policy, undefined),
    extraTools: tools,
    home: deps.home,
    guard: deps.guard,
    paranoid: resolveParanoid(deps.globalConfig.security, undefined),
    correlationId,
    audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
    context: deps.globalConfig.context,
    treeBudget: opts.treeBudget,
  });

  const text = result.text;
  const framed = text
    ? hardenUntrustedInput(text, {
        paranoid: resolveParanoid(deps.globalConfig.security, undefined),
        audit: (kind, detail) => deps.audit?.(kind, detail, correlationId),
        correlationId,
      })
    : text;

  if (result.stopReason === "tree_budget_exceeded") {
    deps.audit?.(
      "budget_exceeded",
      `subagent ${role.id} hit the shared delegation-tree budget`,
      correlationId,
    );
  }

  const sidecarPath = framed
    ? writeDelegationSidecar(deps.home, role.id, framed, correlationId)
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
      ? `Subagent ${role.id} stopped: shared tree budget exhausted.`
      : `Subagent ${role.id} returned no text (${result.stopReason}).`;

  return {
    target: role.id,
    model: `${ref.provider}:${ref.model}`,
    status,
    costUSD: result.costUSD,
    summary: framed && framed.length > 0 ? bounded(framed) : fallback,
    sidecarPath,
    diffSummary: role.permissions?.write === false ? "none (read-only subagent)" : "see sidecar",
    treeIterations:
      result.stopReason === "tree_budget_exceeded"
        ? opts.treeBudget?.usedIterations
        : undefined,
  };
}

function bounded(text: string): string {
  return text.length <= CONTRACT_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, CONTRACT_SUMMARY_MAX_CHARS)}\n…[truncated — full detail in sidecar]`;
}
