// ===========================================================================
// B13-5 Mode ladder: manual | acceptEdits | auto | dontAsk | bypass (#437)
// ---------------------------------------------------------------------------
// VETO BOUNDARY: there is NO plan/readonly rung, ever (§20 #37/#45).
//
// The ladder is a HIGHER-level default than the per-tool `approval` config: it
// governs how T1 (write/exec) calls are treated when no explicit rule decides
// them. It never widens the T2 law — NO mode auto-approves a T2 call, and no
// allow path (session/always/pre-allowed) can auto-approve T2 either.
//
// Evaluation shape per call: T2 veto -> mode refusal (bypass) -> per-mode
// behavior (which itself honors askRules / preAllowed). Pure and headless.
// ===========================================================================

import type { RiskTier } from "./risk-tiers";

export type ModeLadder = "manual" | "acceptEdits" | "auto" | "dontAsk" | "bypass";

/** Ordered ladder for validation / display; manual is the default. */
export const MODE_LADDER_ORDER: readonly ModeLadder[] = [
  "manual",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypass",
];

export const DEFAULT_MODE: ModeLadder = "manual";

export type LadderDecision = "ALLOW" | "ASK" | "DENY" | "REFUSE";

export interface LadderAction {
  action: LadderDecision;
  reason: string;
}

/** The tools acceptEdits lets flow without a prompt (T1 edits). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
]);

export interface ModeDecisionInput {
  mode: ModeLadder;
  tier: RiskTier;
  tool: string;
  input?: unknown;
  /** Tool names that force a human checkpoint (ASK) even in auto. */
  askRules?: Iterable<string>;
  /** Pre-allowed tool names (session/always allow) — never widens the T2 law. */
  preAllowed?: Iterable<string>;
  /** Whether the isolation env flag for bypass is set. */
  bypassEnvReady?: boolean;
}

function has(set: Iterable<string> | undefined, tool: string): boolean {
  if (!set) return false;
  for (const s of set) if (s === tool) return true;
  return false;
}

/**
 * The single mode-ladder decision. The T2 veto is structural and evaluated
 * FIRST: a T2 call is never ALLOW (it prompts, or is denied in dontAsk) no
 * matter the mode, askRules, or preAllowed.
 *
 *   T0 (read)            -> ALLOW in every mode (reads are universally safe).
 *   T2 (irreversible)    -> ASK (or DENY in dontAsk). Never ALLOW.
 *   T1 (write/exec)      -> governed by the mode (see per-mode rules below).
 */
export function decideModeAction(opts: ModeDecisionInput): LadderAction {
  const { mode, tier, tool } = opts;
  const ask = has(opts.askRules, tool);
  const pre = has(opts.preAllowed, tool);

  // --- bypass is refused unless the isolation env flag is set. ---
  if (mode === "bypass" && !opts.bypassEnvReady) {
    return { action: "REFUSE", reason: "bypass requires the isolation env flag" };
  }

  // --- T2 VETO: no mode, ask-rule or pre-allow auto-approves a T2 call. ---
  if (tier === "T2") {
    return mode === "dontAsk"
      ? { action: "DENY", reason: "T2 in dontAsk: auto-denied, no prompt" }
      : { action: "ASK", reason: "T2 veto: no mode auto-approves irreversible/credential work" };
  }

  // --- T0 reads are safe in every mode. ---
  if (tier === "T0") {
    return { action: "ALLOW", reason: "T0 read-only" };
  }

  // --- T1 write/exec, governed by the mode. ---
  switch (mode) {
    case "dontAsk":
      // CI / headless fail-fast: deny everything not explicitly pre-allowed.
      return pre
        ? { action: "ALLOW", reason: "pre-allowed in dontAsk" }
        : { action: "DENY", reason: "dontAsk: not pre-allowed, no prompt" };
    case "acceptEdits":
      // T1 edits flow; everything else T1 still asks.
      if (EDIT_TOOLS.has(tool)) return { action: "ALLOW", reason: "acceptEdits: T1 edit flows" };
      return pre
        ? { action: "ALLOW", reason: "pre-allowed" }
        : { action: "ASK", reason: "acceptEdits: non-edit T1 asks" };
    case "auto":
      // Classifier approves routine work. Explicit ask-rules force a human
      // checkpoint even in auto; deny/ask rules are evaluated before allow.
      if (ask) return { action: "ASK", reason: "auto: explicit ask-rule forces a human checkpoint" };
      if (pre) return { action: "ALLOW", reason: "pre-allowed in auto" };
      return { action: "ALLOW", reason: "auto: routine T1 approved" };
    case "bypass":
      // Isolated env only (flag already checked above): T1 flows.
      return { action: "ALLOW", reason: "bypass: isolated env, T1 flows" };
    case "manual":
    default:
      return pre
        ? { action: "ALLOW", reason: "pre-allowed" }
        : { action: "ASK", reason: "manual: T1 asks" };
  }
}

// ---------------------------------------------------------------------------
// 'Recently denied' review list (tuning feedback, §Task 3)
// ---------------------------------------------------------------------------

export interface DeniedEntry {
  tool: string;
  tier: RiskTier | null;
  reason: string;
  ts: number;
}

/** Bounded FIFO of recently denied calls, for tuning the auto classifier. */
export class RecentlyDeniedList {
  private items: DeniedEntry[] = [];
  constructor(private readonly cap = 50) {}

  add(entry: Omit<DeniedEntry, "ts">, now: number = Date.now()): void {
    this.items.push({ ...entry, ts: now });
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }

  list(): readonly DeniedEntry[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a mode string; returns a clean error message when unknown. */
export function validateMode(mode: string): ModeLadder {
  if ((MODE_LADDER_ORDER as readonly string[]).includes(mode)) return mode as ModeLadder;
  throw new Error(
    `Unknown mode ladder rung "${mode}". Expected one of: ${MODE_LADDER_ORDER.join(" | ")}. ` +
      "There is no plan/readonly rung (B13-5 veto).",
  );
}

/**
 * Is the isolation env flag set (i.e. is the caller running in a deliberately
 * isolated environment)? True only when the env var exists and is non-empty
 * and not a false-y value like "0"/"false".
 */
export function isIsolationEnvReady(flag: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (!flag) return false;
  const v = env[flag];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "no";
}
