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

const REPLY = "BOT_E2E_REPLY";

function sse(frames: Array<[string, unknown]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function chatResponse(text: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 9 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function spawnCli(home: string, args: string[], port: number | undefined) {
  return Bun.spawn(["bun", "run", "src/index.ts", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      TENJIN_HOME: home,
      ANTHROPIC_API_KEY: "dummy-key",
      ANTHROPIC_BASE_URL: `http://localhost:${port}/v1`,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitExit(proc: Bun.Subprocess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bot e2e timed out")), 20_000);
    proc.exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe("e2e: bot mode", () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    server?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("init-examples → inbox delivery → bot session sees identity, notice, scoped session dir", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-bote2e-"));
    server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(chatResponse(REPLY), {
          headers: { "content-type": "text/event-stream" },
        }),
    });

    // 1. scaffold example bots via the real CLI
    const setup = spawnCli(home, ["bot", "init-examples"], server.port);
    expect(await waitExit(setup)).toBe(0);
    expect(existsSync(join(home, "bots", "researcher", "SOUL.md"))).toBe(true);

    writeFileSync(
      join(home, "config.yaml"),
      "provider: anthropic\nmodel: mock-model\nmemory:\n  enabled: false\n",
    );

    // 2. simulate writer leaving a message in researcher's inbox
    const inboxDir = join(home, "bots", "researcher", "inbox");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, "msg-1.json"),
      JSON.stringify({
        id: "msg-1",
        from: "writer",
        to: "researcher",
        subject: "draft request",
        body: "Please summarize the auth refactor.",
        ts: "2026-08-21T10:00:00Z",
        read: false,
      }),
    );

    // 3. run as researcher
    const proc = spawnCli(home, ["--bot", "researcher"], server.port);
    proc.stdin.write("/whoami\n");
    await proc.stdin.flush();
    await Bun.sleep(400);
    proc.stdin.write("/bots\n");
    await proc.stdin.flush();
    await Bun.sleep(300);
    proc.stdin.write("/exit\n");
    await proc.stdin.flush();
    proc.stdin.end();

    expect(await waitExit(proc)).toBe(0);
    const stdout = await new Response(proc.stdout).text();

    expect(stdout).toContain("researcher (bot)");
    expect(stdout).toContain("inbox: 1 unread from writer");
    expect(stdout).toContain("researcher · anthropic:mock-model");
    expect(stdout).toContain("writer");
    expect(stdout).toContain("<- you");

    // 4. session landed in the BOT's scope, not global
    const botSessions = join(home, "bots", "researcher", "sessions");
    expect(existsSync(botSessions)).toBe(true);
    const files = readdirSync(botSessions).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const firstSession = files[0];
    if (!firstSession) throw new Error("unreachable");
    const events = readFileSync(join(botSessions, firstSession), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events[0].t).toBe("session_start");
    expect(events[0].bot).toBe("researcher");

    // 5. global sessions dir untouched
    const globalSessions = join(home, "sessions");
    expect(!existsSync(globalSessions) || readdirSync(globalSessions).length === 0).toBe(true);
  }, 30_000);
});
