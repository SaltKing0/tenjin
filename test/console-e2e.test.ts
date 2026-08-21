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

const REPLY = "CONSOLE_E2E_DONE";

function sse(frames: Array<[string, unknown]>): string {
  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function chatSse(text: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 8 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function toolUseSse(id: string, name: string, inputJson: string): string {
  return sse([
    ["message_start", { type: "message_start", message: { usage: { input_tokens: 8 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: inputJson } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

describe("e2e: web console flow — login, streamed chat, approve write, verify everywhere", () => {
  let home: string;
  let project: string;
  let anthropicServer: ReturnType<typeof Bun.serve>;

  afterEach(() => {
    anthropicServer?.stop(true);
    if (home) rmSync(home, { recursive: true, force: true });
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test("browser-equivalent flow over pure HTTP", async () => {
    home = mkdtempSync(join(tmpdir(), "tj-con-e2e-"));
    project = mkdtempSync(join(tmpdir(), "tj-con-proj-"));
    const port = 40000 + Math.floor(Math.random() * 20000);

    let calls = 0;
    anthropicServer = Bun.serve({
      port: 0,
      fetch: async (req) => {
        await req.json();
        calls++;
        if (calls === 1) {
          return new Response(
            toolUseSse("w1", "write_file", '{"path":"foo.txt","content":"console made this"}'),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(chatSse(REPLY), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

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
        "provider: anthropic",
        "model: mock-model",
        "memory:",
        "  enabled: false",
        "gateway:",
        "  allowWrites: true",
        "  telegram:",
        "    approvalTimeoutMs: 20000",
        "  listen:",
        `    port: ${port}`,
        "    token: console-token",
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
      },
    );

    try {
      const base = `http://127.0.0.1:${port}`;
      const auth = { authorization: "Bearer console-token" };

      // wait for server up + console shell served
      let shellOk = false;
      for (let i = 0; i < 60 && !shellOk; i++) {
        await Bun.sleep(100);
        try {
          const res = await fetch(`${base}/`);
          shellOk = res.ok && (await res.text()).includes("Tenjin Console");
        } catch {
          shellOk = false;
        }
      }
      expect(shellOk).toBe(true);

      // streamed chat that triggers a write — do not await yet
      const chatPromise = fetch(`${base}/api/chat/stream`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "create foo.txt", bot: "researcher" }),
      });

      // approval card data appears (what the Approvals panel polls)
      let pending = null;
      for (let i = 0; i < 80 && !pending; i++) {
        await Bun.sleep(100);
        const res = await fetch(`${base}/api/approvals`, { headers: auth });
        const data = (await res.json()) as any;
        if (data.pending.length > 0) pending = data.pending[0];
      }
      expect(pending?.tool).toBe("write_file");

      // full tool input is on GET /api/approvals/:id, not the truncated list summary
      const detailRes = await fetch(`${base}/api/approvals/${pending.id}`, { headers: auth });
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as { input?: { path?: string; content?: string } };
      expect(detail.input).toEqual({ path: "foo.txt", content: "console made this" });

      // click approve (what the button does)
      const approveRes = await fetch(`${base}/api/approvals/${pending.id}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(approveRes.status).toBe(200);

      // read the stream to completion
      const chatRes = await chatPromise;
      expect(chatRes.status).toBe(200);
      const raw = await chatRes.text();
      const frames = raw
        .split("\n\n")
        .filter(Boolean)
        .map((f) => JSON.parse(f.replace(/^data: /, "")));
      const done = frames.find((f) => f.type === "done");
      expect(done?.reply).toContain(REPLY);

      // file landed in the gateway's project dir
      const fooPath = join(project, "foo.txt");
      let written = false;
      for (let i = 0; i < 50 && !written; i++) {
        await Bun.sleep(100);
        written = existsSync(fooPath);
      }
      expect(written).toBe(true);
      expect(readFileSync(fooPath, "utf8")).toBe("console made this");

      // session visible in the sessions panel API
      const sessionsRes = await fetch(`${base}/api/sessions?bot=researcher`, { headers: auth });
      const sessionsData = (await sessionsRes.json()) as any;
      expect(sessionsData.sessions.length).toBeGreaterThanOrEqual(1);

      // audit trail has the chain
      const auditRes = await fetch(`${base}/api/audit`, { headers: auth });
      const auditData = (await auditRes.json()) as any;
      const kinds = auditData.events.map((e: any) => e.kind);
      expect(kinds).toContain("gateway_msg");
      expect(kinds).toContain("approval");
      expect(kinds).toContain("write_exec");
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 45_000);
});
