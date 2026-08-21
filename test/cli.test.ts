import { describe, test, expect } from "bun:test";
import { parseArgs, HELP } from "../src/cli/args";
import { ConfigError } from "../src/config/loader";

test("HELP mentions all flags", () => {
  for (const flag of ["--model", "--provider", "--budget", "--resume", "-p"]) {
    expect(HELP).toContain(flag);
  }
  expect(HELP).toContain("tenjin tell");
});

describe("parseArgs", () => {
  test("empty argv → defaults", () => {
    expect(parseArgs([])).toEqual({ help: false });
  });

  test("-h and --help set help flag", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
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
