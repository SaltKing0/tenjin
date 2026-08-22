import { describe, test, expect } from "bun:test";
import {
  ApprovalQueue,
  denyFeedback,
  parseApprovalAnswer,
  persistScope,
  renderApprovalBlock,
  timeoutVerdict,
  truncateForPrompt,
  withTimeout,
} from "../src/ui/approval";
import { runAgentTurn } from "../src/agent/loop";
import { Budget } from "../src/agent/budget";
import type { ChatMessage, ChatResponse } from "../src/provider/types";

function mockProvider(script: ChatResponse[]): Provider & { requests: unknown[] } {
  let i = 0;
  const requests: unknown[] = [];
  return {
    name: "mock",
    requests,
    async chat(req: never) {
      requests.push(req);
      const next = script[i++];
      if (!next) throw new Error("script exhausted");
      return next;
    },
  };
}
type Provider = { name: string; requests: unknown[]; chat(req: never): Promise<ChatResponse> };

describe("approval request block", () => {
  test("renders tier badge, WHAT, and answer keys, separated from scrollback", () => {
    const block = renderApprovalBlock({ tool: "bash", tier: "T1", what: "npm test" });
    expect(block).toContain("APPROVAL REQUEST");
    expect(block).toContain("[T1]");
    expect(block).toContain("bash → npm test");
    expect(block).toContain("y=once");
    expect(block).toContain("s=session");
    expect(block).toContain("a=always");
    expect(block).toContain("n=deny");
    // visually separated: separator bars top and bottom.
    const lines = block.split("\n");
    expect((lines[0] ?? "").startsWith("━")).toBe(true);
    expect((lines[lines.length - 1] ?? "").startsWith("━")).toBe(true);
  });

  test("T2 badge carries the strong-confirmation wording", () => {
    const block = renderApprovalBlock({ tool: "bash", tier: "T2", what: "rm -rf /" });
    expect(block).toContain("[T2]");
    expect(block).toContain("irreversible/credential");
  });

  test("renders WHY and RISK-OF when provided", () => {
    const block = renderApprovalBlock({
      tool: "write_file",
      tier: "T1",
      what: "src/config.ts",
      why: "add timeout knob",
      consequence: "modifies a tracked source file",
    });
    expect(block).toContain("WHY:   add timeout knob");
    expect(block).toContain("RISK-OF: modifies a tracked source file");
  });

  test("long WHAT is truncated with a view-full-command hint", () => {
    const long = "x".repeat(200);
    const truncated = truncateForPrompt(long);
    expect(truncated).toContain("(view full command)");
    expect(truncated.length).toBeLessThan(long.length);
    expect(truncateForPrompt("short")).toBe("short");
  });
});

describe("single-key answers + T2 law", () => {
  test("single-key answers map to scopes", () => {
    expect(parseApprovalAnswer("y", { tier: "T1" })).toEqual({
      kind: "verdict",
      verdict: { kind: "allow", scope: "once" },
    });
    expect(parseApprovalAnswer("s", { tier: "T1" })).toEqual({
      kind: "verdict",
      verdict: { kind: "allow", scope: "session" },
    });
    expect(parseApprovalAnswer("a", { tier: "T1" })).toEqual({
      kind: "verdict",
      verdict: { kind: "allow", scope: "always" },
    });
    expect(parseApprovalAnswer("n", { tier: "T1" })).toEqual({
      kind: "verdict",
      verdict: { kind: "deny" },
    });
    // anything else → comment path (tab-to-comment)
    expect(parseApprovalAnswer("?", { tier: "T1" }).kind).toBe("comment");
  });

  test("T2 never allows session/always — no auto-approve path", () => {
    expect(parseApprovalAnswer("a", { tier: "T2" })).toEqual({
      kind: "verdict",
      verdict: { kind: "deny" },
    });
    expect(parseApprovalAnswer("s", { tier: "T2" })).toEqual({
      kind: "verdict",
      verdict: { kind: "deny" },
    });
    // only a one-shot yes allows on T2
    expect(parseApprovalAnswer("y", { tier: "T2" })).toEqual({
      kind: "verdict",
      verdict: { kind: "allow", scope: "once" },
    });
  });
});

describe("timeout auto-denies (never allows)", () => {
  test("timeout verdict is always deny", () => {
    expect(timeoutVerdict().kind).toBe("deny");
  });

  test("withTimeout reports { ok: false } on timeout", async () => {
    const res = await withTimeout(new Promise(() => {}), 20);
    expect(res.ok).toBe(false);
  });

  test("withTimeout resolves the value when the prompt answers first", async () => {
    const res = await withTimeout(Promise.resolve("y"), 500);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("y");
  });
});

describe("comment-on-deny feedback", () => {
  test("deny with comment reaches the model containing the comment text", () => {
    const fb = denyFeedback("write_file", "don't overwrite the config");
    expect(fb).toContain("don't overwrite the config");
    expect(fb).toContain("do not repeat");
  });

  test("plain deny carries no comment", () => {
    expect(denyFeedback("bash")).toContain("Approval for bash was denied.");
    expect(denyFeedback("bash")).not.toContain("The user's comment");
  });
});

describe("always-scope = narrowest rule", () => {
  test("always persists a rule scoped to the exact tool, never a group", () => {
    const rule = persistScope("always", "write_file");
    expect(rule).toEqual({ tool: "write_file" });
    expect(rule?.tool).not.toContain("*");
    expect(persistScope("once", "write_file")).toBeNull();
    expect(persistScope("session", "write_file")).toBeNull();
  });
});

describe("FIFO approval lock", () => {
  test("two concurrent approvals serialize — second waits for the first", async () => {
    const q = new ApprovalQueue();
    const order: string[] = [];
    const run = (id: string, ms: number) =>
      q.run(async () => {
        order.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end:${id}`);
      });
    await Promise.all([run("a", 30), run("b", 5)]);
    // b never starts until a finishes: no overlap.
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});

describe("comment-on-deny reaches the model through the loop", () => {
  test("denial reason is fed back in the tool_result output", async () => {
    const provider = mockProvider([
      {
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        stopReason: "end_turn",
        content: [{ type: "text", text: "ok" }],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const messages: ChatMessage[] = [];
    await runAgentTurn({
      provider,
      model: "m",
      system: "s",
      tools: [],
      messages,
      maxTokens: 100,
      cwd: import.meta.dir,
      approve: async () => ({ allowed: false, reason: "do not touch prod" }),
      budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
    });
    const toolMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content));
    const block = toolMsg?.content as { type: "tool_result"; content: string }[] | undefined;
    expect(block?.[0]?.type).toBe("tool_result");
    expect(block?.[0]?.content).toContain("do not touch prod");
  });
});
