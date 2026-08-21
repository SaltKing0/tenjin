import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { ConfigError } from "../config/loader";
import { parseCron } from "../gateway/schedule";
import { listConfiguredJobs, type JobView } from "../gateway/gateway";
import { resolveBot, botModelRef, botBudgetUSD, type BotProfile } from "../bots/profile";
import { runHeadless, capPolicy } from "../agent/headless";
import { loadAgentsMd } from "../agent/prompt";
import { guardForBot } from "../security/guard";
import { Redactor } from "../security/redact";
import { formatUSD } from "../agent/budget";
import type { Provider } from "../provider/types";
import type { HarnessConfig } from "../config/types";

export const configYamlPath = (home: string): string => join(home, "config.yaml");

/** One raw entry of `gateway.jobs` as written in config.yaml. */
export interface JobEntry {
  name: string;
  bot: string;
  prompt: string;
  postTo?: string;
  cron?: string;
}

export interface ConfigDoc {
  doc: Record<string, unknown>;
  gateway: Record<string, unknown>;
  jobs: Record<string, unknown>[];
}

/**
 * Read `config.yaml` and return the top-level doc plus the `gateway.jobs`
 * array, creating missing `gateway`/`jobs` mappings in memory as needed (they
 * are written back by `writeConfigDoc`). The returned objects are linked — a
 * mutation of `jobs` is reflected in `doc`, so callers only need to pass `doc`
 * to the writer.
 */
