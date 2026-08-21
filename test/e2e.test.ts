import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPLY_TEXT = "E2E_REPLY_MARKER done";

function sse(frames: Array<[string, unknown]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function chatResponse(text: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

describe("e2e: CLI against fake anthropic server", () => {
  let home: string;
  let server: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    server?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("full REPL session: banner, streamed reply, usage line, session log written", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-e2e-"));
    let chatCalls = 0;

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/messages" && req.method === "POST") {
          chatCalls++;
          const body = (await req.json()) as any;
          expect(body.model).toBe("mock-model");
          expect(body.stream).toBe(true);
          return new Response(chatResponse(REPLY_TEXT), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--model", "mock-model"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TENJIN_HOME: home,
        ANTHROPIC_API_KEY: "dummy-key",
        ANTHROPIC_BASE_URL: `http://localhost:${server.port}/v1`,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const feed = async (input: string, ms: number) => {
      proc.stdin.write(input);
      await proc.stdin.flush();
      await Bun.sleep(ms);
    };
    await feed("say hello\n", 500);
    await feed("/memory\n", 300);
    proc.stdin.write("/exit\n");
    await proc.stdin.flush();
    proc.stdin.end();

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("e2e timed out")), 20_000);
      proc.exited.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Tenjin v");
    expect(stdout).toContain("anthropic:mock-model");
    expect(stdout).toContain(REPLY_TEXT);
    expect(stdout).toContain("in 12 out 7");
    expect(stdout).toContain("memory on");

    expect(chatCalls).toBeGreaterThanOrEqual(1);

    const sessionsDir = join(home, "sessions");
    expect(existsSync(sessionsDir)).toBe(true);
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const firstFile = files[0];
    if (!firstFile) throw new Error("unreachable");

    const events = readFileSync(join(sessionsDir, firstFile), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events[0].t).toBe("session_start");
    const userMsgs = events.filter((e) => e.t === "message" && e.role === "user");
    expect(userMsgs.some((m) => m.content === "say hello")).toBe(true);
    const assistantMsgs = events.filter((e) => e.t === "message" && e.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.t === "usage" && e.inputTokens === 12)).toBe(true);
  }, 25_000);
});
