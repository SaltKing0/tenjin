/* Tenjin TUI — split-pane, keyboard-driven interface over the same agent loop
 * the line REPL uses (src/ui/repl.ts). Zero-dependency; paints with raw ANSI
 * via the Screen core (src/ui/screen.ts).
 *
 * Multi-session design (tmux/herdr-style): several sessions can be OPEN at
 * once, each as a "tab" with its own transcript, chat view, scroll, model and
 * running turn. The shared process budget, pinned skills, audit trail and
 * approval queue span all tabs. Switch tabs with Ctrl-N / Ctrl-P.
 *
 * Layout (rows x cols):
 *   row 0        tab bar (open sessions)
 *   row 1        header (active session + model)
 *   rows 2..R-3  chat pane (left)  |  side panel (right, ~30% width)
 *   row R-2      input line
 *   row R-1      status bar
 *
 * Keybindings:
 *   Tab               cycle the side panel (sessions / bots / spend / approvals)
 *   ↑ / ↓             move the session cursor in the sessions panel
 *   Enter (empty)     open the highlighted session
 *   Ctrl-N / Ctrl-P   next / previous open session tab
 *   PgUp / PgDn       scroll the chat pane
 *   Ctrl-C            interrupt the active turn, else quit
 *   Ctrl-D (empty)    quit
 *   Enter             send the input line (message or /command)
 *
 * Slash commands (compact): /new /resume <id> /fork [n] /sessions /exit |
 * /model /cost /mode | /whoami /bots /skills /tools /replay /audit | /help
 */

import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { ChatMessage, Provider } from "../provider/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveModelRef, formatModelRef, type ModelRef } from "../config/models";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/loader";
import { Budget, createBudget, formatUSD, TreeBudget } from "../agent/budget";
import { runAgentTurn, type TurnEvent, type ApproveDecision } from "../agent/loop";
import { checkGlobalBudget } from "../audit/global-budget";
import { SessionLog } from "../session/log";
import { resolveContextGuard, contextWindowTokens, estimateTokens } from "../session/context";
import { buildSkillsSection } from "../skills/activate";
import { buildVolatileTail } from "../agent/prompt";
import { resolveBot, listBots } from "../bots/profile";
import { leaveUserMessage, unreadMessages, inboxPolicyFromConfig } from "../bots/inbox";
import { AuditLog, auditPath, formatAudit } from "../audit/log";
import { getSkill, scaffoldSkill, listSkills } from "../skills/loader";
import { VERSION } from "../version";
import { renderTrajectory } from "../session/trajectory";
import { rebuildMessages, sumUsage } from "../session/events";
import type { SessionEvent } from "../session/events";
import { validateMode, DEFAULT_MODE, type ModeLadder } from "../security/mode-ladder";
import { Screen, decodeKey, LineEditor, type Style, RESET } from "./screen";
import type { ReplOptions } from "./repl";
import { forwardEvent, logEvent } from "./repl";

const COLORS = {
  header: { bg: 4 } as Style,
  user: { fg: 6 } as Style,
  bot: {} as Style,
  dim: { dim: true } as Style,
  err: { fg: 1 } as Style,
  ok: { fg: 2 } as Style,
  input: {} as Style,
  status: { dim: true } as Style,
};

const SIDE_TABS = ["sessions", "bots", "spend", "approvals", "memory"] as const;
type SideTab = (typeof SIDE_TABS)[number];

/** Extract a session id from a sessions-panel list line. Each line is rendered
 *  as `${marker}${id}${open}  ${when}  ${preview}` where `marker` is "▶" for
 *  the active session (or a space otherwise). Strip that leading marker column
 *  so the id is the first real token — otherwise the "▶" leaks into the lookup
 *  and the active session can never be opened ("no session matching ▶<id>"). */
export function extractSessionIdFromLine(line: string): string | undefined {
  const id = line.trim().split(/\s+/)[0]?.replace(/^[▶▸]/, "");
  return id && id.length > 0 ? id : undefined;
}

/** GrokBuild-style user prompt marker (turns render as "❯ <text>"). */
const PROMPT = "❯ ";

/** One open session tab. Own transcript, chat view, model, tokens and turn. */
interface SessionTab {
  id: string;
  logger: SessionLog | undefined;
  messages: ChatMessage[];
  active: ModelRef;
  tokens: { in: number; out: number };
  chat: Array<{ text: string; st: Style }>;
  chatScroll: number;
  turnActive: boolean;
  controller: AbortController | null;
}

