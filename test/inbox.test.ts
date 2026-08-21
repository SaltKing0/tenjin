import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatInbox,
  listMessages,
  markRead,
  sendMessage,
  unreadMessages,
} from "../src/bots/inbox";
import {
  createCheckInboxTool,
  createSendMessageTool,
} from "../src/bots/tools";
import { createBot } from "../src/bots/profile";
import { dispatch } from "../src/tools/registry";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-inbox-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("inbox store", () => {
  test("send + list round-trips messages in chronological order", () => {
    const dir = join(home, "inbox");
    const a = sendMessage(dir, { from: "writer", to: "researcher", subject: "first", body: "one" });
    const b = sendMessage(dir, { from: "writer", to: "researcher", subject: "second", body: "two" });
    expect(a.id).not.toBe(b.id);
    const all = listMessages(dir);
    expect(all.map((m) => m.subject)).toEqual(["first", "second"]);
    expect(all.every((m) => !m.read)).toBe(true);
  });

  test("unread filters and markRead persists", () => {
    const dir = join(home, "inbox");
    const m1 = sendMessage(dir, { from: "a", to: "b", subject: "s1", body: "b1" });
    sendMessage(dir, { from: "a", to: "b", subject: "s2", body: "b2" });
    expect(unreadMessages(dir)).toHaveLength(2);
    markRead(dir, [m1.id]);
    const unread = unreadMessages(dir);
    expect(unread).toHaveLength(1);
    expect(unread[0]?.subject).toBe("s2");
    expect(listMessages(dir)).toHaveLength(2);
  });

  test("missing inbox dir is empty, not an error", () => {
    expect(unreadMessages(join(home, "nope"))).toEqual([]);
  });

  test("corrupted message files are skipped", () => {
    const dir = join(home, "inbox");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.json"), "{nope");
    sendMessage(dir, { from: "a", to: "b", subject: "ok", body: "fine" });
    expect(listMessages(dir)).toHaveLength(1);
  });

  test("subject is normalized and capped", () => {
    const dir = join(home, "inbox");
    const msg = sendMessage(dir, { from: "a", to: "b", subject: `x`.repeat(300), body: "b" });
    expect(msg.subject.length).toBeLessThanOrEqual(200);
  });
});

describe("bot messaging tools", () => {
  beforeEach(() => {
    createBot(home, "researcher");
    createBot(home, "writer");
  });

  test("send_message delivers into target inbox", async () => {
    const tool = createSendMessageTool({ home, fromBot: "writer" });
    const r = await dispatch([tool], "send_message", {
      to: "researcher",
      subject: "please look at auth",
      body: "Can you investigate the login bug?",
    }, { cwd: home });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("Delivered to researcher");
    expect(unreadMessages(join(home, "bots", "researcher", "inbox"))).toHaveLength(1);
  });

  test("send_message rejects unknown target and self-send", async () => {
    const tool = createSendMessageTool({ home, fromBot: "writer" });
    const bad = await dispatch([tool], "send_message", { to: "ghost", subject: "s", body: "b" }, { cwd: home });
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('unknown bot "ghost"');

    const self = await dispatch([tool], "send_message", { to: "writer", subject: "s", body: "b" }, { cwd: home });
    expect(self.ok).toBe(false);
  });

  test("check_inbox returns unread and marks them read", async () => {
    const sender = createSendMessageTool({ home, fromBot: "writer" });
    await dispatch([sender], "send_message", { to: "researcher", subject: "hello", body: "hi there" }, { cwd: home });

    const checker = createCheckInboxTool({
      profile: {
        name: "researcher",
        soulText: "",
        config: {},
        rootDir: join(home, "bots", "researcher"),
        sessionsDir: "",
        memoryDir: "",
        inboxDir: join(home, "bots", "researcher", "inbox"),
      },
    });

    const first = await dispatch([checker], "check_inbox", {}, { cwd: home });
    expect(first.output).toContain("from writer: hello");
    expect(first.output).toContain("hi there");

    const second = await dispatch([checker], "check_inbox", {}, { cwd: home });
    expect(second.output).toBe("inbox empty");
  });
});

test("formatInbox handles empty and long bodies", () => {
  expect(formatInbox([])).toBe("inbox empty");
  const formatted = formatInbox([
    { id: "1", from: "w", to: "r", subject: "s", body: "y".repeat(500), ts: "2026-08-21T10:00:00Z", read: false },
  ]);
  expect(formatted).toContain("[2026-08-21 10:00] from w: s");
  expect(formatted).toContain("…");
});
