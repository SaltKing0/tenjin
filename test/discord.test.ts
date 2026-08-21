import { describe, test, expect, afterEach } from "bun:test";
import { DiscordChannel } from "../src/gateway/discord";
import { parseGatewaySettings } from "../src/gateway/config";

/*
 * Discord channel adapter (#139) tests.
 *
 * The Discord Gateway is a WebSocket protocol, so we stand up a fake gateway
 * (Bun.serve websocket) plus a fake REST API (Bun.serve http), point the
 * adapter at both, and exercise the acceptances:
 *   - a MESSAGE_CREATE from an allowed channel triggers a reply back through
 *     the REST API (message in -> reply out),
 *   - a message from a non-allowed channel is silent (no REST post),
 *   - after a dropped connection the client reconnects with backoff and still
 *     processes messages,
 *   - a 429 from the REST API is retried after retry_after,
 *   - `send()` targets the admin channel, and the mandatory allowlist and
 *     defaultBot are enforced at config time.
 */

interface RestPost {
  path: string;
  body: { content?: string };
  auth: string | null;
}

const ALLOWED_CHANNEL = "111222333";
const OTHER_CHANNEL = "999000111";
const GUILD = "guild-1";
const TOKEN = "BOT-TOKEN";

/** Poll until `fn` is truthy or `maxWaitMs` elapses. */
async function waitFor(fn: () => boolean, maxWaitMs = 3000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    if (fn()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor: condition not met in time");
}

/** A fake Discord gateway: HELLO on open, READY on IDENTIFY, then onIdentify. */
function fakeGateway(
  onIdentify: (ws: { send: (s: string) => void }, connectionNumber: number) => void,
  opts: { heartbeatIntervalMs?: number; ackHeartbeats?: boolean } = {},
): { port: number; stop: () => void } {
  let n = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("upgrade failed", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: opts.heartbeatIntervalMs ?? 30_000 } }));
      },
      message(ws, raw) {
        let p: { op?: number };
        try {
          p = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (p.op === 1 && opts.ackHeartbeats === true) {
          ws.send(JSON.stringify({ op: 11, d: null }));
          return;
        }
        if (p.op === 2) {
          // IDENTIFY
          n += 1;
          ws.send(JSON.stringify({ op: 0, t: "READY", s: 0, d: { user: { id: "1", username: "bot" } } }));
          onIdentify(ws, n);
        }
      },
      close() {},
    },
  });
  return { port: (server as unknown as { port: number }).port, stop: () => server.stop(true) };
}

function messageCreate(channelId: string, content: string, opts: { guild?: string; bot?: boolean; authorId?: string } = {}) {
  return JSON.stringify({
    op: 0,
    t: "MESSAGE_CREATE",
    s: 1,
    d: {
      channel_id: channelId,
      guild_id: opts.guild ?? GUILD,
      author: {
        id: opts.authorId ?? "u-1",
        username: "bob",
        bot: opts.bot === true,
      },
      content,
    },
  });
}

