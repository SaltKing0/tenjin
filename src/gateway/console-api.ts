import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessConfig } from "../config/types";
import type { ProviderRegistry } from "../provider/registry";
import { listBots, botModelRef, resolveBot } from "../bots/profile";
import { inboxPolicyFromConfig, unreadMessages } from "../bots/inbox";
import { SessionLog } from "../session/log";
import { renderTrajectory } from "../session/trajectory";
import { aggregateSpend } from "../audit/spend";
import { AuditLog } from "../audit/log";
import { approvalsDir, getRequest, resolveRequest } from "./approvals";
import { getSettings, applySettings, detectModels, testProvider, DetectTimeoutError } from "./settings";
import { sessionsDir } from "../config/loader";

export interface ConsoleApiDeps {
  home: string;
  cwd: string;
  config: HarnessConfig;
  registry: ProviderRegistry;
  audit: AuditLog;
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
        applySettings(settingsDeps, body);
        return json({ ok: true, settings: getSettings(settingsDeps) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
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

    if (path === "/api/sessions" && req.method === "GET") {
      const bot = url.searchParams.get("bot");
      const dir = scopeSessionsDir(deps.home, bot);
      if (!dir) return json({ error: "unknown bot" }, 400);
      const summaries = existsSync(dir)
        ? SessionLog.list(dir).map((s) => ({
            id: s.id,
            mtimeMs: s.mtimeMs,
            preview: s.preview,
            parentId: s.parentId ?? null,
          }))
        : [];
      return json({ scope: bot ?? "solo", sessions: summaries.slice(0, 100) });
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

    if (path === "/api/spend" && req.method === "GET") {
      const daysParam = url.searchParams.get("days");
      const days = daysParam ? Number(daysParam) : undefined;
      const rows = aggregateSpend(deps.home, {
        days: Number.isFinite(days) ? days : undefined,
        bot: url.searchParams.get("bot") ?? undefined,
      });
      return json({ rows });
    }

    if (path === "/api/audit" && req.method === "GET") {
      const tailParam = url.searchParams.get("tail");
      const kindParam = url.searchParams.get("kind");
      const events = deps.audit.query({
        tail: tailParam ? Number(tailParam) : 100,
        kind: kindParam ? (kindParam as never) : undefined,
      });
      return json({ events });
    }

    if (path === "/api/approvals" && req.method === "GET") {
      const dir = approvalsDir(deps.home);
      const pending: unknown[] = [];
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".json")) continue;
          const reqData = getRequest(deps.home, file.replace(/\.json$/, ""));
          if (reqData && reqData.status === "pending") pending.push(reqData);
        }
      }
      return json({ pending });
    }

    const approvalMatch = /^\/api\/approvals\/([a-z0-9-]+)$/.exec(path);
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
