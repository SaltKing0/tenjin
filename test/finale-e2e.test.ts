import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPLY = "FINALE: wrote the file";

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

function toolUseSse(id: string, name: string, inputJson: string): string {
  return [
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 8 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

describe("e2e finale: http message → guarded write → remote approval → audited execution", () => {
  let home: string;
  let project: string;
  let anthropicServer: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    anthropicServer?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("full chain over the HTTP api with allowWrites", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-fin-home-"));
    project = mkdtempSync(join(tmpdir(), "tj-fin-proj-"));
    const port = 20000 + Math.floor(Math.random() * 20000);

    let calls = 0;
    anthropicServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as any;
        void body;
        calls++;
        if (calls === 1) {
          return new Response(
            toolUseSse("w1", "write_file", '{"path":"foo.txt","content":"hello from tenjin"}'),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(chatSse(REPLY), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    // scaffold bot + config via real CLI
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
        "  allowWrites: true",
        "  listen:",
        `    port: ${port}`,
        "    token: fin-token",
        "  telegram:",
        "    approvalTimeoutMs: 15000",
      ].join("\n") + "\n",
    );

    const proc = Bun.spawn(
      ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), "gateway"],
      {
        cwd: project,
      env: {
        ...process.env,
        TENJIN_HOME: home,
        ANTHROPIC_API_KEY: "dummy-key",
        ANTHROPIC_BASE_URL: `http://localhost:${anthropicServer.port}/v1`,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // wait for http to come up
      let up = false;
      for (let i = 0; i < 50 && !up; i++) {
        await Bun.sleep(100);
        up = existsSync(join(home, ".doctor-probe")) || true;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/status`, {
            headers: { authorization: "Bearer fin-token" },
          });
          if (res.ok) up = true;
        } catch {
          up = false;
        }
      }
      expect(up).toBe(true);

      // send the write request — do NOT await: handler blocks pending approval
      const firstPromise = fetch(`http://127.0.0.1:${port}/message`, {
        method: "POST",
        headers: { authorization: "Bearer fin-token", "content-type": "application/json" },
        body: JSON.stringify({ text: "create foo.txt please" }),
      });

      // while blocked, an approval request file should appear
      const approvalsDir = join(home, "approvals");
      let reqFile: string | null = null;
      for (let i = 0; i < 60 && !reqFile; i++) {
        await Bun.sleep(100);
        if (existsSync(approvalsDir)) {
          const files = readdirSync(approvalsDir).filter((f) => f.endsWith(".json"));
          if (files.length > 0 && files[0]) reqFile = files[0];
        }
      }
      expect(reqFile).not.toBeNull();

      // approve it (simulating telegram /approve — same store)
      const reqPath = join(approvalsDir, reqFile as string);
      const req = JSON.parse(readFileSync(reqPath, "utf8"));
      expect(req.tool).toBe("write_file");
      expect(req.bot).toBe("researcher");
      req.status = "approved";
      writeFileSync(reqPath, JSON.stringify(req, null, 2));

      // wait for the run to finish and the file to land
      const fooPath = join(project, "foo.txt");
      let written = false;
      for (let i = 0; i < 80 && !written; i++) {
        await Bun.sleep(100);
        written = existsSync(fooPath);
      }
      expect(written).toBe(true);
      expect(readFileSync(fooPath, "utf8")).toBe("hello from tenjin");

      const first = await firstPromise;
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { reply?: string };
      expect(firstBody.reply).toContain(REPLY);

      // audit trail contains the whole chain
      const audit = readFileSync(join(home, "audit.jsonl"), "utf8");
      expect(audit).toContain("gateway_msg");
      expect(audit).toContain('"approval"');
      expect(audit).toContain("write_exec");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 40_000);
});
