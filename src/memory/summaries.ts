import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import type { Provider } from "../provider/types";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";

export interface SummaryMeta {
  sessionId: string;
  projectPath: string;
  uptoEvent: number;
  created: string;
}

export interface SummaryEntry {
  path: string;
  meta: SummaryMeta;
  text: string;
}

const SUMMARY_PROMPT = [
  "Summarize this coding-agent session in at most 120 words.",
  "Cover: what was worked on, key decisions made, outcomes, and any open threads.",
  "Plain prose only — no headers, no bullet lists.",
  "The session trajectory follows:",
  "---",
  "{{TRAJECTORY}}",
  "---",
].join("\n");

export function summaryPath(memoryDirPath: string, sessionId: string): string {
  return join(memoryDirPath, "summaries", `${sessionId}.md`);
}

export function readSummary(path: string): SummaryEntry | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!match || !match[1]) return null;
  let meta: Partial<SummaryMeta>;
  try {
    meta = YAML.parse(match[1]) as Partial<SummaryMeta>;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || !meta.sessionId) return null;
  return {
    path,
    meta: {
      sessionId: String(meta.sessionId),
      projectPath: String(meta.projectPath ?? ""),
      uptoEvent: Number(meta.uptoEvent ?? 0),
      created: String(meta.created ?? ""),
    },
    text: (match[2] ?? "").trim(),
  };
}

export function listSummaries(memoryDirPath: string): SummaryEntry[] {
  const dir = join(memoryDirPath, "summaries");
  if (!existsSync(dir)) return [];
  const entries: SummaryEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const entry = readSummary(join(dir, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

export function sessionsWithoutSummary(
  sessionsDirPath: string,
  memoryDirPath: string,
): SessionLog[] {
  const summarized = new Set(listSummaries(memoryDirPath).map((s) => s.meta.sessionId));
  return SessionLog.list(sessionsDirPath)
    .filter((s) => !summarized.has(s.id))
    .map((s) => SessionLog.open(s.path));
}

export async function generateSummary(
  log: SessionLog,
  opts: {
    provider: Provider;
    model: string;
    maxTokens: number;
    projectPath: string;
    memoryDirPath: string;
  },
): Promise<string> {
  const events = log.events();
  const trajectory = renderTrajectory(events).join("\n");
  const prompt = SUMMARY_PROMPT.replace("{{TRAJECTORY}}", trajectory);

  const response = await opts.provider.chat({
    model: opts.model,
    system: "You are a precise technical summarizer.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 512,
  });
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  if (!text) throw new Error("summarizer returned empty output");

  const meta: SummaryMeta = {
    sessionId: log.id,
    projectPath: opts.projectPath,
    uptoEvent: events.length,
    created: new Date().toISOString(),
  };
  writeSummary(opts.memoryDirPath, meta, text);
  return text;
}

export function writeSummary(
  memoryDirPath: string,
  meta: SummaryMeta,
  text: string,
): string {
  const path = summaryPath(memoryDirPath, meta.sessionId);
  mkdirSync(join(memoryDirPath, "summaries"), { recursive: true });
  const frontmatter = [
    "---",
    `sessionId: ${JSON.stringify(meta.sessionId)}`,
    `projectPath: ${JSON.stringify(meta.projectPath)}`,
    `uptoEvent: ${meta.uptoEvent}`,
    `created: ${JSON.stringify(meta.created)}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(path, `${frontmatter}${text.trim()}\n`);
  return path;
}

export interface GenerationReport {
  generated: string[];
  errors: string[];
}

export async function generatePendingSummaries(opts: {
  sessionsDirPath: string;
  memoryDirPath: string;
  provider: Provider;
  model: string;
  maxTokens: number;
  projectPath: string;
  limit?: number;
}): Promise<GenerationReport> {
  const report: GenerationReport = { generated: [], errors: [] };
  const pending = sessionsWithoutSummary(opts.sessionsDirPath, opts.memoryDirPath);
  for (const log of pending.slice(0, opts.limit ?? 10)) {
    try {
      await generateSummary(log, opts);
      report.generated.push(log.id);
    } catch (e) {
      report.errors.push(`${log.id}: ${(e as Error).message}`);
    }
  }
  return report;
}
