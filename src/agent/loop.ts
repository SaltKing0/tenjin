import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  Provider,
  StopReason,
  ToolResultBlock,
  Usage,
} from "../provider/types";
import { schemas } from "../tools/registry";
import { dispatch, cap, type ToolDef, type ToolGroup, type DispatchResult } from "../tools/registry";
import type { SecurityGuard } from "../security/guard";
import { detectSuspiciousOutput, frameToolOutput, maskToolOutput } from "../security/injection";
import type { Budget, TreeBudget } from "./budget";
import { estimateTokens } from "../session/context";
import {
  runStagedCompaction,
  resolveStage,
  shouldMutate,
  newTracker,
  type CompactionTracker,
  type Stage,
} from "../session/compaction";
import {
  DEFAULT_SESSION_KEY,
  sharedTokenPressure,
  type TokenPressure,
} from "../session/token-pressure";
import { markInterrupted } from "../session/abort";
import {
  runConsolidation,
  shouldConsolidate,
  newConsolidationTracker,
  DEFAULT_CONSOLIDATION_THRESHOLD,
  DEFAULT_CONSOLIDATION_MIN_TURNS,
  type ConsolidationTracker,
} from "../memory/consolidate";
import { emit } from "../gateway/events";
import { snapshot as checkpointSnapshot } from "../checkpoints/store";
import { runBoundary, type BoundaryMode } from "../recovery/boundary";
import type { RecoverySession } from "../recovery/session";

export const MAX_ITERATIONS = 25;

export type TurnEvent =
  | { t: "assistant_message"; content: ContentBlock[] }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; name: string; ok: boolean; output: string }
  | { t: "usage"; usage: Usage; costUSD: number }
  | {
      t: "compression";
      beforeTokens: number;
      afterTokens: number;
      elidedTokens: number;
      /** B2-3/B2-4: which staged-compaction stage fired (0 = none, 1 warn, 2 elide, 4 summarize). */
      stage?: Stage;
      /** Per-session archive file written this pass, if content was offloaded. */
      archivePath?: string;
      /** If set, compaction was intentionally skipped (e.g. cache-law). */
      skipped?: string;
    };

export interface TurnResult {
  stopReason: StopReason | "budget_exhausted" | "max_iterations" | "tree_budget_exceeded";
  usage: Usage;
  costUSD: number;
  model: string;
  text: string;
}

export interface ApproveFn {
  (toolName: string, group: ToolGroup, input: unknown): Promise<ApproveDecision>;
}

/**
 * Approval decision. `true` allows; `false` denies; an object carries a
 * user-provided denial reason (comment) that is fed back to the model as
 * corrective feedback (#406).
 */
export type ApproveDecision = boolean | { allowed: false; reason?: string };

/** Result of a pre-call gate check (e.g. a global spend budget). */
export interface GateCheck {
  allowed: boolean;
  reason?: string;
}

/** Optional global budget gate consulted before every provider call. */
export type GlobalBudgetGate = () => GateCheck;

