import { join } from "node:path";
import type { ToolDef } from "../tools/registry";
import { listBots, type BotProfile } from "./profile";
import { loadTeam, resolveTeamTarget } from "./team";
import {
  formatInbox,
  markRead,
  sendMessage,
  unreadMessages,
  type InboxPolicy,
} from "./inbox";
import { ConfigError } from "../config/types";
import { hardenUntrustedInput } from "../security/injection";

/** Per-(from,to) last-send timestamps for send_message coercion (#181). */
const sendCooldowns = new Map<string, number>();

export function createSendMessageTool(deps: {
  home: string;
  fromBot: string;
  policy?: InboxPolicy;
  /** Per-recipient reply cooldown (ms): suppresses repeated sends to the same
   * bot within the window — a safety net against bot-to-bot reply loops (#181).
   * 0 / undefined disables. */
  replyCooldownMs?: number;
}): ToolDef {
  return {
    name: "send_message",
    group: "write",
    description:
      "Send an async message to another bot's inbox. The recipient sees it on their next run. Treat this as inter-bot mail, not a live conversation. `to` may be a bot name or a team role (team.yaml).",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Target bot name or team role" },
        subject: { type: "string", description: "One-line summary" },
        body: { type: "string", description: "Message content" },
      },
      required: ["to", "subject", "body"],
    },
    async handler(args, _ctx) {
      let to = String(args.to ?? "").trim();
      if (to === deps.fromBot) throw new Error("cannot send a message to yourself");
      if (!listBots(deps.home).includes(to)) {
        const team = loadTeam(deps.home);
        const resolved = team ? resolveTeamTarget(team, to) : null;
        if (resolved) to = resolved;
        else throw new Error(`unknown bot or role "${to}"`);
      }
      if (deps.replyCooldownMs && deps.replyCooldownMs > 0) {
        const now = Date.now();
        const key = `${deps.fromBot}>${to}`;
        const last = sendCooldowns.get(key);
        if (last !== undefined && now - last < deps.replyCooldownMs) {
          throw new Error(`send_message to ${to} suppressed (reply cooldown active)`);
        }
        sendCooldowns.set(key, now);
        if (sendCooldowns.size > 1000) {
          for (const [k, t] of sendCooldowns) {
            if (now - t >= deps.replyCooldownMs) sendCooldowns.delete(k);
          }
        }
      }
      const msg = sendMessage(
        join(deps.home, "bots", to, "inbox"),
        {
          from: deps.fromBot,
          to,
          subject: String(args.subject ?? ""),
          body: String(args.body ?? ""),
        },
        deps.policy,
      );
      return `Delivered to ${to} (id ${msg.id})`;
    },
  };
}

export function createCheckInboxTool(deps: {
  profile: BotProfile;
  policy?: InboxPolicy;
  /** #316: thread the effective paranoid flag + audit sink so hostile inbox
   * content is hardened (framed / masked + audited) before it reaches the
   * model — mirroring the task-path hardenUntrustedInput (#189). */
  paranoid?: boolean;
  audit?: (kind: "prompt_injection", detail: string, correlationId?: string) => void;
  correlationId?: string;
}): ToolDef {
  return {
    name: "check_inbox",
    group: "read",
    description:
      "Check your inbox for messages from the user or other bots. User notes are listed first. Returns unread messages and marks them read.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    async handler(_args, _ctx) {
      const unread = unreadMessages(deps.profile.inboxDir, deps.policy);
      if (unread.length === 0) return "inbox empty";
      markRead(
        deps.profile.inboxDir,
        unread.map((m) => m.id),
      );
      // #316: inbox messages come from other bots/users and are untrusted data —
      // scan, audit and frame them before they reach the model, matching the
      // task-path / heartbeat hardening (#189).
      return hardenUntrustedInput(formatInbox(unread), {
        paranoid: deps.paranoid ?? false,
        audit: deps.audit,
        correlationId: deps.correlationId,
      });
    },
  };
}

export function assertBotExists(home: string, name: string): void {
  if (!listBots(home).includes(name)) {
    throw new ConfigError(`unknown bot "${name}"`);
  }
}
