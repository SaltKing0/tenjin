/**
 * Structure-first chunking + small-to-big (Roadmap §12 B9-11, #388).
 *
 * Splits text at STRUCTURE boundaries — functions/classes for code, heading
 * hierarchy then paragraph breaks for markdown — so every section stays whole
 * where possible (structure beats fixed size). Chunks carry complete metadata
 * (source path, title, heading path, line bounds) and a leaf/parent relation:
 * large sections are split into small LEAF chunks for precise embedding, each
 * leaf pointing at its PARENT, and retrieval returns the parent text. No
 * overlap by default.
 */

const CHAR_PER_TOKEN = 4;

/** Heuristic token count (~4 chars/token, ceil). */
export function estTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHAR_PER_TOKEN));
}

export type ContentKind = "code" | "markdown" | "plain";

// A line that begins a top-level function/class/arrow-const declaration.
const CODE_LINE =
  /^\s*(?:(?:export\s+|default\s+)*(?:async\s+)?function\s+\w*|(?:export\s+|default\s+)*(?:class\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\()|(?:export\s+)?(?:async\s+)?function\s*\()/;
// A markdown heading line (#, ##, ...).
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;

export function detectContentKind(text: string): ContentKind {
  let code = 0;
  let heading = 0;
  for (const line of text.split("\n")) {
    if (CODE_LINE.test(line)) code++;
    else if (HEADING_LINE.test(line)) heading++;
  }
  if (code > 0) return "code";
  if (heading > 0) return "markdown";
  return "plain";
}

export interface ChunkMeta {
  sourcePath?: string;
  title?: string;
  /** Markdown heading hierarchy leading to this chunk (e.g. ["Project", "Build"]). */
  headingPath: string[];
  startLine: number;
  endLine: number;
  /** Set on leaf chunks: the id of the parent this leaf belongs to. */
  parentChunkId?: string;
}

export interface Chunk {
  id: string;
  text: string;
  /** True for a structural parent (function / heading section). */
  parent: boolean;
  /** Set on leaf chunks. */
  parentId?: string;
  meta: ChunkMeta;
}

export interface ChunkOptions {
  /** Hard per-chunk token bound (default 512; 1024 analytic, 256 factoid). */
  maxTokens?: number;
  /** Leaf budget for small-to-big splitting (default 256). */
  leafTokens?: number;
  sourcePath?: string;
  title?: string;
}

interface ParentSection {
  text: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
}

/** Split code at top-level function/class boundaries; each block stays whole. */
function splitCodeParents(text: string): ParentSection[] {
  const lines = text.split("\n");
  const sections: { text: string; startLine: number }[] = [];
  let start = 0;
  for (let i = 1; i < lines.length; i++) {
    if (CODE_LINE.test(lines[i]!)) {
      sections.push({ text: lines.slice(start, i).join("\n"), startLine: start });
      start = i;
    }
  }
  sections.push({ text: lines.slice(start).join("\n"), startLine: start });
  return sections
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({
      text: s.text,
      headingPath: [],
      startLine: s.startLine,
      endLine: s.startLine + s.text.split("\n").length - 1,
    }));
}

/** Split markdown at heading boundaries; record the heading hierarchy. */
function splitMarkdownParents(text: string): ParentSection[] {
  const lines = text.split("\n");
  const sections: { text: string; headingPath: string[]; startLine: number }[] = [];
  let start = 0;
  let headingPath: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]!);
    if (m && i > 0) {
      sections.push({
        text: lines.slice(start, i).join("\n"),
        headingPath: [...headingPath],
        startLine: start,
      });
      start = i;
    }
    if (m) {
      const level = m[1]!.length;
      const heading = m[2]!;
      headingPath = headingPath.slice(0, level - 1);
      headingPath.push(heading);
    }
  }
  sections.push({
    text: lines.slice(start).join("\n"),
    headingPath: [...headingPath],
    startLine: start,
  });
  return sections
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({
      text: s.text,
      headingPath: s.headingPath,
      startLine: s.startLine,
      endLine: s.startLine + s.text.split("\n").length - 1,
    }));
}

