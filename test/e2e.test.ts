import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
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
    const modelsSeen: string[] = [];
    const systemsSeen: string[] = [];
    const skillDir = join(home, "skills", "release-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: release-helper",
        "description: Release helper index marker",
        "---",
        "FULL_SKILL_BODY_MUST_STAY_OUT_OF_LEVEL_ONE",
        "",
      ].join("\n"),
    );

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/messages" && req.method === "POST") {
          const body = (await req.json()) as any;
          modelsSeen.push(body.model);
          systemsSeen.push(
            Array.isArray(body.system)
              ? body.system.map((block: any) => String(block?.text ?? "")).join("\n")
              : String(body.system ?? ""),
          );
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

    expect(modelsSeen).toContain("mock-model");
    expect(systemsSeen[0]).toContain("# Tools");
    expect(systemsSeen[0]).toContain("- read_file:");
    expect(systemsSeen[0]).toContain("# Skills");
    expect(systemsSeen[0]).toContain("- release-helper: Release helper index marker");
    expect(systemsSeen[0]).not.toContain("FULL_SKILL_BODY_MUST_STAY_OUT_OF_LEVEL_ONE");

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

  test("tier routing: summarizer uses cheap model, chat uses default", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-e2e-tier-"));
    const modelsSeen: string[] = [];

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/messages" && req.method === "POST") {
          const body = (await req.json()) as any;
          modelsSeen.push(body.model);
          return new Response(chatResponse("summary or reply"), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    mkdirSync(join(home, "sessions"), { recursive: true });
    const priorId = "20260101-0000-prior";
    writeFileSync(
      join(home, "sessions", `${priorId}.jsonl`),
      [
        JSON.stringify({ t: "session_start", id: priorId, ts: "t", provider: "anthropic", model: "mock-model" }),
        JSON.stringify({ t: "message", role: "user", content: "worked on the auth refactor", ts: "t" }),
        JSON.stringify({ t: "message", role: "assistant", content: [{ type: "text", text: "done" }], ts: "t" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(home, "config.yaml"),
      "provider: anthropic\nmodel: mock-model\nmemory:\n  enabled: true\n  vector:\n    enabled: false\nmodels:\n  cheap: anthropic:mock-cheap\n",
    );

    const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
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

    proc.stdin.write("/exit\n");
    await proc.stdin.flush();
    proc.stdin.end();

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("tier e2e timed out")), 20_000);
      proc.exited.then((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    expect(modelsSeen).toContain("mock-cheap");
    expect(modelsSeen).not.toContain("mock-model");

    const summariesDir = join(home, "memory", "summaries");
    expect(existsSync(summariesDir)).toBe(true);
    expect(readdirSync(summariesDir).some((f) => f.startsWith(priorId))).toBe(true);
  }, 25_000);
});
