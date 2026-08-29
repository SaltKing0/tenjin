#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  artifactName,
  buildChecksumsFile,
  computeChecksum,
  resolveDistTarget,
} from "../src/dist";
import { stringifyBlockStyle } from "../src/config/block-style";
import { buildRelease } from "./build-release";

const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "release-blackbox-token-7c53d6e40d71";
const AGENT_REPLY = "RELEASE_BLACKBOX_AGENT_OK";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be a mapping`);
  return value as Record<string, unknown>;
}

async function run(
  command: string[],
  options: { cwd: string; env?: Record<string, string | undefined>; stdin?: string },
): Promise<RunResult> {
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function ok(stage: string): void {
  process.stdout.write(`[release:blackbox] ok ${stage}\n`);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  assert(typeof pkg.version === "string" && pkg.version.length > 0, "invalid package version");
  return pkg.version;
}

function nativeTarget() {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  const target = resolveDistTarget(platform, architecture);
  assert(target, `unsupported blackbox host: ${process.platform}/${process.arch}`);
  return target;
}

function openAiSse(text: string): string {
  return (
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4 } })}\n\n` +
    "data: [DONE]\n\n"
  );
}

function reservePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function waitForGateway(
  baseUrl: string,
  processHandle: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  let lastError = "gateway did not respond";
  for (let attempt = 0; attempt < 120; attempt++) {
    if (processHandle.exitCode !== null) {
      throw new Error(`gateway exited early with ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
      lastError = `gateway returned ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await Bun.sleep(100);
  }
  throw new Error(`gateway startup timeout: ${lastError}`);
}

function parseArtifactArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--artifact") {
      const value = argv[++i];
      if (!value) throw new Error("--artifact requires a path");
      return isAbsolute(value) ? value : resolve(process.cwd(), value);
    }
    throw new Error(`unknown argument: ${argv[i]}`);
  }
  return undefined;
}

