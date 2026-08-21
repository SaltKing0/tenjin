import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INBOX_MAX_MESSAGES,
  DEFAULT_INBOX_TTL_MS,
  formatInbox,
  inboxFile,
  inboxPolicyFromConfig,
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

  test("send_message and check_inbox honor an explicit inbox policy", async () => {
    const policy = { ttlMs: 30 * 24 * 3600 * 1000, maxMessages: 2 };
    const sender = createSendMessageTool({ home, fromBot: "writer", policy });
    await dispatch(
      [sender],
      "send_message",
      { to: "researcher", subject: "one", body: "a" },
      { cwd: home },
    );
    await dispatch(
      [sender],
      "send_message",
      { to: "researcher", subject: "two", body: "b" },
      { cwd: home },
    );
    await dispatch(
      [sender],
      "send_message",
      { to: "researcher", subject: "three", body: "c" },
      { cwd: home },
    );

    const inboxDir = join(home, "bots", "researcher", "inbox");
    expect(listMessages(inboxDir, { maxMessages: 0 }).map((m) => m.subject)).toEqual(["two", "three"]);

    const checker = createCheckInboxTool({
      profile: {
        name: "researcher",
        soulText: "",
        config: {},
        rootDir: join(home, "bots", "researcher"),
        sessionsDir: "",
        memoryDir: "",
        inboxDir,
      },
      policy,
    });
    const r = await dispatch([checker], "check_inbox", {}, { cwd: home });
    expect(r.output).toContain("from writer: two");
    expect(r.output).not.toContain("from writer: one");
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

describe("inbox hygiene", () => {
  function backdate(dir: string, id: string, days: number): void {
    const path = inboxFile(dir, id);
    const msg = JSON.parse(readFileSync(path, "utf8")) as { ts: string };
    msg.ts = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(msg, null, 2));
  }

  test("defaults: 30-day TTL and 500-message cap", () => {
    expect(DEFAULT_INBOX_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(DEFAULT_INBOX_MAX_MESSAGES).toBe(500);
  });

  test("inboxPolicyFromConfig maps ttlDays to ttlMs", () => {
    expect(inboxPolicyFromConfig(undefined)).toBeUndefined();
    expect(inboxPolicyFromConfig({ ttlDays: 2, maxMessages: 9 })).toEqual({
      ttlMs: 2 * 86_400_000,
      maxMessages: 9,
    });
    expect(inboxPolicyFromConfig({ ttlDays: 0 })).toEqual({ ttlMs: 0 });
  });

  test("expired messages are purged on read (TTL)", () => {
    const dir = join(home, "inbox");
    sendMessage(dir, { from: "a", to: "b", subject: "fresh", body: "new" });
    const stale = sendMessage(dir, { from: "a", to: "b", subject: "stale", body: "old" });
    backdate(dir, stale.id, 40);

    const all = listMessages(dir, { ttlMs: 30 * 24 * 3600 * 1000 });
    expect(all.map((m) => m.subject)).toEqual(["fresh"]);
  });

  test("sendMessage purges expired messages (TTL on write)", () => {
    const dir = join(home, "inbox");
    const stale = sendMessage(dir, { from: "a", to: "b", subject: "stale", body: "old" });
    backdate(dir, stale.id, 40);

    sendMessage(dir, { from: "a", to: "b", subject: "fresh", body: "new" }, { ttlMs: 30 * 24 * 3600 * 1000 });
    expect(listMessages(dir).map((m) => m.subject)).toEqual(["fresh"]);
  });

  test("default TTL applies without an explicit policy", () => {
    const dir = join(home, "inbox");
    const stale = sendMessage(dir, { from: "a", to: "b", subject: "stale", body: "old" });
    backdate(dir, stale.id, 40);

    expect(listMessages(dir).map((m) => m.subject)).toEqual([]);
  });

  test("maxMessages drops oldest read messages before unread ones", () => {
    const dir = join(home, "inbox");
    const r1 = sendMessage(dir, { from: "a", to: "b", subject: "r1", body: "x" });
    const r2 = sendMessage(dir, { from: "a", to: "b", subject: "r2", body: "x" });
    sendMessage(dir, { from: "a", to: "b", subject: "u1", body: "x" });
    sendMessage(dir, { from: "a", to: "b", subject: "u2", body: "x" });
    markRead(dir, [r1.id, r2.id]);

    sendMessage(dir, { from: "a", to: "b", subject: "u3", body: "x" }, { maxMessages: 2 });
    expect(listMessages(dir).map((m) => m.subject)).toEqual(["u2", "u3"]);
  });

  test("maxMessages with only unread messages drops the oldest", () => {
    const dir = join(home, "inbox");
    sendMessage(dir, { from: "a", to: "b", subject: "s1", body: "x" });
    sendMessage(dir, { from: "a", to: "b", subject: "s2", body: "x" });
    sendMessage(dir, { from: "a", to: "b", subject: "s3", body: "x" });

    sendMessage(dir, { from: "a", to: "b", subject: "s4", body: "x" }, { maxMessages: 2 });
    expect(listMessages(dir).map((m) => m.subject)).toEqual(["s3", "s4"]);
  });

  test("listMessages enforces maxMessages on read", () => {
    const dir = join(home, "inbox");
    sendMessage(dir, { from: "a", to: "b", subject: "s1", body: "x" }, { maxMessages: 0 });
    sendMessage(dir, { from: "a", to: "b", subject: "s2", body: "x" }, { maxMessages: 0 });
    sendMessage(dir, { from: "a", to: "b", subject: "s3", body: "x" }, { maxMessages: 0 });
    sendMessage(dir, { from: "a", to: "b", subject: "s4", body: "x" }, { maxMessages: 0 });

    expect(listMessages(dir, { maxMessages: 2 }).map((m) => m.subject)).toEqual(["s3", "s4"]);
    expect(listMessages(dir, { maxMessages: 2 }).map((m) => m.subject)).toEqual(["s3", "s4"]);
  });

  test("ttlMs 0 disables expiry; maxMessages 0 disables the cap", () => {
    const dir = join(home, "inbox");
    const stale = sendMessage(dir, { from: "a", to: "b", subject: "stale", body: "old" }, { ttlMs: 0 });
    backdate(dir, stale.id, 40);
    sendMessage(dir, { from: "a", to: "b", subject: "fresh", body: "new" }, { ttlMs: 0, maxMessages: 0 });

    const kept = listMessages(dir, { ttlMs: 0, maxMessages: 0 });
    expect(kept.map((m) => m.subject)).toEqual(["stale", "fresh"]);
  });

  test("parallel markRead loses no messages and leaves valid files", async () => {
    const dir = join(home, "inbox");
    const msgs = Array.from({ length: 20 }, (_, i) =>
      sendMessage(dir, { from: "a", to: "b", subject: `s${i}`, body: `b${i}` }),
    );
    const ids = msgs.map((m) => m.id);
    const src = join(import.meta.dir, "../src/bots/inbox.ts");

    const run = async (subset: string[]) => {
      const script = `import { markRead } from ${JSON.stringify(src)};\nmarkRead(${JSON.stringify(dir)}, ${JSON.stringify(subset)});`;
      const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`child markRead exited ${code}: ${err}`);
      }
    };

    await Promise.all([
      run(ids.slice(0, 15)),
      run(ids.slice(10)),
      run(ids),
      run(ids.slice(5, 20)),
    ]);

    const all = listMessages(dir);
    expect(all).toHaveLength(20);
    expect(all.every((m) => m.read)).toBe(true);
    for (const m of all) {
      expect(() => JSON.parse(readFileSync(inboxFile(dir, m.id), "utf8"))).not.toThrow();
    }
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toHaveLength(20);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("orphan tmp files are removed during cleanup", () => {
    const dir = join(home, "inbox");
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, "deadbeef.tmp-12345678");
    writeFileSync(tmp, "{}");
    const stale = Date.now() / 1000 - 120;
    utimesSync(tmp, stale, stale);

    expect(listMessages(dir)).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});
