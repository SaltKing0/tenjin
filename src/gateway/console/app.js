/* Tenjin Console — vanilla JS, zero dependencies. */
"use strict";

import { renderMarkdown } from "./markdown.js";

const $app = document.getElementById("app");

// auto-accept ?token=… from the URL (then strip it from the address bar)
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken && urlToken.trim()) {
  localStorage.setItem("tenjin_token", urlToken.trim());
  history.replaceState(null, "", location.pathname);
}

let token = localStorage.getItem("tenjin_token") || "";
let currentBot = localStorage.getItem("tenjin_bot") || "solo";
let bots = [];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "onclick") node.onclick = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      authorization: `Bearer ${token}`,
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.removeItem("tenjin_token");
    token = "";
    renderLogin();
    throw new Error("unauthorized");
  }
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

function fmtUsd(n) {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

async function loadBots() {
  const data = await apiJson("/api/bots");
  bots = data.bots;
  return bots;
}

function botSelector(onChange) {
  const select = el("select", { onchange: (e) => onChange(e.target.value) });
  select.append(el("option", { value: "solo" }, "solo"));
  for (const bot of bots) {
    select.append(el("option", { value: bot.name }, bot.name));
  }
  select.value = currentBot;
  return select;
}

/* ---------- panels ---------- */

async function panelStatus(main) {
  main.replaceChildren(el("h1", {}, "Status"));
  const status = await apiJson("/status");
  const card = el(
    "div",
    { class: "card" },
    el("div", {}, `uptime: ${fmtUptime(status.uptimeMs ?? 0)}`),
    el("div", {}, `channels: ${(status.channels || []).join(", ") || "none"}`),
  );
  main.append(card);

  const guard = status.guard || {};
  const disabled = guard.state === "disabled";
  const blocked = guard.blockedEvents ?? 0;
  const guardCard = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: disabled ? "err" : "ok" },
      disabled ? "SECURITY GUARD DISABLED" : "security guard: active",
    ),
    el("div", { class: "dim" }, `${blocked} blocked event(s)`),
  );
  if (disabled) {
    guardCard.append(
      el(
        "div",
        { class: "warn" },
        "Path and command policy is not enforced. Re-enable in config.yaml.",
      ),
    );
  }
  main.append(guardCard);

  main.append(el("h2", {}, "jobs"));
  const jobs = status.jobs || [];
  if (jobs.length === 0) {
    main.append(el("div", { class: "dim" }, "no jobs configured"));
  } else {
    const table = el("table");
    for (const job of jobs) {
      table.append(
        el(
          "tr",
          {},
          el("td", {}, job.name),
          el("td", { class: "dim" }, job.bot),
          el("td", { class: "num dim" }, new Date(job.nextDueMs).toLocaleTimeString()),
        ),
      );
    }
    main.append(table);
  }

  main.append(el("h2", {}, "bots"));
  main.append(botCreateForm(main));
  for (const bot of await loadBots()) {
    main.append(await botEditorCard(main, bot));
  }
}

/* ---------- bot management (create / edit SOUL / rename / delete) ---------- */

