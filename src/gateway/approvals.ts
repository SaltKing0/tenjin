import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { emit } from "./events";
import { Redactor } from "../security/redact";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

/**
 * How long a pending approval may sit before the next scan marks it `expired`.
 * Longer than any gateway approval wait so legitimate requests are not dropped,
 * short enough that abandoned requests stop accumulating forever.
 */
export const DEFAULT_APPROVAL_TTL_MS = 60 * 60 * 1000; // 1h

export interface ApprovalRequest {
  id: string;
  bot: string;
  tool: string;
  inputSummary: string;
  /** Full tool input. Optional on records written before this field existed. */
  input?: unknown;
  ts: string;
  status: ApprovalStatus;
}

export function approvalsDir(home: string): string {
  return join(home, "approvals");
}

function requestPath(home: string, id: string): string {
  return join(approvalsDir(home), `${id}.json`);
}

export function createRequest(
  home: string,
  fields: {
    bot: string;
    tool: string;
    inputSummary?: string;
    input?: unknown;
    /** Mask secrets in the stored input/summary before they reach disk / notices. */
    redactor?: Redactor;
  },
): ApprovalRequest {
  mkdirSync(approvalsDir(home), { recursive: true });
  // #177: approvals must not bypass the redaction layer. The full tool input
  // (and the summary, when a full input is missing) is masked before it lands
  // on disk or in an outbound notice — matching session/audit redaction.
  const redactor = fields.redactor ?? new Redactor();
  const rawInput = fields.input !== undefined ? fields.input : fields.inputSummary ?? "";
  const maskedInput = redactor.redactValue(rawInput);
  const summarySource = fields.inputSummary ?? summarizeInput(maskedInput);
  const maskedSummary = redactor.redact(summarySource);
  const req: ApprovalRequest = {
    id: randomUUID().slice(0, 8),
    bot: fields.bot,
    tool: fields.tool,
    inputSummary: maskedSummary.replace(/\s+/g, " ").trim().slice(0, 300),
    input: maskedInput,
    ts: new Date().toISOString(),
    status: "pending",
  };
  writeFileSync(requestPath(home, req.id), JSON.stringify(req, null, 2));
  emit("approval.created", { id: req.id });
  return req;
}

export function getRequest(home: string, id: string): ApprovalRequest | null {
  const path = requestPath(home, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ApprovalRequest;
  } catch {
    return null;
  }
}

/**
 * Scan the approvals dir and mark pending requests older than `ttlMs` as
 * `expired`. Returns the number of requests expired. Already-resolved requests,
 * corrupt files and temp/lock files are skipped. Mirrors the inbox purge scan.
 */
export function expirePendingRequests(home: string, ttlMs: number): number {
  const dir = approvalsDir(home);
  if (!existsSync(dir)) return 0;
  const cutoff = Date.now() - ttlMs;
  let expired = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue; // skip tmp/lock files
    const req = getRequest(home, file.slice(0, -".json".length));
    if (!req || req.status !== "pending") continue;
    if (new Date(req.ts).getTime() < cutoff) {
      req.status = "expired";
      writeFileSync(requestPath(home, req.id), JSON.stringify(req, null, 2));
      expired++;
    }
  }
  return expired;
}

/**
 * Atomically resolve a pending request. The single-winner guarantee comes from
 * renaming the pending file to a private lock path: `renameSync` is atomic, so
 * exactly one concurrent resolver can claim the file; every other resolver gets
 * an error and reports "already resolved" (false). The winning resolver writes
 * the final status and renames the record back to its canonical path.
 */
export function resolveRequest(
  home: string,
  id: string,
  status: Exclude<ApprovalStatus, "pending">,
): boolean {
  const path = requestPath(home, id);
  if (!existsSync(path)) return false;
  // Fast-path: already resolved (e.g. a second resolve after the first commit).
  const current = getRequest(home, id);
  if (current && current.status !== "pending") return false;

  const lock = `${path}.${randomUUID().slice(0, 8)}.lock`;
  try {
    // Atomic claim — only the resolver that wins this rename proceeds.
    renameSync(path, lock);
  } catch {
    return false; // someone else claimed it (or the request vanished)
  }

  try {
    const req = JSON.parse(readFileSync(lock, "utf8")) as ApprovalRequest;
    if (req.status !== "pending") {
      // Resolved under the lock by another path — put the record back untouched.
      renameSync(lock, path);
      return false;
    }
    req.status = status;
    writeFileSync(lock, JSON.stringify(req, null, 2));
    renameSync(lock, path);
    emit("approval.resolved", { id, status });
    return true;
  } catch {
    rmSync(lock, { force: true });
    return false;
  }
}

export async function waitApproval(
  home: string,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"approved" | "denied" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    const req = getRequest(home, id);
    if (req && req.status !== "pending") {
      // An expired request will never be resolved by a human — treat as timeout.
      return req.status === "expired" ? "timeout" : req.status;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  return "timeout";
}

export function summarizeInput(input: unknown): string {
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return String(input).slice(0, 300);
  }
}
