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
    expect(parseGatewaySettings(undefined)).toEqual({ jobs: [], telegram: null, heartbeat: null, listen: null, allowWrites: false });
    expect(parseGatewaySettings(null)).toEqual({ jobs: [], telegram: null, heartbeat: null, listen: null, allowWrites: false });
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
