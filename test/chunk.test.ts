import { describe, test, expect } from "bun:test";
import { chunkMessage, ChannelSendError } from "../src/gateway/chunk";

describe("chunkMessage", () => {
  test("short text returns as a single chunk", () => {
    expect(chunkMessage("hello world", 2000)).toEqual(["hello world"]);
  });

  test("splits on newline boundaries inside the limit", () => {
    const text = ("line one\n".repeat(10)).trim();
    const max = 20;
    const chunks = chunkMessage(text, max);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(max);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("hard-cuts a single over-long line", () => {
    const text = "a".repeat(500);
    const chunks = chunkMessage(text, 100);
    expect(chunks).toHaveLength(5);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  test("concatenation always equals the input", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ` + "x".repeat(50));
    const text = lines.join("\n");
    for (const max of [40, 64, 128, 300, 900]) {
      expect(chunkMessage(text, max).join("")).toBe(text);
    }
  });
});

describe("ChannelSendError", () => {
  test("is a distinct error type with a message", () => {
    const e = new ChannelSendError("delivery failed");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ChannelSendError);
    expect(e.message).toBe("delivery failed");
    expect(e.name).toBe("ChannelSendError");
  });
});