export function readConfigDoc(home: string): ConfigDoc {
  const path = configYamlPath(home);
  if (!existsSync(path)) {
    throw new ConfigError(`${path} not found — run \`tenjin\` once to create it`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`invalid YAML in ${path}: ${(e as Error).message}`);
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${path} must be a YAML mapping at the top level`);
  }
  const doc = parsed as Record<string, unknown>;
  let gateway = doc.gateway as unknown;
  if (gateway === undefined || gateway === null) {
    gateway = {};
    doc.gateway = gateway;
  }
  if (typeof gateway !== "object" || Array.isArray(gateway)) {
    throw new ConfigError("config.yaml `gateway` must be a mapping");
  }
  const gw = gateway as Record<string, unknown>;
  let jobs = gw.jobs as unknown;
  if (jobs === undefined || jobs === null) {
    jobs = [];
    gw.jobs = jobs;
  }
  if (!Array.isArray(jobs)) {
    throw new ConfigError("config.yaml `gateway.jobs` must be a list");
  }
  return { doc, gateway: gw, jobs: jobs as Record<string, unknown>[] };
}

/** Write the top-level doc back to `config.yaml` in block style. */
export function writeConfigDoc(home: string, doc: Record<string, unknown>): void {
  writeFileSync(configYamlPath(home), stringifyBlockStyle(doc));
}

// Bun's YAML.stringify emits flow style (one line per mapping), but job edits
// must round-trip as readable block-style YAML, so we serialize the (small,
// shallow) config doc ourselves. Values are emitted as plain scalars when that
// is unambiguous and double-quoted otherwise.
const PLAIN_SAFE = /^[A-Za-z0-9_./-]+$/;

function blockScalar(v: unknown): string {
  if (typeof v === "string") return PLAIN_SAFE.test(v) ? v : JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (v === null || v === undefined) return "null";
  return JSON.stringify(String(v));
}

function isMapping(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function emitBlock(v: unknown, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (isMapping(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (isMapping(val) || Array.isArray(val)) {
        out.push(`${pad}${k}:\n`);
        emitBlock(val, indent + 2, out);
      } else {
        out.push(`${pad}${k}: ${blockScalar(val)}\n`);
      }
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      if (isMapping(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          out.push(`${pad}- {}\n`);
          continue;
        }
        const [k0, v0] = entries[0]!;
        if (isMapping(v0) || Array.isArray(v0)) {
          out.push(`${pad}- ${k0}:\n`);
          emitBlock(v0, indent + 4, out);
        } else {
          out.push(`${pad}- ${k0}: ${blockScalar(v0)}\n`);
        }
        for (const [k, val] of entries.slice(1)) {
          if (isMapping(val) || Array.isArray(val)) {
            out.push(`${pad}  ${k}:\n`);
            emitBlock(val, indent + 4, out);
          } else {
            out.push(`${pad}  ${k}: ${blockScalar(val)}\n`);
          }
        }
      } else {
        out.push(`${pad}- ${blockScalar(item)}\n`);
      }
    }
  } else {
    out.push(`${pad}${blockScalar(v)}\n`);
  }
}

export function stringifyBlockStyle(doc: Record<string, unknown>): string {
  const out: string[] = [];
  emitBlock(doc, 0, out);
  return out.join("");
}

function jobNameOf(entry: unknown): string | undefined {
  if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
    return (entry as { name: string }).name;
  }
  return undefined;
}

/** First unused `job-<n>` name among the current jobs. */
function nextJobName(jobs: unknown[]): string {
  const names = new Set<string>();
  for (const j of jobs) {
    const n = jobNameOf(j);
    if (n) names.add(n);
  }
  let n = 1;
  while (names.has(`job-${n}`)) n++;
  return `job-${n}`;
}

/** All configured jobs with computed nextDue/lastRun, for `tenjin job list`. */
export function listJobs(home: string, fromMs = Date.now()): JobView[] {
  const { gateway } = readConfigDoc(home);
  return listConfiguredJobs(gateway, fromMs);
}

export interface AddJobInput {
  bot: string;
  cron: string;
  prompt: string;
}

/**
 * Validate and append a cron job to `gateway.jobs`, writing `config.yaml` in
 * block style. The cron expression is checked with the shared parser BEFORE
 * anything is written; the bot must already exist. Returns the generated
 * job id (`job-<n>`), which `job rm`/`job run` act on.
 */
export function addJob(home: string, input: AddJobInput): string {
  const bot = input.bot.trim();
  const cron = input.cron.trim();
  const prompt = input.prompt.trim();
  if (!bot) throw new ConfigError("job add requires a bot name");
  if (!cron) throw new ConfigError("job add requires a cron expression");
  if (!prompt) throw new ConfigError("job add requires a prompt");
  // Validate cron syntax up front, reusing the existing parser, so an invalid
  // expression is rejected before the file is touched.
  parseCron(cron);
  // The job runs as a real bot — verify it exists now, not at gateway boot.
  resolveBot(home, bot);

  const { doc, jobs } = readConfigDoc(home);
  const name = nextJobName(jobs);
  jobs.push({ name, bot, prompt, cron });
  writeConfigDoc(home, doc);
  return name;
}

/** Remove a job by id. Returns false if no job with that name exists. */
export function removeJob(home: string, name: string): boolean {
  const id = name.trim();
  if (!id) throw new ConfigError("job rm requires a job id (tenjin job list)");
  const { doc, jobs } = readConfigDoc(home);
  const idx = jobs.findIndex((j) => jobNameOf(j) === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  writeConfigDoc(home, doc);
  return true;
}

/** Look up a single configured job by id, throwing if it does not exist. */
export function findJob(home: string, name: string): JobEntry {
  const id = name.trim();
  if (!id) throw new ConfigError("expected a job id (tenjin job list)");
  const { jobs } = readConfigDoc(home);
  const found = jobs.find((j) => jobNameOf(j) === id);
  if (!found) throw new ConfigError(`unknown job "${id}" — tenjin job list to see jobs`);
  return found as unknown as JobEntry;
}

export interface RunJobDeps {
  home: string;
  cwd: string;
  config: HarnessConfig;
  provider: Provider;
  audit?: (kind: "write_exec" | "budget_halt", detail: string, correlationId?: string) => void;
}

export type RunJobResult =
  | { ok: true; stopReason: string; costUSD: number; text: string }
  | { ok: false; error: string };

/**
 * Run a configured job's prompt immediately, headless, as its bot. Mirrors the
 * gateway's job execution path (same bot resolution, model, policy and session
 * logging) so a CLI `job run` behaves like a due job. The provider is injected
 * so tests can drive it with a fake.
 */
export async function runJob(
  home: string,
  name: string,
  deps: RunJobDeps,
): Promise<RunJobResult> {
  let job: JobEntry;
  let profile: BotProfile;
  try {
    job = findJob(home, name);
    profile = resolveBot(home, job.bot);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const ref = botModelRef(profile, deps.config);
  try {
    const result = await runHeadless({
      provider: deps.provider,
      model: ref.model,
      soulText: profile.soulText,
      cwd: deps.cwd,
      message: job.prompt,
      maxTokens: deps.config.maxTokens,
      capUSD: botBudgetUSD(profile, deps.config.budgetUSD),
      pricing: deps.config.pricing,
      policy: capPolicy("read-only", profile.config.security?.policy),
      denyTools: profile.config.security?.denyTools,
      agentsMd: loadAgentsMd(deps.cwd),
      home: deps.home,
      memoryDir: profile.memoryDir,
      sessionLogDir: profile.sessionsDir,
      sessionBot: profile.name,
      guard: guardForBot(deps.config.security, profile.config.security, undefined),
      redactor: Redactor.fromConfig(deps.config.security),
      audit: deps.audit,
    });
    return { ok: true, stopReason: result.stopReason, costUSD: result.costUSD, text: result.text };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Human-readable lines for `tenjin job list`. */
export function renderJob(v: JobView): string {
  const schedule =
    v.cron !== null ? `cron "${v.cron}"` : v.every !== null ? `every ${v.every}` : "manual";
  const last = v.lastRun
    ? `${v.lastRun.at} ${v.lastRun.stopReason}${v.lastRun.error ? ` · ${v.lastRun.error}` : ""}${v.lastRun.costUSD > 0 ? ` · ${formatUSD(v.lastRun.costUSD)}` : ""}`
    : "never";
  const prompt = v.prompt.length > 60 ? `${v.prompt.slice(0, 57)}...` : v.prompt;
  return (
    `${v.name}  bot=${v.bot}  ${schedule}  next=${v.nextDue}  last=${last}\n` +
    `    prompt: ${prompt}\n`
  );
}
