import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  TelegramChannel,
  routeText,
  botsAllowedForUser,
  routeBoundText,
  type TgUpdate,
  type TelegramRejection,
} from "../src/gateway/telegram";

function update(id: number, userId: number, text: string): TgUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: { id: userId, username: `user${userId}` },
      chat: { id: 100 + userId, type: "private" },
      text,
    },
  };
}

describe("routeText", () => {
  const bots = ["researcher", "writer"];
  test("plain text goes to default bot", () => {
    expect(routeText("hello there", "researcher", bots)).toEqual({
      bot: "researcher",
      rest: "hello there",
    });
  });

  test("@mention reroutes to named bot", () => {
    expect(routeText("@writer draft a post", "researcher", bots)).toEqual({
      bot: "writer",
      rest: "draft a post",
    });
  });

  test("unknown mention falls back to default with text intact", () => {
    const r = routeText("@ghost hi", "researcher", bots);
    expect(r.bot).toBe("researcher");
    expect(r.rest).toBe("@ghost hi");
  });
});

describe("per-bot telegram allowlists (#59)", () => {
  const bots = ["researcher", "writer"];
  const allowlists: Record<string, number[] | undefined> = {
    researcher: [42],
    writer: [99],
  };

  test("botsAllowedForUser only returns bots that list the sender", () => {
    expect(botsAllowedForUser(42, bots, allowlists)).toEqual(["researcher"]);
    expect(botsAllowedForUser(99, bots, allowlists)).toEqual(["writer"]);
    expect(botsAllowedForUser(7, bots, allowlists)).toEqual([]);
  });

  test("unlisted bots stay reachable by any globally allowed sender", () => {
    expect(botsAllowedForUser(42, bots, { writer: [99] })).toEqual(["researcher"]);
  });

  test("an empty allowlist means nobody (distinct from unset)", () => {
    expect(botsAllowedForUser(42, bots, { researcher: [], writer: [99] })).toEqual([]);
  });

  test("plain text lands on the bound bot even when defaultBot is a different one", () => {
    const r = routeBoundText("hello", "writer", bots, ["researcher"]);
    expect(r).toEqual({ ok: true, bot: "researcher", rest: "hello" });
  });

  test("@mention of an unbound bot is rejected, not silently rerouted", () => {
    const r = routeBoundText("@writer draft", "researcher", bots, ["researcher"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/writer/);
  });

  test("sender bound to no bot is rejected", () => {
    const r = routeBoundText("hello", "researcher", bots, []);
    expect(r.ok).toBe(false);
  });
});

describe("TelegramChannel", () => {
  let apiBase: string;
  let sentMessages: Array<{ chat_id: number; text: string }>;
  let getUpdatesCalls: string[];
  let scriptedUpdates: TgUpdate[];
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    sentMessages = [];
    getUpdatesCalls = [];
    scriptedUpdates = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/getUpdates")) {
          getUpdatesCalls.push(url.searchParams.get("offset") ?? "(none)");
          const out = scriptedUpdates;
          scriptedUpdates = [];
          return Response.json({ result: out });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          const body = (await req.json()) as { chat_id: number; text: string };
          sentMessages.push(body);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    apiBase = `http://localhost:${server.port}`;
  });

  afterEach(() => server.stop(true));

  const makeChannel = (
    onMessage: (msg: { chatId: number; userId: number; text: string }) => Promise<string | null>,
    allowedUsers = [42],
  ) =>
    new TelegramChannel(
      { token: "T0KEN", apiBase, defaultBot: "researcher", allowedUsers, pollTimeoutSec: 0 },
      onMessage,
      () => {},
    );

  test("allowlisted message reaches handler and reply is sent", async () => {
    scriptedUpdates = [update(1, 42, "investigate the bug")];
    const channel = makeChannel(async (msg) => {
      expect(msg.text).toBe("investigate the bug");
      expect(msg.userId).toBe(42);
      return "here is the analysis";
    });

    const handled = await channel.pollOnce();
    expect(handled).toBe(1);
    expect(sentMessages).toEqual([{ chat_id: 142, text: "here is the analysis" }]);
  });

  test("unauthorized users are ignored silently", async () => {
    scriptedUpdates = [update(2, 999, "spend their tokens")];
    let called = false;
    const channel = makeChannel(async () => {
      called = true;
      return "nope";
    });
    expect(await channel.pollOnce()).toBe(0);
    expect(called).toBe(false);
    expect(sentMessages).toEqual([]);
  });

  test("offset advances past processed updates", async () => {
    scriptedUpdates = [update(7, 42, "one"), update(8, 42, "two")];
    const channel = makeChannel(async () => "ok");
    await channel.pollOnce();
    await channel.pollOnce();
    expect(getUpdatesCalls[0]).toBe("0");
    expect(Number(getUpdatesCalls[1])).toBeGreaterThanOrEqual(9);
  });

  test("handler error still notifies the user", async () => {
    scriptedUpdates = [update(3, 42, "boom")];
    const channel = makeChannel(async () => {
      throw new Error("model exploded");
    });
    await channel.pollOnce();
    expect(sentMessages[0]?.text).toContain("error:");
  });

  test("null reply sends nothing", async () => {
    scriptedUpdates = [update(4, 42, "quiet please")];
    const channel = makeChannel(async () => null);
    await channel.pollOnce();
    expect(sentMessages).toEqual([]);
  });
});

