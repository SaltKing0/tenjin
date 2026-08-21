import { describe, test, expect, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = join(
  import.meta.dir,
  "..",
  "ops",
  "docker",
  "entrypoint.sh",
);

/**
 * #244: the container entrypoint must seed a bot under the operator's
 * configured defaultBot (top-level `defaultBot` in config.yaml, or the
 * $TENJIN_DEFAULT_BOT env override) rather than hard-coding "default", and
 * must warn when that defaultBot is missing.
 */
describe("e2e: docker entrypoint defaultBot seeding (#244)", () => {
  let home: string;
  let appDir: string;
  let binDir: string;

  afterEach(() => {
    for (const d of [home, appDir, binDir]) {
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function seedBotShim() {
    // A fake `bun` that records the `bot new <name>` invocation and writes the
    // bot exactly like the real `bot new` does (SOUL.md under TENJIN_HOME/bots).
    const shim = join(binDir, "bun");
    writeFileSync(
      shim,
      `#!/bin/sh
# fake 'bun' for entrypoint tests: emulate 'bot new' (argv: run src/index.ts bot new NAME)
mkdir -p "$TENJIN_HOME/bots/$5"
printf '# SOUL - %s\\n' "$5" > "$TENJIN_HOME/bots/$5/SOUL.md"
exit 0
`,
    );
    chmodSync(shim, 0o755);
  }

  function runEntrypoint(cmd: string[]): { code: number; stdout: string; stderr: string } {
    const env = {
      ...process.env,
      TENJIN_HOME: home,
      TENJIN_APP_DIR: appDir,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const res = Bun.spawnSync([ENTRYPOINT, ...cmd], { env });
    return {
      code: res.exitCode ?? -1,
      stdout: res.stdout.toString(),
      stderr: res.stderr.toString(),
    };
  }

  test("config.yaml defaultBot + fresh volume → bot seeded under that name", () => {
    home = mkdtempSync(join(tmpdir(), "tj-epcfg-"));
    appDir = mkdtempSync(join(tmpdir(), "tj-epapp-"));
    binDir = mkdtempSync(join(tmpdir(), "tj-epbin-"));
    mkdirSync(join(home, "bots"), { recursive: true });
    writeFileSync(join(home, "config.yaml"), "gateway:\n  listen:\n    port: 3000\ndefaultBot: mybot\n");
    seedBotShim();

    const res = runEntrypoint(["echo", "GATEWAY_UP"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("GATEWAY_UP");
    // the seeded bot is named after config defaultBot, not "default"
    expect(readdirSync(join(home, "bots"))).toEqual(["mybot"]);
    expect(res.stdout).toContain("defaultBot=mybot");
  });

  test("env override TENJIN_DEFAULT_BOT wins over config.yaml", () => {
    home = mkdtempSync(join(tmpdir(), "tj-epenv-"));
    appDir = mkdtempSync(join(tmpdir(), "tj-epapp-"));
    binDir = mkdtempSync(join(tmpdir(), "tj-epbin-"));
    mkdirSync(join(home, "bots"), { recursive: true });
    writeFileSync(join(home, "config.yaml"), "defaultBot: fromconfig\n");
    seedBotShim();

    const env = {
      ...process.env,
      TENJIN_HOME: home,
      TENJIN_APP_DIR: appDir,
      TENJIN_DEFAULT_BOT: "fromenv",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const res = Bun.spawnSync([ENTRYPOINT, "echo", "UP"], { env });
    expect(res.exitCode).toBe(0);
    expect(readdirSync(join(home, "bots"))).toEqual(["fromenv"]);
  });

  test("missing configured defaultBot → clear warning on boot", () => {
    home = mkdtempSync(join(tmpdir(), "tj-epwarn-"));
    appDir = mkdtempSync(join(tmpdir(), "tj-epapp-"));
    binDir = mkdtempSync(join(tmpdir(), "tj-epbin-"));
    // volume already has a bot, but config points at a different, missing bot
    mkdirSync(join(home, "bots", "existing"), { recursive: true });
    writeFileSync(join(home, "bots", "existing", "SOUL.md"), "# SOUL\n");
    writeFileSync(join(home, "config.yaml"), "defaultBot: missing\n");

    const res = runEntrypoint(["echo", "UP"]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("configured defaultBot 'missing' does not exist");
    expect(res.stderr).toContain("existing bots: existing");
  });

  test("no defaultBot anywhere → falls back to 'default' (backwards compatible)", () => {
    home = mkdtempSync(join(tmpdir(), "tj-epdef-"));
    appDir = mkdtempSync(join(tmpdir(), "tj-epapp-"));
    binDir = mkdtempSync(join(tmpdir(), "tj-epbin-"));
    mkdirSync(join(home, "bots"), { recursive: true });
    seedBotShim();

    const res = runEntrypoint(["echo", "UP"]);
    expect(res.code).toBe(0);
    expect(readdirSync(join(home, "bots"))).toEqual(["default"]);
  });
});
