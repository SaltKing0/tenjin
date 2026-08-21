import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPLY = "GATEWAY_E2E_REPLY";

function chatSse(text: string): string {
  return [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 8 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

describe("e2e: gateway with telegram channel end to end", () => {
  let home: string;
  let anthropicServer: ReturnType<typeof Bun.serve>;
  let telegramServer: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    anthropicServer?.stop(true);
    telegramServer?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("inbound telegram update → bot turn → outbound sendMessage → scoped session log", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-gwe2e-"));

    // fake anthropic
    anthropicServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(chatSse(REPLY), { headers: { "content-type": "text/event-stream" } }),
    });

    // fake telegram api
    const sentMessages: Array<{ chat_id: number; text: string }> = [];
    let polls = 0;
    telegramServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname.endsWith("/getUpdates")) {
          polls++;
          const result =
            polls === 1
              ? [
                  {
                    update_id: 1,
                    message: {
                      message_id: 1,
                      from: { id: 42, username: "owner" },
                      chat: { id: 142, type: "private" },
                      text: "what does the auth code do?",
                    },
                  },
                ]
              : [];
          return Response.json({ result });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          sentMessages.push((await req.json()) as { chat_id: number; text: string });
          return Response.json({ ok: true });
        }
        return new Response("nf", { status: 404 });
      },
    });

    // environment setup via real CLI subcommands
    const setup = Bun.spawn(["bun", "run", "src/index.ts", "bot", "new", "researcher"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TENJIN_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await setup.exited).toBe(0);

    writeFileSync(
      join(home, "config.yaml"),
      [
        "provider: anthropic",
        "model: mock-model",
        "memory:",
        "  enabled: false",
        "gateway:",
        "  telegram:",
        "    enabled: true",
        "    defaultBot: researcher",
        "    allowedUsers: [42]",
        "    adminChatId: 142",
      ].join("\n") + "\n",
    );

    // launch the gateway
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "gateway"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TENJIN_HOME: home,
        ANTHROPIC_API_KEY: "dummy-key",
        ANTHROPIC_BASE_URL: `http://localhost:${anthropicServer.port}/v1`,
        TELEGRAM_BOT_TOKEN: "TESTTOKEN",
        TELEGRAM_API_BASE: `http://localhost:${telegramServer.port}`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // wait for the round trip
    const deadline = Date.now() + 15_000;
    while (sentMessages.length === 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(sentMessages[0]?.chat_id).toBe(142);
    expect(sentMessages[0]?.text).toContain(REPLY);

    // session logged in the bot's scope
    const sessionsDir = join(home, "bots", "researcher", "sessions");
    expect(existsSync(sessionsDir)).toBe(true);
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const firstFile = files[0];
    if (!firstFile) throw new Error("unreachable");
    const events = readFileSync(join(sessionsDir, firstFile), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events[0].bot).toBe("researcher");
    const userMsgs = events.filter((e) => e.t === "message" && e.role === "user");
    expect(userMsgs.some((m) => m.content === "what does the auth code do?")).toBe(true);

    proc.kill();
    const code = await proc.exited;
    expect(code).toBe(0);
  }, 30_000);
});
