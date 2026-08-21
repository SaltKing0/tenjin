import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Gateway,
  buildJobs,
  dueJobs,
  msUntilNextJob,
} from "../src/gateway/gateway";

import type { HarnessConfig } from "../src/config/types";
import { parseGatewaySettings as pgs } from "../src/gateway/config";
const parseGatewaySettings = pgs;
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import { createBot } from "../src/bots/profile";
import { listMessages } from "../src/bots/inbox";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-gw-"));
  createBot(home, "worker");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const config = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 512,
  budgetUSD: 1,
  approval: {},
  ...over,
});

function mockProvider(reply = "job output"): Provider {
  return {
    name: "mock",
    async chat(): Promise<ChatResponse> {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

describe("parseGatewaySettings", () => {
  test("empty/missing → defaults", () => {
    expect(parseGatewaySettings(undefined)).toEqual({
      jobs: [],
      telegram: null,
      channels: [],
      heartbeat: null,
      listen: null,
      allowWrites: false,
      catchUp: { enabled: true, max: 50 },
    });
    expect(parseGatewaySettings(null)).toEqual({
      jobs: [],
      telegram: null,
      channels: [],
      heartbeat: null,
      listen: null,
      allowWrites: false,
      catchUp: { enabled: true, max: 50 },
    });
  });

  test("valid job parses with schedule validation", () => {
    const s = parseGatewaySettings({
      jobs: [{ name: "a", bot: "worker", prompt: "do it", every: "10m" }],
    });
    expect(s.jobs).toHaveLength(1);
    expect(s.jobs[0]?.scheduleSpec.every).toBe("10m");
  });

  test("job tz is parsed and validated", () => {
    const s = parseGatewaySettings({
      jobs: [
        {
          name: "a",
          bot: "worker",
          prompt: "do it",
          cron: "0 9 * * *",
          tz: "Europe/Berlin",
        },
      ],
    });
    expect(s.jobs[0]?.scheduleSpec.tz).toBe("Europe/Berlin");
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "b", prompt: "p", cron: "0 9 * * *", tz: "Not/AZone" }],
      }),
    ).toThrow(/time zone/);
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "b", prompt: "p", cron: "0 9 * * *", tz: 1 }],
      }),
    ).toThrow(/IANA time zone/);
  });

  test("invalid schedule rejected", () => {
    expect(() =>
      parseGatewaySettings({ jobs: [{ name: "a", bot: "b", prompt: "p", every: "nope" }] }),
    ).toThrow(/invalid interval/);
  });

  test("duplicate job names rejected", () => {
    expect(() =>
      parseGatewaySettings({
        jobs: [
          { name: "x", bot: "b", prompt: "p", every: "1m" },
          { name: "x", bot: "b", prompt: "p2", cron: "* * * * *" },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test("telegram enabled without allowlist rejected", () => {
    expect(() => parseGatewaySettings({ telegram: { enabled: true } })).toThrow(
      /allowlist/,
    );
    const ok = parseGatewaySettings({
      telegram: { enabled: true, allowedUsers: [42], defaultBot: "researcher" },
    });
    expect(ok.telegram?.allowedUsers).toEqual([42]);
    expect(() =>
      parseGatewaySettings({ telegram: { enabled: true, allowedUsers: [42] } }),
    ).toThrow(/defaultBot/);
  });

  test("telegram bindings map bot → allowed senders", () => {
    const s = parseGatewaySettings({
      telegram: {
        enabled: true,
        allowedUsers: [42, 99],
        defaultBot: "researcher",
        bindings: { researcher: [42], writer: [99] },
      },
    });
    expect(s.telegram?.bindings).toEqual({ researcher: [42], writer: [99] });
  });

  test("telegram bindings reject non-numeric user ids", () => {
    expect(() =>
      parseGatewaySettings({
        telegram: {
          enabled: true,
          allowedUsers: [42],
          defaultBot: "researcher",
          bindings: { researcher: ["alice"] },
        },
      }),
    ).toThrow(/bindings/);
  });

  test("telegram rate-limit and length config parsed (#69)", () => {
    const s = parseGatewaySettings({
      telegram: {
        enabled: true,
        allowedUsers: [42],
        defaultBot: "researcher",
        rateLimitMax: 5,
        rateLimitWindowMs: 10_000,
        maxMessageLength: 512,
      },
    });
    expect(s.telegram?.rateLimitMax).toBe(5);
    expect(s.telegram?.rateLimitWindowMs).toBe(10_000);
    expect(s.telegram?.maxMessageLength).toBe(512);
  });

  test("channels list defaults from telegram and validates kinds (#97)", () => {
    expect(parseGatewaySettings({}).channels).toEqual([]);
    expect(
      parseGatewaySettings({
        telegram: { enabled: true, allowedUsers: [42], defaultBot: "researcher" },
      }).channels,
    ).toEqual(["telegram"]);
    const explicit = parseGatewaySettings({ channels: ["telegram"] });
    expect(explicit.channels).toEqual(["telegram"]);
    expect(() => parseGatewaySettings({ channels: "notalist" })).toThrow(/must be a list/);
    expect(() => parseGatewaySettings({ channels: ["slack"] })).toThrow(/unknown channel/);
    expect(() => parseGatewaySettings({ channels: [3] })).toThrow(/strings/);
  });
});

describe("job scheduling helpers", () => {
  const settings = parseGatewaySettings({
    jobs: [
      { name: "fast", bot: "worker", prompt: "a", every: "1m" },
      { name: "slow", bot: "worker", prompt: "b", cron: "0 9 * * *" },
    ],
  });
  const t0 = new Date("2026-08-21T08:00:00").getTime();

  test("buildJobs computes next due times", () => {
    const jobs = buildJobs(settings, t0);
    expect(jobs.map((j) => j.name)).toEqual(["fast", "slow"]);
    const fast = jobs[0];
    const slow = jobs[1];
    if (!fast || !slow) throw new Error("unreachable");
    expect(fast.nextDueMs).toBe(t0 + 60_000);
    expect(new Date(slow.nextDueMs).getHours()).toBe(9);
  });

  test("buildJobs honors per-job tz across DST", () => {
    const zoned = parseGatewaySettings({
      jobs: [
        {
          name: "morning",
          bot: "worker",
          prompt: "p",
          cron: "0 9 * * *",
          tz: "Europe/Berlin",
        },
      ],
    });
    const from = Date.UTC(2026, 2, 28, 9, 0, 0);
    const jobs = buildJobs(zoned, from);
    expect(jobs[0]?.nextDueMs).toBe(Date.UTC(2026, 2, 29, 7, 0, 0));
  });

  test("dueJobs respects running flag and time", () => {
    const jobs = buildJobs(settings, t0);
    const fast = jobs[0];
    if (!fast) throw new Error("unreachable");
    fast.running = true;
    expect(dueJobs(jobs, t0 + 60_000).map((j) => j.name)).toEqual([]);
    fast.running = false;
    expect(dueJobs(jobs, t0 + 60_000).map((j) => j.name)).toEqual(["fast"]);
    expect(dueJobs(jobs, t0)).toEqual([]);
  });

  test("msUntilNextJob caps at 30s poll ceiling", () => {
    const jobs = buildJobs(settings, t0);
    expect(msUntilNextJob(jobs, t0)).toBe(30_000); // slow job is hours away
    expect(msUntilNextJob([], t0)).toBe(1000);
  });
});

describe("Gateway execution", () => {
  test("fireDue runs due job through the bot profile and posts to channel", async () => {
    const posted: Array<{ channel: string; text: string }> = [];
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [
            { name: "digest", bot: "worker", prompt: "make digest", every: "1m", postTo: "telegram" },
          ],
        },
      }),
      registry: { get: () => mockProvider("DIGEST BODY") } as never,
      channels: {
        telegram: async (text): Promise<void> => {
          posted.push({ channel: "telegram", text });
        },
      },
    });

    const t0 = Date.now();
    await gw.fireDue(t0 + 120_000);
    await Bun.sleep(50);

    expect(posted).toEqual([{ channel: "telegram", text: "DIGEST BODY" }]);
  });

  test("job run injects the bot's facts.md, skill catalog, and use_skill", async () => {
    const mem = join(home, "bots", "worker", "memory");
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, "facts.md"), "- [2026-08-21] worker likes short replies\n");
    mkdirSync(join(home, "skills", "brief"), { recursive: true });
    writeFileSync(
      join(home, "skills", "brief", "SKILL.md"),
      '---\nname: "brief"\ndescription: "Keep it short"\n---\nBe brief.\n',
    );

    const capture: { req?: ChatRequest } = {};
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "digest", bot: "worker", prompt: "make digest", every: "1m" }],
        },
      }),
      registry: {
        get: () => ({
          name: "mock",
          async chat(req: ChatRequest): Promise<ChatResponse> {
            capture.req = req;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "ok" }],
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          },
        }),
      } as never,
    });

    await gw.fireDue(Date.now() + 120_000);
    await Bun.sleep(50);

    const system = String(capture.req?.system);
    expect(system).toContain("# Facts");
    expect(system).toContain("worker likes short replies");
    expect(system).toContain("# Skills");
    expect(system).toContain("brief");
    const names = (capture.req?.tools ?? []).map((t) => t.name);
    expect(names).toContain("use_skill");
    expect(names).not.toContain("save_skill");
  });

  test("postTo unknown channel logs and does not throw", async () => {
    const logs: string[] = [];
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "j", bot: "worker", prompt: "p", every: "1m", postTo: "nowhere" }],
        },
      }),
      registry: { get: () => mockProvider() } as never,
      log: (l) => logs.push(l),
    });
    await gw.fireDue(Date.now() + 120_000);
    await Bun.sleep(50);
    expect(logs.some((l) => l.includes('not available'))).toBe(true);
  });

  test("runNow executes immediately, records lastRun, and does not advance nextDue", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { jobs: [{ name: "digest", bot: "worker", prompt: "make digest", every: "1h" }] },
      }),
      registry: { get: () => mockProvider("NOW") } as never,
    });
    const job = gw.jobs[0];
    if (!job) throw new Error("missing job");
    const before = job.nextDueMs;

    const result = await gw.runNow("digest");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("NOW");
    expect(job.nextDueMs).toBe(before);
    expect(job.lastRun?.stopReason).toBe("end_turn");
    expect(job.running).toBe(false);

    const listed = gw.listJobs();
    expect(listed[0]?.name).toBe("digest");
    expect(listed[0]?.policy).toBe("read-only");
    expect(listed[0]?.every).toBe("1h");
    expect(listed[0]?.lastRun?.stopReason).toBe("end_turn");
    expect(listed[0]?.nextDueMs).toBe(before);
  });

  test("runNow returns not_found / busy without starting a second run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { jobs: [{ name: "digest", bot: "worker", prompt: "p", every: "1h" }] },
      }),
      registry: {
        get: () => ({
          name: "mock",
          async chat(): Promise<ChatResponse> {
            await gate;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "ok" }],
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        }),
      } as never,
    });

    expect((await gw.runNow("nope")).ok).toBe(false);
    const first = gw.runNow("digest");
    for (let i = 0; i < 50 && !gw.jobs[0]?.running; i++) await Bun.sleep(5);
    const busy = await gw.runNow("digest");
    expect(busy.ok).toBe(false);
    if (busy.ok) throw new Error("unreachable");
    expect(busy.code).toBe("busy");
    release();
    expect((await first).ok).toBe(true);
  });

  test("dry-run describe lists channels and jobs", () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "standup", bot: "worker", prompt: "p", cron: "0 9 * * *", postTo: "telegram" }],
        },
      }),
      registry: { get: () => mockProvider() } as never,
    });
    const lines = gw.describe().join("\n");
    expect(lines).toContain("(none — jobs still run)");
    expect(lines).toContain("job standup");
    expect(lines).toContain("bot=worker");
    expect(lines).toContain("→ telegram");
  });
});

