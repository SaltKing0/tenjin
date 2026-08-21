import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, HELP } from "../src/cli/args";
import { ConfigError } from "../src/config/loader";
import {
  addJob,
  listJobs,
  removeJob,
  findJob,
  runJob,
  configYamlPath,
} from "../src/cli/jobs";
import { createBot } from "../src/bots/profile";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import type { HarnessConfig } from "../src/config/types";

const testConfig: HarnessConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  maxTokens: 1024,
  budgetUSD: 5,
  approval: {},
};

function mockProvider(reply: string): Provider {
  return {
    name: "mock",
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return {
        stopReason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 1000, outputTokens: 500 },
      };
    },
  };
}

test("HELP mentions all flags", () => {
  for (const flag of ["--model", "--provider", "--budget", "--resume", "-p"]) {
    expect(HELP).toContain(flag);
  }
  expect(HELP).toContain("tenjin tell");
});

describe("parseArgs", () => {
  test("empty argv → defaults", () => {
    expect(parseArgs([])).toEqual({ help: false, version: false });
  });

  test("-h and --help set help flag", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  test("-v and --version set version flag", () => {
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["--model", "x"]).version).toBe(false);
  });

  test("-p consumes the entire remainder as prompt", () => {
    expect(parseArgs(["-p", "fix", "the", "bug"]).print).toBe("fix the bug");
    expect(parseArgs(["--model", "x", "-p", "hello world"]).print).toBe("hello world");
  });

  test("-p without prompt throws", () => {
    expect(() => parseArgs(["-p"])).toThrow(ConfigError);
    expect(() => parseArgs(["--print", "   "])).toThrow(/requires a prompt/);
  });

  test("value flags parse", () => {
    const a = parseArgs([
      "--model",
      "gpt-4o",
      "--provider",
      "openai",
      "--budget",
      "2.5",
      "--resume",
      "abc123",
    ]);
    expect(a.model).toBe("gpt-4o");
    expect(a.provider).toBe("openai");
    expect(a.budget).toBe(2.5);
    expect(a.resume).toBe("abc123");
  });

  test("value flags without a value throw", () => {
    for (const flag of ["--model", "--provider", "--resume", "--bot"]) {
      expect(() => parseArgs([flag])).toThrow(ConfigError);
    }
    expect(() => parseArgs(["--model"])).toThrow(/requires a value/);
  });

  test("--budget requires a finite number", () => {
    expect(() => parseArgs(["--budget"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--budget", "abc"])).toThrow(/must be a number/);
    expect(() => parseArgs(["--budget", "NaN"])).toThrow(/must be a number/);
    expect(parseArgs(["--budget", "2.5"]).budget).toBe(2.5);
  });

  test("unknown argument throws with help text", () => {
    try {
      parseArgs(["--wat"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("--wat");
      expect((e as Error).message).toContain("--help");
    }
  });

  test("flags after -p are ignored (prompt swallows them)", () => {
    const a = parseArgs(["-p", "say", "--model", "x"]);
    expect(a.print).toBe("say --model x");
    expect(a.model).toBeUndefined();
  });

  describe("--fork", () => {
    test("id only forks at end", () => {
      expect(parseArgs(["--fork", "abc123"]).fork).toEqual({
        id: "abc123",
        uptoEvent: undefined,
      });
    });

    test("numeric second token becomes event index", () => {
      expect(parseArgs(["--fork", "abc", "14"]).fork).toEqual({
        id: "abc",
        uptoEvent: 14,
      });
    });

    test("non-numeric second token is left alone (treated as unknown arg later)", () => {
      const a = parseArgs(["--fork", "abc"]);
      expect(a.fork?.id).toBe("abc");
      expect(a.fork?.uptoEvent).toBeUndefined();
    });

    test("missing id throws", () => {
      expect(() => parseArgs(["--fork"])).toThrow(/requires a session id/);
    });
  });
});

describe("e2e: --version flag", () => {
  const CLI = join(import.meta.dir, "..", "src", "index.ts");
  function run(args: string[]): { exitCode: number | null; stdout: string } {
    const p = Bun.spawnSync(["bun", "run", CLI, ...args], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        TENJIN_HOME: mkdtempSync(join(tmpdir(), "tj-ver-")),
      },
    });
    return { exitCode: p.exitCode, stdout: p.stdout.toString() };
  }

  test("--version prints the version banner and exits 0", () => {
    const { exitCode, stdout } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^Tenjin v\d+\.\d+\.\d+$/);
  });

  test("-v prints the same version banner", () => {
    const { exitCode, stdout } = run(["-v"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^Tenjin v\d+\.\d+\.\d+$/);
  });

  test("--version needs no config / keys (skips model check)", () => {
    const { exitCode } = run(["--version"]);
    expect(exitCode).toBe(0);
  });
});

describe("tenjin job management", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tj-jobcli-"));
    createBot(home, "researcher", { soul: "You are researcher. Be terse." });
    writeFileSync(
      join(home, "config.yaml"),
      "provider: anthropic\nmodel: claude-sonnet-4-5\n",
    );
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("addJob rejects invalid cron before writing anything", () => {
    expect(() =>
      addJob(home, { bot: "researcher", cron: "not a cron", prompt: "p" }),
    ).toThrow(/cron/);
    expect(listJobs(home)).toHaveLength(0);
    expect(readFileSync(configYamlPath(home), "utf8")).not.toContain("jobs");
  });

  test("addJob rejects an unknown bot", () => {
    expect(() =>
      addJob(home, { bot: "ghost", cron: "0 9 * * *", prompt: "p" }),
    ).toThrow(/bot/i);
    expect(listJobs(home)).toHaveLength(0);
  });

  test("add → list roundtrip includes nextDue and cron", () => {
    const name = addJob(home, { bot: "researcher", cron: "0 9 * * *", prompt: "check the news" });
    expect(name).toBe("job-1");
    const views = listJobs(home);
    expect(views).toHaveLength(1);
    const v = views[0]!;
    expect(v.name).toBe("job-1");
    expect(v.bot).toBe("researcher");
    expect(v.cron).toBe("0 9 * * *");
    expect(v.nextDueMs).toBeGreaterThan(Date.now());
    expect(v.lastRun).toBeNull();
  });

  test("add generates unique names", () => {
    expect(addJob(home, { bot: "researcher", cron: "0 8 * * *", prompt: "a" })).toBe("job-1");
    expect(addJob(home, { bot: "researcher", cron: "0 7 * * *", prompt: "b" })).toBe("job-2");
    expect(listJobs(home)).toHaveLength(2);
  });

  test("removeJob removes and reports unknown ids", () => {
    const name = addJob(home, { bot: "researcher", cron: "0 6 * * *", prompt: "x" });
    expect(listJobs(home)).toHaveLength(1);
    expect(removeJob(home, name)).toBe(true);
    expect(listJobs(home)).toHaveLength(0);
    expect(removeJob(home, name)).toBe(false);
  });

  test("add writes config.yaml in block style", () => {
    addJob(home, { bot: "researcher", cron: "0 9 * * *", prompt: "check" });
    const raw = readFileSync(configYamlPath(home), "utf8");
    // YAML.stringify emits block-style mappings (no inline braces for jobs).
    expect(raw).toContain("gateway:");
    expect(raw).toContain("- name:");
    expect(raw).toContain('cron: "0 9 * * *"');
  });

  test("runJob executes headless as the bot and returns output", async () => {
    const name = addJob(home, { bot: "researcher", cron: "0 9 * * *", prompt: "summarize the day" });
    const res = await runJob(home, name, {
      home,
      cwd: home,
      config: testConfig,
      provider: mockProvider("morning briefing ready"),
    });
    expect(res).toMatchObject({ ok: true });
    expect(res.ok && res.text).toContain("morning briefing");
    expect(res.ok && res.stopReason).toBe("end_turn");
  });

  test("runJob with unknown id returns an error", async () => {
    const res = await runJob(home, "job-99", {
      home,
      cwd: home,
      config: testConfig,
      provider: mockProvider("x"),
    });
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.error).toMatch(/unknown job/);
  });

  test("findJob throws for a missing id", () => {
    expect(() => findJob(home, "nope")).toThrow(/unknown job/);
  });
});