export interface AgentTurnOptions {
  provider: Provider;
  model: string;
  system: string;
  tools: ToolDef[];
  messages: ChatMessage[];
  budget: Budget;
  maxTokens: number;
  approve: ApproveFn;
  cwd: string;
  guard?: SecurityGuard | null;
  audit?: (kind: "write_exec" | "budget_halt" | "budget_exceeded" | "prompt_injection", detail: string, correlationId?: string) => void;
  /** Mask suspected prompt-injection tool output before it reaches the model. */
  paranoid?: boolean;
  /** Shared id threaded into this run's audit events (e.g. a delegation correlation id). */
  correlationId?: string;
  /** Consulted before each provider call; returns blocked=false to halt the run. */
  globalBudgetGate?: GlobalBudgetGate;
  onEvent?: (e: TurnEvent) => void;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** Resolved context-window guard (#101); runs before each provider call. */
  contextGuard?: import("../session/context").ContextGuardConfig | null;
  /** Token-calibration store (#354); defaults to the shared in-process store. */
  tokenPressure?: TokenPressure | null;
  /** Session key the reported prompt_tokens are keyed to (#354). */
  sessionKey?: string;
  /** Override MAX_ITERATIONS (e.g. per effort level). */
  maxIterations?: number;
  /** Shared delegation-tree budget (#154): counts this run's iterations/USD
   * against the same counter as every run in the tree. */
  treeBudget?: TreeBudget;
  /**
   * B2-1 cache-shape (#353): volatile per-turn data (clock, context pressure,
   * directory listings, status). Rendered by {@link buildVolatileTail} and
   * appended as a trailing user message AFTER the transcript on every provider
   * call — it never enters the persistent transcript and never touches the
   * stable system prefix, so the provider's prompt cache on the prefix is not
   * invalidated.
   */
  volatileTail?: string | null;
  /** B2-3/B2-4 staged-compaction config (subset of `context.compaction`). */
  compaction?: import("../session/context").ContextConfig["compaction"];
  /** Per-session archive dir for non-lossy offload (default `<memoryDir>/archives`). */
  archiveDir?: string;
  /** Cheap-model summarizer for stage 4 (optional; falls back to archive-only). */
  summarize?: (segment: string) => Promise<string>;
  /** B9-3 end-of-session consolidation pass (runs once at the natural turn
   *  boundary when calibrated pressure crosses `threshold`). */
  consolidation?: {
    enabled?: boolean;
    threshold?: number;
    minTurnsBetween?: number;
    /** The configured cheap/helper model for the single consolidation call. */
    helper?: { provider: Provider; model: string; maxTokens?: number };
    memoryDir?: string;
    projectPath?: string;
    sessionLog?: import("../session/log").SessionLog | null;
    /** Opt-in contradiction check on newly-distilled learnings (see
     *  memory/contradiction.ts). Off by default. */
    contradictionCheck?: {
      enabled?: boolean;
      maxChecks?: number;
      model?: string;
    };
  };
  /** B13-6 checkpoints (#369): shadow-git snapshots at the prompt boundary and
   *  before each file-edit tool. Enabled iff `storeDir`+`sourceDir` are set and
   *  `enabled` is not false. A snapshot failure never breaks the run. */
  checkpoints?: {
    enabled?: boolean;
    storeDir: string;
    sourceDir: string;
    /** Optional session/conversation log captured into each checkpoint. */
    logPath?: string;
    /** Max checkpoints retained; oldest evicted (default 100). */
    keep?: number;
    /** Snapshot before the turn (prompt boundary). Default true. */
    beforeTurn?: boolean;
    /** Snapshot before file-edit tools (write/edit/apply_patch). Default true. */
    beforeEdit?: boolean;
  } | null;
  /** B3-3 recovery boundaries (#372): error-boundary policy for tool steps plus
   *  an optional ON_TOOL_CALL session checkpoint. All additive — when `recovery`
   *  is absent the loop behaves exactly as before. */
  recovery?: {
    /** Boundary policy for non-critical tool steps. Default: current behaviour
     *  (a tool failure returns a structured error result, never aborts). */
    boundary?: BoundaryMode;
    /** Audit sink for recovery decisions (detail carries the reason class). */
    audit?: (kind: "recovery", detail: string, correlationId?: string) => void;
    /** Optional session recording checkpoints ON_TOOL_CALL + completed steps. */
    session?: RecoverySession;
  } | null;
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  // B2-3/B2-4: cache-law tracker so compaction never fires on consecutive turns.
  const compactionTracker = newTracker();
  // B9-3: anti-runaway tracker for the end-of-session consolidation pass.
  const consolidationTracker = newConsolidationTracker();

  const { result, iterations } = await runTurns(opts, compactionTracker);
  // B9-3: run the single consolidation pass at the natural post-turn boundary.
  // It never fires mid-stream (inside the tool loop) — only once a turn ends.
  await maybeConsolidate(opts, consolidationTracker, iterations);
  return result;
}

async function runTurns(
  opts: AgentTurnOptions,
  compactionTracker: CompactionTracker,
): Promise<{ result: TurnResult; iterations: number }> {
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  let costUSD = 0;
  let lastText = "";
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  // B13-6 (#369): prompt boundary — snapshot before the turn begins so the
  // user's prompt sees a clean, restorable pre-turn state.
  maybeCheckpoint(opts, "prompt");

  let iteration = 0;
  for (; iteration < maxIterations; iteration++) {
    if (opts.budget.exhausted) {
      opts.audit?.("budget_halt", `halted at ${opts.budget.spentUSD.toFixed(4)} USD`, opts.correlationId);
      emit("budget.exceeded", { reason: "session budget exhausted" });
      return { result: { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText }, iterations: iteration };
    }

    // #154: a shared delegation-tree budget. Reserve this iteration — if the
    // tree-wide cap was already hit (possibly by a deeper subagent), stop the
    // whole chain with a clear error instead of starting fresh work.
    if (opts.treeBudget && !opts.treeBudget.consumeIteration()) {
      opts.audit?.(
        "budget_exceeded",
        `delegation tree exhausted: ${opts.treeBudget.usedIterations}/${opts.treeBudget.maxIterations || "∞"} iterations`,
        opts.correlationId,
      );
      return {
        result: {
          stopReason: "tree_budget_exceeded",
          usage: totals,
          costUSD,
          model: opts.model,
          text: lastText,
        },
        iterations: iteration,
      };
    }

    const gate = opts.globalBudgetGate?.();
    if (gate && !gate.allowed) {
      const detail =
        gate.reason ?? "blocked by global budget gate";
      opts.audit?.("budget_halt", detail, opts.correlationId);
      emit("budget.exceeded", { reason: detail });
      return { result: { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText }, iterations: iteration };
    }

    await maybeCompress(opts, iteration, compactionTracker);


    let response: ChatResponse;
    // B13-2 (#384): accumulate streamed text so a mid-stream abort can keep
    // the partial output instead of discarding it.
    let streamedPartial = "";
    try {
      // B2-1 cache-shape (#353): append the volatile tail AFTER the transcript
      // as a trailing user message for THIS call only. The persistent
      // transcript (`opts.messages`) stays append-only and clean, and the
      // stable system prefix is untouched — so the provider's prompt cache on
      // the prefix survives across turns. The breakpoint index is the end of
      // the stable prefix (transcript length).
      const requestMessages: ChatMessage[] = opts.volatileTail
        ? [...opts.messages, { role: "user", content: opts.volatileTail }]
        : opts.messages;
      response = await opts.provider.chat(
        {
          model: opts.model,
          system: opts.system,
          messages: requestMessages,
          tools: schemas(opts.tools),
          maxTokens: opts.maxTokens,
        },
        {
          onTextDelta: (d) => {
            streamedPartial += d;
            opts.onTextDelta?.(d);
          },
        },
        opts.signal,
      );
    } catch (e) {
      // #338: provider failures (4xx/5xx, timeout, abort, malformed payload)
      // must surface as a clean, one-line, human-readable error — never a raw
      // stack trace or provider payload reaching the user/channel.
      if (isAbortError(e) && streamedPartial) {
        // B13-2 (#384): PARTIAL OUTPUT IS KEPT — write the streamed text so
        // far (marked interrupted) into the transcript + session trail. Tool
        // results from this aborted iteration were never produced, so none are
        // recorded — nothing to discard.
        const partial = markInterrupted(streamedPartial);
        opts.messages.push({ role: "assistant", content: partial });
        opts.onEvent?.({
          t: "assistant_message",
          content: [{ type: "text", text: partial }],
        });
      }
      throw toCleanProviderError(e);
    }
    if (!response || !Array.isArray(response.content)) {
      throw new Error("The model returned a malformed response.");
    }

    opts.messages.push({ role: "assistant", content: response.content });
    opts.onEvent?.({ t: "assistant_message", content: response.content });
    lastText = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    totals.inputTokens += response.usage.inputTokens;
    totals.outputTokens += response.usage.outputTokens;
    if (response.usage.cacheReadInputTokens != null)
      totals.cacheReadInputTokens =
        (totals.cacheReadInputTokens ?? 0) + response.usage.cacheReadInputTokens;
    if (response.usage.cacheCreationInputTokens != null)
      totals.cacheCreationInputTokens =
        (totals.cacheCreationInputTokens ?? 0) + response.usage.cacheCreationInputTokens;
    // #354: record the provider-reported prompt-token count for the active
    // session so context pressure can be calibrated against the real number the
    // model saw (preamble + system + tool schemas) instead of the local estimate.
    (opts.tokenPressure ?? sharedTokenPressure).record(
      opts.sessionKey ?? DEFAULT_SESSION_KEY,
      response.usage.inputTokens,
    );
    const turnCost = opts.budget.add(response.usage, opts.model);
    costUSD += turnCost;
    opts.treeBudget?.addUsd(turnCost);
    opts.onEvent?.({ t: "usage", usage: response.usage, costUSD: turnCost });

    if (response.stopReason !== "tool_use") {
      return { result: { stopReason: response.stopReason, usage: totals, costUSD, model: opts.model, text: lastText }, iterations: iteration };
    }

    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      opts.onEvent?.({ t: "tool_call", id: block.id, name: block.name, input: block.input });

      let ok = false;
      let output: string;
      let injectionWarning: string | undefined;
      const decision = await opts.approve(block.name, groupOf(opts.tools, block.name), block.input);
      const denied =
        decision === false || (typeof decision === "object" && decision.allowed === false);
      if (denied) {
        const reason = typeof decision === "object" ? decision.reason : undefined;
        // #406: a user denial comment is fed back to the model as corrective
        // feedback (instructive), not a silent refusal.
        output = reason
          ? `User declined this tool call. Reason: ${reason}`
          : "User declined this tool call.";
      } else {
        // B13-6 (#369): edit boundary — snapshot immediately before a file-edit
        // tool runs, so the edit can be rolled back byte-exact. bash is
        // deliberately excluded (its changes are opaque; git reflog is the
        // documented fallback).
        if (isEditTool(block.name)) maybeCheckpoint(opts, `edit:${block.name}`);
        // B3-3 (#372): record an ON_TOOL_CALL checkpoint before the external
        // interaction, then run the tool under the configured error boundary.
        opts.recovery?.session?.checkpoint(`tool:${block.name}:${block.id}`);
        const dispatched = await runDispatchBoundary(opts, block.name, block.input);
        ok = dispatched.ok;
        output = cap(dispatched.output);
        if (ok) opts.recovery?.session?.complete(block.id);
        // #129: tool output is untrusted data. Flag suspicious content, audit
        // it, and (under security.paranoid) mask it before it reaches the model.
        const suspicious = detectSuspiciousOutput(dispatched.output);
        if (suspicious) {
          opts.audit?.("prompt_injection", `${block.name} output flagged: ${suspicious}`, opts.correlationId);
          injectionWarning = `suspected prompt injection (${suspicious})`;
          if (opts.paranoid) {
            output = maskToolOutput(output);
          }
        }
      }

      if (ok && groupOf(opts.tools, block.name) === "write") {
        opts.audit?.("write_exec", `${block.name} succeeded`, opts.correlationId);
      }
      results.push({
        type: "tool_result",
        toolUseId: block.id,
        content: frameToolOutput(output, injectionWarning ? { warning: injectionWarning } : undefined),
        isError: !ok,
      });
      opts.onEvent?.({ t: "tool_result", id: block.id, name: block.name, ok, output });
    }

    opts.messages.push({ role: "user", content: results });
  }