/** Split text into sub-sections each within maxTokens (paragraph/line aware). */
function splitByMax(text: string, maxTokens: number): string[] {
  if (estTokens(text) <= maxTokens) return [text];
  // Prefer paragraph breaks, then line breaks, accumulating within the bound.
  const paragraphs = text.split(/\n\s*\n/);
  const out: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (!p.trim()) continue;
    if (estTokens(cur + (cur ? "\n\n" : "") + p) > maxTokens && cur) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) out.push(cur);
  // Fallback: if a single paragraph still exceeds, split by lines.
  const final: string[] = [];
  for (const o of out) {
    if (estTokens(o) <= maxTokens) {
      final.push(o);
      continue;
    }
    let lcur = "";
    for (const line of o.split("\n")) {
      if (estTokens(lcur + "\n" + line) > maxTokens && lcur) {
        final.push(lcur);
        lcur = line;
      } else {
        lcur = lcur ? `${lcur}\n${line}` : line;
      }
    }
    if (lcur) final.push(lcur);
  }
  return final;
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/**
 * Structure-first chunking with small-to-big. Returns a flat list of chunks:
 * structural parents (functions / heading sections) plus, for any parent over
 * the leaf budget, leaf chunks that carry `parentId`/`meta.parentChunkId`
 * pointing back at it. Every emitted chunk stays within `maxTokens`.
 */
export function chunkStructure(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? 512;
  const leafTokens = opts.leafTokens ?? 256;
  const kind = detectContentKind(text);
  const parents: ParentSection[] =
    kind === "code"
      ? splitCodeParents(text)
      : kind === "markdown"
        ? splitMarkdownParents(text)
        : [{ text, headingPath: [], startLine: 0, endLine: countLines(text) - 1 }];

  const chunks: Chunk[] = [];
  parents.forEach((p, i) => {
    const pid = `parent-${i}`;
    const meta: ChunkMeta = {
      sourcePath: opts.sourcePath,
      title: opts.title,
      headingPath: p.headingPath,
      startLine: p.startLine,
      endLine: p.endLine,
    };
    // Hard bound: a parent over maxTokens is split into sub-parents.
    if (estTokens(p.text) > maxTokens) {
      splitByMax(p.text, maxTokens).forEach((sub, k) => {
        const subId = `${pid}:sub-${k}`;
        chunks.push({
          id: subId,
          text: sub,
          parent: true,
          meta: { ...meta, startLine: p.startLine, endLine: p.startLine + countLines(sub) - 1 },
        });
        if (estTokens(sub) > leafTokens) {
          splitByMax(sub, leafTokens).forEach((leaf, j) => {
            chunks.push({
              id: `${subId}:${j}`,
              text: leaf,
              parent: false,
              parentId: subId,
              meta: { ...meta, parentChunkId: subId },
            });
          });
        }
      });
      return;
    }
    chunks.push({ id: pid, text: p.text, parent: true, meta });
    // Small-to-big: a parent over the leaf budget yields leaf chunks.
    if (estTokens(p.text) > leafTokens) {
      splitByMax(p.text, leafTokens).forEach((leaf, j) => {
        chunks.push({
          id: `${pid}:${j}`,
          text: leaf,
          parent: false,
          parentId: pid,
          meta: { ...meta, parentChunkId: pid },
        });
      });
    }
  });
  return chunks;
}

/** Return the full parent text for a leaf chunk id (or null if not found). */
export function parentTextForLeaf(chunks: Chunk[], leafId: string): string | null {
  const leaf = chunks.find((c) => c.id === leafId);
  if (!leaf) return null;
  const pid = leaf.parentId;
  if (!pid) return leaf.text; // already a parent
  const parent = chunks.find((c) => c.id === pid);
  return parent ? parent.text : null;
}
