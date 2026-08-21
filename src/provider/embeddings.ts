import { fetchWithRetry, normalizeRetry, type RetryPolicy } from "./retry";
import type { RetryConfig } from "../config/types";

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

const DEFAULT_EMBED_MODEL = "text-embedding-3-small";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  private policy: RetryPolicy;

  constructor(
    readonly model: string = DEFAULT_EMBED_MODEL,
    private apiKey: string = process.env.OPENAI_API_KEY ?? "",
    private baseUrl: string =
      process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    retry?: RetryConfig,
  ) {
    // #310: rate limits (429) and transient 5xx on embeddings are common under
    // batch fan-out; retry them instead of aborting the whole index pass.
    this.policy = normalizeRetry(retry);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetchWithRetry(
      `${this.baseUrl.replace(/\/$/, "")}/embeddings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          encoding_format: "float",
        }),
      },
      this.policy,
    );
    if (!res.ok) {
      throw new Error(`embeddings api ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    if (!Array.isArray(data.data)) {
      throw new Error("embeddings api returned unexpected shape");
    }
    const out: number[][] = new Array(texts.length);
    for (const item of data.data) {
      out[item.index] = item.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`embeddings api missing vector at index ${i}`);
    }
    return out as number[][];
  }
}

export function createEmbeddings(opts: {
  provider?: string;
  model?: string;
}): EmbeddingProvider | null {
  switch (opts.provider ?? "openai") {
    case "openai": {
      if (!process.env.OPENAI_API_KEY) return null;
      return new OpenAIEmbeddings(opts.model);
    }
    default:
      return null;
  }
}