  return { result: { stopReason: "max_iterations", usage: totals, costUSD, model: opts.model, text: lastText }, iterations: iteration };
}

function groupOf(tools: ToolDef[], name: string): ToolGroup {
  return tools.find((t) => t.name === name)?.group ?? "read";
}

// File-edit tools that get a checkpoint before running. bash is NOT in this set
// (its effects are opaque to the snapshot — the honest LAW is documented in the
// checkpoint tool / docs, with git reflog as the fallback).
const EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);

function isEditTool(name: string): boolean {
  return EDIT_TOOLS.has(name);
}

/**
 * B13-6 (#369): take a shadow-git checkpoint at a boundary. Swallows every
 * failure — a snapshot problem must never break the agent run; it simply means
 * that boundary has no checkpoint.
 */
function maybeCheckpoint(opts: AgentTurnOptions, label: string): void {
  const c = opts.checkpoints;
  if (!c || c.enabled === false) return;
  if (!c.storeDir || !c.sourceDir) return;
  if (label === "prompt" && c.beforeTurn === false) return;
  if (label.startsWith("edit:") && c.beforeEdit === false) return;
  try {
    checkpointSnapshot(
      { storeDir: c.storeDir, sourceDir: c.sourceDir, logPath: c.logPath, keep: c.keep },
      label,
    );
  } catch {
    // ignore — checkpoint is best-effort
  }
}

