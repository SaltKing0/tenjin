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
import { createSendMessageTool } from "../src/bots/tools";

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

/** Provider that first issues a write_file tool-call, then ends the turn. */
function writeScriptProvider(path: string, content: string): Provider {
  let calls = 0;
  return {
    name: "mockwrite",
    async chat(): Promise<ChatResponse> {
      calls += 1;
      if (calls === 1) {
        return {
          stopReason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "w1",
              name: "write_file",
              input: { path, content },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: "wrote it" }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

describe("parseGatewaySettings", () => {
  test("empty/missing → defaults", () => {
    expect(parseGatewaySettings(undefined)).toEqual({
      jobs: [],
      telegram: null,
      slack: null,
      webhook: null,
      discord: null,
      channels: [],
      heartbeat: null,
      listen: null,
      allowWrites: false,
      catchUp: { enabled: true, max: 50 },
    });
    expect(parseGatewaySettings(null)).toEqual({
      jobs: [],
      telegram: null,
      slack: null,
      webhook: null,
      discord: null,
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

  test("job policy parses and validates (#52)", () => {
    const s = parseGatewaySettings({
      jobs: [
        { name: "a", bot: "worker", prompt: "do it", every: "10m", policy: "full" },
        { name: "b", bot: "worker", prompt: "do it", every: "10m", policy: "read-only" },
      ],
    });
    expect(s.jobs[0]?.policy).toBe("full");
    expect(s.jobs[1]?.policy).toBe("read-only");
    // absent → undefined (defaults resolved at build time from allowWrites)
    const plain = parseGatewaySettings({
      jobs: [{ name: "c", bot: "worker", prompt: "p", every: "10m" }],
    });
    expect(plain.jobs[0]?.policy).toBeUndefined();
    expect(() =>
      parseGatewaySettings({ jobs: [{ name: "a", bot: "b", prompt: "p", every: "10m", policy: "admin" }] }),
    ).toThrow(/policy/);
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

  test("job accepts schedule as a nested mapping (#297)", () => {
    const s = parseGatewaySettings({
      jobs: [
        {
          name: "a",
          bot: "worker",
          prompt: "do it",
          schedule: { cron: "0 9 * * *", tz: "Europe/Berlin" },
        },
      ],
    });
    expect(s.jobs[0]?.scheduleSpec.cron).toBe("0 9 * * *");
    expect(s.jobs[0]?.scheduleSpec.tz).toBe("Europe/Berlin");
  });

  test("job accepts schedule as a flat string → cron (#297)", () => {
    const s = parseGatewaySettings({
      jobs: [{ name: "a", bot: "worker", prompt: "do it", schedule: "30 6 * * *" }],
    });
    expect(s.jobs[0]?.scheduleSpec.cron).toBe("30 6 * * *");
  });

  test("invalid schedule reports the received shape (#297)", () => {
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "worker", prompt: "p", schedule: {} }],
      }),
    ).toThrow(/got schedule/);
    expect(() =>
      parseGatewaySettings({
        jobs: [{ name: "a", bot: "worker", prompt: "p", schedule: 42 }],
      }),
    ).toThrow(/must be a mapping or a cron string/);
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
    expect(() => parseGatewaySettings({ channels: ["matrix"] })).toThrow(/unknown channel/);
    expect(() => parseGatewaySettings({ channels: [3] })).toThrow(/strings/);
    expect(parseGatewaySettings({ channels: ["telegram", "slack"] }).channels).toEqual([
      "telegram",
      "slack",
    ]);
  });

  test("slack config parses, validates allowlist, and feeds default channels (#106)", () => {
    expect(parseGatewaySettings({}).slack).toBeNull();
    expect(
      parseGatewaySettings({
        slack: { enabled: true, botToken: "t", signingSecret: "s", allowedChannels: ["C1"], defaultBot: "researcher" },
      }).channels,
    ).toEqual(["slack"]);
    expect(() => parseGatewaySettings({ slack: { enabled: true, allowedChannels: [], defaultBot: "r" } })).toThrow(/allowlist/);
    expect(() => parseGatewaySettings({ slack: { enabled: true, allowedChannels: ["C1"] } })).toThrow(/defaultBot/);
    expect(() => parseGatewaySettings({ slack: { enabled: true, allowedChannels: [42], defaultBot: "r" } })).toThrow(/strings/);
    const parsed = parseGatewaySettings({
      slack: { enabled: true, botToken: "t", signingSecret: "s", adminChannel: "A1", allowedChannels: ["C1"], defaultBot: "r", rateLimitMax: 5, maxMessageLength: 200 },
    });
    expect(parsed.slack?.adminChannel).toBe("A1");
    expect(parsed.slack?.rateLimitMax).toBe(5);
    expect(parsed.slack?.maxMessageLength).toBe(200);
    expect(parsed.slack?.allowWrites).toBe(false);
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

  test("buildJobs derives job policy from per-job policy, allowWrites, or default (#52)", () => {
    const mixed = parseGatewaySettings({
      jobs: [
        { name: "explicit-full", bot: "worker", prompt: "p", every: "1m", policy: "full" },
        { name: "explicit-ro", bot: "worker", prompt: "p", every: "1m", policy: "read-only" },
        { name: "default-ro", bot: "worker", prompt: "p", every: "1m" },
      ],
    });
    const byName = Object.fromEntries(buildJobs(mixed, 0).map((j) => [j.name, j.policy]));
    expect(byName["explicit-full"]).toBe("full");
    expect(byName["explicit-ro"]).toBe("read-only");
    expect(byName["default-ro"]).toBe("read-only");

    // gateway allowWrites upgrades the default, but an explicit per-job
    // policy still overrides it (read-only can be locked per job).
    const aw = parseGatewaySettings({
      allowWrites: true,
      jobs: [{ name: "upgraded", bot: "worker", prompt: "p", every: "1m" }],
    });
    expect(buildJobs(aw, 0)[0]?.policy).toBe("full");
    const locked = parseGatewaySettings({
      allowWrites: true,
      jobs: [
        { name: "upgraded", bot: "worker", prompt: "p", every: "1m" },
        { name: "locked", bot: "worker", prompt: "p", every: "1m", policy: "read-only" },
      ],
    });
    const lockedBy = Object.fromEntries(buildJobs(locked, 0).map((j) => [j.name, j.policy]));
    expect(lockedBy["upgraded"]).toBe("full");
    expect(lockedBy["locked"]).toBe("read-only");
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

  test("job with policy full can write a file (#52)", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        // Guard is disabled to isolate the job-policy mechanism (the path
        // guard is orthogonal to #52 and trips on the macOS /var symlink).
        security: { disabled: true },
        gateway: {
          jobs: [{ name: "writejob", bot: "worker", prompt: "write a file", every: "1m", policy: "full" }],
        },
      }),
      registry: { get: () => writeScriptProvider("out.txt", "hello") } as never,
    });
    expect(gw.jobs[0]?.policy).toBe("full");
    const result = await gw.runNow("writejob");
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "out.txt"))).toBe(true);
    expect(readFileSync(join(home, "out.txt"), "utf8")).toBe("hello");
    expect(gw.listJobs()[0]?.policy).toBe("full");
  });

  test("default read-only job cannot write a file (#52)", async () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        security: { disabled: true },
        gateway: {
          jobs: [{ name: "rojob", bot: "worker", prompt: "write", every: "1m" }],
        },
      }),
      registry: { get: () => writeScriptProvider("nope.txt", "x") } as never,
    });
    expect(gw.jobs[0]?.policy).toBe("read-only");
    const result = await gw.runNow("rojob");
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "nope.txt"))).toBe(false);
  });

  test("bot security policy still caps a full job to read-only (#52)", async () => {
    // worker security.policy read-only must win over a job-level full policy
    const botCfg = join(home, "bots", "worker", "config.yaml");
    writeFileSync(botCfg, "security:\n  policy: read-only\n");
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        security: { disabled: true },
        gateway: {
          jobs: [{ name: "capped", bot: "worker", prompt: "p", every: "1m", policy: "full" }],
        },
      }),
      registry: { get: () => writeScriptProvider("cap.txt", "x") } as never,
    });
    const result = await gw.runNow("capped");
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "cap.txt"))).toBe(false);
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

  test("boot describe surfaces a disabled web console hint when gateway.listen is unset (#250)", () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({}),
      registry: { get: () => mockProvider() } as never,
    });
    const lines = gw.describe().join("\n");
    expect(lines).toContain("web console: disabled");
    expect(lines).toContain("gateway.listen.port/token");
  });

  test("boot describe reports the console URL when gateway.listen is configured (#250)", () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { listen: { host: "127.0.0.1", port: 3210, token: "s3cret" } },
      }),
      registry: { get: () => mockProvider() } as never,
    });
    const lines = gw.describe().join("\n");
    expect(lines).toContain("web console: enabled at http://127.0.0.1:3210");
  });

  test("reload rebuilds the job set from a fresh config (SIGHUP path)", () => {
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "one", bot: "worker", prompt: "p1", every: "1m" }],
        },
      }),
      registry: { get: () => mockProvider() } as never,
    });
    expect(gw.listJobs().map((j) => j.name)).toEqual(["one"]);

    gw.reload(
      config({
        gateway: {
          jobs: [
            { name: "two", bot: "worker", prompt: "p2", cron: "0 9 * * *" },
            { name: "three", bot: "worker", prompt: "p3", every: "30m" },
          ],
        },
      }),
    );

    expect(gw.listJobs().map((j) => j.name)).toEqual(["two", "three"]);
    expect(gw.listJobs()).toHaveLength(2);
  });

  test("caps concurrent job executions so fireDue never launches unbounded parallelism (#314)", async () => {
    const track = { active: 0, max: 0 };
    const provider: Provider = {
      name: "mock",
      async chat(): Promise<ChatResponse> {
        track.active++;
        if (track.active > track.max) track.max = track.active;
        try {
          await Bun.sleep(40);
          return {
            stopReason: "end_turn",
            content: [{ type: "text", text: "ok" }],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        } finally {
          track.active--;
        }
      },
    };
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [1, 2, 3, 4].map((i) => ({
            name: `j${i}`,
            bot: "worker",
            prompt: `p${i}`,
            every: "1m",
            postTo: "telegram",
          })),
        },
      }),
      registry: { get: () => provider } as never,
      channels: { telegram: async () => {} },
      maxConcurrentJobs: 2,
    });

    const t0 = Date.now();
    await gw.fireDue(t0 + 120_000); // all four are due at the same instant
    await Bun.sleep(200); // give them time to run
    // Without a cap all four would run at once (max would be 4).
    expect(track.max).toBeLessThanOrEqual(2);
  });

  test("run loop does not accumulate abort listeners across ticks (#314)", async () => {
    const ctrl = new AbortController();
    const real = ctrl.signal;
    let added = 0;
    let removed = 0;
    const spy = new Proxy(real, {
      get(target, prop) {
        if (prop === "addEventListener") {
          return (...a: unknown[]) => {
            added++;
            return target.addEventListener(...(a as [never, never]));
          };
        }
        if (prop === "removeEventListener") {
          return (...a: unknown[]) => {
            removed++;
            return target.removeEventListener(...(a as [never, never]));
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as AbortSignal;

    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: {
          jobs: [{ name: "tick", bot: "worker", prompt: "p", every: "1s", postTo: "telegram" }],
        },
      }),
      registry: { get: () => mockProvider("ok") } as never,
      channels: { telegram: async () => {} },
    });

    const runPromise = gw.run(spy);
    await Bun.sleep(3200); // several loop ticks, none aborting
    ctrl.abort();
    await runPromise;
    // Per-tick wait listeners must be removed on the normal timer path, so a
    // small constant remains (not a count that grows with every tick).
    expect(added - removed).toBeLessThanOrEqual(2);
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

    // seed an unread message in worker's inbox (user-originated)
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m1.json"),
      JSON.stringify({ id: "m1", from: "user", to: "worker", subject: "look here", body: "body text", ts: "t", read: false }),
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

  test("heartbeat surfaces only user messages and leaves bot mail unread (#181)", async () => {
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
    // Only the user message is surfacing for the heartbeat to act on.
    expect(message).toContain("1 unread message(s)");
    expect(message).toContain("from user:");
    expect(message).toContain("please sketch the auth refactor");
    expect(message).not.toContain("from alice:");
    // The user message is marked read; the bot mail is left unread (a real run
    // of the bot still handles it via check_inbox).
    const msgs = listMessages(join(home, "bots", "worker", "inbox"));
    expect(msgs.find((m) => m.id === "m-user")?.read).toBe(true);
    expect(msgs.find((m) => m.id === "m-bot")?.read).toBe(false);
  });

  test("heartbeat replies to the sender via send_message, landing in the sender inbox", async () => {
    createBot(home, "alice");
    // the user leaves a message in worker's inbox
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "m1.json"),
      JSON.stringify({
        id: "m1",
        from: "user",
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

  // #181: a bot-originated inbox message must not trigger the heartbeat, so two
  // heartbeat bots cannot ping-pong each other forever.
  test("a bot-originated message does not trigger the heartbeat (no bot-to-bot loop)", async () => {
    mkdirSync(join(home, "bots", "worker", "inbox"), { recursive: true });
    writeFileSync(
      join(home, "bots", "worker", "inbox", "relay.json"),
      JSON.stringify({
        id: "relay",
        from: "alice",
        to: "worker",
        subject: "re: your message",
        body: "are you there",
        ts: "t",
        read: false,
      }),
    );
    const capture: { req?: ChatRequest } = {};
    const gw = makeGateway("ok", capture);
    await gw.fireDue(Date.now() + 60 * 60_000);
    await Bun.sleep(30);

    const message = String(capture.req?.messages[0]?.content);
    // Bot mail is not surfaced to the heartbeat, so it has nothing to reply to.
    expect(message).toContain("Your inbox is empty");
    expect(message).not.toContain("are you there");
    // And it is left unread, so a real run of the bot can still handle it.
    expect(
      listMessages(join(home, "bots", "worker", "inbox")).find((m) => m.id === "relay")?.read,
    ).toBe(false);
  });

  // #181: per-bot-pair reply cooldown as a safety net on the heartbeat's send tool.
  test("heartbeat send_message respects the per-bot-pair reply cooldown", async () => {
    // Unique pair to avoid the module-level cooldown map leaking across tests.
    createBot(home, "cd-writer");
    createBot(home, "cd-reader");
    const tool = createSendMessageTool({ home, fromBot: "cd-writer", replyCooldownMs: 60_000 });
    const handler = tool.handler as (
      args: Record<string, unknown>,
      ctx: unknown,
    ) => Promise<unknown>;
    const args = { to: "cd-reader", subject: "hi", body: "hello" };
    const first = await handler(args, {});
    expect(String(first)).toContain("Delivered");
    // A second send to the same bot within the cooldown window is suppressed.
    await expect(handler(args, {})).rejects.toThrow(/cooldown/i);
  });

  // #181: the reply-cooldown knob is parsed from gateway.heartbeat config.
  test("gateway.heartbeat.replyCooldownMs parses and rejects bad values", () => {
    const ok = parseGatewaySettings({
      heartbeat: { enabled: true, bot: "worker", every: "30m", replyCooldownMs: 5000 },
    });
    expect(ok.heartbeat?.replyCooldownMs).toBe(5000);
    expect(() =>
      parseGatewaySettings({ heartbeat: { enabled: true, bot: "worker", replyCooldownMs: -1 } }),
    ).toThrow(/replyCooldownMs/);
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

  // A provider that completes one spending iteration (forcing the loop to a
  // second call), then hangs on a call that honors the abort signal — models a
  // real upstream that stops when told to.
  function abortingHangingProvider() {
    let calls = 0;
    const aborted = { fired: false };
    return {
      name: "mock",
      aborted,
      async chat(_req: unknown, _callbacks?: unknown, signal?: AbortSignal) {
        calls += 1;
        if (calls === 1) {
          return {
            stopReason: "tool_use",
            content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "." } }],
            usage: { inputTokens: 100, outputTokens: 50 },
          };
        }
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted.fired = true;
            reject(new Error("aborted"));
          });
        });
      },
    };
  }

  test("a job timeout really aborts the run and books spend up to the abort (#190)", async () => {
    const prov = abortingHangingProvider();
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({
        gateway: { jobs: [{ name: "digest", bot: "worker", prompt: "p", every: "1h", timeoutMs: 40 }] },
      }),
      registry: { get: () => prov } as never,
    });

    const started = Date.now();
    const result = await gw.runNow("digest");
    const took = Date.now() - started;

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(String(result.error)).toMatch(/timed out/);
    expect(took).toBeLessThan(2_000);
    // the abort reached the hanging provider — the run's work actually ended
    expect(prov.aborted.fired).toBe(true);

    const job = gw.jobs[0];
    if (!job) throw new Error("missing job");
    expect(job.running).toBe(false);
    // spend from the completed first iteration is booked on the timeout run
    expect(job.lastRun?.stopReason).toBe("timeout");
    expect(job.lastRun?.costUSD).toBeGreaterThan(0);
    // and the persisted history entry carries it too
    expect(job.history[0]?.status).toBe("timeout");
    expect(job.history[0]?.costUSD).toBeGreaterThan(0);
  });
});

