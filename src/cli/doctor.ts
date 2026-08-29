import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stdout } from "node:process";
import {
  ensureGlobalDir,
  loadConfig,
  tenjinHome,
  vectorEnabled,
} from "../config/loader";
import type { HarnessConfig } from "../config/types";
import { cheapModelRef, defaultModelRef } from "../config/models";
import { listBots } from "../bots/profile";
import { ENC_PREFIX } from "../security/keyring";
import { Redactor } from "../security/redact";
import { detectSandbox, type SandboxMechanism } from "../tools/sandbox";
import { testProvider } from "../gateway/settings";
import { PRODUCT, VERSION } from "../version";

export type DoctorState = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  state: DoctorState;
  label: string;
  detail?: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  product: string;
  version: string;
  online: boolean;
  ok: boolean;
  counts: Record<DoctorState, number>;
  checks: DoctorCheck[];
}

export interface DoctorDeps {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  write?: (text: string) => void;
  testProvider?: typeof testProvider;
  detectSandbox?: () => SandboxMechanism;
  platform?: NodeJS.Platform;
}

export const DOCTOR_USAGE =
  "usage: tenjin doctor [--online] [--json]\n" +
  "  --online  make one minimal chat request against the configured default model\n" +
  "  --json    emit a stable, machine-readable diagnostic report\n";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function secretValues(value: unknown, key = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    if (/(?:key|token|secret|password|authorization)$/i.test(key) && value.length >= 6) {
      out.push(value);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) secretValues(entry, key, out);
    return out;
  }
  if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      secretValues(child, childKey, out);
    }
  }
  return out;
}

function privateFileCheck(
  path: string,
  id: string,
  label: string,
  platform: NodeJS.Platform,
): DoctorCheck | null {
  if (!existsSync(path) || platform === "win32") return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) === 0) return { id, state: "ok", label, detail: "private permissions" };
    return {
      id,
      state: "warn",
      label,
      detail: `permissions are ${mode.toString(8)}; use 600 for files containing credentials`,
    };
  } catch (e) {
    return { id, state: "warn", label, detail: (e as Error).message };
  }
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

