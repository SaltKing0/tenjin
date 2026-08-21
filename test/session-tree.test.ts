import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTree } from "../src/session/log";
import { startHttpServer, type HttpServerHandle } from "../src/gateway/http";
import { createConsoleApi } from "../src/gateway/console-api";
import { AuditLog } from "../src/audit/log";
import type { HarnessConfig } from "../src/config/types";

let home: string;
let server: HttpServerHandle | null = null;
const TOKEN = "tree-token";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-tree-"));
});

afterEach(() => {
  server?.stop();
  server = null;
  rmSync(home, { recursive: true, force: true });
});

function sessionsDir(): string {
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a session file whose events are given as strings (one JSON per line). */
function writeSession(id: string, events: object[]): void {
  writeFileSync(
    join(sessionsDir(), `${id}.jsonl`),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}

function start(prefix: string): object {
  return { t: "session_start", id: prefix, ts: "2026-08-21T10:00:00Z" };
}

function startWithParent(id: string, parentId: string, uptoEvent: number): object {
  return { ...start(id), parent: { id: parentId, uptoEvent } };
}

describe("sessionTree", () => {
  test("single session with no parent yields one node, no compressions", () => {
    writeSession("rrrr", [start("rrrr"), { t: "message", role: "user", content: "hi", ts: "t" }]);
    const nodes = sessionTree(sessionsDir(), "rrrr");
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.id).toBe("rrrr");
    expect(nodes[0]!.parentId).toBeNull();
    expect(nodes[0]!.compressions).toEqual([]);
  });

  test("fork-of-fork builds the full ancestor chain with compression markers", () => {
    // root: has a compression (elision) boundary
    writeSession("root1", [
      start("root1"),
      { t: "message", role: "user", content: "a", ts: "t" },
      { t: "compression", beforeTokens: 1000, afterTokens: 300, elidedTokens: 700, ts: "t" },
      { t: "message", role: "assistant", content: "b", ts: "t" },
    ]);
    // mid: forked from root, no compression
    writeSession("mid01", [
      startWithParent("mid01", "root1", 3),
      { t: "message", role: "user", content: "c", ts: "t" },
    ]);
    // child: forked from mid, has its own compression
    writeSession("child1", [
      startWithParent("child1", "mid01", 2),
      { t: "message", role: "user", content: "d", ts: "t" },
      { t: "compression", beforeTokens: 800, afterTokens: 400, elidedTokens: 400, ts: "t" },
    ]);

    const nodes = sessionTree(sessionsDir(), "child1");
    expect(nodes.map((n) => n.id)).toEqual(["child1", "mid01", "root1"]);
    expect(nodes[0]!.parentId).toBe("mid01");
    expect(nodes[1]!.parentId).toBe("root1");
    expect(nodes[2]!.parentId).toBeNull();
    // compression markers land on the sessions that elided
    expect(nodes[0]!.compressions).toEqual([
      { beforeTokens: 800, afterTokens: 400, elidedTokens: 400, ts: "t" },
    ]);
    expect(nodes[1]!.compressions).toEqual([]);
    expect(nodes[2]!.compressions).toEqual([
      { beforeTokens: 1000, afterTokens: 300, elidedTokens: 700, ts: "t" },
    ]);
  });

  test("a broken parent link stops the walk instead of throwing", () => {
    writeSession("only1", [startWithParent("only1", "missing", 1)]);
    const nodes = sessionTree(sessionsDir(), "only1");
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.id).toBe("only1");
    expect(nodes[0]!.parentId).toBe("missing");
  });

  test("unknown id throws", () => {
    expect(() => sessionTree(sessionsDir(), "nope")).toThrow();
  });
});

describe("GET /api/sessions/:id/tree", () => {
  const config = (): HarnessConfig =>
    ({ provider: "anthropic", model: "m", maxTokens: 256, budgetUSD: 1, approval: {} }) as HarnessConfig;

  test("returns the lineage JSON and 404s on unknown ids", async () => {
    writeSession("root1", [
      start("root1"),
      { t: "message", role: "user", content: "a", ts: "t" },
      { t: "compression", beforeTokens: 1000, afterTokens: 300, elidedTokens: 700, ts: "t" },
    ]);
    writeSession("child1", [startWithParent("child1", "root1", 2)]);

    const audit = new AuditLog(join(home, "audit.jsonl"));
    const srv = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: TOKEN },
      handleMessage: async () => null,
      status: () => ({}),
      api: createConsoleApi({
        home,
        cwd: home,
        config: config(),
        registry: { get: () => ({}) } as never,
        audit,
      }),
      consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
    });
    server = srv;
    const base = `http://127.0.0.1:${srv.port}`;

    const res = await fetch(`${base}/api/sessions/child1/tree`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; nodes: { id: string; parentId: string | null; compressions: unknown[] }[] };
    expect(data.id).toBe("child1");
    expect(data.nodes.map((n) => n.id)).toEqual(["child1", "root1"]);
    expect(data.nodes[1]!.compressions.length).toBe(1);
  });

  test("unknown id returns 404", async () => {
    const audit = new AuditLog(join(home, "audit.jsonl"));
    const srv = startHttpServer({
      config: { port: 0, host: "127.0.0.1", token: TOKEN },
      handleMessage: async () => null,
      status: () => ({}),
      api: createConsoleApi({ home, cwd: home, config: config(), registry: { get: () => ({}) } as never, audit }),
      consoleDir: join(import.meta.dir, "..", "src", "gateway", "console"),
    });
    server = srv;
    const base = `http://127.0.0.1:${srv.port}`;
    const res = await fetch(`${base}/api/sessions/nope/tree`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
