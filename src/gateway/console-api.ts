import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../config/types";
import { ConfigError } from "../config/types";
import type { ProviderRegistry } from "../provider/registry";
import {
  listBots,
  botModelRef,
  resolveBot,
  createBot,
  readBotSoul,
  writeBotSoul,
  renameBot,
  deleteBot,
} from "../bots/profile";
import { sanitizeSkillName } from "../skills/loader";
import { inboxPolicyFromConfig, unreadMessages } from "../bots/inbox";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";
import { aggregateSpend, perBotBreakdown } from "../audit/spend";
import { AuditLog, formatAuditMarkdown, AUDIT_KINDS, type AuditKind, type AuditQuery } from "../audit/log";
import {
  approvalsDir,
  DEFAULT_APPROVAL_TTL_MS,
  expirePendingRequests,
  getRequest,
  resolveRequest,
  type ApprovalRequest,
} from "./approvals";
import { getSettings, applySettings, detectModels, testProvider, verifySettingsApply, DetectTimeoutError } from "./settings";
import { sessionsDir } from "../config/loader";
import { listConfiguredJobs, type JobRunResult, type JobView } from "./gateway";
import { readFacts } from "../tools/memory";
import { listSummaries, type SummaryEntry } from "../memory/summaries";
import { loadChunks, vectorsFilePath } from "../memory/vector-store";

export interface JobsApi {
  list(): JobView[];
  runNow(name: string): Promise<JobRunResult>;
}

export interface ConsoleApiDeps {
  home: string;
  cwd: string;
  config: HarnessConfig;
  registry: ProviderRegistry;
  audit: AuditLog;
  jobs?: JobsApi;
}

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function scopeSessionsDir(home: string, bot: string | null): string | null {
  if (!bot || bot === "solo") return sessionsDir(home);
  if (!ID_PATTERN.test(bot) || !listBots(home).includes(bot)) return null;
  return join(home, "bots", bot, "sessions");
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** List cards show the truncated summary; full input is GET /api/approvals/:id. */
/**
 * #147: best-effort old/new extraction for an edit/write approval so the
 * console can render a real diff instead of raw tool input. Tolerates the
 * common field spellings across tools; for a write it falls back to the target
 * file's current content as the "old" baseline. Returns undefined when nothing
 * old/new can be derived (console then shows the raw input as before).
 */
function approvalDiff(
  tool: string,
  input: unknown,
  cwd: string,
): { old: string; new: string } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const pathField = typeof obj.path === "string" ? obj.path : undefined;
  const isEdit = tool === "edit_file" || tool === "edit";
  const isWrite = tool === "write_file" || tool === "write";
  if (!isEdit && !isWrite && pathField === undefined) return undefined;

  const one = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string") return v;
    }
    return undefined;
  };
  let oldText = one("oldText", "old_string", "oldContent", "old", "oldString");
  const newText = one(
    "newText",
    "new_string",
    "newContent",
    "new",
    "content",
    "newString",
  );
  // write: old baseline = current file at path, new = provided content
  if (pathField && !oldText && newText) {
    try {
      const p = join(cwd, pathField);
      oldText = existsSync(p) ? readFileSync(p, "utf8") : "";
    } catch {
      oldText = "";
    }
  }
  if (oldText === undefined && newText === undefined) return undefined;
  return { old: oldText ?? "", new: newText ?? "" };
}

function approvalListItem(req: ApprovalRequest): Omit<ApprovalRequest, "input"> {
  return {
    id: req.id,
    bot: req.bot,
    tool: req.tool,
    inputSummary: req.inputSummary,
    ts: req.ts,
    status: req.status,
  };
}

function parseIsoBound(raw: string | null, field: "from" | "to"): { ms?: number; error?: string } {
  if (!raw) return {};
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { error: `invalid ${field}` };
  return { ms };
}