function makeOptions(restPort: number, gatewayPort: number, over: Partial<ConstructorParameters<typeof DiscordChannel>[0]> = {}) {
  return {
    botToken: TOKEN,
    defaultBot: "alice",
    allowedGuilds: [GUILD],
    allowedChannels: [ALLOWED_CHANNEL],
    adminChannel: "admin-chan",
    apiBase: `http://127.0.0.1:${restPort}`,
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}/?v=10&encoding=json`,
    reconnectBaseMs: 40,
    reconnectMaxMs: 200,
    ...over,
  };
}

async function startRest(
  custom?: (req: Request, count: number) => Response,
): Promise<{ port: number; posts: RestPost[]; stop: () => void }> {
  const posts: RestPost[] = [];
  let counter = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      counter += 1;
      const m = url.pathname.match(/\/channels\/([^/]+)\/messages$/);
      if (req.method === "POST" && m) {
        const body = JSON.parse(await req.text()) as { content?: string };
        posts.push({ path: url.pathname, body, auth: req.headers.get("authorization") });
        if (custom) return custom(req, counter);
        return Response.json({ id: "msg-ok" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: (server as unknown as { port: number }).port,
    posts,
    stop: () => server.stop(true),
  };
}

describe("discord config (parseGatewaySettings)", () => {
  test("enabled requires the allowedChannels allowlist", () => {
    expect(() =>
      parseGatewaySettings({
        discord: { enabled: true, allowedGuilds: [GUILD], allowedChannels: [] },
      }),
    ).toThrow(/allowedChannels allowlist/);
  });

  test("enabled requires a defaultBot", () => {
    expect(() =>
      parseGatewaySettings({
        discord: { enabled: true, allowedChannels: [ALLOWED_CHANNEL] },
      }),
    ).toThrow(/defaultBot/);
  });

  test("valid config parses and is enabled by default in the channels list", () => {
    const s = parseGatewaySettings({
      discord: {
        enabled: true,
        defaultBot: "alice",
        botToken: "secret",
        allowedGuilds: [GUILD],
        allowedChannels: [ALLOWED_CHANNEL],
        adminChannel: "admin-chan",
        allowWrites: true,
      },
    });
    expect(s.discord?.enabled).toBe(true);
    expect(s.discord?.botToken).toBe("secret");
    expect(s.discord?.allowedChannels).toEqual([ALLOWED_CHANNEL]);
    expect(s.discord?.allowWrites).toBe(true);
    expect(s.channels).toContain("discord");
  });

  test("allowlist enforced at the adapter constructor too", () => {
    expect(
      () =>
        new DiscordChannel({
          botToken: TOKEN,
          defaultBot: "alice",
          allowedGuilds: [],
          allowedChannels: [],
        }),
    ).toThrow(/allowedChannels allowlist/);
  });
});

describe("DiscordChannel e2e (fake gateway + REST)", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    stops.splice(0).forEach((s) => s());
  });

  test("message in from an allowed channel -> reply out via REST", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    let gw: { send: (s: string) => void };
    const gateway = fakeGateway((ws) => {
      gw = ws;
      ws.send(messageCreate(ALLOWED_CHANNEL, "hello discord"));
    });
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async (msg) => `echo:${msg.text}`);
    const ac = new AbortController();
    await channel.start(ac.signal);
    await waitFor(() => rest.posts.length > 0);

    expect(rest.posts).toHaveLength(1);
    expect(rest.posts[0]!.path).toBe(`/channels/${ALLOWED_CHANNEL}/messages`);
    expect(rest.posts[0]!.body.content).toBe("echo:hello discord");
    expect(rest.posts[0]!.auth).toBe(`Bot ${TOKEN}`);
    channel.stop();
    ac.abort();
  });

  test("a message from a NON-allowed channel is silent (no REST post)", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    const rejected: string[] = [];
    const gateway = fakeGateway((ws) => {
      ws.send(messageCreate(OTHER_CHANNEL, "should be ignored"));
    });
    stops.push(gateway.stop);

    const channel = new DiscordChannel(
      makeOptions(rest.port, gateway.port, {
        onRejected: (info) => rejected.push(info.reason),
      }),
    );
    channel.onMessage(async (msg) => `reply-to-${msg.text}`);
    const ac = new AbortController();
    await channel.start(ac.signal);
    await waitFor(() => rejected.length > 0);

    expect(rest.posts).toHaveLength(0);
    expect(rejected).toContain("unauthorized");
    channel.stop();
    ac.abort();
  });

  test("reconnects with backoff after a dropped gateway and still answers", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    const gateway = fakeGateway((ws, n) => {
      if (n === 1) {
        // Drop the first connection after a beat so the client is fully up.
        setTimeout(() => (ws as unknown as { close: () => void }).close(), 30);
      } else {
        ws.send(messageCreate(ALLOWED_CHANNEL, "after reconnect"));
      }
    });
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async (msg) => `echo:${msg.text}`);
    const ac = new AbortController();
    await channel.start(ac.signal);
    await waitFor(() => rest.posts.length > 0, 5000);

    expect(rest.posts).toHaveLength(1);
    expect(rest.posts[0]!.body.content).toBe("echo:after reconnect");
    channel.stop();
    ac.abort();
  });

  test("429 from the REST API is retried after retry_after", async () => {
    // First POST -> 429 retry_after 0.01s, second -> 200.
    const rest = await startRest((_req, count) =>
      count === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : Response.json({ id: "msg-ok" }),
    );
    stops.push(rest.stop);
    const gateway = fakeGateway((ws) => {
      ws.send(messageCreate(ALLOWED_CHANNEL, "rate limited message"));
    });
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async (msg) => `echo:${msg.text}`);
    const ac = new AbortController();
    await channel.start(ac.signal);
    // Two posts expected (the 429 attempt + the retry).
    await waitFor(() => rest.posts.length >= 2, 5000);

    expect(rest.posts).toHaveLength(2);
    expect(rest.posts[1]!.body.content).toBe("echo:rate limited message");
    channel.stop();
    ac.abort();
  });

  test("send() posts to the admin channel (job postTo path)", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    const channel = new DiscordChannel(makeOptions(rest.port, 1));
    await channel.send("status: all good");
    expect(rest.posts).toHaveLength(1);
    expect(rest.posts[0]!.path).toBe("/channels/admin-chan/messages");
    expect(rest.posts[0]!.body.content).toBe("status: all good");
  });

  test("a gateway that never heartbeat-acks is terminated and reconnects (#202)", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    let connections = 0;
    const gateway = fakeGateway(
      (_ws, n) => {
        connections = Math.max(connections, n);
      },
      { heartbeatIntervalMs: 30 }, // heartbeats sent every ~30ms, never acked
    );
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async () => "ok");
    const ac = new AbortController();
    await channel.start(ac.signal);
    // The dead connection should be torn down (missing ack) and re-established.
    await waitFor(() => connections >= 2, 5000);
    expect(connections).toBeGreaterThanOrEqual(2);
    channel.stop();
    ac.abort();
  });

  test("a gateway that acks heartbeats keeps the connection alive (no false kill) (#202)", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    let connections = 0;
    const gateway = fakeGateway(
      (_ws, n) => {
        connections = Math.max(connections, n);
      },
      { heartbeatIntervalMs: 30, ackHeartbeats: true },
    );
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async () => "ok");
    const ac = new AbortController();
    await channel.start(ac.signal);
    // Several heartbeat cycles pass; with acks the connection must NOT be killed.
    await new Promise((r) => setTimeout(r, 500));
    expect(connections).toBe(1);
    channel.stop();
    ac.abort();
  });

  test("reconnect backoff resets after each live session so reconnects stay fast (#202)", async () => {
    const rest = await startRest();
    stops.push(rest.stop);
    let connections = 0;
    const gateway = fakeGateway(
      (ws, n) => {
        connections = Math.max(connections, n);
        // Drop each connection right after it establishes.
        setTimeout(() => (ws as unknown as { close: () => void }).close(), 5);
      },
      { heartbeatIntervalMs: 1000 }, // long interval — ack watchdog not in play
    );
    stops.push(gateway.stop);

    const channel = new DiscordChannel(makeOptions(rest.port, gateway.port));
    channel.onMessage(async () => "ok");
    const ac = new AbortController();
    await channel.start(ac.signal);
    // With the backoff reset on HELLO each reconnect uses the base 40ms delay,
    // so several reconnects happen here. If the backoff stuck at a growing
    // delay the count would be far lower.
    await new Promise((r) => setTimeout(r, 1200));
    expect(connections).toBeGreaterThanOrEqual(6);
    channel.stop();
    ac.abort();
  });
});
