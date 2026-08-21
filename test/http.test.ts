import { describe, test, expect, afterEach } from "bun:test";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";

let handle: HttpServerHandle | null = null;

afterEach(() => {
  handle?.stop();
  handle = null;
});

function start(overrides: Partial<Parameters<typeof startHttpServer>[0]> = {}) {
  handle = startHttpServer({
    config: { port: 0, host: "127.0.0.1", token: "SECRETTOKEN" },
    handleMessage: async (text) => `echo:${text}`,
    status: () => ({ jobs: [{ name: "j1", bot: "b", nextDueMs: 123 }] }),
    ...overrides,
  });
  return `http://127.0.0.1:${handle.port}`;
}

test("rejects missing bearer token", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(401);
});

test("rejects wrong token", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer WRONG", "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  expect(res.status).toBe(401);
});

test("POST /message returns handler reply", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: JSON.stringify({ text: "investigate auth" }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { reply?: string };
  expect(data.reply).toBe("echo:investigate auth");
});

test("POST /message validates text", async () => {
  const base = start();
  const res = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

test("GET /status returns uptime and jobs", async () => {
  const base = start();
  const res = await fetch(`${base}/status`, {
    headers: { authorization: "Bearer SECRETTOKEN" },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(typeof data.uptimeMs).toBe("number");
  expect(data.jobs[0]?.name).toBe("j1");
});

test("unknown routes 404; invalid json 400", async () => {
  const base = start();
  const notFound = await fetch(`${base}/nope`, {
    headers: { authorization: "Bearer SECRETTOKEN" },
  });
  expect(notFound.status).toBe(404);

  const badJson = await fetch(`${base}/message`, {
    method: "POST",
    headers: { authorization: "Bearer SECRETTOKEN", "content-type": "application/json" },
    body: "{broken",
  });
  expect(badJson.status).toBe(400);
});
