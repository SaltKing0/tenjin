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
import { dispatch, cap, type ToolDef, type ToolGroup } from "../tools/registry";
import type { SecurityGuard } from "../security/guard";
import { detectSuspiciousOutput, frameToolOutput, maskToolOutput } from "../security/injection";
import type { Budget, TreeBudget } from "./budget";
import { compressMessages } from "../session/context";
import {
  DEFAULT_SESSION_KEY,
  sharedTokenPressure,
  type TokenPressure,
} from "../session/token-pressure";
import { emit } from "../gateway/events";

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
    };

export interface TurnResult {
  stopReason: StopReason | "budget_exhausted" | "max_iterations" | "tree_budget_exceeded";
  usage: Usage;
  costUSD: number;
  model: string;
  text: string;
}

export interface ApproveFn {
  (toolName: string, group: ToolGroup, input: unknown): Promise<boolean>;
}

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
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  let costUSD = 0;
  let lastText = "";
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (opts.budget.exhausted) {
      opts.audit?.("budget_halt", `halted at ${opts.budget.spentUSD.toFixed(4)} USD`, opts.correlationId);
      emit("budget.exceeded", { reason: "session budget exhausted" });
      return { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText };
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
        stopReason: "tree_budget_exceeded",
        usage: totals,
        costUSD,
        model: opts.model,
        text: lastText,
      };
    }

    const gate = opts.globalBudgetGate?.();
    if (gate && !gate.allowed) {
      const detail =
        gate.reason ?? "blocked by global budget gate";
      opts.audit?.("budget_halt", detail, opts.correlationId);
      emit("budget.exceeded", { reason: detail });
      return { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText };
    }

    maybeCompress(opts);


    let response: ChatResponse;
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
        { onTextDelta: opts.onTextDelta },
        opts.signal,
      );
    } catch (e) {
      // #338: provider failures (4xx/5xx, timeout, abort, malformed payload)
      // must surface as a clean, one-line, human-readable error — never a raw
      // stack trace or provider payload reaching the user/channel.
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
      return { stopReason: response.stopReason, usage: totals, costUSD, model: opts.model, text: lastText };
    }

    const results: ToolResultBlock[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      opts.onEvent?.({ t: "tool_call", id: block.id, name: block.name, input: block.input });

      let ok = false;
      let output: string;
      let injectionWarning: string | undefined;
      const approved = await opts.approve(block.name, groupOf(opts.tools, block.name), block.input);
      if (!approved) {
        output = "User declined this tool call.";
      } else {
        const dispatched = await dispatch(opts.tools, block.name, block.input, {
          cwd: opts.cwd,
          guard: opts.guard,
          treeBudget: opts.treeBudget,
          audit: opts.audit,
          correlationId: opts.correlationId,
        });
        ok = dispatched.ok;
        output = cap(dispatched.output);
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

  return { stopReason: "max_iterations", usage: totals, costUSD, model: opts.model, text: lastText };
}

function groupOf(tools: ToolDef[], name: string): ToolGroup {
  return tools.find((t) => t.name === name)?.group ?? "read";
}

/**
 * Context-window guard (#101): if a resolved guard is configured and enabled,
 * estimate the trajectory's tokens and, once it exceeds the threshold
 * (window × ratio), elide old tool-result outputs to placeholders so the
 * provider call survives instead of dying on a 413 / context_length error.
 * Emits a `compression` event so the boundary is recorded in the session.
 */
function maybeCompress(opts: AgentTurnOptions): void {
  const guard = opts.contextGuard;
  if (!guard?.enabled) return;
  const targetTokens = Math.floor(guard.windowTokens * guard.thresholdRatio);
  // #354: calibrated context pressure — prefer the provider-reported input-token
  // count for this session over the local chars/4 estimate once a report exists.
  const pressure = (opts.tokenPressure ?? sharedTokenPressure).pressureTokens(
    opts.sessionKey ?? DEFAULT_SESSION_KEY,
    opts.messages,
  );
  if (pressure <= targetTokens) return;
  const result = compressMessages(opts.messages, { targetTokens, pressureTokens: pressure });
  if (result.compressed) {
    opts.onEvent?.({
      t: "compression",
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      elidedTokens: result.elidedTokens,
    });
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
