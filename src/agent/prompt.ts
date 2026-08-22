import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../provider/types";

export interface SoulSource {
  text: string;
  source: "project" | "global" | "default";
}

const DEFAULT_SOUL = `You are Tenjin — a precise, pragmatic coding agent.

- Prefer working code over abstract advice.
- Be brief. Show, don't tell.
- Never invent APIs; verify against the actual code.
- Leave code cleaner than you found it.`;

export function loadSoul(home: string, projectDir: string): SoulSource {
  const projectPath = join(projectDir, ".tenjin", "SOUL.md");
  if (existsSync(projectPath)) {
    return { text: readFileSync(projectPath, "utf8").trim(), source: "project" };
  }
  const globalPath = join(home, "SOUL.md");
  if (existsSync(globalPath)) {
    return { text: readFileSync(globalPath, "utf8").trim(), source: "global" };
  }
  return { text: DEFAULT_SOUL, source: "default" };
}

export function loadAgentsMd(projectDir: string): string | null {
  const path = join(projectDir, "AGENTS.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").trim();
  return text || null;
}

export function buildSystemPrompt(inputs: {
  soulText: string;
  agentsMd: string | null;
  cwd: string;
  memorySection?: string | null;
  /** B9-1 (#363): named Tier-0 core-memory blocks (REFERENCE DATA). Rendered
   *  before the volatile recall section so it stays in the stable prefix. */
  coreMemory?: string | null;
  facts?: string | null;
  skillsSummary?: string | null;
  /** Compact team context for bots (#141) — null when no team manifest exists. */
  teamSection?: string | null;
}): string {
  const parts: string[] = [inputs.soulText];

  if (inputs.facts) {
    parts.push(`# Facts\n${inputs.facts}`);
  }

  if (inputs.teamSection) {
    parts.push(`# Team\n${inputs.teamSection}`);
  }

  parts.push(
    [
      "# Environment",
      `cwd: ${inputs.cwd}`,
      `platform: ${process.platform}`,
    ].join("\n"),
  );

  parts.push(
    "# Working style\n" +
      "- Use the provided tools to read, search, and modify files. Do not guess file contents.\n" +
      "- Prefer precise edits over rewrites. Keep changes minimal and focused.\n" +
      "- Verify assumptions against the actual code before acting on them.",
  );

  if (inputs.agentsMd) {
    parts.push(`# Project context (AGENTS.md)\n${inputs.agentsMd}`);
  }

  if (inputs.coreMemory) {
    parts.push(inputs.coreMemory);
  }

  if (inputs.memorySection) {
    parts.push(inputs.memorySection);
  }

  if (inputs.skillsSummary) {
    parts.push(`# Skills\nLoad with the use_skill tool.\n${inputs.skillsSummary}`);
  }

  return parts.join("\n\n");
}

/**
 * B2-1 cache-shape discipline (#353): the system prompt is the STABLE prefix —
 * it must be byte-stable across turns within a session so the provider's
 * prompt cache (which reads the prefix at ~1/10 the list price) is not
 * invalidated. Volatile data (clock, context pressure, directory listings,
 * status injections) therefore must NOT live here; inject it via
 * {@link buildVolatileTail} / {@link assembleCacheShapedPrompt} so it lands
 * AFTER the transcript.
 */

/** Volatile, per-turn data that must move to the TAIL zone after the transcript. */
export interface VolatileTail {
  /** Current clock/date line (e.g. ISO date). Null to omit. */
  now?: string | null;
  /** Context pressure as a percentage (0-100), if known. Null to omit. */
  contextPercent?: number | null;
  /** Directory listings, status injections, or any other per-turn lines. */
  statusLines?: string[];
}

/**
 * Build the volatile TAIL zone. This data changes between turns (clock,
 * context pressure, directory listings, status) and must be injected AFTER
 * the transcript — never inside the stable system prefix — or it invalidates
 * the provider's prompt cache. Returns null when there is nothing to inject.
 */
export function buildVolatileTail(v: VolatileTail): string | null {
  const lines: string[] = [];
  if (v.now) lines.push(`date: ${v.now}`);
  if (v.contextPercent != null) lines.push(`context pressure: ${v.contextPercent}%`);
  if (v.statusLines?.length) lines.push(...v.statusLines);
  if (!lines.length) return null;
  return ["# Live context", ...lines].join("\n");
}

export interface CacheShapedPrompt {
  /** Stable system prefix (byte-stable across turns). */
  system: string;
  /** Append-only transcript followed by the volatile tail as the final user message (if any). */
  messages: ChatMessage[];
  /**
   * Index into {@link messages} where the volatile tail begins — equal to the
   * transcript length, i.e. the end of the stable prefix. This is where a
   * provider-native cache breakpoint belongs.
   */
  breakpointIndex: number;
}

/**
 * Assemble a cache-shaped prompt per B2-1 (#353): a stable system prefix plus
 * the append-only transcript, then any volatile tail appended AFTER the
 * transcript as a trailing user message. The breakpoint index marks the end of
 * the stable prefix (start of the volatile tail) so a provider can set a
 * native cache breakpoint there.
 *
 * This is the single, frozen-by-construction assembly path: no code may insert
 * anything between the system prompt and the transcript, and volatile data may
 * only ever be appended at the end.
 */
export function assembleCacheShapedPrompt(opts: {
  system: string;
  transcript: ChatMessage[];
  volatileTail?: string | null;
}): CacheShapedPrompt {
  const tail = opts.volatileTail?.trim();
  const messages = [...opts.transcript];
  const breakpointIndex = messages.length;
  if (tail) {
    messages.push({ role: "user", content: tail });
  }
  return { system: opts.system, messages, breakpointIndex };
}