function auditQueryFromUrl(
  url: URL,
  defaultTail?: number,
): { opts: AuditQuery } | { error: string } {
  const from = parseIsoBound(url.searchParams.get("from"), "from");
  if (from.error) return { error: from.error };
  const to = parseIsoBound(url.searchParams.get("to"), "to");
  if (to.error) return { error: to.error };
  const kindParam = url.searchParams.get("kind");
  const tailParam = url.searchParams.get("tail");
  const opts: AuditQuery = {};
  if (from.ms !== undefined) opts.from = from.ms;
  if (to.ms !== undefined) opts.to = to.ms;
  if (kindParam) {
    if (!(AUDIT_KINDS as readonly string[]).includes(kindParam)) {
      return { error: `unknown audit kind \"${kindParam}\"` };
    }
    opts.kind = kindParam as AuditKind;
  }
  if (tailParam) opts.tail = Number(tailParam);
  else if (defaultTail !== undefined) opts.tail = defaultTail;
  const correlationParam = url.searchParams.get("correlationId");
  if (correlationParam) opts.correlationId = correlationParam;
  return { opts };
}

function parseExportFormat(raw: string | null): "json" | "markdown" | null {
  const v = (raw ?? "").toLowerCase();
  if (v === "json") return "json";
  if (v === "markdown" || v === "md") return "markdown";
  return null;
}

