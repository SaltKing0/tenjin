import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/tools/registry";
import { webFetchTool } from "../src/tools/web-fetch";
import { SecurityGuard } from "../src/security/guard";

const tools = [webFetchTool];
const cwd = tmpdir();

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

/** Local fixture server returning the given body for every path. */
function startServer(status = 200, body = "", headers: Record<string, string> = {}): string {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
    },
  });
  return `http://127.0.0.1:${server!.port}/page`;
}

const PAGE = `
<!doctype html><html><head><title>Fixture</title>
<style>body{display:none}</style><script>alert('xss')</script></head>
<body>
<nav><a href="/home">NavLink</a><a href="/ads">SponsoredAd</a></nav>
<header>SiteHeader</header>
<div class="ad">BUY NOW</div>
<article>
<h1>Main Heading</h1>
<p>First useful paragraph with a <a href="/detail">link</a>.</p>
<p>Second paragraph of real content.</p>
<ul><li>Item one</li><li>Item two</li></ul>
</article>
<footer>FooterLinks</footer>
</body></html>
`;

test("fetch + strip produces markdown with boilerplate gone", async () => {
  const url = startServer(200, PAGE);
  const r = await dispatch(tools, "web_fetch", { url }, { cwd });
  expect(r.ok).toBe(true);
  expect(r.output).toContain("Main Heading");
  expect(r.output).toContain("First useful paragraph");
  // boilerplate / scripts / styles must be stripped
  expect(r.output).not.toContain("<script>");
  expect(r.output).not.toContain("<style>");
  expect(r.output).not.toContain("NavLink");
  expect(r.output).not.toContain("SponsoredAd");
  expect(r.output).not.toContain("BUY NOW");
  expect(r.output).not.toContain("SiteHeader");
  expect(r.output).not.toContain("FooterLinks");
});

test("non-http(s) scheme is rejected", async () => {
  const r = await dispatch(tools, "web_fetch", { url: "ftp://example.com/file" }, { cwd });
  expect(r.ok).toBe(false);
  expect(r.output).toMatch(/http/i);
});

test("deny-listed domain is blocked by the guard with a clean message", async () => {
  const url = startServer(200, PAGE);
  // the fixture host is 127.0.0.1 — block it by pattern
  const guard = new SecurityGuard([], undefined, { denyDomains: ["127.0.0.1"] });
  const r = await dispatch(tools, "web_fetch", { url }, { cwd, guard });
  expect(r.ok).toBe(false);
  expect(r.output).toMatch(/blocked/i);
});

test("oversize page spills to a temp file and returns its path", async () => {
  const big = "<p>" + "x".repeat(60_000) + "</p>";
  const url = startServer(200, big);
  const r = await dispatch(tools, "web_fetch", { url }, { cwd });
  expect(r.ok).toBe(true);
  expect(r.output).toMatch(/saved to/);
  const m = r.output.match(/saved to ([^\s\]]+\.md)\]/);
  expect(m).toBeTruthy();
  expect(m![1]!.startsWith(tmpdir())).toBe(true);
  expect(existsSync(m![1]!)).toBe(true);
});

test("output is wrapped as untrusted data", async () => {
  const url = startServer(200, PAGE);
  const r = await dispatch(tools, "web_fetch", { url }, { cwd });
  expect(r.ok).toBe(true);
  expect(r.output).toContain("<untrusted_data>");
  expect(r.output).toContain("</untrusted_data>");
});
