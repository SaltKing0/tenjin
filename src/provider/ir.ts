// B7-1 canonical provider IR (#377): pure adapters mapping provider-native tool
// shapes to and from the canonical IR (ToolDefinition / ToolCall / ToolResult in
// types.ts). Nothing downstream should touch native formats directly — these
// adapters are the single boundary. `providerCallId` is threaded unchanged so a
// result always answers its originating call.
import type {
  ContentBlock,
  ToolCall,
  ToolDefinition,
  ToolResult,
  ToolSchema,
} from "./types";

// ---------------------------------------------------------------------------
// OpenAI native shapes
// ---------------------------------------------------------------------------
export interface OpenAiNativeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAiNativeToolResult {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/** OpenAI `tool_calls[]` → canonical ToolCall. Arguments are parsed to an OBJECT
 *  even when the provider sent a string (its `function.arguments` JSON). */
export function openAiToolCallToIR(
  provider: string,
  call: OpenAiNativeToolCall,
): ToolCall {
  return {
    provider,
    providerCallId: call.id,
    name: call.function.name,
    arguments: parseArgsObject(call.function.arguments),
    raw: call,
  };
}

/** Canonical ToolCall → OpenAI native `tool_calls[]` entry (lossless). */
export function irToOpenAiToolCall(call: ToolCall): OpenAiNativeToolCall {
  return {
    id: call.providerCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

export function openAiToolResultToIR(
  res: OpenAiNativeToolResult,
): ToolResult {
  return { providerCallId: res.tool_call_id, ok: true, content: res.content };
}

export function irToOpenAiToolResult(res: ToolResult): OpenAiNativeToolResult {
  return { role: "tool", tool_call_id: res.providerCallId, content: res.content };
}

// ---------------------------------------------------------------------------
// Anthropic native shapes
// ---------------------------------------------------------------------------
export interface AnthropicNativeToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicNativeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/** Anthropic `tool_use` block → canonical ToolCall. Input is already an object
 *  on Anthropic; a non-object is boxed so `arguments` is always an OBJECT. */
export function anthropicToolUseToIR(
  provider: string,
  block: AnthropicNativeToolUse,
): ToolCall {
  const input = block.input;
  const argumentsObj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : { _unparsed: input };
  return {
    provider,
    providerCallId: block.id,
    name: block.name,
    arguments: argumentsObj,
    raw: block,
  };
}

export function irToAnthropicToolUse(call: ToolCall): AnthropicNativeToolUse {
  return { type: "tool_use", id: call.providerCallId, name: call.name, input: call.arguments };
}

export function anthropicToolResultToIR(
  res: AnthropicNativeToolResult,
): ToolResult {
  return {
    providerCallId: res.tool_use_id,
    ok: !res.is_error,
    content: res.content,
  };
}

export function irToAnthropicToolResult(res: ToolResult): AnthropicNativeToolResult {
  return {
    type: "tool_result",
    tool_use_id: res.providerCallId,
    content: res.content,
    ...(res.ok ? {} : { is_error: true }),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the ToolResult that answers `call`, carrying its exact providerCallId.
 *  This is the correlation contract: result.providerCallId === call.providerCallId. */
export function irResultForCall(
  call: ToolCall,
  ok: boolean,
  content: string,
): ToolResult {
  return { providerCallId: call.providerCallId, ok, content };
}

function parseArgsObject(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _unparsed: raw };
  } catch {
    return { _unparsed: raw };
  }
}

// ---------------------------------------------------------------------------
// Message-level threading (history entries)
// ---------------------------------------------------------------------------

export interface BlocksIR {
  calls: ToolCall[];
  results: ToolResult[];
}

/** Convert a ContentBlock[] (history entry) into IR tool calls + results,
 *  threading the provider call id through both. */
export function blocksToIR(blocks: ContentBlock[], provider: string): BlocksIR {
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  for (const b of blocks) {
    if (b.type === "tool_use") {
      calls.push(
        anthropicToolUseToIR(provider, {
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.input,
        }),
      );
    } else if (b.type === "tool_result") {
      results.push(
        anthropicToolResultToIR({
          type: "tool_result",
          tool_use_id: b.toolUseId,
          content: b.content,
          ...(b.isError ? { is_error: true } : {}),
        }),
      );
    }
  }
  return { calls, results };
}

/** Convert IR tool calls + results back into ContentBlock[] (history entry). */
export function irToBlocks(calls: ToolCall[], results: ToolResult[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const call of calls) {
    blocks.push({ type: "tool_use", id: call.providerCallId, name: call.name, input: call.arguments });
  }
  for (const res of results) {
    blocks.push({
      type: "tool_result",
      toolUseId: res.providerCallId,
      content: res.content,
      isError: !res.ok,
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** Canonical ToolDefinition from a ToolSchema + optional side-effect flag. */
export function schemaToToolDefinition(
  schema: ToolSchema,
  sideEffect?: boolean,
): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema,
    ...(sideEffect === undefined ? {} : { sideEffect }),
  };
}

/** ToolSchema from a canonical ToolDefinition (drops sideEffect). */
export function toolDefinitionToSchema(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  };
}