/**
 * B3-3 (#372): run a tool under the configured error boundary. Without a
 * `recovery.boundary` this is a plain dispatch (identical behaviour to before).
 * With one, an unexpected throw becomes a noted gap / a paused step / a raised
 * error per policy — never an abort of the whole turn.
 */
async function runDispatchBoundary(
  opts: AgentTurnOptions,
  name: string,
  input: unknown,
): Promise<DispatchResult> {
  const base = () =>
    dispatch(opts.tools, name, input, {
      cwd: opts.cwd,
      guard: opts.guard,
      treeBudget: opts.treeBudget,
      audit: opts.audit,
      correlationId: opts.correlationId,
    });
  const mode = opts.recovery?.boundary;
  if (!mode) return base();
  const outcome = await runBoundary(base, {
    mode,
    audit: (d) => opts.recovery?.audit?.("recovery", d, opts.correlationId),
  });
  if (outcome.status === "success") return outcome.value;
  if (outcome.status === "skipped") {
    return { ok: false, output: `[recovery ${outcome.reason}] ${outcome.note}` };
  }
  if (outcome.status === "paused") {
    return { ok: false, output: "[recovery paused: awaiting human approval]" };
  }
  throw outcome.error;
}

/**
 * B2-3/B2-4 staged compaction (supersedes the simple auto-compact threshold):
 * resolve the calibrated pressure ratio against the config-driven stage table
 * and run the corresponding stage — warn (1), pointer-elide with non-lossy
 * offload (2), or summarize (4). The CACHE LAW (never on consecutive turns
 * unless pressure escalates) is enforced via `tracker`. Emits a `compression`
 * event (stage/archivePath) so the boundary lands in the session trail.
 */
