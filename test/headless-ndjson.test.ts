import { describe, test, expect } from "bun:test";
import {
  turnEventToNdjson,
  heartbeatEvent,
  errorEvent,
  collectStats,
  statsBlock,
  exitCodeFor,
  writeNdjson,
  runHeadlessNdjson,
} from "../src/cli/headless-ndjson";
import { parseArgs } from "../src/cli/args";
import type { TurnEvent } from "../src/agent/loop";
import type { Provider } from "../src/provider/types";

function fakeProvider(stopReason: "end_turn" | "max_tokens" | "other", fail = false): Provider {
  return {
    name: "fake",
    chat: async () => {
      if (fail) throw new Error("provider exploded");
      return {
        stopReason,
        content: [{ type: "text", text: "hello" }],
        usage: { inputTokens: 7, outputTokens: 4 },
      };
    },
  };
}

const events: TurnEvent[] = [
  { t: "assistant_message", content: [{ type: "text", text: "hi" }] },
  { t: "tool_call", id: "c1", name: "read", input: { path: "/a.txt" } },
  { t: "tool_result", id: "c1", name: "read", ok: true, output: "contents" },
  { t: "tool_call", id: "c2", name: "write", input: { path: "/tmp/out.md" } },
  { t: "tool_result", id: "c2", name: "write", ok: true, output: "wrote" },
  { t: "usage", usage: { inputTokens: 5, outputTokens: 3 }, costUSD: 0.001 },
  {
    t: "compression",
    beforeTokens: 100,
    afterTokens: 40,
    elidedTokens: 60,
    stage: 2,
    archivePath: "/mem/archives/x.jsonl",
  },
];

describe("B13-7 ndjson emission (pure)", () => {
  test("every turn event serializes to a valid, parseable ndjson line", () => {
    const lines: string[] = [];
    for (const e of events) writeNdjson(lines.push.bind(lines), turnEventToNdjson(e));
    expect(lines.length).toBe(events.length);
    for (const line of lines) {
      const obj = JSON.parse(line) as { type?: string };
      expect(obj).toBeTruthy();
      expect(typeof obj.type).toBe("string");
    }
    // type discrimination is faithful
    expect(JSON.parse(lines[0]!).type).toBe("message");
    expect(JSON.parse(lines[1]!).type).toBe("tool_call");
    expect(JSON.parse(lines[5]!).type).toBe("usage");
    expect(JSON.parse(lines[6]!).type).toBe("compression");
  });

  test("collectStats accumulates tool counts, files changed and tokens", () => {
    const stats = collectStats(events);
    expect(stats.toolCounts.read).toBe(1);
    expect(stats.toolCounts.write).toBe(1);
    // only mutating tools count as files changed
    expect(stats.filesChanged).toEqual(["/tmp/out.md"]);
    expect(stats.inputTokens).toBe(5);
    expect(stats.outputTokens).toBe(3);
  });

  test("statsBlock carries per-model token split, cost, tool counts, files, duration", () => {
    const block = statsBlock({
      model: "gpt-4o",
      costUSD: 0.0123,
      durationMs: 1500,
      stats: collectStats(events),
    }) as { type: string; model: string; tokens: { input: number; output: number }; costUSD: number; durationMs: number; toolCounts: Record<string, number>; filesChanged: string[] };
    expect(block.type).toBe("stats");
    expect(block.model).toBe("gpt-4o");
    expect(block.tokens).toEqual({ input: 5, output: 3 });
    expect(block.costUSD).toBe(0.0123);
    expect(block.durationMs).toBe(1500);
    expect(block.toolCounts.read).toBe(1);
    expect(block.filesChanged).toEqual(["/tmp/out.md"]);
    expect(JSON.parse(JSON.stringify(block))).toEqual(block); // fully serializable
  });
});

describe("B13-7 exit codes + error events", () => {
  test("exit code 0 on end_turn, nonzero otherwise (CI-friendly)", () => {
    expect(exitCodeFor("end_turn")).toBe(0);
    expect(exitCodeFor("max_tokens")).toBe(1);
    expect(exitCodeFor("other")).toBe(1);
  });

  test("a failed run writes an error event line and exits nonzero", async () => {
    const lines: string[] = [];
    const code = await runHeadlessNdjson({
      provider: fakeProvider("end_turn", true), // throws
      model: "m",
      soulText: "s",
      cwd: "/tmp",
      message: "hi",
      maxTokens: 1024,
      capUSD: 1,
      write: (l) => lines.push(l),
      heartbeatMs: 0,
    });
    expect(code).toBe(1);
    const errorLine = lines[lines.length - 1]!;
    const obj = JSON.parse(errorLine) as { type: string; message: string };
    expect(obj.type).toBe("error");
    expect(obj.message).toContain("provider exploded");
  });
});

describe("B13-7 heartbeat (fake clock)", () => {
  test("heartbeatEvent stamps the injected clock time and parses", () => {
    const line = JSON.stringify(heartbeatEvent(12345));
    const obj = JSON.parse(line) as { type: string; at: number };
    expect(obj.type).toBe("heartbeat");
    expect(obj.at).toBe(12345);
  });
});

describe("B13-7 end-to-end wiring", () => {
  test("a non-TTY run emits only parseable ndjson lines + a final stats block", async () => {
    const lines: string[] = [];
    const code = await runHeadlessNdjson({
      provider: fakeProvider("end_turn"),
      model: "m",
      soulText: "s",
      cwd: "/tmp",
      message: "hi",
      maxTokens: 1024,
      capUSD: 1,
      write: (l) => lines.push(l),
      heartbeatMs: 0,
    });
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(JSON.parse(line)).toBeTruthy();
    const stats = JSON.parse(lines[lines.length - 1]!) as { type: string; model: string; tokens: { input: number; output: number } };
    expect(stats.type).toBe("stats");
    expect(stats.model).toBe("m");
    // per-model token split from the run's usage events
    expect(stats.tokens.input).toBeGreaterThanOrEqual(0);
    expect(stats.tokens.output).toBeGreaterThanOrEqual(0);
  });

  test("a non-end_turn run exits nonzero", async () => {
    const lines: string[] = [];
    const code = await runHeadlessNdjson({
      provider: fakeProvider("max_tokens"),
      model: "m",
      soulText: "s",
      cwd: "/tmp",
      message: "hi",
      maxTokens: 1024,
      capUSD: 1,
      write: (l) => lines.push(l),
      heartbeatMs: 0,
    });
    expect(code).toBe(1);
  });
});

describe("B13-7 --json flag parsing", () => {
  test("--json / --ndjson set the json flag (must precede -p)", () => {
    expect(parseArgs(["--json", "-p", "hello"]).json).toBe(true);
    expect(parseArgs(["--json", "-p", "hello"]).print).toBe("hello");
    expect(parseArgs(["--ndjson", "-p", "x"]).json).toBe(true);
    expect(parseArgs(["-p", "hello"]).json).toBeUndefined();
  });
});