async function botEditorCard(main, bot) {
  let soul = "";
  try {
    soul = (await apiJson(`/api/bots/${encodeURIComponent(bot.name)}`)).soul;
  } catch {
    soul = "# could not load SOUL for this bot";
  }
  const soulArea = el("textarea", { class: "soul-input", rows: 8, spellcheck: "false" }, soul);
  const renameInput = el("input", { class: "rename-input", type: "text", value: bot.name });
  renameInput.setAttribute("aria-label", "rename bot");
  const status = el("div", { class: "dim" });

  const save = el("button", {}, "Save");
  save.onclick = async () => {
    const body = { soul: soulArea.value };
    const newName = renameInput.value.trim();
    if (newName && newName !== bot.name) body.rename = newName;
    try {
      const data = await apiJson(`/api/bots/${encodeURIComponent(bot.name)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      status.textContent = `saved → ${data.name}`;
      status.className = "ok";
      await panelStatus(main);
    } catch (e) {
      status.textContent = e.message;
      status.className = "err";
    }
  };

  const del = el("button", { class: "danger" }, "Delete");
  del.onclick = async () => {
    if (!confirm(`Delete bot ${bot.name}? Its directory and data will be removed.`)) return;
    try {
      await api(`/api/bots/${encodeURIComponent(bot.name)}`, { method: "DELETE" });
      await panelStatus(main);
    } catch (e) {
      status.textContent = e.message;
      status.className = "err";
    }
  };

  return el(
    "div",
    { class: "card" },
    el("strong", {}, bot.name),
    " ",
    el("span", { class: "badge" }, bot.model),
    bot.unread > 0 ? el("span", { class: "badge err" }, `${bot.unread} unread`) : null,
    el("div", { class: "dim" }, `${bot.sessions} session(s)`),
    el("div", { class: "label" }, "SOUL"),
    soulArea,
    el("div", { class: "bot-actions" }, renameInput, save, del, status),
  );
}

function botCreateForm(main) {
  const nameInput = el("input", { type: "text", placeholder: "new bot name" });
  const soulArea = el("textarea", { class: "soul-input", rows: 5, placeholder: "optional SOUL text" });
  const status = el("div", { class: "dim" });
  const create = el("button", {}, "Create bot");
  create.onclick = async () => {
    const body = { name: nameInput.value };
    if (soulArea.value.trim()) body.soul = soulArea.value;
    try {
      await apiJson("/api/bots", { method: "POST", body: JSON.stringify(body) });
      status.textContent = "created";
      status.className = "ok";
      await panelStatus(main);
    } catch (e) {
      status.textContent = e.message;
      status.className = "err";
    }
  };
  return el(
    "div",
    { class: "card" },
    el("div", { class: "label" }, "new bot"),
    nameInput,
    soulArea,
    el("div", { class: "bot-actions" }, create, status),
  );
}

async function panelSessions(main) {
  main.replaceChildren(
    el("h1", {}, "Sessions"),
    el(
      "div",
      { class: "toolbar" },
      botSelector(async (value) => {
        currentBot = value;
        localStorage.setItem("tenjin_bot", value);
        await panelSessions(main);
      }),
      el("span", { class: "dim" }, "click a session to view its trajectory"),
    ),
  );
  const list = el("div");
  main.append(list);

  const data = await apiJson(`/api/sessions?bot=${encodeURIComponent(currentBot)}`);
  if (data.sessions.length === 0) {
    list.append(el("div", { class: "dim" }, "no sessions in this scope yet"));
    return;
  }
  for (const session of data.sessions) {
    const when = new Date(session.mtimeMs).toLocaleString();
    const row = el(
      "div",
      {
        class: "card",
        style: "cursor:pointer",
        onclick: async () => {
          const detail = await apiJson(
            `/api/session/${encodeURIComponent(session.id)}?bot=${encodeURIComponent(currentBot)}`,
          );
          list.replaceChildren(
            el("button", { onclick: () => panelSessions(main) }, "< back"),
            el("h2", {}, `${detail.id}${session.parentId ? ` (forked from ${session.parentId})` : ""}`),
            el("pre", {}, detail.lines.join("\n")),
          );
        },
      },
      el("strong", {}, session.id),
      session.parentId ? el("span", { class: "badge" }, `fork of ${session.parentId}`) : null,
      el("div", { class: "dim" }, `${when} — ${session.preview}`),
    );
    list.append(row);
  }
}

async function panelSpend(main) {
  let days = Number(localStorage.getItem("tenjin_spend_days") || 30);
  main.replaceChildren(
    el("h1", {}, "Spend"),
    el(
      "div",
      { class: "toolbar" },
      ...[7, 30, 0].map((d) =>
        el(
          "button",
          {
            class: d === days ? "primary" : "",
            onclick: () => {
              days = d;
              localStorage.setItem("tenjin_spend_days", String(d));
              panelSpend(main);
            },
          },
          d === 0 ? "all time" : `${d}d`,
        ),
      ),
    ),
  );
  const data = await apiJson(`/api/spend?days=${days}`);
  if (data.rows.length === 0) {
    main.append(el("div", { class: "dim" }, "no spend recorded"));
    return;
  }
  const total = data.rows.reduce((sum, r) => sum + r.costUSD, 0);
  const byBot = data.byBot ?? [];
  const breakdownTable = el(
    "table",
    { class: "spend-breakdown" },
    el(
      "tr",
      {},
      el("th", {}, "bot"),
      el("th", { class: "num" }, "sessions"),
      el("th", { class: "num" }, "in"),
      el("th", { class: "num" }, "out"),
      el("th", { class: "num" }, "cost"),
    ),
  );
  for (const b of byBot) {
    breakdownTable.append(
      el(
        "tr",
        {},
        el("td", {}, b.scope),
        el("td", { class: "num" }, String(b.sessions)),
        el("td", { class: "num" }, fmtTokens(b.inputTokens)),
        el("td", { class: "num" }, fmtTokens(b.outputTokens)),
        el("td", { class: "num" }, fmtUsd(b.costUSD)),
      ),
    );
  }
  const detailTable = el(
    "table",
    {},
    el(
      "tr",
      {},
      el("th", {}, "scope"),
      el("th", {}, "model"),
      el("th", {}, "day"),
      el("th", { class: "num" }, "sessions"),
      el("th", { class: "num" }, "in"),
      el("th", { class: "num" }, "out"),
      el("th", { class: "num" }, "cost"),
    ),
  );
  for (const r of data.rows) {
    detailTable.append(
      el(
        "tr",
        {},
        el("td", {}, r.scope),
        el("td", { class: "dim" }, r.model),
        el("td", {}, r.day),
        el("td", { class: "num" }, String(r.sessions)),
        el("td", { class: "num" }, fmtTokens(r.inputTokens)),
        el("td", { class: "num" }, fmtTokens(r.outputTokens)),
        el("td", { class: "num" }, fmtUsd(r.costUSD)),
      ),
    );
  }
  main.append(el("h2", { class: "dim" }, "by bot"), breakdownTable, el("h2", { class: "dim" }, "details"), detailTable, el("p", { class: "dim" }, `total: ${fmtUsd(total)}`));
}

async function panelAudit(main) {
  main.replaceChildren(el("h1", {}, "Audit"));
  const kinds = ["", "tool_block", "approval", "write_exec", "budget_halt", "channel_reject", "delegation", "gateway_msg", "data_delete"];
  const select = el(
    "select",
    {
      onchange: () => refresh(select.value),
    },
    kinds.map((k) => el("option", { value: k }, k || "(all kinds)")),
  );
  main.append(el("div", { class: "toolbar" }, select));

  const out = el("pre");
  main.append(out);

  async function refresh(kind) {
    const data = await apiJson(`/api/audit?tail=200${kind ? `&kind=${kind}` : ""}`);
    if (data.events.length === 0) {
      out.textContent = "(no audit events)";
      return;
    }
    out.textContent = data.events
      .map((e) => {
        const ts = e.ts.slice(5, 16).replace("T", " ");
        const bot = e.bot ? ` [${e.bot}]` : "";
        return `${ts} ${e.kind.padEnd(14)} ${e.actor}${bot}: ${e.detail}`;
      })
      .join("\n");
  }
  await refresh("");
}

async function panelChat(main) {
  main.replaceChildren(
    el("h1", {}, "Chat"),
    el(
      "div",
      { class: "toolbar" },
      botSelector(() => {}),
      el("span", { class: "dim" }, "prefix @botname to address a specific bot"),
    ),
  );
  const log = el("div", { class: "chat-log" });
  const input = el("input", { placeholder: "message your bot…", autofocus: true });
  const sendBtn = el("button", { class: "primary" }, "send");
  main.append(log, el("div", { class: "chat-input" }, input, sendBtn));

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    log.append(el("div", { class: "msg you" }, text));
    const replyMsg = el("div", { class: "msg bot" }, "…");
    log.append(replyMsg);
    try {
      const res = await api("/api/chat/stream", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reply = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = JSON.parse(buffer.slice(5, idx));
          buffer = buffer.slice(idx + 2);
          if (frame.type === "delta") {
            reply += frame.text;
            replyMsg.textContent = reply;
          } else if (frame.type === "tool") {
            log.append(el("div", { class: "msg tool-status dim" }, `· ${frame.name} …`));
          } else if (frame.type === "done") {
            const finalText = frame.reply ?? reply ?? "(no reply)";
            replyMsg.replaceChildren(renderMarkdown(finalText));
          } else if (frame.type === "error") {
            replyMsg.textContent = `error: ${frame.message}`;
            replyMsg.classList.add("err");
          }
        }
      }
    } catch (e) {
      replyMsg.textContent = `error: ${e.message}`;
      replyMsg.classList.add("err");
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }
  sendBtn.onclick = send;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });
}

function formatApprovalInput(input) {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function approvalActionButtons(req, onDone) {
  return el(
    "div",
    { style: "margin-top:8px; display:flex; gap:8px" },
    el(
      "button",
      {
        class: "primary",
        onclick: async () => {
          await apiJson(`/api/approvals/${req.id}`, {
            method: "POST",
            body: JSON.stringify({ action: "approve" }),
          });
          onDone();
        },
      },
      "approve",
    ),
    el(
      "button",
      {
        class: "danger",
        onclick: async () => {
          await apiJson(`/api/approvals/${req.id}`, {
            method: "POST",
            body: JSON.stringify({ action: "deny" }),
          });
          onDone();
        },
      },
      "deny",
    ),
  );
}

async function panelApprovals(main) {
  main.replaceChildren(el("h1", {}, "Approvals"));
  const container = el("div");
  main.append(container);
  let viewingId = null;

  function closeFull() {
    viewingId = null;
    refresh();
  }

  async function showFull(req) {
    viewingId = req.id;
    try {
      const detail = await apiJson(`/api/approvals/${req.id}`);
      container.replaceChildren(
        el("button", { onclick: closeFull }, "< back"),
        el("h2", {}, `[${detail.id}] ${detail.tool} `, el("span", { class: "badge" }, detail.bot)),
        el("pre", { class: "approval-input" }, formatApprovalInput(detail.input ?? detail.inputSummary)),
        approvalActionButtons(detail, closeFull),
      );
    } catch {
      viewingId = null;
      await refresh();
    }
  }

  async function refresh() {
    if (viewingId) return;
    const data = await apiJson("/api/approvals");
    container.replaceChildren();
    if (data.pending.length === 0) {
      container.append(el("div", { class: "dim" }, "no pending approvals"));
      return;
    }
    for (const req of data.pending) {
      container.append(
        el(
          "div",
          {
            class: "card",
            style: "cursor:pointer",
            title: "view full input",
            onclick: (e) => {
              if (e.target.closest("button")) return;
              showFull(req);
            },
          },
          el("strong", {}, `[${req.id}] ${req.tool}`),
          " ",
          el("span", { class: "badge" }, req.bot),
          el("div", { class: "dim" }, req.inputSummary),
          approvalActionButtons(req, refresh),
        ),
      );
    }
  }
  await refresh();
  const timer = setInterval(refresh, 4000);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearInterval(timer);
      observer.disconnect();
    }
  });
  observer.observe($app, { childList: true, subtree: true });
}

/* ---------- shell ---------- */

async function panelJobs(main) {
  main.replaceChildren(el("h1", {}, "Jobs"));
  const feedback = el(
    "div",
    { class: "dim", style: "margin-bottom:12px" },
    "run now fires immediately; the next scheduled time is unchanged",
  );
  const resultBox = el("pre", { style: "display:none; margin-bottom:12px" });
  const list = el("div");
  main.append(feedback, resultBox, list);

  function scheduleLabel(job) {
    if (job.cron) return job.cron;
    if (job.every) return `every ${job.every}`;
    return "—";
  }

  async function refresh() {
    const data = await apiJson("/api/jobs");
    const jobs = data.jobs || [];
    list.replaceChildren();
    if (jobs.length === 0) {
      list.append(el("div", { class: "dim" }, "no jobs configured"));
      return;
    }
    for (const job of jobs) {
      const runBtn = el("button", { class: "primary" }, job.running ? "running…" : "Run now");
      runBtn.disabled = !!job.running;
      runBtn.onclick = async () => {
        runBtn.disabled = true;
        runBtn.textContent = "running…";
        feedback.className = "dim";
        feedback.textContent = `running ${job.name}…`;
        resultBox.style.display = "none";
        try {
          const res = await api(`/api/jobs/${encodeURIComponent(job.name)}/run`, {
            method: "POST",
          });
          const body = await res.json();
          if (!res.ok || !body.ok) {
            feedback.className = "err";
            feedback.textContent = body.error || `run failed (${res.status})`;
            resultBox.style.display = "none";
          } else {
            feedback.className = "ok";
            feedback.textContent = `${job.name}: ${body.stopReason} (${fmtUsd(body.costUSD ?? 0)})`;
            resultBox.style.display = "block";
            resultBox.textContent = body.text?.trim() ? body.text : "(no output)";
          }
        } catch (e) {
          feedback.className = "err";
          feedback.textContent = `run failed: ${e.message}`;
        }
        await refresh();
      };
      const last = job.lastRun
        ? `${job.lastRun.stopReason} · ${new Date(job.lastRun.at).toLocaleString()}`
        : "never";
      list.append(
        el(
          "div",
          { class: "card" },
          el("strong", {}, job.name),
          " ",
          el("span", { class: "badge" }, job.bot),
          " ",
          el("span", { class: "badge" }, job.policy || "read-only"),
          job.running ? el("span", { class: "badge" }, "running") : null,
          el("div", { class: "dim", style: "margin-top:8px" }, `schedule: ${scheduleLabel(job)}`),
          el("div", { class: "dim" }, `next due: ${new Date(job.nextDueMs).toLocaleString()}`),
          el("div", { class: "dim" }, `last run: ${last}`),
          job.prompt ? el("div", { class: "dim" }, `prompt: ${job.prompt}`) : null,
          job.postTo ? el("div", { class: "dim" }, `postTo: ${job.postTo}`) : null,
          el("div", { style: "margin-top:8px" }, runBtn),
        ),
      );
    }
  }

  await refresh();
}

async function panelMemory(main) {
  main.replaceChildren(
    el("h1", {}, "Memory"),
    el(
      "div",
      { class: "toolbar" },
      botSelector(async (value) => {
        currentBot = value;
        localStorage.setItem("tenjin_bot", value);
        await panelMemory(main);
      }),
      el("span", { class: "dim" }, "read-only view of a bot's facts, summaries and vector store"),
    ),
  );
  const box = el("div");
  main.append(box);

  let data;
  try {
    data = await apiJson(`/api/memory/${encodeURIComponent(currentBot)}`);
  } catch (e) {
    box.append(el("div", { class: "err" }, `no memory for ${currentBot}: ${e.message}`));
    return;
  }

  // facts
  box.append(el("h2", {}, "Facts"));
  const factsCard = el("div", { class: "card" });
  factsCard.append(
    data.facts
      ? el("pre", {}, data.facts)
      : el("div", { class: "dim" }, "no facts recorded yet"),
  );
  box.append(factsCard);

  // summaries
  box.append(el("h2", {}, "Summaries"));
  if (data.summaries.length === 0) {
    box.append(el("div", { class: "dim" }, "no summaries yet"));
  } else {
    for (const s of data.summaries) {
      const when = s.created ? new Date(s.created).toLocaleString() : "";
      box.append(
        el(
          "div",
          { class: "card" },
          el("strong", {}, s.sessionId),
          when ? el("span", { class: "dim" }, ` — ${when}`) : null,
          el("pre", {}, s.text),
        ),
      );
    }
  }

  // vector store stats
  box.append(el("h2", {}, "Vector store"));
  const v = data.vector || { count: 0, embedModel: null, dim: null };
  box.append(
    el(
      "div",
      { class: "card" },
      el("div", {}, `chunks: ${v.count}`),
      el("div", {}, `embedding model: ${v.embedModel ?? "—"}`),
      el("div", {}, `dimensions: ${v.dim ?? "—"}`),
    ),
  );
}

const PANELS = [
  ["chat", "Chat", panelChat],
  ["settings", "Settings", panelSettings],
  ["approvals", "Approvals", panelApprovals],
  ["jobs", "Jobs", panelJobs],
  ["sessions", "Sessions", panelSessions],
  ["memory", "Memory", panelMemory],
  ["spend", "Spend", panelSpend],
  ["audit", "Audit", panelAudit],
  ["status", "Status", panelStatus],
];

async function render() {
  try {
    bots = await apiJson("/api/bots").then((d) => d.bots);
  } catch {
    bots = [];
  }
  const route = location.hash.replace("#", "") || "chat";
  const panel = PANELS.find(([name]) => name === route) || PANELS[0];

  const sidebar = el(
    "div",
    { class: "sidebar" },
    el("div", { class: "logo" }, "TENJIN"),
    el(
      "nav",
      {},
      PANELS.map(([name, label]) =>
        el("a", { class: name === panel[0] ? "active" : "", href: `#${name}` }, label),
      ),
    ),
  );

  const main = el("div", { class: "main" });
  $app.replaceChildren(sidebar, main);
  try {
    await panel[2](main);
  } catch (e) {
    if (e.message !== "unauthorized") {
      main.append(el("div", { class: "err" }, `error: ${e.message}`));
    }
  }
}

