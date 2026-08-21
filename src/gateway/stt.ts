import { ConfigError } from "../config/types";

/**
 * Zero-dep OpenAI-compatible audio transcription (#137).
 *
 * Posts an audio blob to `POST {baseUrl}/audio/transcriptions` (multipart:
 * `file` + `model`) and returns the transcribed text. Newer transcription
 * models (e.g. gpt-4o-transcribe) also report token `usage`, which we surface
 * so callers can trace transcription cost; duration-priced models (whisper-1)
 * report none.
 */

export interface TranscriptionResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface TranscriptionConfig {
  apiKey: string;
  model: string;
  /** OpenAI-compatible /audio/transcriptions base URL (e.g. https://api.openai.com/v1). */
  baseUrl?: string;
}

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

export async function transcribeAudio(
  cfg: TranscriptionConfig,
  audio: Blob,
  filename: string,
): Promise<TranscriptionResult> {
  if (!cfg.apiKey) throw new ConfigError("no API key configured for audio transcription");
  if (!cfg.model) throw new ConfigError("no audio transcription model configured");

  const base = (cfg.baseUrl || DEFAULT_OPENAI_BASE).replace(/\/$/, "");
  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", cfg.model);

  const res = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      `audio transcription ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as { text?: unknown; usage?: unknown };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("audio transcription returned empty output");

  const usage = data.usage as
    | { input_tokens?: number; output_tokens?: number }
    | undefined;
  return {
    text,
    usage:
      usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)
        ? {
            inputTokens: Number(usage.input_tokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? 0),
          }
        : undefined,
  };
}
