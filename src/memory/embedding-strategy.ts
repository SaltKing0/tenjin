/**
 * Local embedding strategy (Roadmap §12 B9-12, #389).
 *
 * Pairs with the local-first posture: embeddings run LOCAL, cost-stable, no
 * vendor lock-in. Default backend is Ollama `nomic-embed-text` through the
 * existing OpenAI-compatible path; `mxbai-embed-large` is selectable when
 * semantic quality matters more than latency/RAM.
 *
 *  - PREFIXES: nomic-embed-text requires the model-card prefixes
 *    (`search_document:` for documents, `search_query:` for queries) — dropping
 *    them costs 3-5 recall points, so we preserve them exactly.
 *  - PINNING: one embedding model per index (stored in index metadata); a query
 *    against a different model is a hard error; a model change requires a full
 *    re-index with explicit confirmation.
 *  - INCREMENTAL: re-index by chunk id — only new/changed chunks are embedded.
 *  - DEGRADATION: an unreachable local endpoint surfaces a clean message, never
 *    silent empty results.
 */

import type { EmbeddingProvider } from "../provider/embeddings";
import { OpenAIEmbeddings } from "../provider/embeddings";
import { ConfigError } from "../config/types";

/** nomic-embed-text model-card prefixes. */
export const DOCUMENT_PREFIX = "search_document:";
export const QUERY_PREFIX = "search_query:";

/** Role of a vector: a document to index or a query to match against. */
export type EmbedRole = "document" | "query";

/** Models that require the search_* prefixes (per their model cards). */
const PREFIXED_MODELS = new Set(["nomic-embed-text"]);

/**
 * Apply the model-card prefix for a role. No-op for models that don't need one.
 */
export function applyPrefix(text: string, role: EmbedRole, model: string): string {
  if (!PREFIXED_MODELS.has(model)) return text;
  return (role === "document" ? DOCUMENT_PREFIX : QUERY_PREFIX) + text;
}

/**
 * Embed texts for a role, applying the role prefix before the provider call so
 * the request body carries the exact prefixed input the model card demands.
 */
export async function embedWithRole(
  provider: EmbeddingProvider,
  texts: string[],
  role: EmbedRole,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  return provider.embed(texts.map((t) => applyPrefix(t, role, provider.model)));
}

/**
 * Enforce one embedding model per index. A query or write against a different
 * model than the index is pinned to is a hard error (mixing vector spaces).
 */
export function assertModelPinned(indexModel: string, usedModel: string): void {
  if (indexModel !== usedModel) {
    throw new ConfigError(
      `embedding model mismatch: index pinned to "${indexModel}" but operation used "${usedModel}" — re-index with the pinned model`,
    );
  }
}

/**
 * Select the incoming chunks that actually need embedding: those whose id is
 * new, or whose content hash changed since the last index. Returns only the
 * changed entries so an incremental pass touches exactly them.
 */
export function selectChangedChunks<T extends { id: string; hash?: string }>(
  existingIds: ReadonlySet<string>,
  incoming: readonly T[],
  hashForId: (id: string) => string | undefined = () => undefined,
): T[] {
  const seen = new Set<string>();
  const changed: T[] = [];
  for (const chunk of incoming) {
    if (seen.has(chunk.id)) continue; // dedupe within the incoming batch
    seen.add(chunk.id);
    if (existingIds.has(chunk.id)) {
      // Already indexed. Skip unless there is a signal that the content
      // changed: the current hash differs from the stored one. When neither a
      // current nor a stored hash is known, treat it as unchanged (skip).
      const unchanged = chunk.hash === hashForId(chunk.id);
      if (unchanged) continue;
    }
    changed.push(chunk);
  }
  return changed;
}

/** Surface a clean degradation message for a failed local embedding call. */
export function cleanDegradation(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/fetch failed|ECONNREFUSED|connect|tls|timed?\s*out/i.test(msg)) {
    return `local embedding unavailable (${msg.slice(0, 120)}) — vector layer disabled; degrade to keyword search`;
  }
  return msg;
}

/**
 * Run an embedding call and, on failure, report a clean degradation message via
 * `onDegrade` then re-throw — never returning silent empty results.
 */
export async function embedOrDegrade(
  embed: () => Promise<number[][]>,
  onDegrade: (msg: string) => void,
): Promise<number[][]> {
  try {
    return await embed();
  } catch (e) {
    onDegrade(cleanDegradation(e));
    throw e;
  }
}

/** Local Ollama backend defaults (OpenAI-compatible path). */
export const LOCAL_EMBED_MODEL = "nomic-embed-text";
export const LOCAL_BASE_URL = "http://localhost:11434/v1";

/**
 * Build a local Ollama embeddings provider (default nomic-embed-text;
 * `mxbai-embed-large` selectable) through the existing OpenAI-compatible path.
 */
export function createLocalEmbeddings(opts: {
  model?: string;
  baseUrl?: string;
  retry?: import("../config/types").RetryConfig;
}): EmbeddingProvider {
  return new OpenAIEmbeddings(
    opts.model ?? LOCAL_EMBED_MODEL,
    "ollama", // api key not used by Ollama; kept non-empty to satisfy the header
    opts.baseUrl ?? LOCAL_BASE_URL,
    opts.retry,
  );
}