describe("per-bot routines (#102)", () => {
  function botWithConfig(name: string, yaml: string): void {
    createBot(home, name);
    writeFileSync(join(home, "bots", name, "config.yaml"), yaml);
  }

  test("bot routines and per-bot heartbeat register as jobs with bot context", () => {
    botWithConfig(
      "night",
      "routines:\n  - name: digest\n    prompt: Summarize.\n    cron: \"0 2 * * *\"\nheartbeat:\n  every: 30m\n",
    );
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({}),
      registry: { get: () => mockProvider() } as never,
    });

    const digest = gw.jobs.find((j) => j.name === "digest");
    expect(digest?.botName).toBe("night");
    expect(digest?.kind).toBe("job");
    expect(digest?.policy).toBe("read-only"); // allowWrites false → default
    expect(new Date(digest?.nextDueMs ?? 0).getHours()).toBe(2);

    const hb = gw.jobs.find((j) => j.name === "heartbeat-night");
    expect(hb?.botName).toBe("night");
    expect(hb?.kind).toBe("heartbeat");
  });

  test("bot routine fires in the bot context — session lands in that bot's sessions dir", async () => {
    botWithConfig("night", "routines:\n  - name: digest\n    prompt: Summarize overnight.\n    every: 1m\n");
    const capture: { req?: ChatRequest } = {};
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({}),
      registry: {
        get: () => ({
          name: "mock",
          async chat(req: ChatRequest): Promise<ChatResponse> {
            capture.req = req;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "NIGHT OUT" }],
              usage: { inputTokens: 10, outputTokens: 5 },
            };
          },
        }),
      } as never,
    });

    await gw.fireDue(Date.now() + 120_000);
    await Bun.sleep(50);

    // The routine ran with the routine's prompt...
    expect(String(capture.req?.messages[0]?.content)).toContain("Summarize overnight.");
    // ...and the session log landed in the bot's own sessions dir.
    const files = readdirSync(join(home, "bots", "night", "sessions")).filter((f) =>
      f.endsWith(".jsonl"),
    );
    expect(files.length).toBeGreaterThan(0);
  });

  test("per-bot heartbeat fires with the heartbeat prompt and inbox tools", async () => {
    botWithConfig("night", "heartbeat:\n  every: 30m\n");
    const capture: { req?: ChatRequest } = {};
    const gw = new Gateway({
      home,
      cwd: home,
      config: config({}),
      registry: {
        get: () => ({
          name: "mock",
          async chat(req: ChatRequest): Promise<ChatResponse> {
            capture.req = req;
            return {
              stopReason: "end_turn",
              content: [{ type: "text", text: "ok" }],
              usage: { inputTokens: 5, outputTokens: 5 },
            };
          },
        }),
      } as never,
    });

    await gw.fireDue(Date.now() + 60 * 60_000);
    await Bun.sleep(30);

    // The heartbeat ran as the night bot (not the default).
    expect(String(capture.req?.messages[0]?.content)).toContain("Heartbeat check");
    expect(capture.req?.messages[0]?.content).toContain("Your inbox is empty.");
    const toolNames = (capture.req?.tools ?? []).map((t: any) => t.name);
    expect(toolNames).toContain("check_inbox");
    expect(toolNames).toContain("send_message");
  });

  test("duplicate routine name across bots is rejected at boot", () => {
    botWithConfig("light", "routines:\n  - name: digest\n    prompt: p\n    every: 1m\n");
    botWithConfig("night", "routines:\n  - name: digest\n    prompt: p\n    every: 1m\n");
    expect(
      () =>
        new Gateway({
          home,
          cwd: home,
          config: config({}),
          registry: { get: () => mockProvider() } as never,
        }),
    ).toThrow(/duplicate job name/);
  });
});
