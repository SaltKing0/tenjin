import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TelegramChannel, routeText, type TgUpdate } from "../src/gateway/telegram";

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
