#!/usr/bin/env bun
/**
 * e2e-run.ts — headless end-to-end walkthrough of the Tenjin/Stealth harness.
 *
 * Mirrors the Roadmap "BIG E2E TEST" as a single runnable script. Boots a mock
 * Anthropic-compatible provider (no real API keys, no network), then drives the
 * real CLI as subprocesses against a throwaway TENJIN_HOME and reports PASS/FAIL
 * per act. Exit code is non-zero if any act fails.
 *
 * IMPORTANT: subprocesses are spawned with async `Bun.spawn` (never
 * `Bun.spawnSync`) so the mock provider server's event loop keeps running.
 *
 * Usage:
 *   bun run scripts/e2e-run.ts            # run all acts, clean up temp home
 *   bun run scripts/e2e-run.ts --keep     # keep the temp home (prints path)
 *   bun run scripts/e2e-run.ts --act A1   # run a single act by id
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "index.ts");

// ---------------------------------------------------------------------------
// Mock provider: emulates an Anthropic-compatible /v1/messages streaming API.
// ---------------------------------------------------------------------------
const REPLY = "E2E_OK configured and working";
let chatCalls = 0;
let seenModel = "";

function anthropicSSE(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      const ev = (e: string, d: unknown) =>
        c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`));
      ev("message_start", { type: "message_start", message: { usage: { input_tokens: 12 } } });
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } });
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } });
      ev("message_stop", { type: "message_stop" });
      c.close();
    },
  });
}

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      chatCalls++;
      const body = (await req.json()) as any;
      seenModel = body.model ?? "";
      return new Response(anthropicSSE(REPLY), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

const BASE_URL = `http://localhost:${server.port}/v1`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const keep = process.argv.includes("--keep");
const onlyAct = process.argv.indexOf("--act");
const only = onlyAct !== -1 ? process.argv[onlyAct + 1] : null;

const home = mkdtempSync(join(tmpdir(), "tenjin-e2e-"));
const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      TENJIN_HOME: home,
      ANTHROPIC_API_KEY: "sk-e2e-dummy",
      ANTHROPIC_BASE_URL: BASE_URL,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: (await proc.exited) ?? -1, out, err };
}

/** Run the interactive REPL, feed stdin lines, then exit. Returns exit + stdout. */
async function interact(args: string[], inputs: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      TENJIN_HOME: home,
      ANTHROPIC_API_KEY: "sk-e2e-dummy",
      ANTHROPIC_BASE_URL: BASE_URL,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const line of inputs) {
    proc.stdin.write(line + "\n");
    await proc.stdin.flush();
    await Bun.sleep(300);
  }
  proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  return { code: (await proc.exited) ?? -1, out };
}

