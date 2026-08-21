/* Tenjin Console — vanilla JS, zero dependencies. */
"use strict";

const $app = document.getElementById("app");

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
  for (const child of children) {
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
  for (const bot of await loadBots()) {
    main.append(
      el(
        "div",
        { class: "card" },
        el("strong", {}, bot.name),
        " ",
        el("span", { class: "badge" }, bot.model),
        bot.unread > 0 ? el("span", { class: "badge err" }, `${bot.unread} unread`) : null,
        el("div", { class: "dim" }, `${bot.sessions} session(s)`),
      ),
    );
  }
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
  const table = el(
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
    table.append(
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
  main.append(table, el("p", { class: "dim" }, `total: ${fmtUsd(total)}`));
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
          } else if (frame.type === "done") {
            replyMsg.textContent = frame.reply ?? reply ?? "(no reply)";
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

async function panelApprovals(main) {
  main.replaceChildren(el("h1", {}, "Approvals"));
  const container = el("div");
  main.append(container);

  async function refresh() {
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
          { class: "card" },
          el("strong", {}, `[${req.id}] ${req.tool}`),
          " ",
          el("span", { class: "badge" }, req.bot),
          el("div", { class: "dim" }, req.inputSummary),
          el(
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
                  refresh();
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
                  refresh();
                },
              },
              "deny",
            ),
          ),
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

const PANELS = [
  ["chat", "Chat", panelChat],
  ["approvals", "Approvals", panelApprovals],
  ["sessions", "Sessions", panelSessions],
  ["spend", "Spend", panelSpend],
  ["audit", "Audit", panelAudit],
  ["status", "Status", panelStatus],
];

async function render() {
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
