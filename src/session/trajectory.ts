import type { SessionEvent } from "./events";

export interface TrajectoryOptions {
  maxLine?: number;
  maxArgs?: number;
  /** Render with no truncation (#136). Used for machine-consumed summaries so
   * the model sees complete events; the human console keeps the capped view. */
  full?: boolean;
}

export function renderTrajectory(
  events: SessionEvent[],
  opts: TrajectoryOptions = {},
): string[] {
  const maxLine = opts.maxLine ?? 160;
  const maxArgs = opts.maxArgs ?? 80;
  const full = opts.full === true;
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
          const line = e.content.replace(/\s+/g, " ");
          lines.push(`you> ${full ? line : truncate(line, maxLine)}`);
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
          if (text) lines.push(`tenjin> ${full ? text : truncate(text, maxLine)}`);
        }
        sawContent = true;
        break;
      }
      case "tool_call": {
        callNames.set(e.id, e.name);
        const input = JSON.stringify(e.input ?? {});
        lines.push(`  -> ${e.name} ${full ? input : truncate(input, maxArgs)}`);
        sawContent = true;
        break;
      }
      case "tool_result": {
        const name = callNames.get(e.id);
        const label = name ? `${name} ` : "";
        if (e.ok) {
          lines.push(`  <- ${label}ok (${formatSize(e.output.length)})`);
        } else {
          const out = firstLine(e.output);
          lines.push(`  <- ${label}ERR: ${full ? out : truncate(out, maxLine)}`);
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
        const msg = firstLine(e.message);
        lines.push(`! error: ${full ? msg : truncate(msg, maxLine)}`);
        sawContent = true;
        break;
      }
      case "compression": {
        lines.push(
          `~ context: ${formatTokens(e.beforeTokens)} -> ${formatTokens(e.afterTokens)} (elided ${formatTokens(e.elidedTokens)})`,
        );
        sawContent = true;
        break;
      }
    }
  }

  if (!sawContent) lines.push("(empty session)");
  return lines;
}

/**
 * Full, untruncated trajectory rendering for machine-consumed summaries (#136).
 */
export function renderFullTrajectory(events: SessionEvent[]): string[] {
  return renderTrajectory(events, { full: true });
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