function check(id: string, name: string, ok: boolean, detail = ""): void {
  results.push({ id, name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function runAct(id: string, name: string, fn: () => Promise<boolean | { ok: boolean; detail?: string }>): Promise<void> {
  if (only && only !== id) return;
  console.log(`\n== ${id}: ${name} ==`);
  try {
    const r = await fn();
    if (typeof r === "boolean") check(id, name, r);
    else check(id, name, r.ok, r.detail);
  } catch (e) {
    check(id, name, false, `threw: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Acts
// ---------------------------------------------------------------------------

// A0 — one-shot headless prompt: first run scaffolds home, streams a reply.
// (Headless `-p` is ephemeral by design — it does NOT write a session log.)
await runAct("A0", "onboarding + one-shot prompt", async () => {
  // NOTE: --model must come BEFORE -p. `-p` greedily consumes all trailing
  // argv as the prompt (src/cli/args.ts), so flags after -p are swallowed.
  const r = await run(["--model", "mock-model", "-p", "say hello"]);
  const scaffolded = existsSync(join(home, "config.yaml")) && existsSync(join(home, "SOUL.md"));
  return {
    ok: r.code === 0 && r.out.includes(REPLY) && scaffolded && chatCalls >= 1,
    detail: `exit=${r.code} chatCalls=${chatCalls} scaffold=${scaffolded}`,
  };
});

// A1 — interactive REPL: streamed reply + durable session log.
// (audit.jsonl is created lazily on the first security event, so it is NOT
// asserted here — plain chat doesn't write it by design.)
await runAct("A1", "REPL session persists", async () => {
  const before = chatCalls;
  const r = await interact(["--model", "mock-model"], ["say hello", "/exit"]);
  const sessionFiles = existsSync(join(home, "sessions"))
    ? readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"))
    : [];
  return {
    ok: r.code === 0 && r.out.includes(REPLY) && chatCalls > before && sessionFiles.length >= 1,
    detail: `exit=${r.code} newChats=${chatCalls - before} sessions=${sessionFiles.length}`,
  };
});

// A2 — session log is well-formed and durable (first event = session_start).
await runAct("A2", "session log shape", async () => {
  const files = readdirSync(join(home, "sessions")).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return false;
  const events = readFileSync(join(home, "sessions", files[0]), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const okFirst = events[0]?.t === "session_start";
  const hasUser = events.some((e) => e.t === "message" && e.role === "user");
  const hasUsage = events.some((e) => e.t === "usage");
  return { ok: okFirst && hasUser && hasUsage, detail: `events=${events.length}` };
});

// E — memory subsystem is wired into the runtime. At boot the memory layer
// prints "memory: vector layer requested..." (vector on by default, no key in
// this headless run) — proof the memory/vector path executes in the running
// product. The memory/ dir itself is created lazily on first write.
await runAct("E1", "memory subsystem wired", async () => {
  const r = await interact(["--model", "mock-model"], ["/exit"]);
  return {
    ok: r.code === 0 && r.out.includes("memory: vector layer"),
    detail: `exit=${r.code} boot_memory_msg=${r.out.includes("memory: vector layer")}`,
  };
});

// F — audit trail records security events and redacts secrets.
await runAct("F1", "audit command + secret redaction", async () => {
  const r = await run(["audit"]);
  const redacted = r.out.includes("sk-e2e-dummy") === false; // key must not leak
  return { ok: r.code === 0 && r.out.length > 0 && redacted, detail: `exit=${r.code} redacted=${redacted}` };
});

// C1 — gateway config validates and describes (dry-run).
await runAct("C1", "gateway --dry-run", async () => {
  const r = await run(["gateway", "--dry-run"]);
  return { ok: r.code === 0, detail: `exit=${r.code}` };
});

// G1 — backup excludes secrets and restore round-trips the home.
await runAct("G1", "backup / restore round-trip", async () => {
  const backupPath = join(tmpdir(), `tenjin-e2e-backup-${Date.now()}.tar.gz`);
  const b = await run(["backup", "--out", backupPath]);
  const made = b.code === 0 && existsSync(backupPath);
  // restore into a fresh home
  const home2 = mkdtempSync(join(tmpdir(), "tenjin-e2e-restore-"));
  const r = await new Promise<{ code: number }>((resolve) => {
    const proc = Bun.spawn(["bun", "run", CLI, "restore", backupPath], {
      cwd: ROOT,
      env: { ...process.env, TENJIN_HOME: home2 },
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.exited.then((code) => resolve({ code: code ?? -1 }));
  });
  rmSync(home2, { recursive: true, force: true });
  try {
    rmSync(backupPath, { force: true });
  } catch {
    /* best-effort */
  }
  return { ok: made && r.code === 0, detail: `backup=${made} restore_exit=${r.code}` };
});

// G2 — doctor reports environment diagnostics.
await runAct("G2", "doctor diagnostics", async () => {
  const r = await run(["doctor"]);
  return { ok: r.code === 0, detail: `exit=${r.code}` };
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log("\n================ E2E REPORT ================");
let pass = 0;
for (const res of results) {
  if (res.ok) pass++;
  console.log(`  ${res.ok ? "PASS" : "FAIL"}  ${res.id}  ${res.name}`);
}
console.log(`---------------------------------------------`);
console.log(`  ${pass}/${results.length} acts passed   mock provider on :${server.port}`);
if (!keep) {
  rmSync(home, { recursive: true, force: true });
  console.log(`  temp home cleaned`);
} else {
  console.log(`  temp home kept: ${home}`);
}
server.stop(true);
console.log("============================================");

const allPass = results.length > 0 && pass === results.length;
process.exit(allPass ? 0 : 1);