export async function runDoctor(args: string[], deps: DoctorDeps = {}): Promise<number> {
  const home = deps.home ?? tenjinHome();
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((text: string) => stdout.write(text));
  const online = args.includes("--online");
  const json = args.includes("--json");

  if (args.includes("--help") || args.includes("-h")) {
    write(DOCTOR_USAGE);
    return 0;
  }
  const invalid = args.filter((arg) => arg !== "--online" && arg !== "--json");
  if (invalid.length) {
    write(`unknown doctor option "${invalid[0]}"\n${DOCTOR_USAGE}`);
    return 2;
  }

  const checks: DoctorCheck[] = [];
  const add = (id: string, state: DoctorState, label: string, detail?: string) =>
    checks.push({ id, state, label, ...(detail ? { detail } : {}) });

  let config: HarnessConfig | null = null;
  try {
    config = loadConfig(cwd, home, { skipModelCheck: true }).config;
    add("config", "ok", "config loads");
  } catch (e) {
    add("config", "fail", "config loads", (e as Error).message);
  }

  const envSecrets = Object.entries(env)
    .filter(([name, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(name) && (value?.length ?? 0) >= 6)
    .map(([, value]) => value!);
  const knownSecrets = [...envSecrets, ...secretValues(config)];
  const redactor = new Redactor(true, knownSecrets);

  if (config) {
    const ref = defaultModelRef(config);
    if (ref.model) add("model", "ok", `model ${ref.provider}:${ref.model}`);
    else add("model", "warn", "no model configured", "set model in ~/.tenjin/config.yaml");

    const anthropicKey = config.providers?.anthropic?.apiKey ?? env.ANTHROPIC_API_KEY;
    const openaiKey = config.providers?.openai?.apiKey ?? env.OPENAI_API_KEY;
    const needsAnthropic =
      ref.provider === "anthropic" || cheapModelRef(config)?.provider === "anthropic";
    const needsOpenai = ref.provider === "openai" || cheapModelRef(config)?.provider === "openai";

    if (needsAnthropic) {
      add(
        "anthropic_credential",
        anthropicKey ? "ok" : "fail",
        anthropicKey ? "Anthropic credential configured" : "Anthropic credential missing",
        anthropicKey ? (config.providers?.anthropic?.apiKey ? "providers.yaml" : "environment") : "required by anthropic model tier",
      );
    }
    if (needsOpenai) {
      add(
        "openai_credential",
        openaiKey ? "ok" : "warn",
        openaiKey ? "OpenAI credential configured" : "OpenAI credential missing",
        openaiKey ? (config.providers?.openai?.apiKey ? "providers.yaml" : "environment") : "needed for openai tiers + vector memory",
      );
    }
    if (vectorEnabled(config)) {
      add(
        "vector_memory",
        openaiKey ? "ok" : "warn",
        openaiKey ? "vector memory ready" : "vector memory on but no OpenAI credential",
        openaiKey ? undefined : "recall will be unavailable",
      );
    }

    if (config.security?.disabled) {
      add("security_guard", "warn", "security guard DISABLED", "security.disabled: true — tools run without policy");
    } else {
      add("security_guard", "ok", "security guard active");
    }

    const gateway = isRecord(config.gateway) ? config.gateway : null;
    const listen = gateway && isRecord(gateway.listen) ? gateway.listen : null;
    if (!listen) {
      add("gateway", "warn", "gateway console not configured");
    } else {
      const token = typeof listen.token === "string" ? listen.token.trim() : "";
      const host = typeof listen.host === "string" ? listen.host : "127.0.0.1";
      add(
        "gateway",
        token ? "ok" : "fail",
        token ? "gateway token configured" : "gateway token missing",
        token
          ? `${host}:${typeof listen.port === "number" ? listen.port : 3000}`
          : "gateway.listen.token is required",
      );
      if (!isLoopbackHost(host)) {
        add(
          "gateway_binding",
          token ? "warn" : "fail",
          `gateway listens on non-loopback host ${host}`,
          token ? "keep the token private and terminate TLS at a trusted proxy" : "never expose an unauthenticated gateway",
        );
      } else {
        add("gateway_binding", "ok", "gateway binding is local-only", host);
      }
    }

    const telegram = gateway && isRecord(gateway.telegram) ? gateway.telegram : null;
    if (telegram?.enabled === true && !env.TELEGRAM_BOT_TOKEN) {
      add("telegram", "fail", "TELEGRAM_BOT_TOKEN missing", "gateway.telegram is enabled");
    } else {
      add("telegram", "ok", "gateway telegram token present or disabled");
    }

    const jobs = gateway && Array.isArray(gateway.jobs) ? gateway.jobs.length : 0;
    add("routines", jobs ? "ok" : "warn", `${jobs} routine(s) configured`);

    if (online) {
      const apiKey = ref.provider === "anthropic" ? anthropicKey : openaiKey;
      if (!ref.model) {
        add("provider_chat", "fail", "provider chat check not run", "no default model configured");
      } else if (!apiKey) {
        add("provider_chat", "fail", "provider chat check not run", `${ref.provider} credential missing`);
      } else {
        const providerResult = await (deps.testProvider ?? testProvider)({
          provider: ref.provider,
          model: ref.model,
          apiKey,
          baseUrl: config.providers?.[ref.provider]?.baseUrl,
        });
        add(
          "provider_chat",
          providerResult.ok ? "ok" : "fail",
          providerResult.ok ? "provider chat check passed" : "provider chat check failed",
          providerResult.ok
            ? `${ref.provider}:${ref.model}`
            : providerResult.error ?? (providerResult.status ? `status ${providerResult.status}` : "unknown provider error"),
        );
      }
    }
  } else if (online) {
    add("provider_chat", "fail", "provider chat check not run", "config did not load");
  }

  const providersPath = join(home, "providers.yaml");
  const keyLines = (existsSync(providersPath) ? readFileSync(providersPath, "utf8") : "")
    .split("\n")
    .filter((line) => /^\s*apiKey:\s*\S/.test(line));
  const plain = keyLines.some((line) => !line.includes(ENC_PREFIX));
  const encrypted = keyLines.some((line) => line.includes(ENC_PREFIX));
  if (keyLines.length === 0) {
    add("provider_key_storage", "ok", "no provider apiKeys stored", "none in providers.yaml");
  } else if (plain) {
    add(
      "provider_key_storage",
      "warn",
      "provider apiKeys stored in plaintext",
      encrypted ? "some keys still plaintext — re-save to encrypt all" : "`tenjin keyring init` then re-save to encrypt",
    );
  } else {
    add("provider_key_storage", "ok", "provider apiKeys encrypted at rest", "keyring active");
  }

  const platform = deps.platform ?? process.platform;
  for (const check of [
    privateFileCheck(join(home, "config.yaml"), "config_permissions", "config.yaml permissions", platform),
    privateFileCheck(providersPath, "provider_permissions", "providers.yaml permissions", platform),
  ]) {
    if (check) checks.push(check);
  }

  try {
    ensureGlobalDir(home);
    const probe = join(home, ".doctor-probe");
    writeFileSync(probe, "x", { mode: 0o600 });
    rmSync(probe);
    add("home_writable", "ok", `${home} writable`);
  } catch (e) {
    add("home_writable", "fail", `${home} writable`, (e as Error).message);
  }

  const bots = listBots(home);
  add("bots", bots.length ? "ok" : "warn", `${bots.length} bot(s)`, bots.join(", ") || undefined);

  const sandbox = (deps.detectSandbox ?? detectSandbox)();
  add(
    "bash_sandbox",
    sandbox ? "ok" : "warn",
    sandbox ? `bash sandbox available (${sandbox})` : "bash sandbox unavailable",
    sandbox ? undefined : "bash execution fails closed when isolation is required",
  );

  const counts: Record<DoctorState, number> = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.state]++;
  const report: DoctorReport = {
    schemaVersion: 1,
    product: PRODUCT,
    version: VERSION,
    online,
    ok: counts.fail === 0,
    counts,
    checks,
  };
  const safeReport = redactor.redactValue(report) as DoctorReport;

  if (json) {
    write(`${JSON.stringify(safeReport)}\n`);
  } else {
    for (const check of safeReport.checks) {
      const icon = check.state === "ok" ? "✅" : check.state === "warn" ? "⚠️ " : "❌";
      write(`${icon} ${check.label}${check.detail ? ` — ${check.detail}` : ""}\n`);
    }
  }
  return safeReport.ok ? 0 : 1;
}