describe("TelegramChannel hardening (#69)", () => {
  let apiBase: string;
  let sentMessages: Array<{ chat_id: number; text: string }>;
  let scriptedUpdates: TgUpdate[];
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    sentMessages = [];
    scriptedUpdates = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/getUpdates")) {
          const out = scriptedUpdates;
          scriptedUpdates = [];
          return Response.json({ result: out });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          const body = (await req.json()) as { chat_id: number; text: string };
          sentMessages.push(body);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    apiBase = `http://localhost:${server.port}`;
  });

  afterEach(() => server.stop(true));

  const makeChannel = (
    onMessage: (msg: { chatId: number; userId: number; text: string }) => Promise<string | null>,
    opts: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {},
    rejected: TelegramRejection[] = [],
  ) =>
    new TelegramChannel(
      {
        token: "T0KEN",
        apiBase,
        defaultBot: "researcher",
        allowedUsers: [42],
        pollTimeoutSec: 0,
        onRejected: (r) => rejected.push(r),
        ...opts,
      },
      onMessage,
      () => {},
    );

  test("rate limit rejects once a chat exceeds the window, no provider call", async () => {
    scriptedUpdates = [
      update(1, 42, "m1"),
      update(2, 42, "m2"),
      update(3, 42, "m3"),
      update(4, 42, "m4"),
    ];
    const handled: string[] = [];
    const rejected: TelegramRejection[] = [];
    const channel = makeChannel(
      async (msg) => {
        handled.push(msg.text);
        return null;
      },
      { rateLimitMax: 3, rateLimitWindowMs: 60_000 },
      rejected,
    );

    const n = await channel.pollOnce();
    expect(n).toBe(3);
    expect(handled).toEqual(["m1", "m2", "m3"]);
    expect(rejected).toEqual([{ userId: 42, chatId: 142, reason: "rate_limited" }]);
    expect(sentMessages.at(-1)?.text).toMatch(/too (many|quickly)|slow down|limit/i);
  });

  test("rate limit is per chat id and does not block other chats", async () => {
    scriptedUpdates = [
      update(1, 42, "a1"),
      update(2, 42, "a2"),
      update(3, 42, "a3"),
      update(4, 42, "a4"),
      update(5, 43, "b1"),
    ];
    const handled: string[] = [];
    const rejected: TelegramRejection[] = [];
    const channel = makeChannel(
      async (msg) => {
        handled.push(msg.text);
        return null;
      },
      { rateLimitMax: 3, rateLimitWindowMs: 60_000, allowedUsers: [42, 43] },
      rejected,
    );
    await channel.pollOnce();
    // chat 142 (user 42) exceeded its limit; chat 143 (user 43) is a fresh window
    expect(handled).toEqual(["a1", "a2", "a3", "b1"]);
    expect(rejected).toEqual([{ userId: 42, chatId: 142, reason: "rate_limited" }]);
  });

  test("messages over maxMessageLength are rejected politely and audited", async () => {
    scriptedUpdates = [update(1, 42, "x".repeat(20))];
    let called = false;
    const rejected: TelegramRejection[] = [];
    const channel = makeChannel(
      async () => {
        called = true;
        return null;
      },
      { maxMessageLength: 10 },
      rejected,
    );

    const n = await channel.pollOnce();
    expect(n).toBe(0);
    expect(called).toBe(false);
    expect(rejected).toEqual([{ userId: 42, chatId: 142, reason: "too_long" }]);
    expect(sentMessages.at(-1)?.text).toMatch(/too long|length/i);
  });

  test("a long message within the limit is handled normally", async () => {
    scriptedUpdates = [update(1, 42, "y".repeat(2000))];
    let got = "";
    const channel = makeChannel(async (msg) => {
      got = msg.text;
      return null;
    });
    const n = await channel.pollOnce();
    expect(n).toBe(1);
    expect(got).toHaveLength(2000);
  });

  test("unauthorized users are audited via onRejected and stay silent", async () => {
    scriptedUpdates = [update(1, 999, "spend their tokens")];
    const rejected: TelegramRejection[] = [];
    const channel = makeChannel(
      async () => {
        throw new Error("must not be called");
      },
      {},
      rejected,
    );
    const n = await channel.pollOnce();
    expect(n).toBe(0);
    expect(rejected).toEqual([{ userId: 999, chatId: 1099, reason: "unauthorized" }]);
    expect(sentMessages).toEqual([]);
  });
});

