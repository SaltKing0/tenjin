import type {
  ChatMessage,
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
import type { Budget } from "./budget";
import { compressMessages } from "../session/context";

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
  stopReason: StopReason | "budget_exhausted" | "max_iterations";
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
  audit?: (kind: "write_exec" | "budget_halt" | "prompt_injection", detail: string, correlationId?: string) => void;
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
  /** Override MAX_ITERATIONS (e.g. per effort level). */
  maxIterations?: number;
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  let costUSD = 0;
  let lastText = "";
  const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (opts.budget.exhausted) {
      opts.audit?.("budget_halt", `halted at ${opts.budget.spentUSD.toFixed(4)} USD`, opts.correlationId);
      return { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText };
    }

    const gate = opts.globalBudgetGate?.();
    if (gate && !gate.allowed) {
      const detail =
        gate.reason ?? "blocked by global budget gate";
      opts.audit?.("budget_halt", detail, opts.correlationId);
      return { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText };
    }

    maybeCompress(opts);


    const response = await opts.provider.chat(
      {
        model: opts.model,
        system: opts.system,
        messages: opts.messages,
        tools: schemas(opts.tools),
        maxTokens: opts.maxTokens,
      },
      { onTextDelta: opts.onTextDelta },
      opts.signal,
    );

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
    const turnCost = opts.budget.add(response.usage, opts.model);
    costUSD += turnCost;
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
        const dispatched = await dispatch(opts.tools, block.name, block.input, { cwd: opts.cwd, guard: opts.guard });
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
  const result = compressMessages(opts.messages, { targetTokens });
  if (result.compressed) {
    opts.onEvent?.({
      t: "compression",
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      elidedTokens: result.elidedTokens,
    });
  }
}
