import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBoundary, type BoundaryOutcome } from "../src/recovery/boundary";
import { RecoverySession } from "../src/recovery/session";
import { IdempotencyLedger } from "../src/recovery/idempotent";
import { runAgentTurn } from "../src/agent/loop";
import { Budget } from "../src/agent/budget";
import { writeTool } from "../src/tools/write";
import type { ChatMessage, ChatResponse, ChatRequest, Provider, StreamCallbacks } from "../src/provider/types";

describe("resume_stable replays to last clean tool boundary (B3-3)", () => {
  test("committed steps are NOT re-executed after a mid-turn crash", () => {
    const session = new RecoverySession();
    const counts: Record<string, number> = { s1: 0, s2: 0, s3: 0, s4: 0 };
    const run = (id: string) => {
      counts[id]!++;
    };

    // Steps s1..s3 run cleanly, each checkpointed ON_TOOL_CALL and completed.
    for (const id of ["s1", "s2", "s3"]) {
      session.checkpoint(`tool:${id}`);
      run(id);
      session.complete(id);
    }
    // Crash injected mid-turn: checkpoint taken before s4, but s4 never completes.
    session.checkpoint("tool:s4");
    expect(session.isCommitted("s4")).toBe(false);

    // After the crash we resume_stable.
    const plan = session.resume("resume_stable");
    expect(plan.mode).toBe("resume_stable");
    expect(plan.rollback).toBe(true);
    expect(plan.committed.has("s1")).toBe(true);
    expect(plan.committed.has("s2")).toBe(true);
    expect(plan.committed.has("s3")).toBe(true);
    expect(plan.committed.has("s4")).toBe(false);

    // Replay: skip committed steps, run the unfinished tail exactly once.
    for (const id of ["s1", "s2", "s3", "s4"]) {
      if (plan.committed.has(id)) continue;
      run(id);
      session.complete(id);
    }

    // No duplicate side effects: s1..s3 ran exactly once (before the crash).
    expect(counts).toEqual({ s1: 1, s2: 1, s3: 1, s4: 1 });
  });

  test("restart_clean discards all in-turn progress; resume_last keeps it", () => {
    const session = new RecoverySession();
    for (const id of ["a", "b"]) {
      session.checkpoint(`tool:${id}`);
      session.complete(id);
    }
    const clean = session.resume("restart_clean");
    expect(clean.committed.size).toBe(0);
    expect(clean.rollback).toBe(true);

    const last = session.resume("resume_last");
    expect(last.committed.has("a")).toBe(true);
    expect(last.committed.has("b")).toBe(true);
    expect(last.rollback).toBe(false);
  });
});

describe("error boundaries (B3-3)", () => {
  test("skip_and_note converts a failing step into a noted gap instead of aborting", async () => {
    const audits: string[] = [];
    const outcome = await runBoundary(
      async () => {
        throw new Error("boom in step");
      },
      { mode: "skip_and_note", audit: (d) => audits.push(d) },
    );
    expect(outcome.status).toBe("skipped");
    if (outcome.status === "skipped") {
      expect(outcome.reason).toBe("skip_and_note");
      expect(outcome.note).toContain("boom in step");
    }
    expect(audits.some((d) => d.includes("reason=skip_and_note"))).toBe(true);
  });

  test("use_cached serves the cached result and skips the failing step", async () => {
    const cache = new Map<string, unknown>();
    const audits: string[] = [];
    const outcome = await runBoundary(
      async () => {
        throw new Error("n/a");
      },
      {
        mode: "use_cached",
        cacheKey: "k",
        cache: { has: (k) => cache.has(k), get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) },
        audit: (d) => audits.push(d),
      },
    );
    // No cache hit yet → falls back to skip_and_note.
    expect(outcome.status).toBe("skipped");

    cache.set("k", "cached-result");
    const hit = await runBoundary<string>(
      async () => {
        throw new Error("n/a");
      },
      {
        mode: "use_cached",
        cacheKey: "k",
        cache: { has: (k) => cache.has(k), get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) },
        audit: (d) => audits.push(d),
      },
    );
    expect(hit.status).toBe("success");
    if (hit.status === "success") {
      expect(hit.reason).toBe("use_cached");
      expect(hit.value).toBe("cached-result");
    }
    expect(audits.some((d) => d.includes("reason=use_cached"))).toBe(true);
  });

  test("ask_human surfaces approval and pauses the run when not approved", async () => {
    const asked: string[] = [];
    const outcome = await runBoundary(
      async () => {
        throw new Error("needs a decision");
      },
      {
        mode: "ask_human",
        ask: async (note) => {
          asked.push(note);
          return false; // not approved → pause
        },
      },
    );
    expect(asked.length).toBe(1);
    expect(asked[0]).toContain("needs a decision");
    expect(outcome.status).toBe("paused");
    if (outcome.status === "paused") expect(outcome.reason).toBe("ask_human");
  });

  test("ask_human approved retries and completes the step", async () => {
    let attempts = 0;
    const outcome = await runBoundary(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("retry me");
        return "done";
      },
      { mode: "ask_human", ask: async () => true },
    );
    expect(outcome.status).toBe("success");
    if (outcome.status === "success") expect(outcome.value).toBe("done");
  });

  test("raise rethrows the error", async () => {
    const audits: string[] = [];
    await expect(
      runBoundary(
        async () => {
          throw new Error("critical");
        },
        { mode: "raise", audit: (d) => audits.push(d) },
      ),
    ).rejects.toThrow("critical");
    expect(audits.some((d) => d.includes("reason=raise"))).toBe(true);
  });
});

