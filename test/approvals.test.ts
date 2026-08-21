import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  approvalsDir,
  createRequest,
  expirePendingRequests,
  getRequest,
  resolveRequest,
  summarizeInput,
  waitApproval,
} from "../src/gateway/approvals";

/** Write a pending request straight to disk with an explicit ts (bypasses createRequest). */
function writePending(home: string, id: string, ts: string): void {
  mkdirSync(approvalsDir(home), { recursive: true });
  writeFileSync(
    join(approvalsDir(home), `${id}.json`),
    JSON.stringify(
      { id, bot: "b", tool: "bash", inputSummary: "x", input: "x", ts, status: "pending" },
      null,
      2,
    ),
  );
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tj-appr-"));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("create + get round-trips a pending request", () => {
  const req = createRequest(home, {
    bot: "researcher",
    tool: "bash",
    inputSummary: 'command: {"command":"bun install"}',
  });
  expect(req.status).toBe("pending");
  expect(req.id).toMatch(/^[a-z0-9-]{8}$/);
  const fetched = getRequest(home, req.id);
  expect(fetched?.tool).toBe("bash");
  expect(fetched?.bot).toBe("researcher");
});

test("resolveRequest transitions pending only", () => {
  const req = createRequest(home, { bot: "b", tool: "edit_file", inputSummary: "x" });
  expect(resolveRequest(home, req.id, "approved")).toBe(true);
  expect(getRequest(home, req.id)?.status).toBe("approved");
  expect(resolveRequest(home, req.id, "denied")).toBe(false);
  expect(resolveRequest(home, "ghost", "denied")).toBe(false);
});

test("waitApproval returns immediately on resolved request", async () => {
  const req = createRequest(home, { bot: "b", tool: "write_file", inputSummary: "y" });
  resolveRequest(home, req.id, "approved");
  const start = Date.now();
  expect(await waitApproval(home, req.id, 5000)).toBe("approved");
  expect(Date.now() - start).toBeLessThan(1000);
});

test("waitApproval times out on pending request", async () => {
  const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "z" });
  expect(await waitApproval(home, req.id, 300)).toBe("timeout");
});

test("waitApproval picks up async approval", async () => {
  const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "z" });
  setTimeout(() => resolveRequest(home, req.id, "approved"), 400);
  expect(await waitApproval(home, req.id, 5000)).toBe("approved");
});

test("summarizeInput truncates and flattens", () => {
  const out = summarizeInput({ command: "x".repeat(1000) });
  expect(out.length).toBeLessThanOrEqual(300);
  expect(summarizeInput({ a: 1 })).toContain('"a":1');
});

test("createRequest stores an untruncated copy when only inputSummary is given", () => {
  const long = "echo " + "a".repeat(400);
  expect(long.length).toBeGreaterThan(300);
  const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: long });
  expect(req.inputSummary.length).toBe(300);
  expect(req.input).toBe(long);
  expect(getRequest(home, req.id)?.input).toBe(long);
});

test("createRequest stores the full tool input even when the summary is truncated", () => {
  const command = `echo ${"secret-payload-".repeat(30)}`;
  expect(command.length).toBeGreaterThan(300);
  const req = createRequest(home, {
    bot: "researcher",
    tool: "bash",
    input: { command },
  });
  expect(req.inputSummary.length).toBeLessThanOrEqual(300);
  expect(req.input).toEqual({ command });
  const fetched = getRequest(home, req.id);
  expect(fetched?.input).toEqual({ command });
  expect((fetched?.input as { command: string }).command).toBe(command);
});

test("expirePendingRequests marks overdue pending requests as expired", () => {
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  writePending(home, "stale1", old);
  writePending(home, "stale2", old);
  writePending(home, "fresh", new Date().toISOString());
  const expired = expirePendingRequests(home, 3_600_000);
  expect(expired).toBe(2);
  expect(getRequest(home, "stale1")?.status).toBe("expired");
  expect(getRequest(home, "stale2")?.status).toBe("expired");
  expect(getRequest(home, "fresh")?.status).toBe("pending");
});

test("expirePendingRequests leaves already-resolved requests untouched", () => {
  const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
  writePending(home, "was-approved", old);
  expect(resolveRequest(home, "was-approved", "approved")).toBe(true);
  expect(expirePendingRequests(home, 3_600_000)).toBe(0);
  expect(getRequest(home, "was-approved")?.status).toBe("approved");
});

test("resolveRequest on an expired request returns false", () => {
  writePending(home, "exp", new Date(Date.now() - 2 * 3_600_000).toISOString());
  expirePendingRequests(home, 3_600_000);
  expect(getRequest(home, "exp")?.status).toBe("expired");
  expect(resolveRequest(home, "exp", "approved")).toBe(false);
  expect(getRequest(home, "exp")?.status).toBe("expired");
});

test("parallel double-resolve yields exactly one success", async () => {
  const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "x" });
  const results = await Promise.all(
    (["approved", "denied"] as const).map((status) =>
      Promise.resolve().then(() => resolveRequest(home, req.id, status)),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("two threads resolving the same request atomically yields one winner", async () => {
  const rounds = 30;
  let failures = 0;
  for (let round = 0; round < rounds; round++) {
    const req = createRequest(home, { bot: "b", tool: "bash", inputSummary: "x" });
    const modUrl = new URL("../src/gateway/approvals.ts", import.meta.url).href;
    const sab = new SharedArrayBuffer(4);
    const gate = new Int32Array(sab);

    const workerSrc = `
      import { parentPort, workerData } from "node:worker_threads";
      const { modUrl, home, id, status, sab } = workerData;
      const gate = new Int32Array(sab);
      Atomics.wait(gate, 0, 0);
      const { resolveRequest } = await import(modUrl);
      parentPort.postMessage(resolveRequest(home, id, status));
    `;
    const run = (status: "approved" | "denied") =>
      new Promise<boolean>((resolve, reject) => {
        const w = new Worker(workerSrc, {
          eval: true,
          workerData: { modUrl, home, id: req.id, status, sab },
        });
        w.once("message", (v) => {
          w.terminate();
          resolve(v as boolean);
        });
        w.once("error", (e) => {
          w.terminate();
          reject(e);
        });
      });

    const pending = [run("approved"), run("denied")];
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    const results = await Promise.all(pending);
    if (results.filter(Boolean).length !== 1) failures++;
    const status = getRequest(home, req.id)?.status;
    expect(status === "approved" || status === "denied").toBe(true);
  }
  expect(failures).toBe(0);
});