describe("heartbeat", () => {
  function makeGateway(reply: string, capture: { req?: ChatRequest }) {
    return new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          heartbeat: { enabled: true, bot: "worker", every: "30m" },
        },
      }),
      registry: {
        get: () => ({
          name: "mock",
          async chat(req: ChatRequest): Promise<ChatResponse> {
            capture.req = req;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: reply }],
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          },
        }),
      } as never,
    });
  }

  test("heartbeat job is synthesized and fires with inbox state", async () => {
    const capture: { req?: ChatRequest } = {};
    const gw = makeGateway("ok", capture);
    const hb = gw.jobs.find((j) => j.kind === "heartbeat");
    expect(hb?.botName).toBe("worker");

    // seed an unread message in worker's inbox
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m1.json"),
      JSON.stringify({ id: "m1", from: "other", to: "worker", subject: "look here", body: "body text", ts: "t", read: false }),
    );

    await gw.fireDue(Date.now() + 60 * 60_000);
    await Bun.sleep(30);

    const message = String(capture.req?.messages[0]?.content);
    expect(message).toContain("Heartbeat check");
    expect(message).toContain("1 unread message(s)");
    expect(message).toContain("look here");
    const toolNames = (capture.req?.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toContain("check_inbox");
    expect(toolNames).toContain("send_message");
    expect(toolNames).toContain("remember");
    expect(toolNames).toContain("use_skill");
  });

  test("heartbeat surfaces user messages first and marks them read", async () => {
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m-bot.json"),
      JSON.stringify({
        id: "m-bot",
        from: "alice",
        to: "worker",
        subject: "bot note",
        body: "from another bot",
        ts: "2026-08-21T10:00:00.000Z",
        read: false,
      }),
    );
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m-user.json"),
      JSON.stringify({
        id: "m-user",
        from: "user",
        to: "worker",
        subject: "idea for tomorrow",
        body: "please sketch the auth refactor",
        ts: "2026-08-21T11:00:00.000Z",
        read: false,
      }),
    );

    const capture: { req?: ChatRequest } = {};
    const gw = makeGateway("ok", capture);
    await gw.fireDue(Date.now() + 60 * 60_000);
    await Bun.sleep(30);

    const message = String(capture.req?.messages[0]?.content);
    expect(message).toContain("2 unread message(s)");
    const userAt = message.indexOf("from user:");
    const botAt = message.indexOf("from alice:");
    expect(userAt).toBeGreaterThan(-1);
    expect(botAt).toBeGreaterThan(-1);
    expect(userAt).toBeLessThan(botAt);
    expect(message).toContain("please sketch the auth refactor");

    expect(listMessages(join(home, "bots", "worker", "inbox")).every((m) => m.read)).toBe(true);
  });

  test("heartbeat replies to the sender via send_message, landing in the sender inbox", async () => {
    createBot(home, "alice");
    // alice leaves a message in worker's inbox
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m1.json"),
      JSON.stringify({
        id: "m1",
        from: "alice",
        to: "worker",
        subject: "status",
        body: "whats up",
        ts: "t",
        read: false,
      }),
    );

    // first turn asks to send_message, second turn ends
    let calls = 0;
    const provider: Provider = {
      name: "mock",
      async chat(req: ChatRequest): Promise<ChatResponse> {
        if (calls === 0) {
          calls++;
          return {
            stopReason: "tool_use",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "send_message",
                input: { to: "alice", subject: "re: status", body: "all good" },
              },
            ],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
        calls++;
        return {
          stopReason: "end_turn",
          content: [{ type: "text", text: "sent" }],
          usage: { inputTokens: 5, outputTokens: 5 },
        };
      },
    };

    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { heartbeat: { enabled: true, bot: "worker", every: "30m" } },
      }),
      registry: { get: () => provider } as never,
    });

    await gw.fireDue(Date.now() + 60 * 60_000);
    await Bun.sleep(30);

    // sender's inbox now holds the reply written by worker's heartbeat
    const replies = listMessages(join(home, "bots", "alice", "inbox"));
    const reply = replies.find((m) => m.from === "worker" && m.to === "alice");
    expect(reply).toBeDefined();
    expect(reply?.subject).toBe("re: status");
    expect(reply?.body).toBe("all good");
  });

  test("disabled heartbeat produces no job", () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({ gateway: { heartbeat: { enabled: false, bot: "worker" } } }),
      registry: { get: () => mockProvider() } as never,
    });
    expect(gw.jobs.find((j) => j.kind === "heartbeat")).toBeUndefined();
  });

  test("heartbeat without bot rejected", () => {
    expect(() =>
      parseGatewaySettings({ heartbeat: { enabled: true } }),
    ).toThrow(/requires a `bot`/);
  });
});

