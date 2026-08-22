// B3-3 recovery boundaries (#372): per-step error boundaries, chosen via
// policy config — never ad hoc. A step (a unit of external interaction) is
// wrapped in a boundary that decides, on failure, what happens:
//
//   skip_and_note  — convert the failure into a noted gap and continue
//                    (the default for non-critical steps)
//   use_cached     — serve a previously cached result instead of re-running
//   raise          — propagate the error (critical steps)
//   ask_human      — surface an approval prompt and PAUSE the run
//
// Every decision is emitted to the audit trail with its reason class so a
// recovery is always attributable and reviewable.
import { classifyError } from "../provider/retry";

/** Error-boundary policy for a single step, chosen via config, never ad hoc. */
export type BoundaryMode = "skip_and_note" | "use_cached" | "raise" | "ask_human";

/** A step's terminal outcome. `reason` is the audit reason class. */
export type BoundaryOutcome<T> =
  | { status: "success"; value: T; reason: "success" | "use_cached" }
  | { status: "skipped"; note: string; reason: "skip_and_note" | "use_cached" }
  | { status: "paused"; reason: "ask_human" }
  | { status: "raised"; error: unknown; reason: "raise" };

export interface BoundaryOpts {
  /** Which boundary to apply. Default "raise" (strictest, preserves caller semantics). */
  mode?: BoundaryMode;
  /** Optional cache consulted for `use_cached`. */
  cache?: {
    has: (key: string) => boolean;
    get: (key: string) => unknown;
    set: (key: string, value: unknown) => void;
  };
  /** Cache key used by `use_cached`. */
  cacheKey?: string;
  /** Audit sink; `detail` always carries the reason class. */
  audit?: (detail: string) => void;
  /** Approval gate for `ask_human`: returns true to proceed, false to pause. */
  ask?: (note: string) => Promise<boolean>;
}

/**
 * Run a step under the configured error boundary. `step` is the external
 * interaction (a tool call, a network call, a sub-routine). On success returns
 * the value; on failure applies the boundary. The underlying error's retry
 * classification (B3-9 #371) feeds the note so the recovery is actionable.
 */
export async function runBoundary<T>(
  step: () => Promise<T>,
  opts: BoundaryOpts = {},
): Promise<BoundaryOutcome<T>> {
  const mode = opts.mode ?? "raise";
  try {
    const value = await step();
    return { status: "success", value, reason: "success" };
  } catch (e) {
    const decision = classifyError(e);
    const note = decision.message ?? (e instanceof Error ? e.message : String(e));

    if (mode === "raise") {
      opts.audit?.(`reason=raise: ${note}`);
      throw e;
    }
    if (mode === "skip_and_note") {
      opts.audit?.(`reason=skip_and_note: ${note}`);
      return { status: "skipped", note, reason: "skip_and_note" };
    }
    if (mode === "use_cached") {
      const key = opts.cacheKey;
      if (key && opts.cache?.has(key)) {
        opts.audit?.(`reason=use_cached key=${key}`);
        return { status: "success", value: opts.cache.get(key) as T, reason: "use_cached" };
      }
      opts.audit?.(`reason=skip_and_note: ${note}`);
      return { status: "skipped", note, reason: "skip_and_note" };
    }
    if (mode === "ask_human") {
      opts.audit?.(`reason=ask_human: ${note}`);
      if (opts.ask) {
        const approved = await opts.ask(note);
        if (approved) {
          // Approved: the boundary is relaxed to a retry for this step.
          return runBoundary(step, { ...opts, mode: "raise" });
        }
      }
      return { status: "paused", reason: "ask_human" };
    }
    throw e;
  }
}

/** Human-readable one-liner for an outcome (used in audit/tool replies). */
export function describeOutcome<T>(o: BoundaryOutcome<T>): string {
  switch (o.status) {
    case "success":
      return o.reason === "use_cached" ? "served from cache" : "ok";
    case "skipped":
      return `skipped (${o.reason}): ${o.note}`;
    case "paused":
      return "paused awaiting human approval";
    case "raised":
      return "raised";
  }
}
