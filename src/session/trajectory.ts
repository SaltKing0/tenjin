import type { SessionEvent } from "./events";

export interface TrajectoryOptions {
  maxLine?: number;
  maxArgs?: number;
}

export function renderTrajectory(
  events: SessionEvent[],
  opts: TrajectoryOptions = {},
): string[] {
  const maxLine = opts.maxLine ?? 160;
  const maxArgs = opts.maxArgs ?? 80;
  const lines: string[] = [];
  const callNames = new Map<string, string>();
  let sawContent = false;

  for (const e of events) {
    switch (e.t) {
      case "session_start": {
        let header = `session ${e.id} · ${e.provider || "?"}:${e.model || "?"}`;
        if (e.parent) {
          header += ` · forked from ${e.parent.id} @${e.parent.uptoEvent}`;
        }
        lines.push(header, "─".repeat(Math.min(60, header.length)));
        sawContent = true;
        break;
      }
      case "message": {
        if (e.role === "user") {
          if (typeof e.content !== "string") continue;
          lines.push(`you> ${truncate(e.content.replace(/\s+/g, " "), maxLine)}`);
        } else {
          const blocks =
            typeof e.content === "string"
              ? ([{ type: "text", text: e.content }] as const)
              : e.content;
          const text = blocks
            .map((b) => (b.type === "text" ? b.text : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) lines.push(`tenjin> ${truncate(text, maxLine)}`);
        }
        sawContent = true;
        break;
      }
      case "tool_call": {
        callNames.set(e.id, e.name);
        lines.push(`  -> ${e.name} ${truncate(JSON.stringify(e.input ?? {}), maxArgs)}`);
        sawContent = true;
        break;
      }
      case "tool_result": {
        const name = callNames.get(e.id);
        const label = name ? `${name} ` : "";
        if (e.ok) {
          lines.push(`  <- ${label}ok (${formatSize(e.output.length)})`);
        } else {
          lines.push(`  <- ${label}ERR: ${truncate(firstLine(e.output), maxLine)}`);
        }
        sawContent = true;
        break;
      }
      case "usage": {
        lines.push(
          `$ in ${formatTokens(e.inputTokens)} out ${formatTokens(e.outputTokens)} · ${formatUSD(e.costUSD)} turn · ${formatUSD(e.spentUSD)} spent`,
        );
        sawContent = true;
        break;
      }
      case "error": {
        lines.push(`! error: ${truncate(firstLine(e.message), maxLine)}`);
        sawContent = true;
        break;
      }
    }
  }

  if (!sawContent) lines.push("(empty session)");
  return lines;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

function formatUSD(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
