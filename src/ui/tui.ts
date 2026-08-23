/* Tenjin TUI — split-pane, keyboard-driven interface over the same agent loop
 * the line REPL uses (src/ui/repl.ts). Zero-dependency; paints with raw ANSI
 * via the Screen core (src/ui/screen.ts).
 *
 * Layout (rows x cols):
 *   row 0        header
 *   rows 1..R-4  chat pane (left)  |  side panel (right, ~30% width)
 *   row R-2      input line
 *   row R-1      status bar
 *
 * Keybindings:
 *   Tab               cycle the side panel (sessions / bots / spend / approvals)
 *   PgUp / PgDn       scroll the chat pane
 *   Ctrl-C            interrupt the active turn, else quit
 *   Ctrl-D (empty)    quit
 *   Enter             send the input line (message or /command)
 */

import { stdin, stdout } from "node:process";
import { join } from "node:path";
import type { ChatMessage, Provider } from "../provider/types";
import { ProviderRegistry } from "../provider/registry";
import { resolveModelRef, formatModelRef, type ModelRef } from "../config/models";
import type { ToolDef } from "../tools/registry";
import type { HarnessConfig } from "../config/loader";
import { Budget, createBudget, formatUSD, TreeBudget } from "../agent/budget";
import { runAgentTurn, type ApproveDecision } from "../agent/loop";
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
import { rebuildMessages } from "../session/events";
import { validateMode, DEFAULT_MODE, type ModeLadder } from "../security/mode-ladder";
import { Screen, decodeKey, LineEditor, type Style, RESET } from "./screen";
import type { ReplOptions } from "./repl";

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

interface TuiState {
  messages: ChatMessage[];
  budget: Budget;
  treeBudget?: TreeBudget;
  active: ModelRef;
  pinnedSkills: Set<string>;
  audit: AuditLog;
  sessionAllowed: Set<string>;
  /** Running token usage across the session (for the spend + ctx indicator). */
  tokens: { in: number; out: number };
}

