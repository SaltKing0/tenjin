import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { InboxConfig } from "../config/types";

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  ts: string;
  read: boolean;
}

export interface InboxPolicy {
  /** Messages older than this are purged on read/write. Default: 30 days. 0 disables. */
  ttlMs?: number;
  /** Max messages kept per inbox; oldest read messages are dropped first. Default: 500. 0 disables. */
  maxMessages?: number;
}

export const DEFAULT_INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_INBOX_MAX_MESSAGES = 500;
const STALE_TMP_MS = 60_000;

function resolvePolicy(p?: InboxPolicy): Required<InboxPolicy> {
  return {
    ttlMs: p?.ttlMs ?? DEFAULT_INBOX_TTL_MS,
    maxMessages: p?.maxMessages ?? DEFAULT_INBOX_MAX_MESSAGES,
  };
}

/** Map `inbox:` from config.yaml onto a store policy. `ttlDays: 0` / `maxMessages: 0` disable. */
export function inboxPolicyFromConfig(inbox?: InboxConfig): InboxPolicy | undefined {
  if (!inbox) return undefined;
  const policy: InboxPolicy = {};
  if (inbox.ttlDays !== undefined) policy.ttlMs = inbox.ttlDays * 86_400_000;
  if (inbox.maxMessages !== undefined) policy.maxMessages = inbox.maxMessages;
  return policy;
}

export function inboxFile(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

let lastMs = 0;

function nowUnique(): number {
  const now = Date.now();
  lastMs = now > lastMs ? now : lastMs + 1;
  return lastMs;
}

export function sendMessage(
  inboxDir: string,
  msg: { from: string; to: string; subject: string; body: string },
  policy?: InboxPolicy,
): InboxMessage {
  mkdirSync(inboxDir, { recursive: true });
  const ts = nowUnique();
  const message: InboxMessage = {
    id: `${ts}-${randomUUID().slice(0, 8)}`,
    from: msg.from,
    to: msg.to,
    subject: msg.subject.replace(/\s+/g, " ").trim().slice(0, 200),
    body: msg.body.trim(),
    ts: new Date(ts).toISOString(),
    read: false,
  };
  atomicWriteJson(inboxFile(inboxDir, message.id), message);
  listMessages(inboxDir, policy);
  return message;
}

/** Raw listing without side effects; sorted chronologically. */
function readMessages(inboxDir: string): InboxMessage[] {
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

function isTmpFile(name: string): boolean {
  return name.includes(".tmp-") || name.endsWith(".tmp");
}

/** Remove expired messages and crash-orphaned atomic-write temp files. */
function purgeExpired(inboxDir: string, ttlMs: number): void {
  const cutoff = ttlMs > 0 ? Date.now() - ttlMs : null;
  const now = Date.now();
  for (const file of readdirSync(inboxDir)) {
    const path = join(inboxDir, file);
    if (isTmpFile(file)) {
      try {
        if (now - statSync(path).mtimeMs >= STALE_TMP_MS) rmSync(path, { force: true });
      } catch {
        // raced with a writer
      }
      continue;
    }
    if (cutoff === null || !file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as InboxMessage;
      if (parsed && typeof parsed.ts === "string" && new Date(parsed.ts).getTime() < cutoff) {
        rmSync(path, { force: true });
      }
    } catch {
      // skip corrupted
    }
  }
}

/** Drop oldest read messages first, then oldest unread, until under the cap. */
function enforceMax(inboxDir: string, maxMessages: number): void {
  if (maxMessages <= 0) return;
  const all = readMessages(inboxDir);
  if (all.length <= maxMessages) return;
  const excess = all.length - maxMessages;
  const victims = new Set<string>();
  for (const m of all) {
    if (victims.size >= excess) break;
    if (m.read) victims.add(m.id);
  }
  for (const m of all) {
    if (victims.size >= excess) break;
    if (!m.read) victims.add(m.id);
  }
  for (const id of victims) rmSync(inboxFile(inboxDir, id), { force: true });
}

export function listMessages(inboxDir: string, policy?: InboxPolicy): InboxMessage[] {
  if (!existsSync(inboxDir)) return [];
  const { ttlMs, maxMessages } = resolvePolicy(policy);
  purgeExpired(inboxDir, ttlMs);
  enforceMax(inboxDir, maxMessages);
  return readMessages(inboxDir);
}

export function unreadMessages(inboxDir: string, policy?: InboxPolicy): InboxMessage[] {
  return listMessages(inboxDir, policy).filter((m) => !m.read);
}

export function markRead(inboxDir: string, ids: string[]): void {
  for (const id of ids) {
    const path = inboxFile(inboxDir, id);
    if (!existsSync(path)) continue;
    try {
      const msg = JSON.parse(readFileSync(path, "utf8")) as InboxMessage;
      if (msg.read) continue;
      msg.read = true;
      atomicWriteJson(path, msg);
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
