import type { SummaryEntry } from "./summaries";

export const DEFAULT_MAX_CHARS = 3200;

export interface MemorySectionOptions {
  currentProject: string;
  maxChars?: number;
}

const HEADER =
  "# Memory — recent sessions in this project\nWhat happened before, newest first:";

export function buildMemorySection(
  entries: SummaryEntry[],
  opts: MemorySectionOptions,
): string | null {
  const relevant = entries
    .filter((e) => e.meta.projectPath === opts.currentProject && e.text)
    .sort((a, b) => (a.meta.created < b.meta.created ? 1 : -1));

  if (relevant.length === 0) return null;

  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const body: string[] = [];

  for (const entry of relevant) {
    const date = entry.meta.created.slice(0, 10);
    const prefix = `- ${date} (${entry.meta.sessionId}): `;
    const candidate = `${HEADER}\n${[...body, `${prefix}${entry.text}`].join("\n")}`;
    if (candidate.length <= max) {
      body.push(`${prefix}${entry.text}`);
      continue;
    }
    if (body.length === 0) {
      const room = max - HEADER.length - 1 - prefix.length - 1;
      if (room > 20) {
        body.push(`${prefix}${entry.text.slice(0, room)}…`);
      }
    }
    break;
  }

  if (body.length === 0) return null;
  return `${HEADER}\n${body.join("\n")}`;
}
