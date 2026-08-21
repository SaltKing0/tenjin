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
import type { Budget } from "./budget";

export const MAX_ITERATIONS = 25;

export type TurnEvent =
  | { t: "assistant_message"; content: ContentBlock[] }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; name: string; ok: boolean; output: string }
  | { t: "usage"; usage: Usage; costUSD: number };

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
  onEvent?: (e: TurnEvent) => void;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<TurnResult> {
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  let costUSD = 0;
  let lastText = "";

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (opts.budget.exhausted) {
      return { stopReason: "budget_exhausted", usage: totals, costUSD, model: opts.model, text: lastText };
    }

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
      const approved = await opts.approve(block.name, groupOf(opts.tools, block.name), block.input);
      if (!approved) {
        output = "User declined this tool call.";
      } else {
        const dispatched = await dispatch(opts.tools, block.name, block.input, { cwd: opts.cwd });
        ok = dispatched.ok;
        output = cap(dispatched.output);
      }

      results.push({
        type: "tool_result",
        toolUseId: block.id,
        content: output,
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
