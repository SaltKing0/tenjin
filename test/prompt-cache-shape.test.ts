import { describe, test, expect } from "bun:test";
import type { ChatMessage } from "../src/provider/types";
import {
  buildSystemPrompt,
  buildVolatileTail,
  assembleCacheShapedPrompt,
} from "../src/agent/prompt";

const msg = (role: "user" | "assistant", content: string): ChatMessage => ({ role, content });

describe("buildVolatileTail (B2-1 volatile tail zone)", () => {
  test("renders clock, context pressure, and status lines", () => {
    const tail = buildVolatileTail({
      now: "2026-08-22",
      contextPercent: 42,
      statusLines: ["cwd: /src"],
    });
    expect(tail).toContain("# Live context");
    expect(tail).toContain("date: 2026-08-22");
    expect(tail).toContain("context pressure: 42%");
    expect(tail).toContain("cwd: /src");
  });

  test("returns null when there is nothing volatile", () => {
    expect(buildVolatileTail({})).toBeNull();
    expect(buildVolatileTail({ statusLines: [] })).toBeNull();
  });

  test("omits unset fields", () => {
    const tail = buildVolatileTail({ now: "2026-08-22" });
    expect(tail).toContain("date: 2026-08-22");
    expect(tail).not.toContain("context pressure");
  });
});

describe("assembleCacheShapedPrompt (B2-1 stable prefix + tail)", () => {
  const system = buildSystemPrompt({
    soulText: "SOUL",
    cwd: "/c",
    agentsMd: null,
  });

  test("breakpoint index equals transcript length (end of stable prefix)", () => {
    const transcript = [msg("user", "hello"), msg("assistant", "hi")];
    const out = assembleCacheShapedPrompt({
      system,
      transcript,
      volatileTail: buildVolatileTail({ now: "2026-08-22" }),
    });
    expect(out.system).toBe(system);
    expect(out.breakpointIndex).toBe(transcript.length);
    expect(out.messages.length).toBe(transcript.length + 1);
  });

  test("volatile tail lands AFTER the transcript, never inside the prefix", () => {
    const transcript = [msg("user", "q1"), msg("assistant", "a1")];
    const out = assembleCacheShapedPrompt({
      system,
      transcript,
      volatileTail: buildVolatileTail({ now: "2026-08-22", contextPercent: 99 }),
    });
    // The system prompt (prefix) must not contain any volatile data.
    expect(out.system).not.toContain("2026-08-22");
    expect(out.system).not.toContain("context pressure");
    // The tail is the last message, after all transcript messages.
    const last = out.messages[out.messages.length - 1];
    expect(last).toEqual({ role: "user", content: expect.stringContaining("date: 2026-08-22") });
    // Transcript order preserved verbatim.
    expect(out.messages.slice(0, 2)).toEqual(transcript);
  });

  test("two consecutive builds in one session produce a byte-identical prefix", () => {
    const transcript = [msg("user", "hello")];
    const first = assembleCacheShapedPrompt({
      system,
      transcript,
      volatileTail: buildVolatileTail({ now: "2026-08-22" }),
    });
    const second = assembleCacheShapedPrompt({
      system,
      transcript,
      volatileTail: buildVolatileTail({ now: "2026-08-22" }),
    });
    expect(second.system).toBe(first.system);
    // Stable prefix = system + transcript; identical across builds.
    expect(second.system).toBe(first.system);
    expect(second.messages.slice(0, transcript.length)).toEqual(
      first.messages.slice(0, transcript.length),
    );
  });

  test("a new turn appends only — existing prefix bytes unchanged (diff assert)", () => {
    const turn1 = assembleCacheShapedPrompt({
      system,
      transcript: [msg("user", "q1"), msg("assistant", "a1")],
      volatileTail: buildVolatileTail({ now: "2026-08-22" }),
    });
    // Next turn: transcript grows by one appended user message.
    const turn2 = assembleCacheShapedPrompt({
      system,
      transcript: [msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2")],
      volatileTail: buildVolatileTail({ now: "2026-08-22" }),
    });
    // System prefix identical.
    expect(turn2.system).toBe(turn1.system);
    // The first two transcript messages are byte-for-byte unchanged.
    expect(turn2.messages[0]).toEqual(turn1.messages[0]);
    expect(turn2.messages[1]).toEqual(turn1.messages[1]);
    // turn2 only adds the new transcript message + the volatile tail.
    expect(turn2.breakpointIndex).toBe(turn1.breakpointIndex + 1);
    expect(turn2.messages.length).toBe(turn1.messages.length + 1);
  });

  test("no volatile tail means messages are exactly the transcript", () => {
    const transcript = [msg("user", "hi")];
    const out = assembleCacheShapedPrompt({ system, transcript, volatileTail: null });
    expect(out.messages).toEqual(transcript);
    expect(out.breakpointIndex).toBe(1);
  });
});
