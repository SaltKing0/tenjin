/**
 * Anti-hallucination grounding gates (Roadmap §12 B9-14, #394).
 *
 * The law for BOTH retrieval modes (grep/BM25-deterministic and vector/hybrid):
 * an answer is accepted only when it is backed by the delivered context and
 * every citation it makes is programmatically verifiable against that context.
 * No evidence ⇒ a clean "don't know" abstention; a citation that cannot be
 * verified ⇒ the answer is rejected and must be revised or abstained.
 *
 * This module is deliberately MODE-AGNOSTIC: it reasons over a delivered
 * {@link GroundingContext} (chunk-ids + file texts) regardless of how that
 * context was produced, so grep-mode and hybrid-mode are gated identically.
 */

/** The context actually delivered to the model for the current turn. */
export interface GroundingContext {
  /** Retrieved chunk texts keyed by chunk-id (delivered context). */
  chunks: Map<string, string>;
  /** File texts keyed by path, when files were read into the context. */
  files: Map<string, string>;
}

/** A parsed citation: either a `path:line` or a bare chunk-id. */
export type Citation =
  | { kind: "file"; path: string; line: number }
  | { kind: "chunk"; id: string };

// A `path:line` citation: relative/absolute path plus a 1-based line number.
const FILE_LINE_RE = /^([A-Za-z0-9_./\\-]+):(\d+)$/;

/**
 * Parse a citation token. Accepts `path:line` (file citation) or any bare
 * non-whitespace token (chunk-id citation). Returns null when malformed.
 */
export function parseCitation(raw: string): Citation | null {
  const s = raw.trim();
  if (!s) return null;
  const m = FILE_LINE_RE.exec(s);
  if (m) return { kind: "file", path: m[1]!, line: Number(m[2]) };
  // A token containing a colon must be a `path:line` file citation; anything
  // else with a colon is malformed (not a valid chunk-id).
  if (s.includes(":")) return null;
  // Chunk-ids are opaque, non-whitespace tokens (e.g. "chunk_ab12").
  if (!/\s/.test(s) && !/[(){}]/.test(s)) return { kind: "chunk", id: s };
  return null;
}

/** True when the token is a well-formed citation (file:line or bare chunk-id). */
export function isValidCitation(raw: string): boolean {
  return parseCitation(raw) != null;
}

/**
 * Verify a citation against the delivered context. A file citation must name
 * a file that is in the delivered context and a line that exists; a chunk
 * citation must reference a chunk-id that was actually delivered.
 */
export function verifyCitation(
  raw: string,
  ctx: GroundingContext,
): { ok: true } | { ok: false; reason: string } {
  const c = parseCitation(raw);
  if (!c) return { ok: false, reason: `malformed citation: "${raw}"` };
  if (c.kind === "chunk") {
    if (!ctx.chunks.has(c.id)) {
      return { ok: false, reason: `chunk-id "${c.id}" was not in the delivered context` };
    }
    return { ok: true };
  }
  const text = ctx.files.get(c.path);
  if (text == null) {
    return { ok: false, reason: `file "${c.path}" was not in the delivered context` };
  }
  const lineCount = text.split("\n").length;
  if (c.line < 1 || c.line > lineCount) {
    return { ok: false, reason: `line ${c.line} out of range for "${c.path}" (has ${lineCount})` };
  }
  return { ok: true };
}

/**
 * Extract citation markers from a generated answer. This implementation uses
 * an `@`-prefixed marker convention (`@src/foo.ts:12`, `@chunk_ab12`) so a
 * citation is unambiguous inside prose and cheap to locate programmatically.
 */
export function extractCitations(answer: string): string[] {
  const out: string[] = [];
  const re = /@([A-Za-z0-9_./\\:-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    const tok = m[1]!;
    // Drop a trailing ':' with no line number (e.g. "@path:" in prose).
    if (/^[A-Za-z0-9_./\\-]+:$/.test(tok)) continue;
    out.push(tok);
  }
  return out;
}

/** Verify every citation in an answer; returns the list of failed citations. */
export function verifyAnswerCitations(
  answer: string,
  ctx: GroundingContext,
): Array<{ citation: string; reason: string }> {
  const failures: Array<{ citation: string; reason: string }> = [];
  for (const c of extractCitations(answer)) {
    const res = verifyCitation(c, ctx);
    if (!res.ok) failures.push({ citation: c, reason: res.reason });
  }
  return failures;
}

/** The clean "don't know" abstention fallback — never an invented answer. */
export function abstention(question: string): string {
  return (
    `I can't answer that from my delivered context: I found no evidence for ` +
    `"${question}". Rather than guess, I'll abstain. Use the retrieve tool to pull ` +
    `relevant chunks (or a grep/read tool for source) and I'll answer with citations.`
  );
}

export interface GroundedResponse {
  /** True when the answer passed the gate (has evidence + valid citations). */
  ok: boolean;
  /** The accepted answer when ok, or the corrective/abstention message. */
  output: string;
}

/**
 * The retrieval gate applied to a generated answer:
 *   - no delivered context ⇒ abstain (abstention beats invention);
 *   - any unverifiable citation ⇒ reject and force retry/abstain;
 *   - otherwise accept.
 */
export function groundResponse(opts: {
  question: string;
  answer: string;
  ctx: GroundingContext;
}): GroundedResponse {
  const hasEvidence = opts.ctx.chunks.size > 0 || opts.ctx.files.size > 0;
  if (!hasEvidence) {
    return { ok: false, output: abstention(opts.question) };
  }
  const failures = verifyAnswerCitations(opts.answer, opts.ctx);
  if (failures.length) {
    const detail = failures
      .map((f) => `"${f.citation}" (${f.reason})`)
      .join("; ");
    return {
      ok: false,
      output:
        `Unverifiable citation(s): ${detail}. Answer only from the delivered context; ` +
        `cite file:line or a chunk-id that was actually delivered, or abstain.`,
    };
  }
  return { ok: true, output: opts.answer };
}

/** A single sampled claim and whether it traces to the delivered context. */
export interface FaithfulnessSample {
  claim: string;
  supported: boolean;
}

// Tokens too generic to count as evidence of a claim (function words).
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "will",
  "you", "your", "are", "was", "were", "has", "had", "not", "but",
  "what", "when", "where", "which", "there", "here", "than", "then",
]);

/** Fraction of a claim's meaningful tokens present in a text (0..1). */
function overlap(claim: string, text: string): number {
  const tokens = claim
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  if (tokens.length === 0) return 1; // no meaningful tokens ⇒ vacuously consistent
  let hit = 0;
  for (const t of tokens) if (text.toLowerCase().includes(t)) hit++;
  return hit / tokens.length;
}

/**
 * RAGAS-style faithfulness spot check: each sampled claim must trace back to
 * the delivered context (a chunk or a read file). A claim sharing fewer than
 * {@link TRACE_THRESHOLD} of its meaningful tokens with any delivered text is
 * flagged unsupported — a hallucination candidate.
 */
export function faithfulnessSpotCheck(
  claims: string[],
  ctx: GroundingContext,
  threshold = 0.5,
): FaithfulnessSample[] {
  const corpus = [...ctx.chunks.values(), ...ctx.files.values()];
  return claims.map((claim) => {
    const supported = corpus.some((text) => overlap(claim, text) >= threshold);
    return { claim, supported };
  });
}
