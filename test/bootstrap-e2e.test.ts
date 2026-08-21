import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("e2e: zero-key bootstrap via console settings", () => {
  let home: string;
  let project: string;
  let openaiServer: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    openaiServer?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
    if (project) rmSync(project, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("boot with nothing → detect → save → chat streams → persists across restart", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-boot-"));
    project = mkdtempSync(join(tmpdir(), "tj-boot-proj-"));
    const gwPort = 45000 + Math.floor(Math.random() * 10000);

    // mock OpenAI-compatible provider: /models for detection, /chat/completions for chat
    let chatCalls = 0;
    let seenAuth = "";
    openaiServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seenAuth = req.headers.get("authorization") ?? "";
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "mock-large" }, { id: "mock-small" }],
          });
        }
        if (url.pathname === "/v1/chat/completions") {
          chatCalls++;
          await req.json();
          const stream = new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "configured " } }] })}\n\n`,
                ),
              );
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "and working" } }] })}\n\n`,
                ),
              );
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
                ),
              );
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("nf", { status: 404 });
      },
    });

    // scaffold one bot; config has NO model and NO keys anywhere
    const setup = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "bot", "new", "researcher"],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, TENJIN_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await setup.exited).toBe(0);
    writeFileSync(
      join(home, "config.yaml"),
      [
        "memory:",
        "  enabled: false",
        "gateway:",
        "  listen:",
        `    port: ${gwPort}`,
        "    token: boot-token",
      ].join("\n") + "\n",
    );

    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "gateway"],
      {
        cwd: project,
        env: {
          ...process.env,
          TENJIN_HOME: home,
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    try {
      const base = `http://127.0.0.1:${gwPort}`;
      const auth = { authorization: "Bearer boot-token" };

      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await Bun.sleep(100);
        try {
          up = (await fetch(`${base}/status`, { headers: auth })).ok;
        } catch {
          up = false;
        }
      }
      expect(up).toBe(true);

      // 1. detect models against the custom provider
      const detectRes = await fetch(`${base}/api/settings/detect`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          provider: "openai",
          baseUrl: `http://localhost:${openaiServer.port}/v1`,
          apiKey: "sk-bootstrap",
        }),
      });
      const detectData = (await detectRes.json()) as any;
      expect(detectData.models).toEqual(["mock-large", "mock-small"]);

      // 2. save settings — applied live
      const saveRes = await fetch(`${base}/api/settings`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          openai: {
            apiKey: "sk-bootstrap",
            baseUrl: `http://localhost:${openaiServer.port}/v1`,
          },
          models: { default: "openai:mock-large" },
        }),
      });
      expect(saveRes.status).toBe(200);

      // 3. chat streams through the just-configured provider — no restart
      const chatRes = await fetch(`${base}/api/chat/stream`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello", bot: "researcher" }),
      });
      expect(chatRes.status).toBe(200);
      const raw = await chatRes.text();
      const frames = raw
        .split("\n\n")
        .filter(Boolean)
        .map((f) => JSON.parse(f.replace(/^data: /, "")));
      const deltas = frames
        .filter((f) => f.type === "delta")
        .map((f) => f.text)
        .join("");
      expect(deltas).toBe("configured and working");
      expect(frames.some((f) => f.type === "done")).toBe(true);
      expect(seenAuth).toBe("Bearer sk-bootstrap");

      // 4. persisted to providers.yaml
      expect(existsSync(join(home, "providers.yaml"))).toBe(true);
      const persisted = readFileSync(join(home, "providers.yaml"), "utf8");
      expect(persisted).toContain("sk-bootstrap");
      expect(persisted).toContain("mock-large");
    } finally {
      proc.kill();
      await proc.exited;
    }

    // 5. restart → still configured, chat works again
    const proc2 = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "gateway"],
      {
        cwd: project,
        env: {
          ...process.env,
          TENJIN_HOME: home,
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const base = `http://127.0.0.1:${gwPort}`;
      const auth = { authorization: "Bearer boot-token" };
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        await Bun.sleep(100);
        try {
          up = (await fetch(`${base}/status`, { headers: auth })).ok;
        } catch {
          up = false;
        }
      }
      expect(up).toBe(true);

      const chatRes = await fetch(`${base}/api/chat/stream`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "still there?", bot: "researcher" }),
      });
      const raw = await chatRes.text();
      expect(raw).toContain("configured and working");
    } finally {
      proc2.kill();
      await proc2.exited;
    }
  }, 60_000);
});
