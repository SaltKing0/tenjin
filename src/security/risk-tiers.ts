// ===========================================================================
// B13-3 Risk tiers T0/T1/T2 + evaluation order DENY > ASK > ALLOW (#401)
// ---------------------------------------------------------------------------
// Correctness invariant: evaluation order is DENY > ASK > ALLOW, first match
// wins, and specificity NEVER reorders a broad deny ahead of a narrow allow.
// The tier is enforced at RUNTIME (in the approval/guard call sites), never in
// the model.
//
//   T0  read-only                  -> auto-approve  (reads, greps, ls, git status/diff/log)
//   T1  write/exec/web/state       -> always ask    (file edits, bash, web, state-changing)
//   T2  irreversible/credential    -> always ask + STRONGEST confirmation
//        (rm -rf, force-push, drop table, deploy, credential access)
//        — "actions no mode auto-approves"
//
// Layering note: these harness tiers are AUTHORITATIVE. Future model-inline
// security_risk labels (B1-1) feed in only as advisory signal, never to
// downgrade a T2 decision.
// ===========================================================================

export type RiskTier = "T0" | "T1" | "T2";
export type RiskAction = "DENY" | "ASK" | "ALLOW";
export type ConfirmationStrength = "normal" | "strong";

/** Base tier per registered tool. Unknown/dynamic tools fall back to
 *  DEFAULT_RISK_TIER (conservative: ask). */
export const RISK_TIER_BY_TOOL: Readonly<Record<string, RiskTier>> = {
  // T0 — read-only, safe to auto-approve.
  read_file: "T0",
  glob: "T0",
  grep: "T0",
  recall: "T0",
  retrieve: "T0",
  list_skills: "T0",
  check_inbox: "T0",
  // T1 — write / exec / web / state-changing.
  write_file: "T1",
  edit_file: "T1",
  apply_patch: "T1",
  bash: "T1",
  web_fetch: "T1",
  web_search: "T1",
  remember: "T1",
  record_learning: "T1",
  core_memory: "T1",
  use_skill: "T1",
  save_skill: "T1",
  send_message: "T1",
  checkpoint: "T1",
};

/** Conservative default for unregistered tools, incl. dynamic `mcp__*` names. */
export const DEFAULT_RISK_TIER: RiskTier = "T1";

/** Every tool the harness can register (base + optional). Used by the test to
 *  assert the classification table covers all registered tools. Dynamic tools
 *  (mcp__*, bot tools) are not enumerated here and fall back to the default. */
export const KNOWN_TOOLS: readonly string[] = [
  "read_file",
  "glob",
  "grep",
  "write_file",
  "edit_file",
  "apply_patch",
  "bash",
  "web_fetch",
  "web_search",
  "remember",
  "record_learning",
  "recall",
  "core_memory",
  "retrieve",
  "use_skill",
  "save_skill",
  "list_skills",
  "check_inbox",
  "send_message",
  "checkpoint",
];

/** Irreversible / credential operations that escalate a call to T2. */
const T2_BASH_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i, // rm -rf / -fr / --recursive --force
  /\bgit\s+push\b[^|;&\n]*\s--force(?:\s|$)/i, // force push
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+TABLE\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  /\bdd\s+of=(\/dev\/|\.)/i,
  /\bmkfs\./i,
  /\bshutdown\b|\bpoweroff\b|\breboot\b|\binit\s+0\b/i,
];