export async function startTui(opts: ReplOptions): Promise<void> {
  const audit = new AuditLog(auditPath(opts.home));
  // Shared across all tabs: process budget, skills, audit, approvals.
  const budget = createBudget(opts.config.budgetUSD, opts.config.pricing);
  budget.spentUSD = opts.initialSpentUSD ?? 0;
  const treeBudget = opts.config.maxTreeIterations
    ? new TreeBudget(opts.config.maxTreeIterations ?? 0, 0)
    : undefined;
  const pinnedSkills = new Set<string>();
  const sessionAllowed = new Set<string>();
  const sessionMode = { current: DEFAULT_MODE as ModeLadder };

  // Open tabs — start with the initial session log.
  const tabs: SessionTab[] = [];
  let activeIdx = 0;
  function tab(): SessionTab {
    return tabs[activeIdx]!;
  }
  function buildTabFromLog(log: SessionLog, label: string): SessionTab {
    const events = log.events();
    const t: SessionTab = {
      id: log.id,
      logger: log,
      messages: rebuildMessages(events),
      active: { ...opts.defaultRef },
      tokens: { in: 0, out: 0 },
      chat: [],
      chatScroll: 0,
      turnActive: false,
      controller: null,
    };
    for (const m of t.messages) {
      appendChat(t, m.role === "user" ? `${PROMPT}${m.content}` : `${m.content}`, m.role === "user" ? COLORS.user : COLORS.bot);
    }
    appendChat(t, dim(label), COLORS.dim);
    return t;
  }

  // Side-panel data (refreshed each time a tab is shown).
  let sideTab: SideTab = "sessions";
  let sideData: string[] = [];
  // Cursor row within the current side panel (↑/↓ navigation, Enter to open).
  let sideCursor = 0;
  // GrokBuild-style: the side panel is an overlay, hidden by default. Tab opens
  // it (then cycles the panel), Esc closes it — the conversation stays fullscreen.
  let sideOpen = false;

  const editor = new LineEditor();
  const scr = new Screen(process.stdout.rows || 24, process.stdout.columns || 80);

  // ---------- helpers ----------
  const chatW = () => (sideOpen ? scr.cols - Math.floor(scr.cols * 0.3) - 1 : scr.cols - 1);
  function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for (const raw of text.split("\n")) {
      if (raw === "") {
        lines.push("");
        continue;
      }
      let rest = raw;
      while (rest.length > width) {
        lines.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      lines.push(rest);
    }
    return lines.length ? lines : [""];
  }
  function appendChat(t: SessionTab, text: string, st: Style): void {
    for (const line of wrap(text, chatW())) t.chat.push({ text: line, st });
    t.chatScroll = 0; // jump to newest
  }
  function setStatus(field: string, value: string): void {}

  // ---------- tab management ----------
  function switchTab(delta: number): void {
    if (tabs.length === 0) return;
    activeIdx = (activeIdx + delta + tabs.length) % tabs.length;
    sideCursor = 0;
    render();
  }
  function addTab(t: SessionTab): void {
    tabs.push(t);
    activeIdx = tabs.length - 1;
    sideCursor = 0;
    render();
  }
  /** Start a fresh session as a new tab (used by /new). */
  function newTab(): void {
    if (!opts.sessionsDir) {
      appendChat(tab(), "no sessions dir — sessions disabled", COLORS.err);
      render();
      return;
    }
    const log = SessionLog.create(opts.sessionsDir);
    const t = buildTabFromLog(log, `new session ${log.id}`);
    t.messages = [];
    t.chat = [];
    logEvent(t.logger, {
      t: "session_start",
      id: t.id,
      ts: new Date().toISOString(),
      provider: t.active.provider,
      model: t.active.model,
      ...(opts.bot ? { bot: opts.bot } : {}),
    } as SessionEvent);
    appendChat(t, dim(`new session ${t.id}`), COLORS.dim);
    addTab(t);
  }
  /** Open a session by id — as a new tab, or switch to it if already open. */
  function openSession(id: string): void {
    if (!opts.sessionsDir) return;
    const existing = tabs.findIndex((t) => t.id === id);
    if (existing >= 0) {
      activeIdx = existing;
      sideCursor = 0;
      render();
      return;
    }
    try {
      const log = SessionLog.resolve(opts.sessionsDir, id);
      const t = buildTabFromLog(log, `resumed ${log.id} — ${log.events().length} events`);
      addTab(t);
    } catch (e) {
      appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
      render();
    }
  }
  /** Close the active tab; when it is the last one, return "exit" to leave. */
  function closeActiveTab(): "exit" | void {
    if (tabs.length <= 1) return "exit";
    const t = tab();
    if (t.controller) t.controller.abort();
    tabs.splice(activeIdx, 1);
    activeIdx = Math.min(activeIdx, tabs.length - 1);
    sideCursor = 0;
    render();
  }

  // ---------- side panel loaders ----------
  function loadSessions(): string[] {
    if (!opts.sessionsDir) return ["(no sessions dir)"];
    const all = SessionLog.list(opts.sessionsDir);
    if (all.length === 0) return ["no sessions yet"];
    return all.slice(0, 20).map((s) => {
      const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(5, 16);
      const open = tabs.some((t) => t.id === s.id) ? " ●" : "";
      const active = s.id === tab().id ? "▶" : " ";
      return `${active}${s.id}${open}  ${when}  ${(s.preview ?? "").slice(0, 20)}`;
    });
  }
  function loadBots(): string[] {
    const bots = listBots(opts.home);
    if (bots.length === 0) return ["no bots — tenjin bot new <name>"];
    return bots.map((b) => {
      const unread = unreadMessages(
        join(opts.home, "bots", b, "inbox"),
        inboxPolicyFromConfig(opts.config.inbox),
      ).length;
      const note = unread ? `  ${unread} unread` : "";
      const marker = b === opts.bot ? "  <- you" : "";
      return `${b}${note}${marker}`;
    });
  }
  function loadMemory(): string[] {
    const out: string[] = [`memoryDir ${opts.memoryDir ?? "(none)"}`];
    if (opts.sessionsDir) {
      out.push(`sessions: ${SessionLog.list(opts.sessionsDir).length}`);
    }
    return out;
  }
  function loadSpend(): string[] {
    const out: string[] = [
      `spent ${formatUSD(budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "∞"}`,
      `tokens  in ${tab().tokens.in} · out ${tab().tokens.out}`,
      ctxStatus(),
    ];
    for (const entry of budget.breakdown()) {
      out.push(`  ${entry.model}: ${formatUSD(entry.usd)}`);
    }
    return out;
  }
  function loadApprovals(): string[] {
    return pendingApprovals.length ? pendingApprovals.map((p) => p.summary) : ["no pending approvals"];
  }

  /** Context-window occupancy for the active model (used + window, with a bar). */
  function ctxStatus(): string {
    const window = contextWindowTokens(tab().active.model, opts.config.context);
    const used = estimateTokens(tab().messages);
    const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
    const barLen = 8;
    const filled = Math.round((pct / 100) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return `ctx ${bar} ${pct}% ${k(used)}/${k(window)}`;
  }

  // ---------- approval handling ----------
  const pendingApprovals: Array<{ resolve: (d: ApproveDecision) => void; summary: string }> = [];
  function requestApproval(tool: string, group: "read" | "write", input: unknown): Promise<ApproveDecision> {
    return new Promise((resolve) => {
      const summary = `${tool} (${group}) — approve?  [1] allow  [2] deny  [3] always`;
      pendingApprovals.push({ resolve, summary });
      appendChat(tab(), summary, COLORS.dim);
      render();
    });
  }
  function answerApproval(allow: boolean): void {
    const p = pendingApprovals.shift();
    if (p) p.resolve(allow);
  }

  // ---------- agent turn ----------
  function activeProvider(t: SessionTab): Provider {
    return opts.registry.get(t.active.provider);
  }
  async function runTurn(t: SessionTab, text: string): Promise<void> {
    t.messages.push({ role: "user", content: text });
    logEvent(t.logger, { t: "message", role: "user", content: text, ts: new Date().toISOString() } as SessionEvent);
    appendChat(t, `${PROMPT}${text}`, COLORS.user);

    t.controller = new AbortController();
    t.turnActive = true;
    // stream deltas straight into the chat view (batched)
    let buf = "";
    const flush = () => {
      if (buf) {
        appendChat(t, buf, COLORS.bot);
        buf = "";
        render();
      }
    };
    const ticker = setInterval(flush, 30);
    const skillsSection = buildSkillsSection(opts.home, opts.cwd, pinnedSkills);
    const volatileTail = buildVolatileTail({
      now: new Date().toISOString().slice(0, 10),
      statusLines: skillsSection ? [skillsSection] : [],
    });
    try {
      const result = await runAgentTurn({
        provider: activeProvider(t),
        model: t.active.model,
        system: opts.system,
        volatileTail,
        tools: opts.tools,
        messages: t.messages,
        budget,
        treeBudget,
        maxTokens: opts.config.maxTokens,
        cwd: opts.cwd,
        globalBudgetGate: opts.config.globalBudget
          ? () => checkGlobalBudget(opts.home, opts.config.globalBudget!)
          : undefined,
        approve: (name, group, input) =>
          requestApproval(name, group, input),
        guard: opts.guard,
        audit: (kind, detail, correlationId) =>
          audit.append(kind, "user", detail, opts.bot, correlationId),
        onTextDelta: (d) => {
          buf += d;
        },
        onEvent: (e) => {
          forwardEvent(e, t.logger, budget);
          // GrokBuild-style tool hints: show a ◆ line for each tool call.
          if (e.t === "tool_call") appendChat(t, dim(`  ◆ ${e.name}`), COLORS.dim);
        },
        signal: t.controller.signal,
        contextGuard: resolveContextGuard(t.active.model, opts.config.context),
      });
      if (buf) {
        appendChat(t, buf, COLORS.bot);
        buf = "";
      }
      t.tokens.in += result.usage.inputTokens ?? 0;
      t.tokens.out += result.usage.outputTokens ?? 0;
      appendChat(
        t,
        dim(`  ◆ [${result.model} · in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)} turn · ${formatUSD(budget.spentUSD)} total]`),
        COLORS.dim,
      );
    } catch (e) {
      if (buf) {
        appendChat(t, buf, COLORS.bot);
        buf = "";
      }
      if ((e as Error)?.name === "AbortError") {
        appendChat(t, "(interrupted)", COLORS.dim);
      } else {
        appendChat(t, `error: ${(e as Error)?.message ?? e}`, COLORS.err);
      }
    } finally {
      clearInterval(ticker);
      t.turnActive = false;
      t.controller = null;
      render();
    }
  }

  // ---------- commands ----------
  async function runCommand(line: string): Promise<"exit" | void> {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/help":
        appendChat(
          tab(),
          [
            "sessions:  /new  /resume <id>  /fork [n]  /sessions  /exit",
            "model:     /model [id]  /cost  /mode [rung]",
            "info:      /whoami  /bots  /skills  /tools  /replay  /audit [n]",
            "panel:     Tab cycle · ↑/↓ select · Enter open · Ctrl-N/P tabs · PgUp/PgDn scroll",
          ].join("\n"),
          COLORS.dim,
        );
        return;
      case "/exit":
      case "/quit":
        // Close the current tab; only leave the TUI when it is the last one.
        return closeActiveTab();
      case "/new":
        newTab();
        return;
      case "/cost":
        appendChat(tab(), `spent ${formatUSD(budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "no cap"}`, COLORS.dim);
        return;
      case "/model":
        if (!rest[0]) {
          appendChat(tab(), dim(formatModelRef(tab().active)), COLORS.dim);
          return;
        }
        try {
          if (rest[0] === "default") tab().active = opts.defaultRef;
          else if (rest[0] === "cheap" && opts.cheapRef) tab().active = opts.cheapRef;
          else tab().active = resolveModelRef(rest.join(" "), opts.config.provider);
          appendChat(tab(), dim(`model → ${formatModelRef(tab().active)}`), COLORS.dim);
        } catch (e) {
          appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      case "/whoami":
        appendChat(tab(), dim(`${opts.bot ?? "solo"} · ${tab().active.provider}:${tab().active.model} · cwd ${opts.cwd}`), COLORS.dim);
        return;
      case "/bots":
        appendChat(tab(), loadBots().join("\n"), COLORS.bot);
        return;
      case "/sessions":
        appendChat(tab(), loadSessions().join("\n"), COLORS.bot);
        return;
      case "/skills": {
        const all = listSkills(opts.home, opts.cwd);
        appendChat(tab(), all.length ? all.map((s) => `${s.name}  ${s.description}`).join("\n") : "no skills", COLORS.bot);
        return;
      }
      case "/tools":
        appendChat(
          tab(),
          opts.tools.length
            ? opts.tools.map((t) => `${t.name.padEnd(14)} ${t.group}${sessionAllowed.has(t.name) ? " ✓" : ""}`).join("\n")
            : "no tools",
          COLORS.bot,
        );
        return;
      case "/replay": {
        const lg = tab().logger;
        if (!lg) {
          appendChat(tab(), "no session log active", COLORS.err);
          return;
        }
        appendChat(tab(), renderTrajectory(lg.events()).join("\n"), COLORS.dim);
        return;
      }
      case "/resume": {
        if (!opts.sessionsDir || !rest[0]) {
          appendChat(tab(), "usage: /resume <id>", COLORS.err);
          return;
        }
        try {
          openSession(rest[0]);
        } catch (e) {
          appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      }
      case "/fork": {
        if (!opts.sessionsDir || !tab().logger) {
          appendChat(tab(), "usage: /fork [n]  (no active session to fork)", COLORS.err);
          return;
        }
        const n = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : undefined;
        try {
          const log = SessionLog.fork(opts.sessionsDir, tab().id, n);
          const t = buildTabFromLog(log, `forked ${log.id} — ${log.events().length} events`);
          addTab(t);
        } catch (e) {
          appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      }
      case "/mode": {
        const rung = rest[0];
        if (!rung) {
          appendChat(tab(), dim(`${sessionMode.current} (session; config default ${opts.config.mode?.ladder ?? DEFAULT_MODE})`), COLORS.dim);
          return;
        }
        try {
          sessionMode.current = validateMode(rung);
          appendChat(tab(), dim(`mode → ${sessionMode.current}`), COLORS.dim);
        } catch (e) {
          appendChat(tab(), dim(`  ${(e as Error).message}`), COLORS.dim);
        }
        return;
      }
      case "/tell": {
        const bot = rest[0];
        const text = rest.slice(1).join(" ");
        if (!bot || !text.trim()) {
          appendChat(tab(), "usage: /tell <bot> <text>", COLORS.err);
          return;
        }
        try {
          const profile = resolveBot(opts.home, bot);
          const msg = leaveUserMessage(profile.inboxDir, profile.name, text, inboxPolicyFromConfig(opts.config.inbox));
          appendChat(tab(), dim(`left message for ${profile.name} (id ${msg.id})`), COLORS.dim);
        } catch (e) {
          appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      }
      case "/audit": {
        const n = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 20;
        const es = audit.query({ tail: n });
        appendChat(tab(), es.length ? formatAudit(es) : "no audit events", COLORS.bot);
        return;
      }
      case "/skill": {
        const name = rest[0];
        if (!name) {
          appendChat(tab(), "usage: /skill <name> [off] | /skill new <name>", COLORS.err);
          return;
        }
        if (name === "new") {
          if (!rest[1]) {
            appendChat(tab(), "usage: /skill new <name>", COLORS.err);
            return;
          }
          try {
            const p = scaffoldSkill(opts.cwd, rest[1]);
            appendChat(tab(), dim(`scaffolded ${p}`), COLORS.dim);
          } catch (e) {
            appendChat(tab(), `error: ${(e as Error).message}`, COLORS.err);
          }
          return;
        }
        if (rest[1] === "off") {
          pinnedSkills.delete(name);
          appendChat(tab(), dim(`unpinned ${name}`), COLORS.dim);
          return;
        }
        const skill = getSkill(opts.home, opts.cwd, name);
        if (!skill) {
          appendChat(tab(), `unknown skill "${name}" — /skills`, COLORS.err);
          return;
        }
        pinnedSkills.add(skill.name);
        appendChat(tab(), dim(`pinned ${skill.name}`), COLORS.dim);
        return;
      }
      default:
        appendChat(tab(), `unknown command ${cmd} — /help`, COLORS.err);
    }
  }
  const dim = (s: string) => s;

  // ---------- render ----------
  function render(): void {
    scr.clear();
    const t = tab();
    const win = contextWindowTokens(t.active.model, opts.config.context);
    const used = estimateTokens(t.messages);
    const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;
    // Row 0 — GrokBuild-style thin status line: identity · tabs · budget.
    const tabsBar = tabs.map((ti, i) => (i === activeIdx ? "●" : "·") + ti.id.slice(-4)).join(" ");
    const left = ` ◆ ${opts.bot ?? "solo"} · ${t.active.provider}:${t.active.model} · #${t.id.slice(-4)}${t.turnActive ? " ◆thinking" : ""}`;
    const right = `${pct}% ctx · ${formatUSD(budget.spentUSD)}${opts.config.budgetUSD > 0 ? `/${formatUSD(opts.config.budgetUSD)}` : ""}${pendingApprovals.length > 0 ? ` · ${pendingApprovals.length} appr` : ""}`;
    scr.write(0, 0, ` ${left}   [${tabsBar}]   ${right}`.slice(0, scr.cols), COLORS.header);

    // Side panel — GrokBuild-style overlay (right 30%), only when toggled open.
    let sideLeft = scr.cols;
    if (sideOpen) {
      const sw = Math.floor(scr.cols * 0.3);
      sideLeft = scr.cols - sw;
      sideData =
        sideTab === "sessions" ? loadSessions()
        : sideTab === "bots" ? loadBots()
        : sideTab === "spend" ? loadSpend()
        : sideTab === "memory" ? loadMemory()
        : loadApprovals();
      scr.write(1, sideLeft, ` ${sideTab} `, COLORS.header);
      const sideRows = scr.rows - 4;
      if (sideCursor >= sideData.length) sideCursor = Math.max(0, sideData.length - 1);
      sideData.slice(0, sideRows).forEach((l, i) => {
        const selected = sideTab === "sessions" && i === sideCursor;
        const st = selected ? { ...COLORS.bot, reverse: true } : COLORS.dim;
        scr.write(2 + i, sideLeft, (selected ? "▸ " : "  ") + l.slice(0, sw - 3), st);
      });
    }

    // Chat pane — full width, or left of the overlay when open.
    const chatRows = scr.rows - 3;
    const cw = sideOpen ? sideLeft - 1 : scr.cols - 1;
    const start = Math.max(0, t.chat.length - chatRows - t.chatScroll);
    for (let i = 0; i < chatRows; i++) {
      const line = t.chat[start + i];
      if (line) scr.write(1 + i, 0, line.text.slice(0, cw), line.st);
    }

    // Prompt + input (row R-2), hint line (row R-1) — GrokBuild-style.
    scr.write(scr.rows - 2, 0, `${PROMPT}${editor.text}`, COLORS.input);
    scr.write(
      scr.rows - 1,
      0,
      ` Enter:run │ Ctrl-N/P:tabs │ Tab:panel │ Esc:clear │ /exit:quit │ Ctrl-C:interrupt`.slice(0, scr.cols),
      COLORS.status,
    );
    scr.render(stdout, { row: scr.rows - 2, col: Math.min(2 + editor.cursor, scr.cols - 1) });
  }

  // ---------- input loop ----------
  let quitting = false;
  const onResize = () => {
    scr.resize(process.stdout.rows || 24, process.stdout.columns || 80);
    render();
  };
  process.stdout.on("resize", onResize);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  // SGR mouse tracking (button events with absolute x;y coordinates).
  stdout.write("\x1b[?1000h\x1b[?1006h");
  stdin.resume();
  stdin.setEncoding("utf8");

  // drain any pending approvals on a turn
  function feed(chunk: string): void {
    const keys = decodeKey(new TextEncoder().encode(chunk));
    for (const k of keys) {
      // approval mode: 1/2/3 answer the front approval
      if (pendingApprovals.length > 0) {
        if (k.type === "char") {
          if (k.ch === "1") answerApproval(true);
          else if (k.ch === "2") answerApproval(false);
          else if (k.ch === "3") answerApproval(true);
        }
        render();
        continue;
      }
      switch (k.type) {
        case "char":
          editor.insert(k.ch);
          break;
        case "backspace":
          editor.backspace();
          break;
        case "delete":
          editor.del();
          break;
        case "left":
          editor.left();
          break;
        case "right":
          editor.right();
          break;
        case "up":
          if (sideOpen && sideTab === "sessions" && sideData.length > 0) {
            sideCursor = Math.max(0, sideCursor - 1);
          }
          break;
        case "down":
          if (sideOpen && sideTab === "sessions" && sideData.length > 0) {
            sideCursor = Math.min(sideData.length - 1, sideCursor + 1);
          }
          break;
        case "home":
          editor.home();
          break;
        case "end":
          editor.end();
          break;
        case "ctrl-k":
          editor.ctrlK();
          break;
        case "ctrl-n":
          switchTab(1);
          continue;
        case "ctrl-p":
          switchTab(-1);
          continue;
        case "mouse":
          if (sideOpen && k.pressed && k.button === 0) {
            // Clicking a row in the sessions side panel opens that session.
            const sw = Math.floor(scr.cols * 0.3);
            const sideLeft = scr.cols - sw;
            if (sideTab === "sessions" && k.x >= sideLeft && k.y >= 2 && k.y <= scr.rows - 3) {
              const idx = k.y - 2;
              sideCursor = idx;
              openSessionAt(idx);
              render();
            }
          }
          break;
        case "tab":
          // GrokBuild-style: Tab opens the (hidden) side panel; when it is open,
          // Tab cycles sessions→bots→spend→approvals→memory. Esc closes it.
          if (sideOpen) {
            const i = SIDE_TABS.indexOf(sideTab);
            sideTab = SIDE_TABS[(i + 1) % SIDE_TABS.length]!;
          } else {
            sideOpen = true;
          }
          break;
        case "esc":
          // Esc: close the side panel and clear the input (GrokBuild-style).
          if (sideOpen) sideOpen = false;
          editor.text = "";
          editor.cursor = 0;
          break;
        case "pgup":
          tab().chatScroll = Math.min(tab().chat.length, tab().chatScroll + 5);
          break;
        case "pgdown":
          tab().chatScroll = Math.max(0, tab().chatScroll - 5);
          break;
        case "enter": {
          const line = editor.submit();
          // Empty input in the (open) sessions panel → open the highlighted session.
          if (line === "" && sideOpen && sideTab === "sessions" && sideData.length > 0) {
            openSessionAt(sideCursor);
            render();
            break;
          }
          render();
          if (line.startsWith("/")) {
            void (async () => {
              const r = await runCommand(line);
              if (r === "exit") {
                quit();
              }
              render();
            })();
          } else if (line.trim()) {
            void runTurn(tab(), line.trim());
          }
          break;
        }
        case "ctrl-c": {
          const t = tab();
          if (t.turnActive && t.controller) {
            t.controller.abort();
          } else {
            quit();
          }
          break;
        }
        case "ctrl-d":
          if (editor.text === "") {
            quit();
          }
          break;
        default:
          break;
      }
      render();
    }
  }
  function openSessionAt(index: number): void {
    if (sideTab !== "sessions" || !opts.sessionsDir) return;
    const line = sideData[index];
    if (!line) return;
    const id = extractSessionIdFromLine(line);
    if (!id) return;
    openSession(id);
  }
  let inputBuf = "";
  stdin.on("data", (chunk: string) => {
    inputBuf += chunk;
    // decode complete keys when a data frame arrives
    feed(inputBuf);
    inputBuf = "";
  });

  function quit(): void {
    if (quitting) return;
    quitting = true;
    stdin.removeAllListeners("data");
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stdout.removeListener("resize", onResize);
    stdout.write("\x1b[?1000l\x1b[?1006l"); // disable mouse tracking
    stdout.write("\x1b[2J\x1b[H" + RESET + "\n");
    process.exit(0);
  }
  process.on("SIGINT", () => quit());

  // Seed the initial tab from the initial session log.
  if (opts.logger) {
    const init = buildTabFromLog(opts.logger, "");
    init.messages = [...(opts.initialMessages ?? [])];
    init.chat = [];
    for (const m of init.messages) {
      appendChat(init, m.role === "user" ? `${PROMPT}${m.content}` : `${m.content}`, m.role === "user" ? COLORS.user : COLORS.bot);
    }
    // Persist a fresh session_start for a brand-new log (not a resumed/forked one).
    if (init.logger && init.logger.events().find((e) => e.t === "session_start") === undefined) {
      logEvent(init.logger, {
        t: "session_start",
        id: init.id,
        ts: new Date().toISOString(),
        provider: init.active.provider,
        model: init.active.model,
        ...(opts.bot ? { bot: opts.bot } : {}),
      } as SessionEvent);
    }
    tabs.push(init);
  } else {
    tabs.push({
      id: opts.sessionId,
      logger: undefined,
      messages: [...(opts.initialMessages ?? [])],
      active: opts.defaultRef,
      tokens: { in: 0, out: 0 },
      chat: [],
      chatScroll: 0,
      turnActive: false,
      controller: null,
    });
  }
  activeIdx = 0;

  render();
  await new Promise<void>((resolve) => {
    const onQuit = () => {
      if (quitting) resolve();
      else setTimeout(onQuit, 50);
    };
    setTimeout(onQuit, 50);
  });
}
