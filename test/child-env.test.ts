import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnvironment } from "../src/security/child-env";
import { Redactor } from "../src/security/redact";
import { buildBashChildEnvironment, createBashTool } from "../src/tools/bash";
import { dispatch } from "../src/tools/registry";
import { buildBwrapArgs } from "../src/tools/sandbox";

function linuxBwrapLifecycleAvailable(): boolean {
  if (
    process.platform !== "linux" ||
    !existsSync("/usr/bin/bwrap") ||
    !existsSync("/usr/bin/setsid")
  ) {
    return false;
  }
  try {
    const probe = Bun.spawnSync(
      buildBwrapArgs({
        writableRoots: [process.cwd()],
        readOnly: true,
        command: ["/bin/true"],
      }),
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

describe("child environment boundary", () => {
  test("inherits only the safe ambient allowlist", () => {
    const child = buildChildEnvironment({
      PATH: "/safe/bin",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      OPENAI_API_KEY: "provider-secret",
      TELEGRAM_BOT_TOKEN: "channel-secret",
      GITHUB_TOKEN: "source-secret",
      AWS_SECRET_ACCESS_KEY: "cloud-secret",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      HOME: "/host/home",
      TENJIN_HOME: "/host/tenjin",
    });

    expect(child).toEqual({
      PATH: "/safe/bin",
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
    });
  });

  test("explicit values are scoped additions and may override base values", () => {
    const child = buildChildEnvironment(
      { PATH: "/host/bin", OPENAI_API_KEY: "not-ambient" },
      {
        isolatedHome: "/isolated/home",
        explicit: { PATH: "/server/bin", SERVER_TOKEN: "explicit-secret", OMIT: undefined },
      },
    );

    expect(child).toEqual({
      PATH: "/server/bin",
      HOME: "/isolated/home",
      SERVER_TOKEN: "explicit-secret",
    });
  });

  test("bash receives an isolated HOME but no host credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenjin-child-env-"));
    const tool = createBashTool(
      {
        PATH: process.env.PATH,
        LANG: "C",
        HOME: "/host/home",
        OPENAI_API_KEY: "provider-secret",
        TELEGRAM_BOT_TOKEN: "channel-secret",
        TENJIN_HOME: "/host/tenjin",
      },
      { allowUnsandboxed: true },
    );

    try {
      const result = await dispatch(
        [tool],
        "bash",
        {
          command:
            "printf '%s|%s|%s|%s' \"$OPENAI_API_KEY\" \"$TELEGRAM_BOT_TOKEN\" \"$TENJIN_HOME\" \"$HOME\"",
          sandbox: "off",
        },
        { cwd: dir },
      );

      expect(result.ok).toBe(true);
      expect(result.output).toContain(`|||${realpathSync(dir)}`);
      expect(result.output).not.toContain("provider-secret");
      expect(result.output).not.toContain("channel-secret");
      expect(result.output).not.toContain("/host/tenjin");
      expect(result.output).not.toContain("/host/home");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bash overrides every ambient temp variable with its isolated temp", () => {
    const env = buildBashChildEnvironment(
      "/workspace",
      { TMPDIR: "/host/tmpdir", TMP: "/host/tmp", TEMP: "/host/temp" },
      "/isolated/tmp",
    );
    expect(env.HOME).toBe("/workspace");
    expect(env.TMPDIR).toBe("/isolated/tmp");
    expect(env.TMP).toBe("/isolated/tmp");
    expect(env.TEMP).toBe("/isolated/tmp");
  });

  test("bash is fail-closed when no native sandbox is available", async () => {
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => null,
        buildSandboxPrefix: () => null,
      },
    );

    const result = await dispatch([tool], "bash", { command: "echo must-not-run" }, { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/sandbox unavailable/i);
  });

  test("tool input cannot disable the sandbox without a host capability", async () => {
    const tool = createBashTool({ PATH: process.env.PATH });
    const result = await dispatch(
      [tool],
      "bash",
      { command: "echo must-not-run", sandbox: "off" },
      { cwd: process.cwd() },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/disabled by host policy/i);
  });

  test("missing ready marker turns sandbox initialization into a tool error", async () => {
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => "bwrap",
        buildSandboxPrefix: () => [
          "/bin/bash",
          "-c",
          "printf 'synthetic sandbox init failure\\n' >&2; exit 71",
        ],
      },
    );

    const result = await dispatch(
      [tool],
      "bash",
      { command: "echo must-not-run" },
      { cwd: process.cwd() },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/sandbox failed to initialize/i);
    expect(result.output).toContain("synthetic sandbox init failure");
  });

  test("redacts the full missing-marker diagnostic before limiting it", async () => {
    const secret = "opaque-sandbox-init-secret-123456789";
    const diagnostic = `${"x".repeat(490)}${secret}`;
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => "bwrap",
        buildSandboxPrefix: () => [
          "/bin/bash",
          "-c",
          'printf "%s" "$1" >&2; exit 71',
          "synthetic-init",
          diagnostic,
        ],
      },
    );

    const result = await dispatch(
      [tool],
      "bash",
      { command: "echo must-not-run" },
      { cwd: process.cwd(), redactor: new Redactor(true, [secret]) },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("[REDACTED]");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(secret.slice(0, 10));
  });

  test("bwrap launch maps the seccomp program to child fd 3", async () => {
    let requestedChildFd: number | undefined;
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => "bwrap",
        buildSandboxPrefix: (opts) => {
          requestedChildFd = opts.seccompFd;
          return opts.command;
        },
      },
    );

    const result = await dispatch(
      [tool],
      "bash",
      { command: 'test -r /dev/fd/3 && printf "seccomp-fd-ready"' },
      { cwd: process.cwd() },
    );
    expect(requestedChildFd).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("seccomp-fd-ready");
  });

  test("ready marker is stripped and preserves a normal nonzero user exit", async () => {
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => "bwrap",
        buildSandboxPrefix: (opts) => {
          return opts.command;
        },
      },
    );

    const result = await dispatch(
      [tool],
      "bash",
      { command: "printf user-output; exit 23" },
      { cwd: process.cwd() },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("exit: 23");
    expect(result.output).toContain("user-output");
    expect(result.output).not.toContain("__TENJIN_SANDBOX_READY__");
  });

  test("rejects injected Seatbelt before running its policy builder", async () => {
    let builderCalled = false;
    const tool = createBashTool(
      { PATH: process.env.PATH },
      {
        detectSandbox: () => "sandbox-exec",
        buildSandboxPrefix: () => {
          builderCalled = true;
          return ["/bin/false"];
        },
      },
    );

    const result = await dispatch(
      [tool],
      "bash",
      { command: "echo must-not-run" },
      { cwd: process.cwd() },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/cannot reliably terminate descendants/i);
    expect(builderCalled).toBe(false);
  });

  test("realpaths the workspace and rejects an alias of the host root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenjin-root-alias-"));
    const rootAlias = join(dir, "workspace");
    symlinkSync("/", rootAlias, "dir");
    const tool = createBashTool(
      { PATH: process.env.PATH },
      { allowUnsandboxed: true },
    );

    try {
      const result = await dispatch(
        [tool],
        "bash",
        { command: "echo must-not-run", sandbox: "off" },
        { cwd: rootAlias },
      );
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/host root/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("terminates the process group when combined output exceeds the hard limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenjin-output-limit-"));
    const tool = createBashTool(
      { PATH: process.env.PATH },
      { allowUnsandboxed: true },
    );

    try {
      const result = await dispatch(
        [tool],
        "bash",
        {
          command: "printf '%020000d' 0; printf '%020000d' 0 >&2",
          sandbox: "off",
        },
        { cwd: dir },
      );
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/output exceeded.*30000-byte safety limit/i);
      expect(result.output.length).toBeLessThan(200);
      expect(result.output).not.toContain("0000000000000000");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kills ordinary background descendants after direct exit and timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tenjin-process-group-"));
    const tool = createBashTool(
      { PATH: process.env.PATH },
      { allowUnsandboxed: true },
    );
    const directExitMarker = join(dir, "direct-exit-survivor");
    const timeoutMarker = join(dir, "timeout-survivor");

    try {
      const directExit = await dispatch(
        [tool],
        "bash",
        {
          command: `(/bin/sleep 0.25; printf survived > ${JSON.stringify(directExitMarker)}) &`,
          sandbox: "off",
        },
        { cwd: dir },
      );
      expect(directExit.ok).toBe(true);

      const timedOut = await dispatch(
        [tool],
        "bash",
        {
          command: `(/bin/sleep 0.25; printf survived > ${JSON.stringify(timeoutMarker)}) & /bin/sleep 5`,
          sandbox: "off",
          timeoutMs: 40,
        },
        { cwd: dir },
      );
      expect(timedOut.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(existsSync(directExitMarker)).toBe(false);
      expect(existsSync(timeoutMarker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!linuxBwrapLifecycleAvailable())(
    "Linux bwrap PID namespace tears down a setsid descendant",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tenjin-bwrap-setsid-"));
      const marker = join(dir, "detached-survivor");
      try {
        const result = await dispatch(
          [createBashTool()],
          "bash",
          {
            command: `/usr/bin/setsid /bin/bash -c '/bin/sleep 0.4; printf survived > ${marker}' >/dev/null 2>&1 & /bin/sleep 0.15`,
          },
          { cwd: dir },
        );
        expect(result.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
