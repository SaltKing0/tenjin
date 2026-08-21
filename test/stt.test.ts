import { describe, test, expect, afterEach } from "bun:test";
import { transcribeAudio } from "../src/gateway/stt";

describe("transcribeAudio (#137)", () => {
  let server: ReturnType<typeof Bun.serve>;

  afterEach(() => server?.stop(true));

  const start = (handler: (req: Request) => Response | Promise<Response>): string => {
    server = Bun.serve({ port: 0, fetch: handler });
    return `http://localhost:${server.port}/v1`;
  };

  test("posts multipart to /audio/transcriptions and returns the text", async () => {
    const received: Array<{ model: string; fileName: string }> = [];
    const base = start(async (req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/audio/transcriptions")) {
        const form = await req.formData();
        received.push({
          model: String(form.get("model") ?? ""),
          fileName: (form.get("file") as File | null)?.name ?? "",
        });
        return Response.json({ text: "the transcribed words" });
      }
      return new Response("not found", { status: 404 });
    });

    const audio = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" });
    const res = await transcribeAudio(
      { apiKey: "k", model: "whisper-1", baseUrl: base },
      audio,
      "voice_1.ogg",
    );
    expect(res.text).toBe("the transcribed words");
    expect(received).toEqual([{ model: "whisper-1", fileName: "voice_1.ogg" }]);
  });

  test("surfaces token usage when the model reports it", async () => {
    const base = start(async () =>
      Response.json({ text: "x", usage: { input_tokens: 100, output_tokens: 5 } }),
    );
    const res = await transcribeAudio(
      { apiKey: "k", model: "m", baseUrl: base },
      new Blob(["a"]),
      "a.ogg",
    );
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
  });

  test("throws when the endpoint is not ok", async () => {
    const base = start(async () => new Response("bad key", { status: 401 }));
    await expect(
      transcribeAudio({ apiKey: "k", model: "m", baseUrl: base }, new Blob(["a"]), "a.ogg"),
    ).rejects.toThrow(/401/);
  });

  test("throws when transcription is empty", async () => {
    const base = start(async () => Response.json({ text: "   " }));
    await expect(
      transcribeAudio({ apiKey: "k", model: "m", baseUrl: base }, new Blob(["a"]), "a.ogg"),
    ).rejects.toThrow(/empty/);
  });

  test("throws when no API key or model is configured", async () => {
    await expect(
      transcribeAudio({ apiKey: "", model: "m" }, new Blob(["a"]), "a.ogg"),
    ).rejects.toThrow(/API key/);
    await expect(
      transcribeAudio({ apiKey: "k", model: "" }, new Blob(["a"]), "a.ogg"),
    ).rejects.toThrow(/model/);
  });
});