describe("onSessionEnd summaries (#37)", () => {
  test("enabled: a finished job writes a summary for the bot session", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        memory: { enabled: true, summaries: { onSessionEnd: true } },
        gateway: {
          jobs: [{ name: "j", bot: "worker", prompt: "summarize me", every: "1m" }],
        },
      }),
      registry: { get: () => mockProvider("run output") } as never,
      log: () => {},
    });

    await gw.fireDue(Date.now() + 120_000);

    const summariesDir = join(home, "bots", "worker", "memory", "summaries");
    let summaryFile: string | undefined;
    for (let i = 0; i < 60; i++) {
      const files = existsSync(summariesDir) ? readdirSync(summariesDir) : [];
      if (files.length > 0) {
        summaryFile = files[0];
        break;
      }
      await Bun.sleep(20);
    }
    expect(summaryFile).toBeDefined();
    // The summary is a real file with YAML frontmatter (uptoEvent written).
    const text = readFileSync(join(summariesDir, summaryFile!), "utf8");
    expect(text).toMatch(/uptoEvent:/);
  });

  test("disabled by default: no summary file is produced", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "j", bot: "worker", prompt: "summarize me", every: "1m" }],
        },
      }),
      registry: { get: () => mockProvider("run output") } as never,
      log: () => {},
    });

    await gw.fireDue(Date.now() + 120_000);
    await Bun.sleep(100);

    const summariesDir = join(home, "bots", "worker", "memory", "summaries");
    expect(existsSync(summariesDir)).toBe(false);
  });
});

