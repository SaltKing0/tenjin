import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E test for the Tenjin TUI (src/ui/tui.ts) driven through a real PTY using
 * Bun's native terminal support (Bun.spawn + `terminal` option, Bun >= 1.3.5).
 *
 * This exercises the user-facing layer end to end: boot rendering, the tab bar,
 * the editor, slash commands, Ctrl-N/Ctrl-P tab switching, the sessions panel,
 * and exit semantics — asserted against the actual ANSI frames the TUI paints.
 */

const CLI = join(import.meta.dir, "..", "src", "index.ts");

/** Strip ANSI SGR/CUP/reset escapes so assertions work on plain text. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\[[0-9;]*[mlh]/g, "").replace(/\x1b\[2J/g, "").replace(/\r/g, "");
}

function makeConfig(home: string): void {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    [
      "provider: openai",
      "model: deepseek-v4-flash-0731",
      "maxTokens: 512",
      "budgetUSD: 5",
      "memory:",
      "  enabled: false",
      "providers:",
      "  openai:",
      "    baseUrl: http://127.0.0.1:9/v1",
      "    apiKey: test-key",
      "",
    ].join("\n"),
  );
}

interface Tui {
  proc: ReturnType<typeof Bun.spawn>;
  out: () => string;
  /** Send raw bytes to the TTY (e.g. a command string or a control byte). */
  write: (bytes: Uint8Array | string) => void;
  exited: Promise<number | null>;
}

function startTui(home: string): Tui {
  let buf = "";
  const onData = (data: Uint8Array | string) => {
    const s = typeof data === "string" ? data : new TextDecoder().decode(data);
    buf += s;
  };
  const proc = Bun.spawn(["bun", "run", CLI, "tui"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TENJIN_HOME: home },
    terminal: { cols: 100, rows: 30, data: (_t, data) => onData(data) },
  });
  const exited = proc.exited;
  return {
    proc,
    out: () => stripAnsi(buf),
    write: (bytes) => proc.terminal!.write(bytes),
    exited,
  };
}

/** Poll `buf` until it contains all `needles` or timeout; returns the text. */
async function waitFor(tui: Tui, needles: string[], timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const text = tui.out();
    if (needles.every((n) => text.includes(n))) return text;
    await Bun.sleep(40);
  }
  const text = tui.out();
  throw new Error(
    `timed out waiting for [${needles.join(", ")}].\n--- last 600 chars ---\n${text.slice(-600)}`,
  );
}

describe("tui e2e (PTY, user-facing)", () => {
  let home: string;
  let tui: Tui;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "tj-tui-e2e-"));
    makeConfig(home);
    tui = startTui(home);
    // Wait for the initial paint: status line + prompt + hint line.
    await waitFor(tui, ["◆", "Enter:run", "❯"]);
  });

  afterEach(async () => {
    // If still alive, quit cleanly, then hard-kill as a fallback.
    try {
      if (tui.proc.killed === false) tui.write("/exit\r");
      await Promise.race([tui.exited, Bun.sleep(1500)]);
    } catch {
      /* ignore */
    }
    try {
      tui.proc.kill();
    } catch {
      /* ignore */
    }
    rmSync(home, { recursive: true, force: true });
  });

  test("boot paints the GrokBuild-style status line, tabs, prompt and hints", async () => {
    const text = tui.out();
    // Row 0 status: identity ◆, bot, session id, budget, ctx%.
    expect(text).toContain("◆");
    expect(text).toContain("solo");
    expect(text).toMatch(/#[0-9a-f]{4}/); // session id short (#ffb0)
    expect(text).toContain("$0/$5.00");
    expect(text).toContain("ctx");
    // Tab bar bracket with the active ● mark.
    expect(text).toContain("[●");
    // Prompt ❯ and the hint line.
    expect(text).toContain("❯");
    expect(text).toContain("Enter:run");
  });

  test("editor accepts typed input (characters land in the input line)", async () => {
    tui.write("hello e2e");
    const text = await waitFor(tui, ["hello e2e"]);
    expect(text).toContain("❯ hello e2e");
  });

  test("/help lists the compact slash-command set", async () => {
    tui.write("/help\r");
    const text = await waitFor(tui, ["/new", "/resume", "/exit", "/model"]);
    expect(text).toContain("sessions:  /new  /resume <id>  /fork [n]  /sessions  /exit");
    expect(text).toContain("Ctrl-N/P tabs");
  });

  test("/new opens a second tab and the tab bar grows", async () => {
    tui.write("/new\r");
    await waitFor(tui, ["[●"]);
    await Bun.sleep(300);
    // Two tab ids in the latest tab-bar, still exactly one active ●.
    expect(tabBarIds(tui.out()).length).toBe(2);
    expect(activeTabCount(tui.out())).toBe(1);
  });

  test("/sessions lists the session in the panel and chat", async () => {
    tui.write("/sessions\r");
    const text = await waitFor(tui, ["sessions"]);
    // The session id looks like 202608231221-b6a2 (20 + 10 digits + suffix).
    expect(text).toMatch(/20\d{10}-[0-9a-f]{4}|no sessions yet/);
  });

  test("Ctrl-N / Ctrl-P cycle the active tab", async () => {
    // Open a second tab so there is something to switch to.
    tui.write("/new\r");
    await waitFor(tui, ["[●"]);
    await Bun.sleep(300);
    const firstId = extractActiveTab(tui.out());
    expect(tabBarIds(tui.out()).length).toBe(2);

    tui.write(new Uint8Array([0x0e])); // Ctrl-N → next tab
    await Bun.sleep(300);
    const secondId = extractActiveTab(tui.out());
    expect(secondId).not.toBe(firstId);

    // Ctrl-P → back to the first tab.
    tui.write(new Uint8Array([0x10]));
    await Bun.sleep(300);
    expect(extractActiveTab(tui.out())).toBe(firstId);
  });

  test("/exit closes a tab when >1 open, and quits the process on the last tab", async () => {
    // Open a second tab, then /exit should close it but keep the TUI alive.
    tui.write("/new\r");
    await waitFor(tui, ["[●"]);
    await Bun.sleep(300);
    expect(tabBarIds(tui.out()).length).toBe(2);
    expect(activeTabCount(tui.out())).toBe(1);

    // Close it — process must stay alive (still one tab left).
    tui.write("/exit\r");
    await waitFor(tui, ["[●"]);
    await Bun.sleep(300);
    expect(tui.proc.exitCode ?? null).toBe(null); // still running
    expect(tabBarIds(tui.out()).length).toBe(1);

    // Close the last tab → process must exit 0.
    tui.write("/exit\r");
    const code = await Promise.race([tui.exited, Bun.sleep(4000)]);
    expect(code).toBe(0);
  });
});

/** Extract the bracketed tab bar `[●abcd ·efgh]` from the LATEST frame. The tab
 * bar is the only `[●/· …]` group the UI paints, so it is unambiguous. */
function tabBarText(text: string): string {
  const m = text.match(/\[(?:[●·][0-9a-f]{4})(?: (?:[●·][0-9a-f]{4}))*\]/g);
  const last = m?.[m.length - 1];
  return last ? last.slice(1, -1) : "";
}
function activeTabCount(text: string): number {
  return (tabBarText(text).match(/●/g) ?? []).length;
}
function extractActiveTab(text: string): string {
  const m = tabBarText(text).match(/●([0-9a-f]{4})/);
  return m ? m[1]! : "";
}
function tabBarIds(text: string): string[] {
  return Array.from(tabBarText(text).matchAll(/([●·])([0-9a-f]{4})/g)).map((m) => m[2]!);
}
