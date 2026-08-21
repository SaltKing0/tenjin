import { ConfigError, type HarnessConfig } from "../config/types";
import type { ProviderRegistry } from "../provider/registry";
import type { SecurityGuard } from "../security/guard";
import { Redactor } from "../security/redact";
import type { AuditLog } from "../audit/log";
import { resolveBot, botModelRef, botBudgetUSD } from "../bots/profile";
import { formatModelRef, type ModelRef } from "../config/models";
import { runHeadless, capPolicy } from "../agent/headless";
import { loadAgentsMd } from "../agent/prompt";
import { formatUSD } from "../agent/budget";
import { guardForBot } from "../security/guard";
import {
  routeText,
  botsAllowedForUser,
  routeBoundText,
  mergeBotAllowlist,
} from "./telegram";
import {
  createRequest,
  resolveRequest,
  waitApproval,
  summarizeInput,
} from "./approvals";

export interface HandlerDeps {
  home: string;
  cwd: string;
  config: HarnessConfig;
  registry: ProviderRegistry;
  availableBots: string[];
  defaultBot: string;
  allowWrites: boolean;
  approvalTimeoutMs: number;
  guard: SecurityGuard | null;
  audit: AuditLog;
  log: (line: string) => void;
  notifyApproval?: (chatId: number, text: string) => Promise<void>;
  /** Gateway-level bot → Telegram user-id allowlists. */
  telegramBindings?: Record<string, number[]>;
}

export interface HandleContext {
  actor: string;
  source: "telegram" | "http";
  chatId?: number;
  userId?: number;
  onDelta?: (delta: string) => void;
}

export function chatStreamResponse(
  handle: (text: string, ctx: HandleContext) => Promise<string | null>,
  text: string,
  ctx: HandleContext,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        const reply = await handle(text, { ...ctx, onDelta: (d) => send({ type: "delta", text: d }) });
        send({ type: "done", reply });
      } catch (e) {
        send({ type: "error", message: (e as Error).message });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function telegramAllowlists(deps: HandlerDeps): Record<string, number[] | undefined> {
  const allowlists: Record<string, number[] | undefined> = {};
  for (const name of deps.availableBots) {
    try {
      const profile = resolveBot(deps.home, name);
      allowlists[name] = mergeBotAllowlist(
        profile.config.telegram?.allowedUsers,
        deps.telegramBindings?.[name],
      );
    } catch {
      continue;
    }
  }
  return allowlists;
}

function routeInbound(
  deps: HandlerDeps,
  text: string,
  ctx: HandleContext,
): { bot: string; rest: string } | { error: string } {
  if (ctx.source === "telegram" && ctx.userId !== undefined) {
    const allowed = botsAllowedForUser(
      ctx.userId,
      deps.availableBots,
      telegramAllowlists(deps),
    );
    const routed = routeBoundText(text, deps.defaultBot, deps.availableBots, allowed);
    if (!routed.ok) return { error: routed.error };
    return { bot: routed.bot, rest: routed.rest };
  }
  return routeText(text, deps.defaultBot, deps.availableBots);
}

export function createMessageHandler(deps: HandlerDeps) {
  return async function handle(
    text: string,
    ctx: HandleContext,
  ): Promise<string | null> {
    const approvalCmd = /^\/(approve|deny)\s+([a-z0-9-]+)\s*$/i.exec(text.trim());
    if (approvalCmd && approvalCmd[1] && approvalCmd[2]) {
      const action = approvalCmd[1].toLowerCase() as "approve" | "deny";
      const id = approvalCmd[2];
      const resolved = resolveRequest(
        deps.home,
        id,
        action === "approve" ? "approved" : "denied",
      );
      deps.audit.append(
        "approval",
        ctx.actor,
        `${action} ${id} -> ${resolved ? "recorded" : "not found or already resolved"}`,
      );
      return resolved
        ? `Request ${id} ${action === "approve" ? "approved" : "denied"}.`
        : `Unknown or already-resolved request ${id}.`;
    }

    const routed = routeInbound(deps, text, ctx);
    if ("error" in routed) return routed.error;
    const { bot: botName, rest } = routed;
    const profile = resolveBot(deps.home, botName);
    const ref = botModelRef(profile, deps.config);
    deps.audit.append("gateway_msg", ctx.actor, `${botName}: ${text.slice(0, 120)}`, botName);

    let approve;
    if (deps.allowWrites) {
      approve = async (toolName: string, group: "read" | "write", input: unknown) => {
        if (group === "read") return true;
        const req = createRequest(deps.home, {
          bot: botName,
          tool: toolName,
          inputSummary: summarizeInput(input),
        });
        const notice =
          `Approval needed [${req.id}]\nbot: ${botName}\ntool: ${toolName}\n${req.inputSummary}\nReply /approve ${req.id} or /deny ${req.id}`;
        if (ctx.chatId !== undefined && deps.notifyApproval) {
          await deps.notifyApproval(ctx.chatId, notice);
        } else {
          deps.log(`approval requested [${req.id}] (${toolName}) — no channel to notify`);
        }
        const decision = await waitApproval(deps.home, req.id, deps.approvalTimeoutMs);
        deps.audit.append("approval", ctx.actor, `${toolName} (${req.id}) -> ${decision}`, botName);
        return decision === "approved";
      };
    }

    let result;
    try {
      result = await runHeadless({
        provider: deps.registry.get(ref.provider),
        model: ref.model,
        soulText: profile.soulText,
        cwd: deps.cwd,
        message: rest,
        maxTokens: deps.config.maxTokens,
        capUSD: botBudgetUSD(profile, deps.config.budgetUSD),
        pricing: deps.config.pricing,
        policy: capPolicy(
          deps.allowWrites ? "full" : "read-only",
          profile.config.security?.policy,
        ),
        denyTools: profile.config.security?.denyTools,
        agentsMd: loadAgentsMd(deps.cwd),
        home: deps.home,
        memoryDir: profile.memoryDir,
        sessionLogDir: profile.sessionsDir,
        sessionBot: profile.name,
        guard: guardForBot(
          deps.config.security,
          profile.config.security,
          (detail) => deps.audit.append("tool_block", ctx.actor, detail, botName),
        ),
        approve,
        audit: (kind, detail) => deps.audit.append(kind, ctx.actor, detail, botName),
        onTextDelta: ctx.onDelta,
        redactor: Redactor.fromConfig(deps.config.security),
      });
    } catch (e) {
      throw annotateChatError(e, ref);
    }
    deps.log(
      `${ctx.source}: handled for ${botName} (${formatUSD(result.costUSD)})`,
    );
    return result.text || null;
  };
}

const SETTINGS_HINT = "change it in Settings → Models";

function annotateChatError(err: unknown, ref: ModelRef): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const suffix = `active model: ${formatModelRef(ref)} — ${SETTINGS_HINT}`;
  if (original.message.includes(suffix)) return original;
  const message = `${original.message} (${suffix})`;
  const wrapped = err instanceof ConfigError ? new ConfigError(message) : new Error(message);
  wrapped.cause = original;
  return wrapped;
}
