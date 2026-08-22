import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { dispatch } from "../src/tools/registry";
import { createWebSearchTool, parseCandidates } from "../src/tools/web-search";
import { webSearchEnabled } from "../src/config/loader";

let server: ReturnType<typeof Bun.serve> | null = null;
let base = "";

const RESULTS = [
  { title: "Tenjin Docs", url: "https://example.com/docs", description: "The Tenjin agent harness docs." },
  { title: "Bun Blog", url: "https://example.com/bun", description: "Bun runtime blog." },
  { title: "TypeScript Guide", url: "https://example.com/ts", description: "A TypeScript guide." },
  { title: "Node Weekly", url: "https://example.com/node", description: "Node.js newsletter." },
  { title: "Zero Deps", url: "https://example.com/zero", description: "Building without dependencies." },
];

/** Mock Brave-shaped API: echoes count and returns RESULTS. */
function startServer(status = 200): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      if (status !== 200) return new Response("unauthorized", { status });
      const u = new URL(req.url);
      const count = Number(u.searchParams.get("count")) || RESULTS.length;
      return Response.json({ web: { results: RESULTS.slice(0, count) } });
    },
  });
  base = `http://127.0.0.1:${server!.port}`;
  return base;
}

beforeEach(() => {
  // ensure no ambient key leaks into the missing-key test
  delete process.env.BRAVE_API_KEY;
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

describe("webSearchEnabled (default-off flag)", () => {
  test("is OFF by default and only on when enabled: true", () => {
    expect(webSearchEnabled({})).toBe(false);
    expect(webSearchEnabled({ webSearch: { enabled: false } })).toBe(false);
    expect(webSearchEnabled({ webSearch: { enabled: true } })).toBe(true);
  });
});

describe("parseCandidates", () => {
  test("extracts title/url/description and skips empty entries", () => {
    const c = parseCandidates({
      web: { results: [{ title: "A", url: "u", description: "d" }, { url: "only-url" }, {}] },
    });
    expect(c).toEqual([
      { title: "A", url: "u", description: "d" },
      { title: "", url: "only-url", description: "" },
    ]);
  });
});

describe("web_search tool", () => {
  test("returns ranked candidates wrapped as untrusted data", async () => {
    const url = startServer();
    const tool = createWebSearchTool({ enabled: true, apiKey: "test-key", endpoint: url });
    const r = await dispatch([tool], "web_search", { query: "tenjin" }, { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("<untrusted_data>");
    expect(r.output).toContain("</untrusted_data>");
    expect(r.output).toContain("1. Tenjin Docs");
    expect(r.output).toContain("https://example.com/docs");
    expect(r.output).toContain("The Tenjin agent harness docs.");
    expect(r.output).toContain("5. Zero Deps");
  });

  test("respects count (only N candidates returned)", async () => {
    const url = startServer();
    const tool = createWebSearchTool({ enabled: true, apiKey: "k", endpoint: url });
    const r = await dispatch([tool], "web_search", { query: "x", count: 2 }, { cwd: "/tmp" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("2. Bun Blog");
    expect(r.output).not.toContain("3. TypeScript Guide");
  });

  test("missing API key is a clean error, no fetch", async () => {
    const url = startServer();
    const tool = createWebSearchTool({ enabled: true, endpoint: url }); // no key
    const r = await dispatch([tool], "web_search", { query: "x" }, { cwd: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/API key|BRAVE_API_KEY/);
  });

  test("API error surfaces a clean one-line message", async () => {
    const url = startServer(401);
    const tool = createWebSearchTool({ enabled: true, apiKey: "k", endpoint: url });
    const r = await dispatch([tool], "web_search", { query: "x" }, { cwd: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/HTTP 401|API error/);
    expect(r.output).not.toContain("at ");
  });

  test("empty query is rejected cleanly", async () => {
    const tool = createWebSearchTool({ enabled: true, apiKey: "k" });
    const r = await dispatch([tool], "web_search", { query: "   " }, { cwd: "/tmp" });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/non-empty query/);
  });
});
