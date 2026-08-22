import { describe, test, expect } from "bun:test";
import type { ChatMessage, ChatResponse, Provider } from "../src/provider/types";
import { runAgentTurn } from "../src/agent/loop";
import { Budget } from "../src/agent/budget";
import { readTool } from "../src/tools/read";
import { parseSse } from "../src/provider/sse";
import {
  classifyAbort,
  abortReason,
  markInterrupted,
  createChildController,
  ForceExitTimer,
  INTERRUPT_MARKER,
} from "../src/session/abort";

const tools = [readTool];
const base = {
  model: "test-model",
  system: "sys",
  tools,
  maxTokens: 1024,
  cwd: import.meta.dir,
  approve: async () => true,
  budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
};

describe("B13-2 reason classification", () => {
  test("classifies user-interrupt vs timeout vs error from signal.reason", () => {
    const user = new AbortController();
    user.abort(); // bare abort() → user interrupt
    expect(classifyAbort(user.signal)).toBe("user-interrupt");

    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    const timeout = new AbortController();
    timeout.abort(timeoutErr);
    expect(classifyAbort(timeout.signal)).toBe("timeout");

    const error = new AbortController();
    error.abort(new Error("boom"));
    expect(classifyAbort(error.signal)).toBe("error");

    const idle = new AbortController();
    expect(classifyAbort(idle.signal)).toBe("none");
  });

  test("abortReason tolerates structured (non-Error) reasons", () => {
    expect(abortReason({ kind: "timeout" })).toBe("timeout");
    expect(abortReason({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(abortReason({ kind: "error" })).toBe("error");
    expect(abortReason({ kind: "user" })).toBe("user-interrupt");
    expect(abortReason(undefined)).toBe("none");
  });

  test("markInterrupted keeps partial text and tags it", () => {
    expect(markInterrupted("hello partial")).toBe(`hello partial ${INTERRUPT_MARKER}`);
    expect(markInterrupted("")).toBe(INTERRUPT_MARKER);
  });
});

describe("B13-2 abort mid-stream preserves partial output", () => {
  test("session trail gets partial text + (interrupted), no tool results from aborted iteration", async () => {
    const aborting: Provider = {
      name: "abort",
      async chat(_req, callbacks): Promise<ChatResponse> {
        callbacks?.onTextDelta?.("partial answer ");
        callbacks?.onTextDelta?.("so far");
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    };
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events: Array<{ t: string; content?: unknown }> = [];
    await expect(
      runAgentTurn({
        ...base,
        provider: aborting,
        messages,
        onEvent: (e) => events.push({ t: e.t, content: e.t === "assistant_message" ? (e as any).content : undefined }),
      }),
    ).rejects.toThrow(/aborted/);

    // PARTIAL OUTPUT IS KEPT in the transcript with the interrupted marker
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(String(last?.content)).toContain("partial answer so far");
    expect(String(last?.content)).toContain(INTERRUPT_MARKER);

    // no tool results from the aborted iteration
    const allJson = JSON.stringify(messages);
    expect(allJson).not.toContain("tool_result");

    // the interrupted assistant message is surfaced to the session trail
    expect(events.some((e) => e.t === "assistant_message")).toBe(true);
  });
});

describe("B13-2 reader.cancel on abort (no orphaned stream)", () => {
  function fakeStream() {
    let cancelCalled = false;
    let resolveRead: ((v: { done: boolean }) => void) | null = null;
    const reader = {
      read: () =>
        new Promise<{ done: boolean }>((resolve) => {
          resolveRead = resolve;
        }),
      cancel: async () => {
        cancelCalled = true;
        resolveRead?.({ done: true });
      },
      releaseLock: () => {},
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    return { body, cancelled: () => cancelCalled };
  }

  test("aborting the signal cancels the reader (no orphaned polling)", async () => {
    const { body, cancelled } = fakeStream();
    const ctrl = new AbortController();
    const it = parseSse(body, ctrl.signal);
    const pending = it.next();
    ctrl.abort();
    // the abort listener cancelled the reader
    expect(cancelled()).toBe(true);
    // and the generator surfaces the abort instead of hanging
    await expect(pending).rejects.toThrow();
  });
});

describe("B13-2 child controllers isolate subtasks", () => {
  test("subtask abort leaves parent turn alive", () => {
    const parent = new AbortController();
    const child = createChildController(parent.signal);
    child.abort();
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false); // parent not poisoned
  });

  test("parent abort propagates down to children", () => {
    const parent = new AbortController();
    const child = createChildController(parent.signal);
    parent.abort();
    expect(child.signal.aborted).toBe(true);
  });

  test("child of an already-aborted parent starts aborted", () => {
    const parent = new AbortController();
    parent.abort();
    const child = createChildController(parent.signal);
    expect(child.signal.aborted).toBe(true);
  });
});

describe("B13-2 force-exit failsafe", () => {
  test("timer fires when a hung tool never clears it", async () => {
    let fired = false;
    const timer = new ForceExitTimer(5, () => {
      fired = true;
    });
    timer.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(true);
    expect(timer.armed).toBe(false);
  });

  test("clearing the timer prevents force-exit", async () => {
    let fired = false;
    const timer = new ForceExitTimer(5, () => {
      fired = true;
    });
    timer.start();
    timer.clear();
    await new Promise((r) => setTimeout(r, 30));
    expect(fired).toBe(false);
  });
});