function auditDownload(body: string, contentType: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function createConsoleApi(deps: ConsoleApiDeps) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    const path = url.pathname;

    if (path === "/api/settings" && req.method === "GET") {
      return json(getSettings({ home: deps.home, config: deps.config, registry: deps.registry }));
    }

    if (path === "/api/settings" && req.method === "POST") {
      let body: Parameters<typeof applySettings>[1];
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      try {
        const settingsDeps = {
          home: deps.home,
          config: deps.config,
          registry: deps.registry,
          audit: (detail: string) => deps.audit.append("settings_changed", "console", detail),
        };
        await verifySettingsApply(settingsDeps, body);
        applySettings(settingsDeps, body);
        return json({ ok: true, settings: getSettings(settingsDeps) });
      } catch (e) {
        const err = (e as Error).message;
        deps.audit.append("settings_changed", "console", `settings apply rejected: ${err}`);
        return json({ error: err }, 400);
      }
    }

    if (path === "/api/settings/detect" && req.method === "POST") {
      let body: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; timeoutMs?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      try {
        const models = await detectModels(
          {
            provider: String(body.provider ?? ""),
            baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
          },
          typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined,
        );
        return json({ models });
      } catch (e) {
        const status = e instanceof DetectTimeoutError ? 504 : 400;
        return json({ error: (e as Error).message }, status);
      }
    }

    if (path === "/api/settings/test" && req.method === "POST") {
      let body: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; timeoutMs?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const result = await testProvider(
        {
          provider: String(body.provider ?? ""),
          baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        },
        typeof body.timeoutMs === "number" && body.timeoutMs > 0 ? body.timeoutMs : undefined,
      );
      return json(result);
    }

    if (path === "/api/bots" && req.method === "GET") {
      const bots = listBots(deps.home).map((name) => {
        const profile = resolveBotSafe(deps.home, name);
        const sessionsDirPath = join(deps.home, "bots", name, "sessions");
        const sessionCount = existsSync(sessionsDirPath)
          ? readdirSync(sessionsDirPath).filter((f) => f.endsWith(".jsonl")).length
          : 0;
        return {
          name,
          model: profile
            ? `${botModelRef(profile, deps.config).provider}:${botModelRef(profile, deps.config).model}`
            : "?",
          unread: profile
            ? unreadMessages(profile.inboxDir, inboxPolicyFromConfig(deps.config.inbox)).length
            : 0,
          sessions: sessionCount,
        };
      });
      return json({ bots });
    }

    const botSingleMatch = /^\/api\/bots\/([a-zA-Z0-9_-]+)$/.exec(path);

    if (path === "/api/bots" && req.method === "POST") {
      let body: { name?: unknown; soul?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const rawName = typeof body.name === "string" ? body.name : "";
      if (!rawName.trim()) return json({ error: "name is required" }, 400);
      const soul = typeof body.soul === "string" ? body.soul : undefined;
      try {
        createBot(deps.home, rawName, soul !== undefined ? { soul } : {});
        const name = sanitizeSkillName(rawName);
        return json({ ok: true, ...botDetailView(deps.home, name, deps.config) }, 201);
      } catch (e) {
        return botErrorResponse(e);
      }
    }

    if (botSingleMatch && req.method === "GET") {
      const name = botSingleMatch[1]!;
      const detail = botDetailView(deps.home, name, deps.config);
      if (!detail) return json({ error: "unknown bot" }, 404);
      return json(detail);
    }

    if (botSingleMatch && req.method === "PUT") {
      const name = botSingleMatch[1]!;
      let body: { soul?: unknown; rename?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      try {
        // Apply the soul first so an invalid (empty) soul fails before any rename.
        if (body.soul !== undefined) {
          if (typeof body.soul !== "string") return json({ error: "soul must be a string" }, 400);
          writeBotSoul(deps.home, name, body.soul);
        }
        let finalName = name;
        if (body.rename !== undefined) {
          if (typeof body.rename !== "string") return json({ error: "rename must be a string" }, 400);
          finalName = renameBot(deps.home, name, body.rename);
        }
        return json({ ok: true, ...botDetailView(deps.home, finalName, deps.config) });
      } catch (e) {
        return botErrorResponse(e);
      }
    }

    if (botSingleMatch && req.method === "DELETE") {
      const name = botSingleMatch[1]!;
      try {
        deleteBot(deps.home, name);
        deps.audit.append("data_delete", "console", `bot ${name} deleted`);
        return json({ ok: true });
      } catch (e) {
        if (e instanceof ConfigError) return json({ error: (e as Error).message }, 404);
        return json({ error: (e as Error).message }, 400);
      }
    }

    const memoryMatch = /^\/api\/memory\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (memoryMatch && req.method === "GET") {
      const name = memoryMatch[1]!;
      const profile = resolveBotSafe(deps.home, name);
      if (!profile) return json({ error: `unknown bot "${name}"` }, 400);
      const view = memoryView(deps.home, name);
      return json(view);
    }

    if (path === "/api/sessions" && req.method === "GET") {
      const bot = url.searchParams.get("bot");
      const dir = scopeSessionsDir(deps.home, bot);
      if (!dir) return json({ error: "unknown bot" }, 400);
      const limitRaw = url.searchParams.get("limit");
      const offsetRaw = url.searchParams.get("offset");
      const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const limit = limitRaw ? Number(limitRaw) : 100;
      const offset = offsetRaw ? Number(offsetRaw) : 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return json({ error: "limit must be an integer between 1 and 500" }, 400);
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return json({ error: "offset must be a non-negative integer" }, 400);
      }
      const scope = bot ?? "solo";
      let summaries = existsSync(dir)
        ? SessionLog.list(dir).map((s) => ({
            id: s.id,
            mtimeMs: s.mtimeMs,
            preview: s.preview,
            parentId: s.parentId ?? null,
          }))
        : [];
      summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (q) {
        summaries = summaries.filter(
          (s) => s.preview.toLowerCase().includes(q) || scope.toLowerCase().includes(q),
        );
      }
      return json({
        scope,
        total: summaries.length,
        sessions: summaries.slice(offset, offset + limit),
      });
    }

    const sessionMatch = /^\/api\/session\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (sessionMatch && req.method === "GET") {
      const id = sessionMatch[1];
      if (!id) return json({ error: "missing id" }, 400);
      const bot = url.searchParams.get("bot");
      const dir = scopeSessionsDir(deps.home, bot);
      if (!dir) return json({ error: "unknown bot" }, 400);
      try {
        const log = SessionLog.resolve(dir, id);
        return json({
          id: log.id,
          lines: renderTrajectory(log.events()),
        });
      } catch (e) {
        return json({ error: (e as Error).message }, 404);
      }
    }

    const replayMatch = /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/(events|fork)$/.exec(path);
    if (replayMatch && (req.method === "GET" || req.method === "POST")) {
      const id = replayMatch[1];
      const action = replayMatch[2];
      if (!id) return json({ error: "missing id" }, 400);
      const bot = url.searchParams.get("bot");
      const dir = scopeSessionsDir(deps.home, bot);
      if (!dir) return json({ error: "unknown bot" }, 400);
      try {
        if (action === "events") {
          if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
          const log = SessionLog.resolve(dir, id);
          return json({ id: log.id, events: log.events() });
        }
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
        const forked = SessionLog.fork(dir, id);
        return json({ ok: true, id: forked.id, parentId: id });
      } catch (e) {
        return json({ error: (e as Error).message }, 404);
      }
    }

    if (path === "/api/spend" && req.method === "GET") {
      const daysParam = url.searchParams.get("days");
      const days = daysParam ? Number(daysParam) : undefined;
      const rows = aggregateSpend(deps.home, {
        days: Number.isFinite(days) ? days : undefined,
        bot: url.searchParams.get("bot") ?? undefined,
      });
      return json({ rows, byBot: perBotBreakdown(rows) });
    }

    if (path === "/api/audit" && req.method === "GET") {
      const parsed = auditQueryFromUrl(url, 100);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      return json({ events: deps.audit.query(parsed.opts), kinds: AUDIT_KINDS });
    }

    if (path === "/api/audit/export" && req.method === "GET") {
      const format = parseExportFormat(url.searchParams.get("format"));
      if (!format) return json({ error: 'format must be "json" or "markdown"' }, 400);
      const parsed = auditQueryFromUrl(url);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const events = deps.audit.query(parsed.opts);
      const day = new Date().toISOString().slice(0, 10);
      if (format === "json") {
        return auditDownload(
          `${JSON.stringify({ events }, null, 2)}\n`,
          "application/json; charset=utf-8",
          `audit-${day}.json`,
        );
      }
      return auditDownload(
        formatAuditMarkdown(events),
        "text/markdown; charset=utf-8",
        `audit-${day}.md`,
      );
    }

    if (path === "/api/jobs" && req.method === "GET") {
      const jobs = deps.jobs ? deps.jobs.list() : listConfiguredJobs(deps.config.gateway);
      return json({ jobs });
    }

    const jobRunMatch = /^\/api\/jobs\/([^/]+)\/run$/.exec(path);
    if (jobRunMatch && req.method === "POST") {
      if (!deps.jobs) return json({ error: "gateway jobs not running" }, 503);
      let name = "";
      try {
        name = decodeURIComponent(jobRunMatch[1] ?? "");
      } catch {
        return json({ error: "invalid job id" }, 400);
      }
      if (!name) return json({ error: "missing id" }, 400);
      const result = await deps.jobs.runNow(name);
      if (!result.ok && result.code === "not_found") {
        return json({ error: result.error }, 404);
      }
      if (!result.ok && result.code === "busy") {
        return json({ error: result.error }, 409);
      }
      return json(result, result.ok ? 200 : 500);
    }

    if (path === "/api/approvals" && req.method === "GET") {
      // The list is the approval "scan": drop long-stale pending requests first.
      expirePendingRequests(deps.home, DEFAULT_APPROVAL_TTL_MS);
      const dir = approvalsDir(deps.home);
      const pending: unknown[] = [];
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".json")) continue;
          const reqData = getRequest(deps.home, file.replace(/\.json$/, ""));
          if (reqData && reqData.status === "pending") pending.push(approvalListItem(reqData));
        }
      }
      return json({ pending });
    }

    // #147: bulk approve/deny — resolve several pending requests at once,
    // emitting one audit event per request.
    if (path === "/api/approvals/bulk" && req.method === "POST") {
      let body: { ids?: unknown; action?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const action = body.action;
      if (action !== "approve" && action !== "deny") {
        return json({ error: 'action must be "approve" or "deny"' }, 400);
      }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      if (ids.length === 0) return json({ error: "ids is required" }, 400);
      const resolved: string[] = [];
      const failed: string[] = [];
      for (const id of ids) {
        const r = resolveRequest(
          deps.home,
          id,
          action === "approve" ? "approved" : "denied",
        );
        if (!r) {
          failed.push(id);
          continue;
        }
        resolved.push(id);
        deps.audit.append(
          "approval",
          "console",
          `${action} ${id} (${getRequest(deps.home, id)?.tool ?? "?"})`,
        );
      }
      return json({
        ok: true,
        action,
        resolved,
        failed,
        resolvedCount: resolved.length,
      });
    }

    const approvalMatch = /^\/api\/approvals\/([a-z0-9-]+)$/.exec(path);
    if (approvalMatch && req.method === "GET") {
      const id = approvalMatch[1];
      if (!id) return json({ error: "missing id" }, 400);
      // `/api/approvals/bulk` is handled above; guard here anyway.
      if (id === "bulk") return json({ error: "not found" }, 404);
      const found = getRequest(deps.home, id);
      if (!found) return json({ error: "not found" }, 404);
      return json({
        ...found,
        input: found.input ?? found.inputSummary,
        diff: approvalDiff(found.tool, found.input, deps.cwd),
      });
    }
    if (approvalMatch && req.method === "POST") {
      const id = approvalMatch[1];
      if (!id) return json({ error: "missing id" }, 400);
      let body: { action?: unknown };
      try {
        body = (await req.json()) as { action?: unknown };
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const action = body.action;
      if (action !== "approve" && action !== "deny") {
        return json({ error: 'action must be "approve" or "deny"' }, 400);
      }
      const resolved = resolveRequest(
        deps.home,
        id,
        action === "approve" ? "approved" : "denied",
      );
      if (!resolved) return json({ error: "not found or already resolved" }, 404);
      deps.audit.append(
        "approval",
        "console",
        `${action} ${id} (${getRequest(deps.home, id)?.tool ?? "?"})`,
      );
      return json({ ok: true, status: action === "approve" ? "approved" : "denied" });
    }

    return null;
  };
}