describe("scheduler catch-up (#19)", () => {
  // A persisted run two minutes in the past — downtime long enough that, for a
  // 1m cadence (every) or a daily cron, the next scheduled run has been missed.
  const TWO_MIN_AGO_MS = Date.now() - 2 * 60_000;
  const stateFile = () => join(home, "gateway-state.json");

  function writeOverdueState(jobs: Record<string, number | undefined>) {
    const state: { version: number; jobs: Record<string, unknown> } = {
      version: 1,
      jobs: {},
    };
    for (const [name, atMs] of Object.entries(jobs)) {
      state.jobs[name] =
        atMs === undefined
          ? { lastRun: null }
          : { lastRun: { atMs, stopReason: "end_turn", costUSD: 0 } };
    }
    writeFileSync(stateFile(), JSON.stringify(state));
  }

  function makeGateway(jobs: unknown[], catchUp?: unknown, opts: { log?: (l: string) => void } = {}) {
    return new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { jobs, ...(catchUp !== undefined ? { catchUp } : {}) } as never,
      }),
      registry: { get: () => mockProvider("CATCHUP BODY") } as never,
      log: opts.log,
    });
  }

  test("parse: catchUp defaults to enabled with max 50", () => {
    expect(parseGatewaySettings(undefined).catchUp).toEqual({ enabled: true, max: 50 });
    expect(
      parseGatewaySettings({ catchUp: { enabled: false, max: 2 } }).catchUp,
    ).toEqual({ enabled: false, max: 2 });
  });

  test("parse: invalid catchUp rejected", () => {
    expect(() => parseGatewaySettings({ catchUp: { max: 0 } })).toThrow(/positive integer/);
    expect(() => parseGatewaySettings({ catchUp: { max: "x" } })).toThrow(/positive integer/);
  });

  test("parse: per-job timeoutMs parsed and validated", () => {
    const s = parseGatewaySettings({
      jobs: [{ name: "a", bot: "worker", prompt: "p", every: "1m", timeoutMs: 5000 }],
    });
    expect(s.jobs[0]?.timeoutMs).toBe(5000);
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "worker", prompt: "p", every: "1m", timeoutMs: 0 }],
      }),
    ).toThrow(/timeoutMs/);
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "worker", prompt: "p", every: "1m", timeoutMs: -1 }],
      }),
    ).toThrow(/timeoutMs/);
  });

  test("hydrates persisted lastRun and fires the missed run exactly once", async () => {
    writeOverdueState({ digest: TWO_MIN_AGO_MS });
    const gw = makeGateway([{ name: "digest", bot: "worker", prompt: "p", every: "1m" }]);
    const job = gw.jobs[0];
    if (!job) throw new Error("missing job");
    // Persisted lastRun is hydrated into the in-memory job at boot.
    expect(job.lastRun?.atMs).toBe(TWO_MIN_AGO_MS);

    const fired = await gw.catchUpOverdue(Date.now());

    expect(fired).toBe(1);
    await Bun.sleep(80);
    expect(job.running).toBe(false);
    // The missed run advanced lastRun to now and freshened the cadence.
    expect(job.lastRun?.atMs).toBeGreaterThan(TWO_MIN_AGO_MS);
    expect(job.nextDueMs).toBeGreaterThan(Date.now() - 5_000);
  });

  test("a recently-run job is not overdue", async () => {
    writeOverdueState({ digest: Date.now() - 5_000 });
    const gw = makeGateway([{ name: "digest", bot: "worker", prompt: "p", every: "10m" }]);
    // 5s old run, 10m cadence → next scheduled slot is still in the future.
    expect(await gw.catchUpOverdue(Date.now())).toBe(0);
  });

  test("no persisted state → nothing to catch up (first boot)", async () => {
    const gw = makeGateway([{ name: "digest", bot: "worker", prompt: "p", every: "1m" }]);
    expect(await gw.catchUpOverdue(Date.now())).toBe(0);
  });

  test("catchUp disabled → no catch-up runs", async () => {
    writeOverdueState({ digest: TWO_MIN_AGO_MS });
    const gw = makeGateway(
      [{ name: "digest", bot: "worker", prompt: "p", every: "1m" }],
      { enabled: false, max: 50 },
    );
    expect(await gw.catchUpOverdue(Date.now())).toBe(0);
  });

  test("catchUp caps the number of runs per boot", async () => {
    writeOverdueState({ a: TWO_MIN_AGO_MS, b: TWO_MIN_AGO_MS, c: TWO_MIN_AGO_MS });
    const logs: string[] = [];
    const gw = makeGateway(
      [
        { name: "a", bot: "worker", prompt: "p", every: "1m" },
        { name: "b", bot: "worker", prompt: "p", every: "1m" },
        { name: "c", bot: "worker", prompt: "p", every: "1m" },
      ],
      { enabled: true, max: 2 },
      { log: (l) => logs.push(l) },
    );
    expect(await gw.catchUpOverdue(Date.now())).toBe(2);
    const catched = logs
      .filter((l) => l.includes("catch-up"))
      .map((l) => /job (\w+) catch-up/.exec(l)?.[1]);
    expect(catched).toEqual(["a", "b"]);
  });
});

