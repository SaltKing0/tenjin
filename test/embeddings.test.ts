import { describe, test, expect, afterEach } from "bun:test";
import { OpenAIEmbeddings, createEmbeddings } from "../src/provider/embeddings";

const originalKey = process.env.OPENAI_API_KEY;
const originalBase = process.env.OPENAI_BASE_URL;

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  if (originalBase === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBase;
});

test("createEmbeddings returns null without OPENAI_API_KEY", () => {
  delete process.env.OPENAI_API_KEY;
  expect(createEmbeddings({})).toBeNull();
});

test("createEmbeddings returns provider with key present", () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const e = createEmbeddings({});
  expect(e?.name).toBe("openai");
  expect(e?.model).toBe("text-embedding-3-small");
});

describe("OpenAIEmbeddings.embed", () => {
  test("posts batch and maps vectors by index", async () => {
    let captured: { url: string; body: any; headers: any } | undefined;
    const e = new OpenAIEmbeddings(
      "text-embedding-3-small",
      "sk-test",
      "http://localhost:1/v1",
    );
    (e as any).baseUrl = "http://mock";
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [3, 3] },
            { index: 0, embedding: [1, 1] },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const vectors = await e.embed(["first", "second"]);
      expect(vectors).toEqual([
        [1, 1],
        [3, 3],
      ]);
      expect(captured?.url).toBe("http://mock/embeddings");
      expect(captured?.body.model).toBe("text-embedding-3-small");
      expect(captured?.body.input).toEqual(["first", "second"]);
      expect(captured?.headers.authorization).toBe("Bearer sk-test");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("empty input short-circuits without network", async () => {
    const e = new OpenAIEmbeddings("m", "k", "http://invalid");
    expect(await e.embed([])).toEqual([]);
  });

  test("api error surfaces status and body snippet", async () => {
    const e = new OpenAIEmbeddings("m", "bad", "http://mock");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), { status: 401 })) as unknown as typeof fetch;
    try {
      await expect(e.embed(["x"])).rejects.toThrow(/401/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("missing vector at an index throws", async () => {
    const e = new OpenAIEmbeddings("m", "k", "http://mock");
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      await expect(e.embed(["a", "b"])).rejects.toThrow(/missing vector at index 1/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