const T2_CREDENTIAL_PATHS: readonly RegExp[] = [
  /(^|[\/\\])\.env([.\/\\]|$)/i,
  /(^|[\/\\])\.env\.[A-Za-z0-9_-]+([\/\\]|$)/i,
  /(^|[\/\\])id_rsa([.\/\\]|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.ssh([\/\\]|$)/i,
  /credential/i,
  /secret/i,
];

const PATH_FIELDS = ["path", "file", "target", "src", "dest"] as const;

/** Input-sensitive T2 detection: irreversible shell ops and credential access.
 *  A read tool (T0) still escalates to T2 on credential paths — reading a
 *  secret is credential access, not an innocuous read. */
export function isT2Input(tool: string, input: unknown): boolean {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (tool === "bash") {
    const cmd = typeof obj.command === "string" ? obj.command : "";
    return T2_BASH_PATTERNS.some((re) => re.test(cmd));
  }
  for (const f of PATH_FIELDS) {
    const v = obj[f];
    if (typeof v === "string" && T2_CREDENTIAL_PATHS.some((re) => re.test(v))) {
      return true;
    }
  }
  return false;
}

/** Classify a tool call into a risk tier: base table + T2 input escalation. */
export function classifyRisk(tool: string, input: unknown): RiskTier {
  if (isT2Input(tool, input)) return "T2";
  return RISK_TIER_BY_TOOL[tool] ?? DEFAULT_RISK_TIER;
}

/** The default approval action a tier implies. T0 allows; T1/T2 ask. */
export function tierToAction(tier: RiskTier): RiskAction {
  return tier === "T0" ? "ALLOW" : "ASK";
}

/** T2 requires the strongest confirmation shape at the prompt. */
export function confirmationStrength(tier: RiskTier): ConfirmationStrength {
  return tier === "T2" ? "strong" : "normal";
}

/** The T2 hard law: no mode, config, or session-allow path may auto-approve a
 *  T2-tiered call. Exposed separately so runtime call sites (approve fns in
 *  the REPL / gateway) can refuse T2 before honoring any allow path. */
export function isT2(tier: RiskTier): boolean {
  return tier === "T2";
}

/**
 * Bypass-mode guard: can a tier be auto-approved under an approval `mode`?
 * By the order law only T0 (read-only) is ever auto-approved. T1 always asks;
 * T2 is NEVER auto-approved under ANY mode — "actions no mode auto-approves".
 * `mode` is accepted so the invariant is explicit and testable across modes;
 * it never widens the gate.
 */
export function canAutoApprove(tier: RiskTier, _mode: string = "auto"): boolean {
  return tier === "T0";
}

// ---- Evaluation engine: DENY > ASK > ALLOW, first match wins -------------

export interface RiskRule {
  id: string;
  action: RiskAction;
  /** Tool names this rule applies to (exact or `*` glob). Empty = all tools. */
  tools?: string[];
  /** Optional input predicate (e.g. one specific dangerous command). */
  matchInput?: (input: unknown) => boolean;
  note?: string;
}

/** Precedence that encodes the order law; specificity never reorders. */
const ACTION_PRECEDENCE: Record<RiskAction, number> = { DENY: 0, ASK: 1, ALLOW: 2 };

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function toolMatches(pat: string, tool: string): boolean {
  if (pat === "*") return true;
  if (!pat.includes("*")) return pat === tool;
  const re = new RegExp(`^${pat.split("*").map(escapeRe).join(".*")}$`);
  return re.test(tool);
}

function ruleMatches(rule: RiskRule, tool: string, input: unknown): boolean {
  if (rule.tools && rule.tools.length > 0 && !rule.tools.some((t) => toolMatches(t, tool))) {
    return false;
  }
  if (rule.matchInput && !rule.matchInput(input)) return false;
  return true;
}

/**
 * Evaluate a rule set against a tool call. The order law DENY > ASK > ALLOW is
 * STRUCTURAL: rules are sorted by action precedence before matching, so a broad
 * deny always beats a narrow allow regardless of list order or specificity.
 * First matching rule (in precedence-then-list order) wins; falls back to the
 * tier's default action when no rule matches.
 */
export function evaluateRisk(rules: RiskRule[], tool: string, input: unknown): RiskAction {
  const ordered = [...rules].sort(
    (a, b) => ACTION_PRECEDENCE[a.action] - ACTION_PRECEDENCE[b.action],
  );
  for (const rule of ordered) {
    if (ruleMatches(rule, tool, input)) return rule.action;
  }
  return tierToAction(classifyRisk(tool, input));
}

/** Baseline rule set, already ordered by the DENY > ASK > ALLOW law. Callers
 *  append their own rules; evaluateRisk re-sorts so the law always holds. */
export function defaultRiskRules(): RiskRule[] {
  return [
    {
      id: "deny-mcp-by-default",
      action: "DENY",
      tools: ["mcp__*"],
      note: "MCP tools are gated by a deny default (#347); surface them only via explicit allow rules.",
    },
  ];
}