describe("job hang release + per-job timeout (#19)", () => {
  // A provider whose single chat() call never settles — simulates a hung
  // upstream request that must not pin the job slot forever.
  function hangingProvider(gate: { release: () => void }) {
    return {
      name: "mock",
      async chat(): Promise<never> {
        return new Promise<never>(() => {
          if (gate.release) gate.release();
        });
      },
    };
  }

  test("a hanging job with timeoutMs frees its slot and records the timeout", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "digest", bot: "worker", prompt: "p", every: "1h", timeoutMs: 30 }],
        },
      }),
      registry: { get: () => hangingProvider({ release: () => {} }) } as never,
    });

    const started = Date.now();
    const result = await gw.runNow("digest");
    const took = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(String(result.error)).toMatch(/timed out/);
    expect(took).toBeLessThan(2_000);
    // Slot is free again and the timeout is recorded as the last run.
    const job = gw.jobs[0];
    if (!job) throw new Error("missing job");
    expect(job.running).toBe(false);
    // A hung run must not be treated as caught-up-but-successful state; the
    // error run is persisted so a restart won't re-fetch it as overdue.
    expect(job.lastRun?.error).toMatch(/timed out/);
    expect(existsSync(join(home, "gateway-state.json"))).toBe(true);
  });

  test("job without timeoutMs still runs normally (no regression)", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { jobs: [{ name: "digest", bot: "worker", prompt: "p", every: "1h" }] },
      }),
      registry: { get: () => mockProvider("HELLO") } as never,
    });
    const result = await gw.runNow("digest");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.text).toBe("HELLO");
  });
});