export async function runReleaseBlackbox(providedArtifact?: string): Promise<void> {
  const version = packageVersion();
  const target = nativeTarget();
  const expectedArtifactName = artifactName(target);
  const root = mkdtempSync(join(tmpdir(), "tenjin-release-blackbox-"));
  const buildDir = join(root, "build");
  const installDir = join(root, "bin");
  const home = join(root, "home");
  const work = join(root, "workspace-without-sources");
  const scratch = join(root, "tmp");
  for (const dir of [buildDir, installDir, home, work, scratch]) {
    mkdirSync(dir, { recursive: true });
  }

  let mockServer: ReturnType<typeof Bun.serve> | undefined;
  let gateway: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayStdout: Promise<string> | undefined;
  let gatewayStderr: Promise<string> | undefined;

  try {
    const artifact = providedArtifact ?? join(buildDir, expectedArtifactName);
    if (!providedArtifact) {
      await buildRelease({ target: target.bunTarget, outfile: artifact, version });
    }
    assert(existsSync(artifact), `release artifact missing: ${artifact}`);
    ok("native artifact built");

    const checksum = await computeChecksum(artifact);
    const sums = buildChecksumsFile([{ name: expectedArtifactName, hash: checksum }]);
    const tag = `v${version}`;
    mockServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === `/releases/download/${tag}/${expectedArtifactName}`) {
          return new Response(Bun.file(artifact));
        }
        if (url.pathname === `/releases/download/${tag}/SHA256SUMS`) {
          return new Response(sums, { headers: { "content-type": "text/plain" } });
        }
        if (url.pathname === "/v1/models" && request.method === "GET") {
          return Response.json({ data: [{ id: "mock-model" }] });
        }
        if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
          return new Response(openAiSse(AGENT_REPLY), {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const mockBase = `http://127.0.0.1:${mockServer.port}`;

    const env: Record<string, string | undefined> = {
      ...process.env,
      TENJIN_HOME: home,
      TENJIN_RELEASES_URL: `${mockBase}/releases`,
      TMPDIR: scratch,
    };
    const install = await run(
      [
        "sh",
        join(ROOT, "install.sh"),
        `--platform=${target.platform}`,
        `--arch=${target.arch}`,
        `--version=${tag}`,
        `--dir=${installDir}`,
      ],
      { cwd: work, env },
    );
    assert(install.code === 0, `installer failed:\n${install.stdout}${install.stderr}`);
    const installed = join(installDir, `tenjin${target.ext}`);
    assert(existsSync(installed), `installer did not create ${basename(installed)}`);
    assert(!existsSync(join(installDir, expectedArtifactName)), "installer leaked the platform artifact name");
    ok("installer produced tenjin");

    const versionRun = await run([installed, "--version"], { cwd: work, env });
    assert(versionRun.code === 0, `--version failed: ${versionRun.stderr}`);
    assert(
      versionRun.stdout.trim() === `Tenjin v${version}`,
      `binary version mismatch: expected ${version}, got ${versionRun.stdout.trim()}`,
    );
    ok("embedded version matches package.json");

    const onboard = await run(
      [
        installed,
        "onboard",
        "--provider",
        "openai",
        "--key",
        "sk-release-blackbox",
        "--base-url",
        `${mockBase}/v1`,
        "--model",
        "mock-model",
        "--bot-name",
        "release-bot",
        "--role",
        "coder",
        "--trust",
        "supervised",
        "--gateway-token",
        TOKEN,
        "--example-routine",
        "--yes",
      ],
      { cwd: work, env },
    );
    assert(onboard.code === 0, `onboarding failed:\n${onboard.stdout}${onboard.stderr}`);
    assert(existsSync(join(home, "providers.yaml")), "onboarding did not persist provider config");
    assert(existsSync(join(home, "bots", "release-bot", "SOUL.md")), "onboarding did not create the bot");

    const configPath = join(home, "config.yaml");
    const config = mapping(Bun.YAML.parse(readFileSync(configPath, "utf8")), "onboard config");
    const mode = mapping(config.mode, "onboard mode");
    const gatewayConfig = mapping(config.gateway, "onboard gateway");
    const listen = mapping(gatewayConfig.listen, "onboard gateway.listen");
    const jobs = gatewayConfig.jobs;
    assert(config.defaultBot === "release-bot", "onboarding did not select the requested bot");
    assert(mode.ladder === "manual", "supervised onboarding did not select manual mode");
    assert(gatewayConfig.allowWrites === true, "supervised onboarding did not enable approval-gated writes");
    assert(listen.token === TOKEN, "onboarding did not persist the requested gateway token");
    assert(Array.isArray(jobs), "onboarding did not create a routines list");
    const exampleRoutine = jobs.find(
      (job) => mapping(job, "onboard routine").name === "daily-repo-watch",
    ) as Record<string, unknown> | undefined;
    assert(exampleRoutine, "onboarding did not create the daily repo watch");
    assert(exampleRoutine.bot === "release-bot", "daily repo watch routes to the wrong bot");
    assert(exampleRoutine.policy === "read-only", "daily repo watch is not read-only");
    const botConfig = mapping(
      Bun.YAML.parse(readFileSync(join(home, "bots", "release-bot", "config.yaml"), "utf8")),
      "onboard bot config",
    );
    assert(mapping(botConfig.security, "onboard bot security").policy === "full", "supervised bot policy is not full");
    ok("golden journey persisted provider, bot, trust, token and routine");

    const doctor = await run([installed, "doctor", "--online", "--json"], {
      cwd: work,
      env,
    });
    assert(doctor.code === 0, `doctor preflight failed:\n${doctor.stdout}${doctor.stderr}`);
    assert(!doctor.stdout.includes("sk-release-blackbox"), "doctor leaked the provider key");
    assert(!doctor.stdout.includes(TOKEN), "doctor leaked the gateway token");
    const doctorReport = mapping(JSON.parse(doctor.stdout), "doctor report");
    assert(doctorReport.ok === true, "doctor JSON report is not healthy");
    const doctorChecks = doctorReport.checks;
    assert(Array.isArray(doctorChecks), "doctor JSON report has no checks array");
    assert(
      doctorChecks.some(
        (check) => mapping(check, "doctor check").id === "provider_chat" && mapping(check, "doctor check").state === "ok",
      ),
      "doctor did not verify provider chat",
    );
    ok("redacted online doctor preflight passed");

    const gatewayPort = reservePort();
    config.memory = { ...mapping(config.memory, "onboard memory"), enabled: false };
    config.mcpServer = { expose: ["read_file"] };
    gatewayConfig.listen = {
      ...listen,
      host: "127.0.0.1",
      port: gatewayPort,
      token: TOKEN,
    };
    writeFileSync(
      configPath,
      stringifyBlockStyle(config),
      { mode: 0o600 },
    );

    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "blackbox", version: "1" } },
    });
    const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const mcp = await run([installed, "mcp-serve"], {
      cwd: work,
      env,
      stdin: `${initialize}\n${toolsList}\n`,
    });
    assert(mcp.code === 0, `mcp-serve failed:\n${mcp.stdout}${mcp.stderr}`);
    const frames = mcp.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert(frames[0]?.result?.serverInfo?.name === "tenjin", "mcp initialize response missing");
    assert(frames[0]?.result?.serverInfo?.version === version, "mcp server version does not match package version");
    assert(
      frames[1]?.result?.tools?.some((tool: { name?: string }) => tool.name === "read_file"),
      "mcp-serve did not expose the configured tool",
    );
    ok("mcp-serve dispatch works");

    gateway = Bun.spawn([installed, "gateway"], {
      cwd: work,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    gatewayStdout = new Response(gateway.stdout).text();
    gatewayStderr = new Response(gateway.stderr).text();
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    await waitForGateway(gatewayBase, gateway);
    ok("gateway started");

    const consoleResponse = await fetch(gatewayBase);
    const consoleHtml = await consoleResponse.text();
    assert(consoleResponse.ok && consoleHtml.includes("Tenjin Console"), "embedded console HTML unavailable");
    const bundleResponse = await fetch(`${gatewayBase}/console/app.bundle.js`);
    assert(bundleResponse.ok && (await bundleResponse.text()).length > 1_000, "embedded console bundle unavailable");
    ok("embedded console assets served");

    const unauthorized = await fetch(`${gatewayBase}/api/health`);
    assert(unauthorized.status === 401, "health endpoint is not token protected");
    const health = await fetch(`${gatewayBase}/api/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert(health.ok, `authenticated healthcheck failed with ${health.status}`);
    const healthBody = (await health.json()) as { status?: string };
    assert(typeof healthBody === "object", "healthcheck returned invalid JSON");
    ok("authenticated healthcheck passed");

    const authHeaders = {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    };
    const firstRun = await fetch(`${gatewayBase}/message`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ bot: "release-bot", text: "Reply with the release blackbox marker." }),
    });
    const firstRunBody = (await firstRun.json()) as { reply?: string; error?: string };
    assert(firstRun.ok, `first agent run failed: ${firstRun.status} ${JSON.stringify(firstRunBody)}`);
    assert(firstRunBody.reply?.includes(AGENT_REPLY), "first agent run returned the wrong reply");
    ok("first agent run completed");

    const routineRun = await fetch(`${gatewayBase}/api/jobs/daily-repo-watch/run`, {
      method: "POST",
      headers: authHeaders,
    });
    const routineBody = (await routineRun.json()) as {
      ok?: boolean;
      name?: string;
      text?: string;
      error?: string;
    };
    assert(routineRun.ok, `daily repo watch failed: ${routineRun.status} ${JSON.stringify(routineBody)}`);
    assert(routineBody.ok && routineBody.name === "daily-repo-watch", "daily repo watch returned an invalid result");
    assert(routineBody.text?.includes(AGENT_REPLY), "daily repo watch returned the wrong reply");

    const activityResponses = await Promise.all([
      fetch(`${gatewayBase}/api/sessions?bot=all&limit=5`, { headers: authHeaders }),
      fetch(`${gatewayBase}/api/spend?days=7`, { headers: authHeaders }),
      fetch(`${gatewayBase}/api/audit?tail=8`, { headers: authHeaders }),
      fetch(`${gatewayBase}/api/jobs`, { headers: authHeaders }),
    ]);
    assert(activityResponses.every((response) => response.ok), "one or more Activity endpoints failed");
    const listedJobs = (await activityResponses[3]!.json()) as {
      jobs?: Array<{ name?: string; lastRun?: { stopReason?: string } }>;
    };
    const completedRoutine = listedJobs.jobs?.find((job) => job.name === "daily-repo-watch");
    assert(completedRoutine?.lastRun?.stopReason === "end_turn", "routine result was not recorded for Activity");
    ok("golden journey pilot completed with routine, cost and audit activity");
  } catch (error) {
    if (gateway && gateway.exitCode === null) gateway.kill();
    const [stdout, stderr] = await Promise.all([
      gatewayStdout ?? Promise.resolve(""),
      gatewayStderr ?? Promise.resolve(""),
    ]);
    const detail = stdout || stderr ? `\n--- gateway stdout ---\n${stdout}\n--- gateway stderr ---\n${stderr}` : "";
    throw new Error(`${(error as Error).message}${detail}`);
  } finally {
    if (gateway && gateway.exitCode === null) {
      gateway.kill();
      await gateway.exited;
    }
    mockServer?.stop(true);
    if (process.env.TENJIN_KEEP_BLACKBOX !== "1") {
      rmSync(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`[release:blackbox] kept ${root}\n`);
    }
  }
}

if (import.meta.main) {
  await runReleaseBlackbox(parseArtifactArg(process.argv.slice(2)));
}
