import { describe, test, expect } from "bun:test";
import {
  AgentRuntime,
  agentStatusView,
  type AgentRecord,
  type AgentRuntimeOptions,
} from "../src/ui/agents";

describe("agentStatusView", () => {
  test("maps every status to a badge/tone", () => {
    expect(agentStatusView("running")).toEqual({ badge: "▸", tone: "ok" });
    expect(agentStatusView("awaiting_approval")).toEqual({ badge: "⏳", tone: "warn" });
    expect(agentStatusView("done")).toEqual({ badge: "✓", tone: "dim" });
    expect(agentStatusView("error")).toEqual({ badge: "✗", tone: "err" });
    expect(agentStatusView("cancelled")).toEqual({ badge: "⊘", tone: "dim" });
    expect(agentStatusView("idle")).toEqual({ badge: "·", tone: "" });
  });
});

/** Poll until `fn` is true (the runtime's runner is detached/async). */
async function until(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeRuntime(over: Partial<AgentRuntimeOptions> = {}) {
  const statuses: AgentRecord[] = [];
  const notified: AgentRecord[] = [];
  const rt = new AgentRuntime({
    run: async (_id, _label, hooks) => {
      hooks.onTextDelta("hello world");
      hooks.onToolActivity("read_file");
      return { costUSD: 0.42 };
    },
    onStatusChange: (r) => statuses.push({ ...r }),
    notify: (r) => notified.push({ ...r }),
    ...over,
  });
  return { rt, statuses, notified };
}

describe("AgentRuntime lifecycle", () => {
  test("spawn registers as running then transitions to done with cost", async () => {
    const { rt, statuses } = makeRuntime();
    const id = rt.spawn("do the thing");
    expect(rt.get(id)?.status).toBe("running");
    expect(rt.count()).toBe(1);
    await until(() => rt.get(id)?.status === "done");
    expect(rt.get(id)?.costUSD).toBe(0.42);
    expect(rt.get(id)?.lastEvent).toContain("done");
    // statuses[0] is the spawn (running), last is done.
    expect(statuses[0]?.status).toBe("running");
    expect(statuses[statuses.length - 1]?.status).toBe("done");
  });

  test("spawn honours a caller-provided id", () => {
    const { rt } = makeRuntime();
    const id = rt.spawn("x", "sess-123");
    expect(id).toBe("sess-123");
    expect(rt.get("sess-123")?.label).toBe("x");
  });

  test("runner rejection transitions to error", async () => {
    const { rt } = makeRuntime({ run: async () => { throw new Error("boom"); } });
    const id = rt.spawn("x");
    await until(() => rt.get(id)?.status === "error");
    expect(rt.get(id)?.lastEvent).toContain("boom");
  });

  test("abort transitions a hung agent to cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { rt } = makeRuntime({
      run: async (_id, _label, _hooks, signal) => {
        await gate; // hangs until released
        if (signal.aborted) throw new Error("AbortError");
        return { costUSD: 0 };
      },
    });
    const id = rt.spawn("x");
    rt.abort(id);
    release();
    await until(() => rt.get(id)?.status === "cancelled");
    expect(rt.get(id)?.lastEvent).toBe("cancelled");
  });

  test("notify fires exactly once on a terminal state", async () => {
    const { rt, notified } = makeRuntime();
    const id = rt.spawn("x");
    await until(() => rt.get(id)?.status === "done");
    expect(notified).toHaveLength(1);
    expect(notified[0]?.id).toBe(id);
    expect(notified[0]?.status).toBe("done");
  });

  test("default approve allows reads and denies writes", async () => {
    let read: boolean | undefined;
    let write: boolean | undefined;
    const rt = new AgentRuntime({
      run: async (_id, _label, hooks) => {
        read = await hooks.approve("read_file", "read", {});
        write = await hooks.approve("write_file", "write", {});
        return { costUSD: 0 };
      },
    });
    const id = rt.spawn("x");
    await until(() => rt.get(id)?.status === "done");
    expect(read).toBe(true);
    expect(write).toBe(false);
  });

  test("a custom approve option is forwarded to the runner", async () => {
    let saw: boolean | undefined;
    const rt = new AgentRuntime({
      run: async (_id, _label, hooks) => {
        saw = await hooks.approve("write_file", "write", {});
        return { costUSD: 0 };
      },
      approve: async () => true,
    });
    const id = rt.spawn("x");
    await until(() => rt.get(id)?.status === "done");
    expect(saw).toBe(true);
  });
});
