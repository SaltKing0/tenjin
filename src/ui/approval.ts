import { isT2, type RiskTier } from "../security/risk-tiers";

/**
 * Approval request block (#406, B13-4). One approval on screen at a time,
 * decidable in <2s. This module owns the pure, headless-testable decisions:
 * rendering the structured request block (RISK badge → WHAT → WHY →
 * consequence → answer keys), the FIFO lock that serializes concurrent
 * approvals, single-key scope resolution, timeout auto-deny (never allow) and
 * comment-on-deny feedback that reaches the model.
 *
 * The gateway/console approval surface (createRequest / resolveRequest /
 * waitApproval + /api/approvals + console approval cards) already exists; this
 * module and its REPL wiring formalize the interactive block on top of it.
 */

/** Scope a single-key approval answer grants. "always" is the narrowest rule. */
export type ApprovalScope = "once" | "session" | "always";

export type ApprovalVerdict =
  | { kind: "allow"; scope: ApprovalScope }
  | { kind: "deny"; comment?: string };

/** Single-key answer set shown in the block. */
export const ANSWER_ONCE = "y";
export const ANSWER_SESSION = "s";
export const ANSWER_ALWAYS = "a";
export const ANSWER_DENY = "n";

/** How long an interactive approval waits before it auto-denies (never allows). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export const BLOCK_SEPARATOR = "━".repeat(28);

/** Render a structured approval request block, visually separated from scrollback. */
export function renderApprovalBlock(opts: {
  tool: string;
  tier: RiskTier;
  what: string;
  why?: string;
  consequence?: string;
}): string {
  const lines: string[] = [];
  lines.push(BLOCK_SEPARATOR);
  lines.push("APPROVAL REQUEST");
  lines.push(BLOCK_SEPARATOR);
  lines.push(`  RISK:  [${opts.tier}] ${describeTier(opts.tier)}`);
  lines.push(`  WHAT:  ${opts.tool} → ${truncateForPrompt(opts.what)}`);
  if (opts.why !== undefined && opts.why.trim() !== "") lines.push(`  WHY:   ${opts.why}`);
  if (opts.consequence !== undefined && opts.consequence.trim() !== "") {
    lines.push(`  RISK-OF: ${opts.consequence}`);
  }
  lines.push(BLOCK_SEPARATOR);
  lines.push(`  answer:  ${ANSWER_ONCE}=once  ${ANSWER_SESSION}=session  ${ANSWER_ALWAYS}=always  ${ANSWER_DENY}=deny  (other = deny with comment)`);
  lines.push(BLOCK_SEPARATOR);
  return lines.join("\n");
}

function describeTier(tier: RiskTier): string {
  switch (tier) {
    case "T0":
      return "read-only";
    case "T1":
      return "write/exec";
    case "T2":
      return "irreversible/credential — strong confirmation";
  }
}

/**
 * Shorten a long command/path for the prompt. Long inputs (> ~70 chars) are
 * truncated with a "view full command" hint instead of a wall of text.
 */
export function truncateForPrompt(s: string, max = 70): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (view full command)`;
}

/** Parse a single-key answer into an approval verdict, honoring the T2 law. */
export type AnswerParse =
  | { kind: "verdict"; verdict: ApprovalVerdict }
  | { kind: "comment" };

export function parseApprovalAnswer(answer: string, opts: { tier: RiskTier }): AnswerParse {
  const a = answer.trim().toLowerCase();
  // T2 (irreversible/credential): ONLY a one-shot yes is allowed. session /
  // always are never available on T2 — there is no mode that auto-approves it.
  if (isT2(opts.tier)) {
    if (a === ANSWER_ONCE || a === "yes") {
      return { kind: "verdict", verdict: { kind: "allow", scope: "once" } };
    }
    return { kind: "verdict", verdict: { kind: "deny" } };
  }
  if (a === ANSWER_ONCE || a === "yes") {
    return { kind: "verdict", verdict: { kind: "allow", scope: "once" } };
  }
  if (a === ANSWER_SESSION) {
    return { kind: "verdict", verdict: { kind: "allow", scope: "session" } };
  }
  if (a === ANSWER_ALWAYS) {
    return { kind: "verdict", verdict: { kind: "allow", scope: "always" } };
  }
  if (a === ANSWER_DENY || a === "no") {
    return { kind: "verdict", verdict: { kind: "deny" } };
  }
  // Anything else (incl. tab-to-comment) → deny and collect the comment.
  return { kind: "comment" };
}

/** A persisted "always" approval rule, scoped to the NARROWEST possible surface. */
export interface AlwaysRule {
  tool: string;
}

/**
 * Resolve which rule a scope persists. "always" persists a rule scoped to the
 * exact tool name — never widened to a group or "*" (narrowest-scope invariant).
 * "session" is in-memory; "once" persists nothing.
 */
export function persistScope(scope: ApprovalScope, tool: string): AlwaysRule | null {
  if (scope === "always") return { tool };
  return null;
}

/** Corrective feedback fed back to the model when an approval is denied. */
export function denyFeedback(tool: string, comment?: string): string {
  const base = `Approval for ${tool} was denied.`;
  if (comment !== undefined && comment.trim() !== "") {
    return `${base} The user's comment: "${comment.trim()}" — do not repeat the same action; address the concern instead.`;
  }
  return base;
}

/** A timed-out approval NEVER allows — it auto-denies. */
export function timeoutVerdict(): ApprovalVerdict {
  return { kind: "deny" };
}

/**
 * FIFO approval lock: concurrent approval prompts never stack — the queue
 * serializes them so exactly one is visible at a time, and later requests wait
 * in order (#406).
 */
export class ApprovalQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Race a prompt against a timeout; `{ ok: false }` on timeout (auto-deny). */
export async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  const result = await Promise.race([p.then((value) => ({ ok: true as const, value })), timeout]);
  if (timer) clearTimeout(timer);
  return result;
}