describe("TelegramChannel implements Channel (#97)", () => {
  let apiBase: string;
  let sentMessages: Array<{ chat_id: number; text: string }>;
  let scriptedUpdates: TgUpdate[];
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    sentMessages = [];
    scriptedUpdates = [];
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/getUpdates")) {
          const out = scriptedUpdates;
          scriptedUpdates = [];
          return Response.json({ result: out });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          const body = (await req.json()) as { chat_id: number; text: string };
          sentMessages.push(body);
          return Response.json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    apiBase = `http://localhost:${server.port}`;
  });

  afterEach(() => server.stop(true));

  const makeChannel = (opts: Partial<ConstructorParameters<typeof TelegramChannel>[0]> = {}) =>
    new TelegramChannel(
      {
        token: "T0KEN",
        apiBase,
        defaultBot: "researcher",
        allowedUsers: [42],
        pollTimeoutSec: 0,
        ...opts,
      },
      async () => null,
    );

  test("onMessage setter wires the handler after construction", async () => {
    const channel = makeChannel();
    let got = "";
    channel.onMessage(async (msg) => {
      got = msg.text;
      return "ok";
    });
    scriptedUpdates = [update(1, 42, "hello channel")];
    await channel.pollOnce();
    expect(got).toBe("hello channel");
  });

  test("send(text) posts to adminChatId", async () => {
    const channel = makeChannel({ adminChatId: 999 });
    await channel.send("broadcast");
    expect(sentMessages).toEqual([{ chat_id: 999, text: "broadcast" }]);
  });

  test("send(text) without adminChatId is a config error", async () => {
    const channel = makeChannel();
    await expect(channel.send("nope")).rejects.toThrow(/adminChatId/);
  });

  test("start with an already-aborted signal resolves immediately", async () => {
    const channel = makeChannel();
    const ac = new AbortController();
    ac.abort();
    await channel.start(ac.signal);
  });
});
