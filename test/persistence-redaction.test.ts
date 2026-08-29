import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless } from "../src/agent/headless";
import type { ChatRequest, ChatResponse, Provider } from "../src/provider/types";
import { Redactor } from "../src/security/redact";
import type { SessionEvent } from "../src/session/events";
import { forwardEvent, logEvent } from "../src/ui/repl";

const USER_SECRET = "sk-user-secret-123456789";
const ASSISTANT_SECRET = "sk-assistant-secret-123456789";

class MemoryLogger {
  readonly events: SessionEvent[] = [];

  append(event: SessionEvent): void {
    this.events.push(event);
  }
}

function oneShotProvider(text: string): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const response: ChatResponse = {
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  return {
    name: "test",
    requests,
    async chat(request) {
      requests.push(request);
      return response;
    },
  };
}

describe("session persistence redaction", () => {
  test("forwardEvent redacts assistant content, tool inputs, and tool outputs by default", () => {
    const logger = new MemoryLogger();

    forwardEvent(
      { t: "assistant_message", content: [{ type: "text", text: ASSISTANT_SECRET }] },
      logger,
    );
    forwardEvent(
      { t: "tool_call", id: "call-1", name: "demo", input: { token: USER_SECRET } },
      logger,
    );
    forwardEvent(
      { t: "tool_result", id: "call-1", name: "demo", ok: true, output: USER_SECRET },
      logger,
    );

    const persisted = JSON.stringify(logger.events);
    expect(persisted).not.toContain(USER_SECRET);
    expect(persisted).not.toContain(ASSISTANT_SECRET);
    expect(persisted).toContain("[REDACTED]");
  });

  test("logEvent and forwardEvent respect an explicitly disabled redactor", () => {
    const logger = new MemoryLogger();
    const disabled = new Redactor(false);

    logEvent(
      logger,
      { t: "message", role: "user", content: USER_SECRET, ts: "2026-08-29T00:00:00.000Z" },
      disabled,
    );
    forwardEvent(
      { t: "assistant_message", content: [{ type: "text", text: ASSISTANT_SECRET }] },
      logger,
      undefined,
      disabled,
    );

    const persisted = JSON.stringify(logger.events);
    expect(persisted).toContain(USER_SECRET);
    expect(persisted).toContain(ASSISTANT_SECRET);
  });
});

describe("headless persistence redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tj-persistence-redaction-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("logs redacted user and assistant messages while the provider receives the raw user message", async () => {
    const provider = oneShotProvider(`answer ${ASSISTANT_SECRET}`);
    const sessionLogDir = join(dir, "sessions");

    await runHeadless({
      provider,
      model: "test-model",
      soulText: "test",
      cwd: dir,
      message: `question ${USER_SECRET}`,
      maxTokens: 32,
      capUSD: 1,
      policy: "none",
      sessionLogDir,
    });

    expect(provider.requests[0]?.messages[0]?.content).toBe(`question ${USER_SECRET}`);
    const logName = readdirSync(sessionLogDir).find((name) => name.endsWith(".jsonl"));
    expect(logName).toBeTruthy();
    const persisted = readFileSync(join(sessionLogDir, logName!), "utf8");
    expect(persisted).not.toContain(USER_SECRET);
    expect(persisted).not.toContain(ASSISTANT_SECRET);
    expect(persisted).toContain("[REDACTED]");
  });

  test("headless session logging respects redaction false", async () => {
    const provider = oneShotProvider(ASSISTANT_SECRET);
    const sessionLogDir = join(dir, "sessions");

    await runHeadless({
      provider,
      model: "test-model",
      soulText: "test",
      cwd: dir,
      message: USER_SECRET,
      maxTokens: 32,
      capUSD: 1,
      policy: "none",
      sessionLogDir,
      redactor: new Redactor(false),
    });

    const logName = readdirSync(sessionLogDir).find((name) => name.endsWith(".jsonl"));
    expect(logName).toBeTruthy();
    const persisted = readFileSync(join(sessionLogDir, logName!), "utf8");
    expect(persisted).toContain(USER_SECRET);
    expect(persisted).toContain(ASSISTANT_SECRET);
  });
});