export async function startTui(opts: ReplOptions): Promise<void> {
  const audit = new AuditLog(auditPath(opts.home));
  const state: TuiState = {
    messages: [...(opts.initialMessages ?? [])],
    budget: createBudget(opts.config.budgetUSD, opts.config.pricing),
    treeBudget: opts.config.maxTreeIterations
      ? new TreeBudget(opts.config.maxTreeIterations ?? 0, 0)
      : undefined,
    active: opts.defaultRef,
    pinnedSkills: new Set<string>(),
    audit,
    sessionAllowed: new Set<string>(),
    tokens: { in: 0, out: 0 },
  };
  state.budget.spentUSD = opts.initialSpentUSD ?? 0;
  const sessionMode = { current: DEFAULT_MODE as ModeLadder };

  // Side-panel data (refreshed each time a tab is shown).
  let sideTab: SideTab = "sessions";
  let sideData: string[] = [];

  // Chat view: a list of already-wrapped display lines, styled per block.
  const chat: Array<{ text: string; st: Style }> = [];
  let chatScroll = 0;

  let turnActive = false;
  let controller: AbortController | null = null;

  const editor = new LineEditor();
  const scr = new Screen(process.stdout.rows || 24, process.stdout.columns || 80);

  // ---------- helpers ----------
  const chatW = () => scr.cols - Math.floor(scr.cols * 0.3) - 1;
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
  function appendChat(text: string, st: Style): void {
    for (const line of wrap(text, chatW())) chat.push({ text: line, st });
    chatScroll = 0; // jump to newest
  }
  function setStatus(field: string, value: string): void {}

  // ---------- side panel loaders ----------
  function loadSessions(): string[] {
    if (!opts.sessionsDir) return ["(no sessions dir)"];
    const all = SessionLog.list(opts.sessionsDir);
    if (all.length === 0) return ["no sessions yet"];
    return all.slice(0, 20).map((s) => {
      const when = new Date(s.mtimeMs).toISOString().replace("T", " ").slice(5, 16);
      return `${s.id}  ${when}  ${(s.preview ?? "").slice(0, 22)}`;
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
      `spent ${formatUSD(state.budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "∞"}`,
      `tokens  in ${state.tokens.in} · out ${state.tokens.out}`,
      ctxStatus(),
    ];
    for (const entry of state.budget.breakdown()) {
      out.push(`  ${entry.model}: ${formatUSD(entry.usd)}`);
    }
    return out;
  }
  function loadApprovals(): string[] {
    return pendingApprovals.length ? pendingApprovals.map((p) => p.summary) : ["no pending approvals"];
  }

  /** Context-window occupancy for the active model (used + window, with a bar). */
  function ctxStatus(): string {
    const window = contextWindowTokens(state.active.model, opts.config.context);
    const used = estimateTokens(state.messages);
    const pct = window > 0 ? Math.min(100, Math.round((used / window) * 100)) : 0;
    const barLen = 8;
    const filled = Math.round((pct / 100) * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return `ctx ${bar} ${pct}% ${k(used)}/${k(window)}`;
  }
  const ktok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  // ---------- approval handling ----------
  const pendingApprovals: Array<{ resolve: (d: ApproveDecision) => void; summary: string }> = [];
  function requestApproval(tool: string, group: "read" | "write", input: unknown): Promise<ApproveDecision> {
    return new Promise((resolve) => {
      const summary = `${tool} (${group}) — approve?  [1] allow  [2] deny  [3] always`;
      pendingApprovals.push({ resolve, summary });
      appendChat(summary, COLORS.dim);
      render();
    });
  }
  function answerApproval(allow: boolean): void {
    const p = pendingApprovals.shift();
    if (p) p.resolve(allow);
  }

  // ---------- agent turn ----------
  function activeProvider(): Provider {
    return opts.registry.get(state.active.provider);
  }
  async function runTurn(text: string): Promise<void> {
    state.messages.push({ role: "user", content: text });
    appendChat(`you> ${text}`, COLORS.user);
    appendChat("tenjin> ", COLORS.bot);

    controller = new AbortController();
    turnActive = true;
    // stream deltas straight into the chat view (batched)
    let buf = "";
    const flush = () => {
      if (buf) {
        appendChat(buf, COLORS.bot);
        buf = "";
        render();
      }
    };
    const ticker = setInterval(flush, 30);
    const skillsSection = buildSkillsSection(opts.home, opts.cwd, state.pinnedSkills);
    const volatileTail = buildVolatileTail({
      now: new Date().toISOString().slice(0, 10),
      statusLines: skillsSection ? [skillsSection] : [],
    });
    try {
      const result = await runAgentTurn({
        provider: activeProvider(),
        model: state.active.model,
        system: opts.system,
        volatileTail,
        tools: opts.tools,
        messages: state.messages,
        budget: state.budget,
        treeBudget: state.treeBudget,
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
        onEvent: () => {},
        signal: controller.signal,
        contextGuard: resolveContextGuard(state.active.model, opts.config.context),
      });
      if (buf) {
        appendChat(buf, COLORS.bot);
        buf = "";
      }
      state.tokens.in += result.usage.inputTokens ?? 0;
      state.tokens.out += result.usage.outputTokens ?? 0;
      appendChat(
        dim(`  [${result.model} · in ${result.usage.inputTokens} out ${result.usage.outputTokens} · ${formatUSD(result.costUSD)} turn · ${formatUSD(state.budget.spentUSD)} total]`),
        COLORS.dim,
      );
    } catch (e) {
      if (buf) {
        appendChat(buf, COLORS.bot);
        buf = "";
      }
      if ((e as Error)?.name === "AbortError") {
        appendChat("(interrupted)", COLORS.dim);
      } else {
        appendChat(`error: ${(e as Error)?.message ?? e}`, COLORS.err);
      }
    } finally {
      clearInterval(ticker);
      turnActive = false;
      controller = null;
      render();
    }
  }

  // ---------- commands ----------
  async function runCommand(line: string): Promise<"exit" | void> {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/help":
        appendChat(
          "/help /exit /quit | /cost /model [id] /mode [rung] | /whoami /bots /sessions | Tab: side panel | PgUp/PgDn: scroll",
          COLORS.dim,
        );
        return;
      case "/exit":
      case "/quit":
        return "exit";
      case "/cost":
        appendChat(`spent ${formatUSD(state.budget.spentUSD)} of ${opts.config.budgetUSD > 0 ? formatUSD(opts.config.budgetUSD) : "no cap"}`, COLORS.dim);
        return;
      case "/model":
        if (!rest[0]) {
          appendChat(dim(formatModelRef(state.active)), COLORS.dim);
          return;
        }
        try {
          if (rest[0] === "default") state.active = opts.defaultRef;
          else if (rest[0] === "cheap" && opts.cheapRef) state.active = opts.cheapRef;
          else state.active = resolveModelRef(rest.join(" "), opts.config.provider);
          appendChat(dim(`model → ${formatModelRef(state.active)}`), COLORS.dim);
        } catch (e) {
          appendChat(`error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      case "/whoami":
        appendChat(dim(`${opts.bot ?? "solo"} · ${state.active.provider}:${state.active.model} · cwd ${opts.cwd}`), COLORS.dim);
        return;
      case "/bots":
        appendChat(loadBots().join("\n"), COLORS.bot);
        return;
      case "/sessions":
        appendChat(loadSessions().join("\n"), COLORS.bot);
        return;
      case "/skills": {
        const all = listSkills(opts.home, opts.cwd);
        appendChat(all.length ? all.map((s) => `${s.name}  ${s.description}`).join("\n") : "no skills", COLORS.bot);
        return;
      }
      case "/tools":
        appendChat(
          opts.tools.length
            ? opts.tools.map((t) => `${t.name.padEnd(14)} ${t.group}${state.sessionAllowed.has(t.name) ? " ✓" : ""}`).join("\n")
            : "no tools",
          COLORS.bot,
        );
        return;
      case "/replay":
        if (!opts.logger) {
          appendChat("no session log active", COLORS.err);
          return;
        }
        appendChat(renderTrajectory(opts.logger.events()).join("\n"), COLORS.dim);
        return;
      case "/resume": {
        if (!opts.sessionsDir || !rest[0]) {
          appendChat("usage: /resume <id>", COLORS.err);
          return;
        }
        try {
          const log = SessionLog.resolve(opts.sessionsDir, rest[0]);
          state.messages = rebuildMessages(log.events());
          appendChat(dim(`resumed ${log.id} — ${state.messages.length} messages`), COLORS.dim);
        } catch (e) {
          appendChat(`error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      }
      case "/mode": {
        const rung = rest[0];
        if (!rung) {
          appendChat(dim(`${sessionMode.current} (session; config default ${opts.config.mode?.ladder ?? DEFAULT_MODE})`), COLORS.dim);
          return;
        }
        try {
          sessionMode.current = validateMode(rung);
          appendChat(dim(`mode → ${sessionMode.current}`), COLORS.dim);
        } catch (e) {
          appendChat(dim(`  ${(e as Error).message}`), COLORS.dim);
        }
        return;
      }
      case "/tell": {
        const bot = rest[0];
        const text = rest.slice(1).join(" ");
        if (!bot || !text.trim()) {
          appendChat("usage: /tell <bot> <text>", COLORS.err);
          return;
        }
        try {
          const profile = resolveBot(opts.home, bot);
          const msg = leaveUserMessage(profile.inboxDir, profile.name, text, inboxPolicyFromConfig(opts.config.inbox));
          appendChat(dim(`left message for ${profile.name} (id ${msg.id})`), COLORS.dim);
        } catch (e) {
          appendChat(`error: ${(e as Error).message}`, COLORS.err);
        }
        return;
      }
      case "/audit": {
        const n = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 20;
        const es = audit.query({ tail: n });
        appendChat(es.length ? formatAudit(es) : "no audit events", COLORS.bot);
        return;
      }
      case "/skill": {
        const name = rest[0];
        if (!name) {
          appendChat("usage: /skill <name> [off] | /skill new <name>", COLORS.err);
          return;
        }
        if (name === "new") {
          if (!rest[1]) {
            appendChat("usage: /skill new <name>", COLORS.err);
            return;
          }
          try {
            const p = scaffoldSkill(opts.cwd, rest[1]);
            appendChat(dim(`scaffolded ${p}`), COLORS.dim);
          } catch (e) {
            appendChat(`error: ${(e as Error).message}`, COLORS.err);
          }
          return;
        }
        if (rest[1] === "off") {
          state.pinnedSkills.delete(name);
          appendChat(dim(`unpinned ${name}`), COLORS.dim);
          return;
        }
        const skill = getSkill(opts.home, opts.cwd, name);
        if (!skill) {
          appendChat(`unknown skill "${name}" — /skills`, COLORS.err);
          return;
        }
        state.pinnedSkills.add(skill.name);
        appendChat(dim(`pinned ${skill.name}`), COLORS.dim);
        return;
      }
      default:
        appendChat(`unknown command ${cmd} — /help`, COLORS.err);
    }
  }
  const dim = (s: string) => s;

  // ---------- render ----------
  function render(): void {
    scr.clear();
    // header
    scr.write(0, 0, ` Tenjin TUI v${VERSION}  ·  ${opts.bot ?? "solo"}  ·  ${state.active.provider}:${state.active.model}`, COLORS.header);
    // side panel
    const sw = Math.floor(scr.cols * 0.3);
    const sideLeft = scr.cols - sw;
    const sideLines =
      sideTab === "sessions" ? loadSessions()
      : sideTab === "bots" ? loadBots()
      : sideTab === "spend" ? loadSpend()
      : sideTab === "memory" ? loadMemory()
      : loadApprovals();
    scr.write(1, sideLeft, ` ${sideTab} `, COLORS.header);
    sideLines.slice(0, scr.rows - 5).forEach((l, i) => {
      scr.write(2 + i, sideLeft, l.slice(0, sw - 1), COLORS.dim);
    });
    // chat pane (rows 1..R-4)
    const chatRows = scr.rows - 5;
    const cw = chatW();
    const start = Math.max(0, chat.length - chatRows - chatScroll);
    for (let i = 0; i < chatRows; i++) {
      const line = chat[start + i];
      if (line) scr.write(1 + i, 0, line.text.slice(0, cw), line.st);
    }
    // input line
    scr.write(scr.rows - 2, 0, `you> ${editor.text}`, COLORS.input);
    // status bar
    const win = contextWindowTokens(state.active.model, opts.config.context);
    const used = estimateTokens(state.messages);
    const pct = win > 0 ? Math.min(100, Math.round((used / win) * 100)) : 0;
    const status = ` ${turnActive ? "…thinking" : "ready"} · ${formatUSD(state.budget.spentUSD)}${opts.config.budgetUSD > 0 ? `/${formatUSD(opts.config.budgetUSD)}` : ""} · in ${ktok(state.tokens.in)} out ${ktok(state.tokens.out)} · ${pct}% ctx · ${pendingApprovals.length} appr · Tab:${sideTab}`;
    scr.write(scr.rows - 1, 0, status.slice(0, scr.cols), COLORS.status);
    scr.render(stdout, { row: scr.rows - 2, col: Math.min(5 + editor.cursor, scr.cols - 1) });
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
        case "home":
          editor.home();
          break;
        case "end":
          editor.end();
          break;
        case "ctrl-k":
          editor.ctrlK();
          break;
        case "mouse":
          if (k.pressed && k.button === 0) {
            // Clicking a row in the side-panel sessions list opens that session.
            const sw = Math.floor(scr.cols * 0.3);
            const sideLeft = scr.cols - sw;
            if (sideTab === "sessions" && k.x >= sideLeft && k.y >= 2 && k.y <= scr.rows - 4) {
              const idx = k.y - 2;
              const line = loadSessions()[idx];
              if (line) {
                const id = line.split(/\s+/)[0]!;
                if (id) {
                  void runCommand(`/resume ${id}`).then((r) => {
                    if (r === "exit") {
                      quitting = true;
                      quit();
                    }
                  });
                  render();
                }
              }
            }
          }
          break;
        case "tab": {
          const i = SIDE_TABS.indexOf(sideTab);
          sideTab = SIDE_TABS[(i + 1) % SIDE_TABS.length]!;
          break;
        }
        case "pgup":
          chatScroll = Math.min(chat.length, chatScroll + 5);
          break;
        case "pgdown":
          chatScroll = Math.max(0, chatScroll - 5);
          break;
        case "enter": {
          const line = editor.submit();
          render();
          if (line.startsWith("/")) {
            void (async () => {
              const r = await runCommand(line);
              if (r === "exit") {
                quitting = true;
                quit();
              }
              render();
            })();
          } else if (line.trim()) {
            void runTurn(line.trim());
          }
          break;
        }
        case "ctrl-c":
          if (turnActive && controller) {
            controller.abort();
          } else {
            quitting = true;
            quit();
          }
          break;
        case "ctrl-d":
          if (editor.text === "") {
            quitting = true;
            quit();
          }
          break;
        default:
          break;
      }
      render();
    }
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

  render();
  await new Promise<void>((resolve) => {
    const onQuit = () => {
      if (quitting) resolve();
      else setTimeout(onQuit, 50);
    };
    setTimeout(onQuit, 50);
  });
}
