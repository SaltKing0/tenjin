import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  ts: string;
  read: boolean;
}

export function inboxFile(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

export function sendMessage(
  inboxDir: string,
  msg: { from: string; to: string; subject: string; body: string },
): InboxMessage {
  mkdirSync(inboxDir, { recursive: true });
  const message: InboxMessage = {
    id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
    from: msg.from,
    to: msg.to,
    subject: msg.subject.replace(/\s+/g, " ").trim().slice(0, 200),
    body: msg.body.trim(),
    ts: new Date().toISOString(),
    read: false,
  };
  writeFileSync(inboxFile(inboxDir, message.id), JSON.stringify(message, null, 2));
  return message;
}

export function listMessages(inboxDir: string): InboxMessage[] {
  if (!existsSync(inboxDir)) return [];
  const messages: InboxMessage[] = [];
  for (const file of readdirSync(inboxDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(inboxDir, file), "utf8")) as InboxMessage;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.from === "string" &&
        typeof parsed.body === "string"
      ) {
        messages.push(parsed);
      }
    } catch {
      // skip corrupted
    }
  }
  return messages.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

export function unreadMessages(inboxDir: string): InboxMessage[] {
  return listMessages(inboxDir).filter((m) => !m.read);
}

export function markRead(inboxDir: string, ids: string[]): void {
  for (const id of ids) {
    const path = inboxFile(inboxDir, id);
    if (!existsSync(path)) continue;
    try {
      const msg = JSON.parse(readFileSync(path, "utf8")) as InboxMessage;
      msg.read = true;
      writeFileSync(path, JSON.stringify(msg, null, 2));
    } catch {
      // skip corrupted
    }
  }
}

export function formatInbox(messages: InboxMessage[]): string {
  if (messages.length === 0) return "inbox empty";
  return messages
    .map(
      (m) =>
        `[${m.ts.slice(0, 16).replace("T", " ")}] from ${m.from}: ${m.subject}\n${m.body.length > 400 ? `${m.body.slice(0, 400)}…` : m.body}`,
    )
    .join("\n---\n");
}