describe("idempotent job reruns (B3-3)", () => {
  test("double-rerun of the same job ID executes side effects exactly once", async () => {
    const ledger = new IdempotencyLedger();
    let calls = 0;
    const fn = async () => {
      calls++;
      return "job-result";
    };
    const first = await ledger.runOnce("job-1", fn);
    const second = await ledger.runOnce("job-1", fn);
    expect(calls).toBe(1);
    expect(first.ran).toBe(true);
    expect(second.ran).toBe(false);
    expect(second.value).toBe("job-result");
    expect(ledger.isCompleted("job-1")).toBe(true);
  });

  test("a fresh invocation key still runs", async () => {
    const ledger = new IdempotencyLedger();
    let calls = 0;
    await ledger.runOnce("job-1", async () => calls++);
    await ledger.runOnce("job-2", async () => calls++);
    expect(calls).toBe(2);
  });
});

describe("recovery decisions land in the audit trail with reason class (B3-3)", () => {
  test("every boundary / session / idempotent decision carries a reason tag", async () => {
    const details: string[] = [];
    const audit = (d: string) => details.push(d);

    // boundary: skip_and_note
    await runBoundary(
      async () => {
        throw new Error("x");
      },
      { mode: "skip_and_note", audit },
    );
    // session: checkpoint + complete + resume_stable
    const session = new RecoverySession(audit);
    session.checkpoint("tool:a");
    session.complete("a");
    session.checkpoint("tool:b");
    session.resume("resume_stable");
    // idempotent: runOnce twice (skip on the second)
    const ledger = new IdempotencyLedger(audit);
    await ledger.runOnce("j", async () => 1);
    await ledger.runOnce("j", async () => 1);

    expect(details.length).toBeGreaterThan(0);
    for (const d of details) {
      expect(d).toMatch(/^reason=/);
    }
    expect(details.some((d) => d.startsWith("reason=skip_and_note"))).toBe(true);
    expect(details.some((d) => d.startsWith("reason=resume_stable"))).toBe(true);
    expect(details.some((d) => d.startsWith("reason=idempotent_skip"))).toBe(true);
  });
});

describe("loop integration (B3-3)", () => {
  function mockProvider(script: ChatResponse[]): Provider {
    let i = 0;
    return {
      name: "mock",
      async chat(_req: ChatRequest, _cb?: StreamCallbacks) {
        const next = script[i++];
        if (!next) throw new Error("script exhausted");
        return next;
      },
    };
  }
  const endTurn = (text: string): ChatResponse => ({
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  test("records an ON_TOOL_CALL checkpoint + recovery audit during a tool turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenjin-recovery-loop-"));
    try {
      const audit: string[] = [];
      const session = new RecoverySession((d) => audit.push(d));
      const provider = mockProvider([
        {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "w1",
              name: "write_file",
              input: { path: "tmp-recovery.txt", content: "x" },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        endTurn("done"),
      ]);
      const messages: ChatMessage[] = [{ role: "user", content: "write a file" }];

      await runAgentTurn({
        provider,
        model: "m",
        system: "sys",
        tools: [writeTool],
        messages,
        maxTokens: 1024,
        cwd: dir,
        approve: async () => true,
        budget: new Budget(0, { inputPerMTok: 0, outputPerMTok: 0 }),
        recovery: {
          session,
          audit: (kind, detail) => {
            if (kind === "recovery") audit.push(detail);
          },
        },
      });

      // The ON_TOOL_CALL checkpoint was recorded before the tool and the step
      // completed after it.
      expect(session.lastCheckpoint?.at).toContain("tool:write_file");
      expect(session.isCommitted("w1")).toBe(true);
      // And the recovery audit saw the checkpoint reason tag.
      expect(audit.some((d) => d.includes("reason=checkpoint"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