function resolveBotSafe(home: string, name: string) {
  try {
    return resolveBot(home, name);
  } catch {
    return null;
  }
}

/** Map a bot CRUD error to a JSON response; conflicts become 409. */
function botErrorResponse(e: unknown): Response {
  const msg = (e as Error).message;
  if (e instanceof ConfigError) {
    return json({ error: msg }, msg.includes("already exists") ? 409 : 400);
  }
  return json({ error: msg }, 400);
}

/** Full bot view incl. raw SOUL text (for the console editor). */
function botDetailView(home: string, name: string, config: HarnessConfig) {
  const profile = resolveBotSafe(home, name);
  if (!profile) return null;
  const ref = botModelRef(profile, config);
  return {
    name: profile.name,
    model: `${ref.provider}:${ref.model}`,
    soul: readBotSoul(home, profile.name),
    sessions: existsSync(profile.sessionsDir)
      ? readdirSync(profile.sessionsDir).filter((f) => f.endsWith(".jsonl")).length
      : 0,
  };
}

/** Read-only memory view for a bot: facts, latest summaries, vector stats. */
function memoryView(home: string, name: string) {
  const mem = join(home, "bots", name, "memory");
  const summaries: Array<{ sessionId: string; projectPath: string; created: string; text: string }> =
    listSummaries(mem)
      .slice()
      .sort((a, b) => (a.meta.created < b.meta.created ? 1 : -1))
      .slice(0, 20)
      .map((s: SummaryEntry) => ({
        sessionId: s.meta.sessionId,
        projectPath: s.meta.projectPath,
        created: s.meta.created,
        text: s.text,
      }));

  const chunks = loadChunks(vectorsFilePath(mem));
  const seed = chunks[0];
  const vector = {
    count: chunks.length,
    embedModel: seed?.embedModel ?? null,
    dim: seed?.embedDim ?? (seed?.embedding.length ?? null),
  };

  return {
    bot: name,
    facts: readFacts(mem),
    summaries,
    vector,
  };
}

