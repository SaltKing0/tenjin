import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRequest,
  getRequest,
  resolveRequest,
  summarizeInput,
  waitApproval,
} from "../src/gateway/approvals";

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