async function maybeCompress(
  opts: AgentTurnOptions,
  iteration: number,
  tracker: CompactionTracker,
): Promise<void> {
  const guard = opts.contextGuard;
  if (!guard?.enabled) return;
  const compaction = opts.compaction;
  if (compaction?.enabled === false) return;

  // #354: calibrated context pressure — prefer the provider-reported input-token
  // count for this session over the local chars/4 estimate once a report exists.
  const pressure = (opts.tokenPressure ?? sharedTokenPressure).pressureTokens(
    opts.sessionKey ?? DEFAULT_SESSION_KEY,
    opts.messages,
  );
  const ratio = guard.windowTokens > 0 ? pressure / guard.windowTokens : 1;
  const stage = resolveStage(ratio, compaction?.table);
  if (stage === 0) return;

  const minTurns = compaction?.minTurnsBetween ?? 1;
  if (!shouldMutate(tracker, iteration, stage, minTurns)) {
    opts.onEvent?.({
      t: "compression",
      beforeTokens: estimateTokens(opts.messages),
      afterTokens: estimateTokens(opts.messages),
      elidedTokens: 0,
      stage,
      skipped: "cache-law",
    });
    return;
  }

  // Stage 1 = warn only; no mutation, no archive needed.
  if (stage === 1) {
    opts.onEvent?.({
      t: "compression",
      beforeTokens: estimateTokens(opts.messages),
      afterTokens: estimateTokens(opts.messages),
      elidedTokens: 0,
      stage,
    });
    return;
  }

  // Stages 2/4 mutate and offload non-lossy — they need an archive dir.
  if (!opts.archiveDir) return;

  const beforeTokens = estimateTokens(opts.messages);
  const result = await runStagedCompaction(opts.messages, {
    pressureTokens: pressure,
    windowTokens: guard.windowTokens,
    archiveDir: opts.archiveDir,
    sessionKey: opts.sessionKey ?? DEFAULT_SESSION_KEY,
    table: compaction?.table,
    keepLast: compaction?.keepLast,
    summarize: opts.summarize,
  });
  if (result.mutated) {
    tracker.lastMutatedIteration = iteration;
    tracker.lastStage = result.stage;
  }
  opts.onEvent?.({
    t: "compression",
    beforeTokens,
    afterTokens: estimateTokens(opts.messages),
    elidedTokens: result.elidedCount ?? 0,
    stage: result.stage,
    archivePath: result.archivePath,
  });
}