function renderLogin() {
  $app.replaceChildren();
  const input = el("input", { type: "password", placeholder: "gateway token" });
  const box = el(
    "div",
    { class: "login-box" },
    el("h1", {}, "Tenjin Console"),
    el("div", { class: "dim" }, "enter the gateway.listen.token from your config"),
    input,
    el(
      "button",
      {
        class: "primary",
        onclick: async () => {
          token = input.value.trim();
          if (!token) return;
          try {
            await apiJson("/status");
            localStorage.setItem("tenjin_token", token);
            render();
          } catch {
            input.value = "";
            input.placeholder = "invalid token, try again";
          }
        },
      },
      "unlock",
    ),
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") box.querySelector("button").click();
  });
  $app.append(box);
  input.focus();
}

window.addEventListener("hashchange", render);
if (token) {
  render().catch(renderLogin);
} else {
  renderLogin();
}

/* ---------- settings ---------- */

// Persist per-provider detected model lists across reloads so the
// dropdown isn't empty every time the console is reopened.
const DETECT_CACHE_KEY = "tenjin_detected_models";

function readDetectedCache() {
  try {
    return JSON.parse(localStorage.getItem(DETECT_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeDetectedCache(cache) {
  localStorage.setItem(DETECT_CACHE_KEY, JSON.stringify(cache));
}

async function panelSettings(main) {
  main.replaceChildren(el("h1", {}, "Settings"));
  const settings = await apiJson("/api/settings");

  const state = {
    detected: readDetectedCache(),
    defaultModel: settings.models.default || "",
    cheapModel: settings.models.cheap || "",
  };

  const statusLine = el("div", { class: "dim" });
  const modelSelect = el("select", { style: "width:100%; margin-bottom:8px" },
    el("option", { value: "" }, "— run detect on a provider to list models —"));
  // restore previously detected models from the cache so the dropdown
  // is populated immediately on reopen, before any detect runs
  for (const [provider, models] of Object.entries(state.detected)) {
    for (const model of models) {
      modelSelect.append(el("option", { value: provider + ":" + model }, provider + ":" + model));
    }
  }

  // Select (and if needed add) a model in the default dropdown. Used to
  // surface a model id the user typed manually even when it is not in any
  // detected list.
  function setDefaultModel(value) {
    const already = [...modelSelect.options].some((o) => o.value === value);
    if (!already) modelSelect.append(el("option", { value }, value));
    modelSelect.value = value;
  }
  const cheapSelect = el("select", { style: "width:100%" },
    el("option", { value: "" }, "(none)"));
  main.append(statusLine);

  function providerCard(name, label, keyPlaceholder) {
    const configured = settings[name].configured;
    const keyInput = el("input", {
      type: "password",
      placeholder: configured
        ? "configured (" + settings[name].masked + ") — leave blank to keep"
        : keyPlaceholder,
      style: "width:100%; margin-bottom:8px",
    });
    const urlInput = el("input", {
      type: "text",
      value: settings[name].baseUrl || "",
      placeholder:
        "custom base URL (optional) — e.g. " +
        (name === "openai" ? "https://api.deepseek.com/v1" : "https://gateway.example/v1"),
      style: "width:100%; margin-bottom:8px",
    });
    const detectOut = el("div", { class: "dim", style: "margin:8px 0" });

    async function detect() {
      detectOut.textContent = "detecting models…";
      detectOut.className = "dim";
      try {
        const res = await api("/api/settings/detect", {
          method: "POST",
          body: JSON.stringify({
            provider: name,
            baseUrl: urlInput.value.trim() || undefined,
            apiKey: keyInput.value.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (data.error) {
          detectOut.textContent = "detection failed: " + data.error;
          detectOut.className = "err";
          return;
        }
        state.detected[name] = data.models;
        writeDetectedCache(state.detected);
        detectOut.textContent = data.models.length + " models detected";
        detectOut.className = "ok";
        modelSelect.append(...data.models.map((m) => el("option", { value: name + ":" + m }, name + ":" + m)));
      } catch (e) {
        detectOut.textContent = "detection failed: " + e.message;
        detectOut.className = "err";
      }
    }

    // Manual entry: lets the user type a model id even when /models returned
    // nothing or an incomplete list. A bare id (e.g. deepseek-chat) is prefixed
    // with this card's provider; a qualified ref (openai:…) is used as-is. The
    // result becomes the default model so it is sent to the backend on save.
    const manualInput = el("input", {
      type: "text",
      placeholder:
        "or type a model id — e.g. " + (name === "openai" ? "deepseek-chat" : "claude-sonnet-4-6"),
      style: "width:100%; margin-bottom:8px",
      oninput: () => {
        const v = manualInput.value.trim();
        if (!v) return;
        const prefixed = v.indexOf(":") !== -1 ? v : name + ":" + v;
        setDefaultModel(prefixed);
      },
    });

    return el(
      "div",
      { class: "card" },
      el("strong", {}, label),
      " ",
      configured
        ? el("span", { class: "badge ok" }, "configured (" + settings[name].source + ")")
        : el("span", { class: "badge err" }, "not configured"),
      el("div", { style: "margin-top:8px" }, keyInput),
      el("div", {}, urlInput),
      el("div", { style: "display:flex; gap:8px; margin-bottom:4px" },
        el("button", { onclick: detect }, "test & detect models")),
      detectOut,
      el("div", { class: "dim", style: "margin:2px 0 4px" }, "or type a model id (skip detect)"),
      manualInput,
    );
  }

  const anthropicCard = providerCard("anthropic", "Anthropic", "sk-ant-…");
  const openaiCard = providerCard("openai", "OpenAI-compatible (DeepSeek, Ollama, OpenRouter…)", "sk-…");
  cheapSelect.value = state.cheapModel;

  const saveBtn = el("button", { class: "primary" }, "save & apply live");
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    statusLine.textContent = "saving…";
    statusLine.className = "dim";
    try {
      const defaultModel = modelSelect.value || state.defaultModel;
      if (!defaultModel && !confirm("No default model selected — save anyway?")) {
        statusLine.textContent = "save cancelled";
        statusLine.className = "dim";
        return;
      }
      const body = {
        models: {
          default: defaultModel,
          cheap: cheapSelect.value,
        },
      };
      const aKey = anthropicCard.querySelector("input[type=password]").value.trim();
      const aInputs = anthropicCard.querySelectorAll("input");
      const aUrl = aInputs[1].value.trim();
      const oInputs = openaiCard.querySelectorAll("input");
      const oKey = oInputs[0].value.trim();
      const oUrl = oInputs[1].value.trim();
      if (aKey || aUrl) {
        body.anthropic = {};
        if (aKey) body.anthropic.apiKey = aKey;
        if (aUrl) body.anthropic.baseUrl = aUrl;
      }
      if (oKey || oUrl) {
        body.openai = {};
        if (oKey) body.openai.apiKey = oKey;
        if (oUrl) body.openai.baseUrl = oUrl;
      }
      const res = await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (data.error) {
        statusLine.textContent = "save failed: " + data.error;
        statusLine.className = "err";
      } else {
        statusLine.textContent = "saved — applied live, no restart needed";
        statusLine.className = "ok";
      }
    } catch (e) {
      statusLine.textContent = "save failed: " + e.message;
      statusLine.className = "err";
    } finally {
      saveBtn.disabled = false;
    }
  };

  main.append(
    anthropicCard,
    openaiCard,
    el("h2", {}, "models"),
    el("div", { class: "card" },
      el("div", { class: "dim", style: "margin-bottom:4px" }, "default model"),
      modelSelect,
      el("div", { class: "dim", style: "margin:8px 0 4px" }, "cheap tier (summaries, background jobs)"),
      cheapSelect,
    ),
    el("div", { class: "toolbar" }, saveBtn, statusLine),
    el("p", { class: "dim" },
      "keys are stored in ~/.tenjin/providers.yaml (0600). changes apply live — no restart."),
  );
}
