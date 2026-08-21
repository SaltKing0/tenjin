import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type ApprovalStatus = "pending" | "approved" | "denied";

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
  },
): ApprovalRequest {
  mkdirSync(approvalsDir(home), { recursive: true });
  const rawInput = fields.input !== undefined ? fields.input : fields.inputSummary ?? "";
  const summarySource = fields.inputSummary ?? summarizeInput(rawInput);
  const req: ApprovalRequest = {
    id: randomUUID().slice(0, 8),
    bot: fields.bot,
    tool: fields.tool,
    inputSummary: summarySource.replace(/\s+/g, " ").trim().slice(0, 300),
    input: rawInput,
    ts: new Date().toISOString(),
    status: "pending",
  };
  writeFileSync(requestPath(home, req.id), JSON.stringify(req, null, 2));
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

export function resolveRequest(
  home: string,
  id: string,
  status: Exclude<ApprovalStatus, "pending">,
): boolean {
  const req = getRequest(home, id);
  if (!req || req.status !== "pending") return false;
  req.status = status;
  writeFileSync(requestPath(home, id), JSON.stringify(req, null, 2));
  return true;
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
    if (req && req.status !== "pending") return req.status;
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