/**
 * B9-3 end-of-session consolidation: at the natural post-turn boundary, if
 * calibrated pressure crosses the threshold and the anti-runaway gate allows,
 * run ONE consolidation call on the configured cheap/helper model and write the
 * results through the memory tiers. A helper failure is swallowed by
 * runConsolidation (the session simply continues unconsolidated). Never runs
 * mid-stream — this is only invoked once, after runTurns completes.
 */
async function maybeConsolidate(
  opts: AgentTurnOptions,
  tracker: ConsolidationTracker,
  iteration: number,
): Promise<void> {
  const cfg = opts.consolidation;
  if (!cfg || cfg.enabled === false) return;
  const helper = cfg.helper;
  if (!helper?.provider) return;
  const memoryDir = cfg.memoryDir;
  if (!memoryDir) return;
  const guard = opts.contextGuard;
  if (!guard?.enabled) return;

  const pressure = (opts.tokenPressure ?? sharedTokenPressure).pressureTokens(
    opts.sessionKey ?? DEFAULT_SESSION_KEY,
    opts.messages,
  );
  const ratio = guard.windowTokens > 0 ? pressure / guard.windowTokens : 1;
  const threshold = cfg.threshold ?? DEFAULT_CONSOLIDATION_THRESHOLD;
  const minTurns = cfg.minTurnsBetween ?? DEFAULT_CONSOLIDATION_MIN_TURNS;
  if (!shouldConsolidate(tracker, iteration, ratio, threshold, minTurns)) return;

  const result = await runConsolidation({
    provider: helper.provider,
    model: helper.model,
    maxTokens: helper.maxTokens ?? 1024,
    sessionKey: opts.sessionKey ?? DEFAULT_SESSION_KEY,
    memoryDir,
    projectPath: cfg.projectPath ?? "",
    sessionLog: cfg.sessionLog ?? null,
    contradictionCheck: cfg.contradictionCheck,
    audit: (kind, detail) =>
      (opts.audit as ((kind: string, detail: string, correlationId?: string) => void) | undefined)?.(
        kind,
        detail,
        opts.correlationId,
      ),
  });

  if (result.ran) {
    tracker.lastRunIteration = iteration;
    tracker.lastRunPressureRatio = ratio;
  }
}

/**
 * #338: normalize an error thrown by the provider into a clean, one-line,
 * human-readable Error. The first line of an Error's message is kept (that is
 * the actionable summary); the stack and any trailing provider payload are
 * dropped. Non-Error thrown values (objects, bare strings, undefined) get a
 * generic message rather than leaking "[object Object]".
 */
function toCleanProviderError(e: unknown): Error {
  if (isAbortError(e)) {
    return new Error("The agent run was aborted before the model finished.");
  }
  if (e instanceof Error && e.message) {
    const firstLine = e.message.split("\n")[0]?.trim() ?? "";
    if (firstLine) return new Error(firstLine);
  }
  if (typeof e === "string" && e.trim()) {
    return new Error(e.trim().split("\n")[0] ?? "The model provider call failed.");
  }
  return new Error("The model provider call failed.");
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}
