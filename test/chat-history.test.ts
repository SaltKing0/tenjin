import { describe, test, expect } from "bun:test";
import { messageText, sessionMessages, chatRequestBody } from "../src/gateway/console/chat-history.js";

describe("console chat history from session events (#284)", () => {
  test("sessionMessages extracts the ordered user/assistant transcript", () => {
    const events = [
      { t: "session_start", id: "s1" },
      { t: "message", role: "user", content: "hello" },
      { t: "tool_call", name: "edit" },
      { t: "message", role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ];
    expect(sessionMessages(events)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  test("messageText handles string and content-block content", () => {
    expect(messageText({ role: "user", content: "raw" })).toBe("raw");
    expect(
      messageText({
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a b");
    expect(messageText({ role: "assistant", content: [] })).toBe("");
  });

  test("sessionMessages tolerates empty/missing events and skips non-messages", () => {
    expect(sessionMessages(null)).toEqual([]);
    expect(sessionMessages([])).toEqual([]);
    expect(sessionMessages([{ t: "tool_call" }])).toEqual([]);
  });

  test("chatRequestBody keeps the selected bot in the request", () => {
    expect(chatRequestBody("review this", "repo-guard")).toEqual({
      text: "review this",
      bot: "repo-guard",
    });
    expect(chatRequestBody("hello", "solo")).toEqual({ text: "hello", bot: "solo" });
  });
});
