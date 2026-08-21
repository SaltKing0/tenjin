/* Tenjin Console — vanilla JS, zero dependencies. */
"use strict";

import { renderMarkdown } from "./markdown.js";
import { emptyStateFor } from "./empty-state.js";
import { resolvePanelScope, scopeHint, panelScopeKey } from "./scope-defaults.js";
import { setupChecklist } from "./setup-checklist.js";
import { headerLabels, stackLabels, isHeaderRow } from "./tables.js";
import { firstRunView, shouldShowFirstRun } from "./first-run.js";
import { botSectionItems } from "./sidebar-bots.js";
import { lastRunStatus, runStatusView, historyTones } from "./job-status.js";
import { messageText, sessionMessages } from "./chat-history.js";
import { THEME_KEY, resolveTheme, nextTheme } from "./theme.js";

import { panelGroups } from "./sidebar-groups.js";

import { connectionView } from "./topbar-state.js";
import {
  approvalBadgeText,
  approvalBadgeClass,
  browserTitle,
  approvalLine,
  approvalAge,
} from "./approval-badge.js";

const $app = document.getElementById("app");

// #286: apply the saved theme (or system preference) before the first paint.
const savedTheme = localStorage.getItem(THEME_KEY);
const systemLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches ?? false;
let theme = resolveTheme(savedTheme, systemLight);
document.documentElement.dataset.theme = theme;
// Follow the OS theme until the user makes an explicit choice.
window.matchMedia?.("(prefers-color-scheme: light)")?.addEventListener?.("change", (e) => {
  if (!localStorage.getItem(THEME_KEY)) {
    theme = resolveTheme(null, e.matches);
    document.documentElement.dataset.theme = theme;
  }
});

// auto-accept ?token=… from the URL (then strip it from the address bar)
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken && urlToken.trim()) {
  localStorage.setItem("tenjin_token", urlToken.trim());
  // keep the hash (#route) so a deep link like /?token=X#jobs still opens the
  // target panel after the auto-accept instead of being thrown back to chat.
  history.replaceState(null, "", location.pathname + location.hash);
}

let token = localStorage.getItem("tenjin_token") || "";
// #251: while the first-run guide is showing, suppress it after a step CTA so
// the destination panel renders instead of re-showing the guide.
let suppressFirstRun = false;
let currentBot = localStorage.getItem("tenjin_bot") || "solo";
let bots = [];
// #296: live pending-approval counter for the TopBar (SSE-driven), mirrored to
// the document title so a pending cross-surface approval is visible anywhere.
let approvalCount = 0;
let approvalBadgeEl = null;
let approvalDropdown = null;

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

// #258: annotate every <td> with the matching <th> text so a <768px stylesheet
// can stack rows into labelled cards instead of overflowing horizontally.
// The label mapping lives in the pure tables.js module (headless-testable);
// this DOM glue reads the real table rows and applies it.
function prepareTables(root) {
  for (const table of root.querySelectorAll("table")) {
    const body = table.querySelector("tr");
    if (!body) continue;
    const headers = headerLabels(
      [...body.children].map((c) => ({ tag: c.tagName, text: c.textContent.trim() })),
    );
    if (headers.length === 0) continue; // no header row -> skip
    for (const row of table.querySelectorAll("tr")) {
      const cells = [...row.children];
      if (isHeaderRow(cells.map((c) => ({ tag: c.tagName })))) continue; // header row itself
      stackLabels(headers, cells.map((c) => ({ tag: c.tagName }))).forEach((label, i) => {
        if (label !== undefined) cells[i].setAttribute("data-label", label);
      });
    }
  }
}

// #254: build an empty-state guidance card from the pure empty-state module.
// CTAs are anchors that drive the existing hashchange router.
function emptyStateCard(panel) {
  const def = emptyStateFor(panel);
  if (!def) return null;
  const parts = [el("div", { class: "empty-title" }, def.title)];
  if (def.caption) parts.push(el("div", { class: "dim" }, def.caption));
  if (def.cta && def.hash) parts.push(el("a", { class: "primary", href: def.hash }, def.cta));
  return el("div", { class: "card empty-state" }, ...parts);
}

// #277: when the currently selected scope is empty but another bot has data,
// show a subtle one-tap hint to switch scopes instead of leaving the user stuck
// on an empty panel.
function scopeHintCard(panel, current) {
  const hint = scopeHint({ current, bots: scopeBots(panel) });
  if (!hint) return null;
  return el(
    "div",
    { class: "card scope-hint" },
    `${hint.name} has ${hint.count} item${hint.count === 1 ? "" : "s"} — `,
    el(
      "a",
      {
        href: "#",
        onclick: (e) => {
          e.preventDefault();
          setPanelScope(panel, hint.name);
          if (panel === "memory") currentBot = hint.name;
          render();
        },
      },
      "switch",
    ),
  );
}

// #252: render the setup checklist (from /api/setup/state) with deep-links on
// every still-missing item. Pure items come from setup-checklist.js.
function renderSetupChecklist(state) {
  const rows = setupChecklist(state).map((item) => {
    const row = el(
      "div",
      { class: item.ok ? "setup-row ok" : "setup-row" },
      el("span", { class: "setup-mark" }, item.ok ? "✓" : "✗"),
      el("span", {}, item.label),
      item.optional ? el("span", { class: "dim" }, " (optional)") : null,
    );
    if (!item.ok && item.hash) row.append(el("a", { class: "setup-link", href: item.hash }, "→"));
    return row;
  });
  return el("div", { class: "card" }, ...rows);
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

// Live gateway events over SSE. Panels subscribe per type via onEvent(); the
// stream reconnects with the last seen event id so no event is lost.
const eventTabs = Object.create(null);
let lastEventId = 0;
let sseStarted = false;
// #280: tri-state SSE connection ("connecting" | "online" | "offline") so the
// banner never shows as offline before the first stream opens on a healthy
// server, and flips online the moment the stream opens (not after a message).
let sseState = "connecting";
let sseAbort = null;
let sseIndicator = null;
let offlineBanner = null;

// #256: reflect the live SSE connection in the top bar (pure view from
// topbar-state.js); clicking the indicator forces an immediate reconnect.
function setSseUi() {
  const { label, tone, banner } = connectionView(sseState);
  if (sseIndicator) {
    sseIndicator.textContent = label;
    sseIndicator.className = `topbar-sse ${tone}`;
  }
  if (offlineBanner) {
    offlineBanner.style.display = banner ? "block" : "none";
    offlineBanner.textContent = banner || "";
  }
}
function reconnectSse() {
  sseState = "offline";
  setSseUi();
  if (sseAbort) sseAbort.abort();
}

function onEvent(type, fn) {
  (eventTabs[type] ||= new Set()).add(fn);
  return () => eventTabs[type]?.delete(fn);
}

function dispatchEvent(ev) {
  const set = eventTabs[ev.type];
  if (set) for (const fn of [...set]) fn(ev.payload);
}

async function connectEvents() {
  while (true) {
    sseAbort = new AbortController();
    let res;
    try {
      const headers = lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {};
      res = await api("/api/events", { headers, signal: sseAbort.signal });
    } catch {
      sseState = "offline";
      setSseUi();
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok || !res.body) {
      sseState = "offline";
      setSseUi();
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    sseState = "online";
    setSseUi();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let id = null;
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = line.slice(4).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          if (id !== null) {
            const n = Number(id);
            if (Number.isFinite(n) && n > lastEventId) lastEventId = n;
          }
          dispatchEvent(ev);
        }
      }
    } catch {
      // dropped connection — fall through to reconnect
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    sseState = "offline";
    setSseUi();
    await new Promise((r) => setTimeout(r, 1000));
  }
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

function botSelector(onChange, value = currentBot) {
  const select = el("select", { onchange: (e) => onChange(e.target.value) });
  select.append(el("option", { value: "solo" }, "solo"));
  for (const bot of bots) {
    select.append(el("option", { value: bot.name }, bot.name));
  }
  select.value = value;
  return select;
}

// #277: per-panel scope helpers. A scoped panel (Sessions/Memory) picks which
// bot scope to render from data counts in the loaded `bots` list (each bot has
// `.sessions` and `.memory`), falling back to "solo". The choice persists per
// panel in localStorage (like tenjin_spend_days), independent of the global
// currentBot used by the chat/topbar.
function scopeBots(panel) {
  const list = [{ name: "solo", count: 0 }];
  for (const b of bots) {
    list.push({ name: b.name, count: panel === "memory" ? b.memory ?? 0 : b.sessions ?? 0 });
  }
  return list;
}
function panelScope(panel) {
  const stored = localStorage.getItem(panelScopeKey(panel)) || "";
  return resolvePanelScope({ stored, bots: scopeBots(panel) });
}
function setPanelScope(panel, value) {
  localStorage.setItem(panelScopeKey(panel), value);
}

/* ---------- panels ---------- */

async function panelStatus(main) {
  main.replaceChildren(el("h1", {}, "Status"));
  // #251: re-open the first-run guide from here while the setup is incomplete.
  try {
    const setup = await apiJson("/api/setup/state");
    if (shouldShowFirstRun(setup)) {
      main.append(
        el(
          "button",
          {
            class: "firstrun-guide",
            onclick: () => {
              localStorage.removeItem("tenjin_firstrun_skipped");
              suppressFirstRun = false;
              render();
            },
          },
          "setup guide",
        ),
      );
    }
  } catch {}
  const status = await apiJson("/status");
  const card = el(
    "div",
    { class: "card" },
    el("div", {}, `uptime: ${fmtUptime(status.uptimeMs ?? 0)}`),
    el("div", {}, `channels: ${(status.channels || []).join(", ") || "none"}`),
  );
  main.append(card);

  // #252: what is still missing to use the console (model, bot, token, budget,
  // optional channel) with deep-links into the relevant panel.
  main.append(el("h2", {}, "setup"));
  try {
    const setup = await apiJson("/api/setup/state");
    main.append(renderSetupChecklist(setup));
  } catch {
    main.append(el("div", { class: "dim" }, "setup state unavailable"));
  }

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
    table.append(
      el("tr", {}, el("th", {}, "job"), el("th", {}, "bot"), el("th", { class: "num" }, "next due")),
    );
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
    prepareTables(main);
  }
}

/* ---------- bots panel (bot list + create / edit / delete) ---------- */

async function panelBots(main) {
  main.replaceChildren(el("h1", {}, "Bots"));
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
      await panelBots(main);
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
      await panelBots(main);
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
    el("span", { class: "badge mono" }, bot.model),
    bot.unread > 0 ? el("span", { class: "badge err" }, `${bot.unread} unread`) : null,
    el("div", { class: "dim" }, `${bot.sessions} session(s)`),
    el("div", { class: "label" }, "SOUL"),
    soulArea,
    el("div", { class: "bot-actions" }, renameInput, save, del, status),
  );
}

function botCreateForm(main) {
  const nameInput = el("input", { type: "text", placeholder: "new bot name" });
  const roleSelect = el("select", { style: "width:100%; margin-bottom:8px" });
  const modelSelect = el("select", { style: "width:100%; margin-bottom:8px" });
  const soulArea = el("textarea", { class: "soul-input", rows: 6, placeholder: "SOUL.md for this bot — generated from a template or edited" });
  const preview = el("div", { class: "soul-preview" });
  const status = el("div", { class: "dim" });
  const create = el("button", {}, "Create bot");

  let templates = [];
  async function refreshTemplates() {
    roleSelect.replaceChildren(el("option", { value: "" }, "— choose a role —"));
    try {
      const data = await apiJson("/api/bots/templates");
      templates = data.templates || [];
      for (const t of templates) {
        roleSelect.append(el("option", { value: t.id }, t.label));
      }
    } catch {
      /* templates unavailable — name-only creation still works */
    }
  }

  // Populate the model dropdown from the detected-model cache (mine/grouped).
  function refreshModels() {
    modelSelect.replaceChildren(el("option", { value: "" }, "— default model —"));
    const detected = readDetectedCache();
    const seen = new Set();
    for (const [provider, groups] of Object.entries(detected)) {
      const g = normalizeDetected(groups);
      const flat = [...g.chat, ...g.embedding, ...g.other];
      if (flat.length === 0) continue;
      for (const m of flat) {
        const key = `${provider}:${m.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const label = m.free ? `${m.id} ⭐free` : m.id;
        modelSelect.append(el("option", { value: key }, label));
      }
    }
  }

  async function updatePreview() {
    const name = nameInput.value.trim();
    const role = roleSelect.value;
    if (!name || !role) {
      preview.replaceChildren();
      return;
    }
    try {
      const data = await apiJson("/api/bots/soul-preview", {
        method: "POST",
        body: JSON.stringify({ role, name }),
      });
      soulArea.value = data.soul;
      preview.replaceChildren(renderMarkdown(data.soul));
    } catch {
      preview.replaceChildren(el("div", { class: "err" }, "could not preview this template"));
    }
  }

  roleSelect.addEventListener("change", updatePreview);
  nameInput.addEventListener("input", updatePreview);

  function validate() {
    if (!nameInput.value.trim()) return "name is required";
    if (modelSelect.value && !modelSelect.value.includes(":")) return "invalid model selection";
    return null;
  }

  create.onclick = async () => {
    const err = validate();
    if (err) {
      status.textContent = err;
      status.className = "err";
      return;
    }
    const body = { name: nameInput.value.trim() };
    if (roleSelect.value) body.role = roleSelect.value;
    if (modelSelect.value) body.model = modelSelect.value;
    if (soulArea.value.trim()) body.soul = soulArea.value;
    status.textContent = "…";
    status.className = "dim";
    try {
      await apiJson("/api/bots", { method: "POST", body: JSON.stringify(body) });
      status.textContent = "created";
      status.className = "ok";
      nameInput.value = "";
      soulArea.value = "";
      await panelBots(main);
    } catch (e) {
      status.textContent = e.message;
      status.className = "err";
    }
  };

  refreshTemplates();
  refreshModels();

  return el(
    "div",
    { class: "card" },
    el("div", { class: "label" }, "new bot"),
    nameInput,
    roleSelect,
    modelSelect,
    el("div", { class: "dim", style: "margin:4px 0" }, "SOUL.md"),
    soulArea,
    preview,
    el("div", { class: "bot-actions" }, create, status),
  );
}

async function panelSessions(main) {
  // #277: default to the first bot that has sessions (else solo) and persist
  // the choice per panel; keep currentBot in sync for replay/fork downstream.
  currentBot = panelScope("sessions");
  main.replaceChildren(
    el("h1", {}, "Sessions"),
    el(
      "div",
      { class: "toolbar" },
      botSelector(
        async (value) => {
          currentBot = value;
          setPanelScope("sessions", value);
          await panelSessions(main);
        },
        currentBot,
      ),
      el("input", { id: "session-q", placeholder: "search preview…" }),
      el("span", { class: "dim" }, "click a session to open its timeline"),
    ),
  );
  const list = el("div");
  const pager = el("div", { class: "toolbar", style: "margin-top:8px" });
  main.append(list, pager);
  const PER = 100;
  let offset = 0;
  let total = 0;

  function searchTerm() {
    return (main.querySelector("#session-q")?.value ?? "").trim();
  }

  async function load() {
    const q = encodeURIComponent(searchTerm());
    const url = `/api/sessions?bot=${encodeURIComponent(currentBot)}&limit=${PER}&offset=${offset}${q ? `&q=${q}` : ""}`;
    const data = await apiJson(url);
    total = data.total ?? 0;
    const count = data.sessions.length;
    list.replaceChildren();
    if (count === 0) {
      // #254: guide a first-time user; keep the plain line during a filtered
      // or paginated view so the CTA isn't misleading.
      list.append(
        !q && offset === 0
          ? emptyStateCard("sessions")
          : el("div", { class: "dim" }, "no sessions in this scope yet"),
      );
      // #277: if this scope is empty but another bot has sessions, offer a switch.
      if (!q && offset === 0) {
        const hintCard = scopeHintCard("sessions", currentBot);
        if (hintCard) list.append(hintCard);
      }
    }
    for (const session of data.sessions) {
      const when = new Date(session.mtimeMs).toLocaleString();
      const row = el(
        "div",
        {
          class: "card",
          style: "cursor:pointer",
          onclick: async () => openReplay(main, session.id),
        },
        el("strong", {}, session.id),
        session.parentId ? el("span", { class: "badge" }, `fork of ${session.parentId}`) : null,
        el("div", { class: "dim" }, `${when} — ${session.preview}`),
      );
      list.append(row);
    }
    pager.replaceChildren();
    if (total === 0) return;
    const prev = el("button", { onclick: () => { offset = Math.max(0, offset - PER); load(); } }, "‹ prev");
    if (offset === 0) prev.disabled = true;
    const next = el("button", { onclick: () => { offset += PER; load(); } }, "next ›");
    if (offset + count >= total) next.disabled = true;
    pager.append(prev, el("span", { class: "dim" }, `${offset + 1}–${Math.min(offset + count, total)} of ${total}`), next);
  }

  const searchBtn = main.querySelector("#session-q");
  if (searchBtn) {
    searchBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        offset = 0;
        load();
      }
    });
  }
  await load();
}

async function openReplay(main, id) {
  main.replaceChildren(
    el("h1", {}, "Session"),
    el(
      "div",
      { class: "toolbar" },
      el("button", { onclick: () => panelSessions(main) }, "< back"),
      el("span", { class: "dim" }, id),
      el("button", { onclick: () => forkSession(main, id) }, "Fork"),
    ),
  );
  const box = el("div");
  main.append(box);

  // #131: ancestry breadcrumb — which forks this session traces back to, and
  // where context-elision (compression) happened along the way.
  try {
    const tree = await apiJson(`/api/sessions/${encodeURIComponent(id)}/tree?bot=${encodeURIComponent(currentBot)}`);
    const lineage = tree && Array.isArray(tree.lineage) ? tree.lineage : [];
    if (lineage.length > 0) {
      box.append(el("h2", {}, "Lineage"));
      box.append(
        el(
          "div",
          { class: "dim", style: "margin:4px 0 8px" },
          lineage.map((n) => n.id).join(" ← forked from "),
        ),
      );
      for (const n of lineage) {
        if (n.compressionCount > 0) {
          box.append(
            el(
              "div",
              { class: "dim", style: "margin-left:8px" },
              `${n.id}: ${n.compressionCount} compression(s)` +
                n.compressions.map((c) => ` ~ ${c.beforeTokens} → ${c.afterTokens} (elided ${c.elidedTokens})`).join(""),
            ),
          );
        }
      }
    }
  } catch {
    // lineage is best-effort; the timeline below still renders without it
  }

  const data = await apiJson(`/api/sessions/${encodeURIComponent(id)}/events?bot=${encodeURIComponent(currentBot)}`);
  box.append(el("h2", {}, "Timeline"));
  if (!data.events || data.events.length === 0) {
    box.append(el("div", { class: "dim" }, "(empty session)"));
    return;
  }
  for (const ev of data.events) {
    switch (ev.t) {
      case "session_start": {
        const head = `session ${ev.id} · ${ev.provider || "?"}:${ev.model || "?"}`;
        box.append(el("div", { class: "dim" }, ev.parent ? `${head} — forked from ${ev.parent.id} @${ev.parent.uptoEvent}` : head));
        break;
      }
      case "message":
        box.append(messageCard(ev));
        break;
      case "tool_call": {
        const details = el(
          "details",
          {},
          el("summary", {}, `→ ${ev.name}`),
          el("pre", {}, JSON.stringify(ev.input ?? {}, null, 2)),
        );
        box.append(el("div", { class: "toolcall" }, details));
        break;
      }
      case "tool_result": {
        const cls = ev.ok ? "toolok" : "toolerr";
        const label = ev.ok ? `← ${ev.name} ok` : `← ${ev.name} ERR`;
        const details = el(
          "details",
          {},
          el("summary", {}, label),
          el("pre", {}, String(ev.output)),
        );
        box.append(el("div", { class: cls }, details));
        break;
      }
      case "usage":
        box.append(el("div", { class: "dim" }, `$ in ${ev.inputTokens} · out ${ev.outputTokens} · ${ev.costUSD} turn · ${ev.spentUSD} spent`));
        break;
      case "error":
        box.append(el("div", { class: "err" }, `error: ${ev.message}`));
        break;
      case "compression":
        box.append(el("div", { class: "dim" }, `~ context ${ev.beforeTokens} → ${ev.afterTokens} (elided ${ev.elidedTokens})`));
        break;
      default:
        break;
    }
  }
}

// #284: shared message-block builder (used by chat history + live sends).
function chatMessage(m) {
  const cls = m.role === "user" ? "msg you" : "msg bot";
  const label = m.role === "user" ? "you" : "tenjin";
  return el("div", { class: cls }, el("strong", {}, label), el("div", {}, m.text));
}

function messageCard(ev) {
  const text = messageText(ev);
  if (ev.role === "user") {
    return el("div", { class: "msg you" }, el("strong", {}, "you"), el("div", {}, text));
  }
  if (!text) return el("div", {});
  return el("div", { class: "msg bot" }, el("strong", {}, "tenjin"), el("div", {}, text));
}

async function forkSession(main, id) {
  const data = await apiJson(`/api/sessions/${encodeURIComponent(id)}/fork?bot=${encodeURIComponent(currentBot)}`, { method: "POST" });
  if (data && data.ok) {
    await openReplay(main, data.id);
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
        el("td", { class: "dim mono" }, r.model),
        el("td", {}, r.day),
        el("td", { class: "num" }, String(r.sessions)),
        el("td", { class: "num" }, fmtTokens(r.inputTokens)),
        el("td", { class: "num" }, fmtTokens(r.outputTokens)),
        el("td", { class: "num" }, fmtUsd(r.costUSD)),
      ),
    );
  }
  main.append(el("h2", { class: "dim" }, "by bot"), breakdownTable, el("h2", { class: "dim" }, "details"), detailTable, el("p", { class: "dim" }, `total: ${fmtUsd(total)}`));
  prepareTables(main);
}

async function panelAudit(main) {
  main.replaceChildren(el("h1", {}, "Audit"));
  const select = el("select", {
    onchange: () => refresh(select.value),
  });
  const out = el("pre");
  main.append(el("div", { class: "toolbar" }, select), out);

  async function refresh(kind) {
    const data = await apiJson(`/api/audit?tail=200${kind ? `&kind=${kind}` : ""}`);
    // Build the kind filter from the backend list, not a duplicated copy.
    if (select.options.length === 0 && Array.isArray(data.kinds)) {
      select.append(el("option", { value: "" }, "(all kinds)"));
      for (const k of data.kinds) select.append(el("option", { value: k }, k));
    }
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
      botSelector(() => loadHistory()),
      el("span", { class: "dim" }, "prefix @botname to address a specific bot"),
    ),
  );
  const log = el("div", { class: "chat-log" });
  const input = el("input", { placeholder: "message your bot…", autofocus: true });
  const sendBtn = el("button", { class: "primary" }, "send");
  main.append(log, el("div", { class: "chat-input" }, input, sendBtn));

  // #284: on open, render the selected bot's last session as history (auto-
  // scrolled), or an empty-state with context; reload when the bot switches.
  async function loadHistory() {
    let history = [];
    try {
      const s = await apiJson(`/api/sessions?bot=${encodeURIComponent(currentBot)}&limit=1`);
      const latest = s.sessions && s.sessions[0];
      if (latest) {
        const ev = await apiJson(
          `/api/sessions/${encodeURIComponent(latest.id)}/events?bot=${encodeURIComponent(currentBot)}`,
        );
        history = sessionMessages(ev.events);
      }
    } catch {
      history = [];
    }
    log.replaceChildren();
    if (bots.length === 0) {
      // #254: with no bots yet, guide the user (dismissed on the first message)
      log.append(emptyStateCard("chat"));
    } else if (history.length === 0) {
      log.append(emptyStateCard("chat_history"));
    } else {
      for (const m of history) log.append(chatMessage(m));
      log.lastElementChild?.scrollIntoView({ block: "end" });
    }
  }
  await loadHistory();

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    log.querySelector(".empty-state")?.remove();
    log.append(chatMessage({ role: "user", text }));
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

// #296: resolve a pending approval from the dropdown. Small wrapper shared by
// the TopBar dropdown and the Approvals panel so one approve/deny works in both.
async function resolveApproval(id, action) {
  await apiJson(`/api/approvals/${id}`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

// #296: fetch pending approvals, update the TopBar badge + document title, and
// rebuild the dropdown body. Called on render and on every approval SSE event.
async function refreshApprovalBadge() {
  let pending = [];
  try {
    const data = await apiJson("/api/approvals");
    pending = data.pending || [];
  } catch {
    pending = [];
  }
  approvalCount = pending.length;
  if (approvalBadgeEl) {
    approvalBadgeEl.textContent = approvalBadgeText(approvalCount);
    approvalBadgeEl.className = approvalBadgeClass(approvalCount);
    approvalBadgeEl.title = approvalCount > 0 ? `${approvalCount} pending approval${approvalCount === 1 ? "" : "s"}` : "no pending approvals";
  }
  document.title = browserTitle(approvalCount);
  if (approvalDropdown) buildApprovalDropdown(approvalDropdown, pending);
  return pending;
}

// #296: render the dropdown listing pending approvals with inline approve/deny
// and a link into the Approvals panel. `host` is the dropdown container.
function buildApprovalDropdown(host, pending) {
  host.replaceChildren();
  if (pending.length === 0) {
    host.append(el("div", { class: "dim", style: "padding:8px" }, "nothing pending"));
    return;
  }
  const now = Date.now();
  for (const req of pending) {
    const row = el(
      "div",
      { class: "approval-dd-item" },
      el("div", {}, approvalLine(req), el("span", { class: "dim" }, ` · ${approvalAge(req.ts, now)}`)),
      el(
        "div",
        { style: "display:flex; gap:6px; margin-top:6px" },
        el(
          "button",
          {
            class: "primary",
            onclick: async () => {
              await resolveApproval(req.id, "approve");
              refreshApprovalBadge();
            },
          },
          "approve",
        ),
        el(
          "button",
          {
            class: "danger",
            onclick: async () => {
              await resolveApproval(req.id, "deny");
              refreshApprovalBadge();
            },
          },
          "deny",
        ),
      ),
    );
    host.append(row);
  }
  host.append(el("a", { class: "approval-dd-all", href: "#approvals" }, "all approvals →"));
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
      container.append(emptyStateCard("approvals") ?? el("div", { class: "dim" }, "no pending approvals"));
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
  const offs = [
    onEvent("approval.created", refresh),
    onEvent("approval.resolved", refresh),
  ];
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      for (const off of offs) off();
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
      list.append(emptyStateCard("jobs") ?? el("div", { class: "dim" }, "no jobs configured"));
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
      // #285: prominent run-status badge (ok/error/timeout/never) with a
      // replay link for failed/timed-out runs and a compact history strip.
      const lastStatus = lastRunStatus(job);
      const lastView = runStatusView(lastStatus);
      const lastRunRow = el(
        "div",
        { style: "margin-top:8px" },
        el("span", { class: `badge run ${lastView.tone}` }, lastView.label),
      );
      if (job.lastRun) {
        lastRunRow.append(" ", el("span", { class: "dim" }, new Date(job.lastRun.at).toLocaleString()));
      }
      const lastRunSession = job.history?.[0]?.sessionId;
      if ((lastStatus === "error" || lastStatus === "timeout") && lastRunSession) {
        lastRunRow.append(
          " ",
          el(
            "a",
            {
              class: "run-link",
              href: "#",
              onclick: (e) => {
                e.preventDefault();
                openReplay(main, lastRunSession);
              },
            },
            "view run session",
          ),
        );
      }
      const dotTones = historyTones(job.history);
      if (dotTones.length > 0) {
        lastRunRow.append(
          " ",
          el(
            "span",
            { class: "run-dots", title: "recent runs (newest first)" },
            ...dotTones.map((t) => el("span", { class: `dot ${t}` })),
          ),
        );
      }
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
          lastRunRow,
          job.prompt ? el("div", { class: "dim" }, `prompt: ${job.prompt}`) : null,
          job.postTo ? el("div", { class: "dim" }, `postTo: ${job.postTo}`) : null,
          el("div", { style: "margin-top:8px" }, runBtn),
        ),
      );
    }
  }

  await refresh();
  const off = onEvent("job.status", refresh);
  const observer = new MutationObserver(() => {
    if (!document.body.contains(list)) {
      off();
      observer.disconnect();
    }
  });
  observer.observe($app, { childList: true, subtree: true });
}

async function panelMemory(main) {
  // #274/#277: if there are no bots at all, there is no memory scope — guide
  // the user to create a bot. Otherwise resolve the effective memory scope from
  // per-bot memory counts (default = first bot with memory data, else solo) and
  // persist the choice per panel.
  if (bots.length === 0) {
    main.replaceChildren(
      el("h1", {}, "Memory"),
      el("div", { class: "toolbar" }, el("span", { class: "dim" }, "read-only view of a bot's facts, summaries and vector store")),
    );
    main.append(emptyStateCard("memory_nobots"));
    return;
  }
  const scope = panelScope("memory");
  if (currentBot !== scope) currentBot = scope;

  main.replaceChildren(
    el("h1", {}, "Memory"),
    el(
      "div",
      { class: "toolbar" },
      botSelector(
        async (value) => {
          currentBot = value;
          setPanelScope("memory", value);
          await panelMemory(main);
        },
        scope,
      ),
      el("span", { class: "dim" }, "read-only view of a bot's facts, summaries and vector store"),
    ),
  );
  const box = el("div");
  main.append(box);

  let data;
  try {
    data = await apiJson(`/api/memory/${encodeURIComponent(scope)}`);
  } catch (e) {
    box.append(
      el(
        "div",
        { class: "card err" },
        el("div", { class: "empty-title" }, "Memory unavailable"),
        el("div", { class: "dim" }, `Could not load memory for “${scope}”. Please try again or pick another bot.`),
      ),
    );
    return;
  }

  // #254: guide a first-time user when nothing has been persisted in this scope
  if (data.summaries.length === 0 && !data.facts) {
    box.append(emptyStateCard("memory"));
    // #277: if this scope is empty but another bot has memory data, offer a switch.
    const hintCard = scopeHintCard("memory", scope);
    if (hintCard) box.append(hintCard);
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

const DOCS_URL = "https://github.com/SaltKing0/Stealth/tree/main/docs";

// #256: slim persistent top bar above every panel — SSE state (click to
// reconnect), active bot switcher, budget spent today, docs link.
function buildTopBar() {
  sseIndicator = el("button", { class: "topbar-sse", title: "reconnect", onclick: reconnectSse }, "…");
  offlineBanner = el("div", { class: "offline-banner", style: "display:none" });
  const botSel = el("select", {
    onchange: (e) => {
      currentBot = e.target.value;
      localStorage.setItem("tenjin_bot", currentBot);
      render();
    },
  });
  botSel.append(el("option", { value: "solo" }, "solo"));
  for (const b of bots) botSel.append(el("option", { value: b.name }, b.name));
  botSel.value = currentBot;
  const budget = el("span", { class: "topbar-budget", title: "spend today" }, "…");
  apiJson("/api/health")
    .then((h) => {
      budget.textContent = `$${fmtUsd(h.budgetSpentTodayUSD ?? 0)} today`;
    })
    .catch(() => {
      budget.textContent = "budget n/a";
    });
  const docs = el("a", { class: "topbar-docs", href: DOCS_URL, target: "_blank", rel: "noopener" }, "docs");

  // #296: live pending-approval badge + dropdown in the TopBar.
  approvalDropdown = el("div", { class: "approval-dd", style: "display:none" });
  approvalBadgeEl = el(
    "button",
    {
      class: "topbar-approvals idle",
      title: "no pending approvals",
      onclick: () => {
        const open = approvalDropdown.style.display !== "none";
        approvalDropdown.style.display = open ? "none" : "block";
        if (!open) refreshApprovalBadge();
      },
    },
    approvalBadgeText(0),
  );
  // #286: light/dark theme toggle (persisted in localStorage).
  const themeBtn = el(
    "button",
    {
      class: "topbar-theme",
      title: "toggle light/dark theme",
      onclick: toggleTheme,
    },
    theme === "light" ? "☀" : "☾",
  );
  const bar = el("div", { class: "topbar" }, sseIndicator, botSel, approvalBadgeEl, approvalDropdown, budget, themeBtn, docs);
  setSseUi();
  return bar;
}

// #286: flip the theme, persist the choice, and update the toggle label.
function toggleTheme() {
  theme = nextTheme(theme);
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.querySelector(".topbar-theme");
  if (btn) btn.textContent = theme === "light" ? "☀" : "☾";
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
  ["bots", "Bots", panelBots],
];

// #251: the 3-step first-run guide (progress + links into the real panels).
// Each "start" CTA navigates into its panel (suppressing the guide so the panel
// renders); "skip to advanced mode" persists the choice and shows the console.
function renderFirstRun(view) {
  $app.replaceChildren();
  $app.append(
    el(
      "div",
      { class: "first-run" },
      el("h1", {}, "Welcome to Tenjin"),
      el("div", { class: "dim" }, "A few quick steps to your first run."),
      el("div", { class: "firstrun-progress" }, el("div", { class: "firstrun-progress-fill", style: `width:${view.progress}%` })),
      el("div", { class: "dim firstrun-count" }, `${view.done} of ${view.steps.length} steps done`),
      ...view.steps.map((s) =>
        el(
          "div",
          { class: s.done ? "card firstrun-step done" : "card firstrun-step" },
          el("span", { class: "firstrun-step-n" }, s.n),
          el("span", { class: "firstrun-step-mark" }, s.done ? "✓" : "✗"),
          el("span", { class: "firstrun-step-title" }, s.title),
          s.done
            ? null
            : el(
                "button",
                {
                  class: "primary",
                  onclick: () => {
                    suppressFirstRun = true;
                    location.hash = s.hash;
                  },
                },
                "start",
              ),
        ),
      ),
      el(
        "button",
        {
          class: "firstrun-skip",
          onclick: () => {
            localStorage.setItem("tenjin_firstrun_skipped", "1");
            suppressFirstRun = true;
            render();
          },
        },
        "skip to advanced mode",
      ),
    ),
  );
}

async function render() {
  try {
    bots = await apiJson("/api/bots").then((d) => d.bots);
  } catch {
    bots = [];
  }
  // #251: on an incomplete setup (unless skipped or the user navigated into a
  // panel), show the 3-step first-run guide instead of dead panels.
  if (!suppressFirstRun && localStorage.getItem("tenjin_firstrun_skipped") !== "1") {
    try {
      const setup = await apiJson("/api/setup/state");
      if (shouldShowFirstRun(setup)) {
        renderFirstRun(firstRunView(setup));
        return;
      }
    } catch {
      // setup state unavailable → fall through to the normal console
    }
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
      // #287: group the panels (Operate / Observe / Settings) instead of a
      // flat list. Labels are hidden on the mobile bottom-nav layout.
      ...panelGroups(PANELS.map(([name]) => name)).flatMap((g) => [
        g.label ? el("div", { class: "sidebar-group-label" }, g.label) : null,
        ...g.names.map((name) => {
          const entry = PANELS.find(([p]) => p[0] === name);
          return el(
            "a",
            { class: name === panel[0] ? "active" : "", href: `#${name}` },
            entry[1],
          );
        }),
      ]),
    ),
  );

  // #276: list the bots as a sidebar section under the panels. Clicking one
  // preselects that bot in chat (native hashchange re-renders when not already
  // on Chat; otherwise we re-render in place so the switch takes effect).
  const botLinks = botSectionItems(bots, currentBot);
  if (botLinks.length > 0) {
    sidebar.append(
      el(
        "div",
        { class: "sidebar-bots" },
        el("div", { class: "sidebar-bots-label" }, "Bots"),
        el(
          "nav",
          {},
          ...botLinks.map((b) =>
            el(
              "a",
              {
                class: b.active ? "active" : "",
                href: "#chat",
                onclick: () => {
                  currentBot = b.name;
                  localStorage.setItem("tenjin_bot", b.name);
                  if (location.hash === "#chat") render();
                },
              },
              b.name,
              b.model ? el("span", { class: "badge mono" }, b.model) : null,
            ),
          ),
        ),
      ),
    );
  }

  const topbar = buildTopBar();
  const main = el("div", { class: "main" });
  $app.replaceChildren(topbar, offlineBanner, sidebar, main);
  if (!sseStarted) {
    sseStarted = true;
    connectEvents();
    // #296: badge + title stay live as approvals are created/resolved anywhere
    // (Jobs, Telegram, delegations) — not just when the Approvals panel is open.
    onEvent("approval.created", refreshApprovalBadge);
    onEvent("approval.resolved", refreshApprovalBadge);
  }
  refreshApprovalBadge();
  try {
    await panel[2](main);
    prepareTables(main);
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

/* #257: group the detected model list into Chat / Embedding / Other with a
 * `:free` badge and a search filter. The backend already returns the grouped
 * structure (`{models, groups}` from /api/settings/detect) sorted free-first
 * within each group, so the client only renders it — no heuristic duplication.
 */
const GROUP_LABELS = { chat: "Chat", embedding: "Embedding", other: "Other" };

// Normalize a per-provider detected entry: new cache holds the backend's
// `groups` object ({chat:[{id,group,free}],...}), legacy caches hold a flat
// string[]. Coerce both to the groups shape.
function normalizeDetected(groups) {
  if (Array.isArray(groups)) {
    return { chat: groups.map((id) => ({ id, group: "chat", free: false })), embedding: [], other: [] };
  }
  const g = groups || {};
  return {
    chat: g.chat || [],
    embedding: g.embedding || [],
    other: g.other || [],
  };
}

function detectedModelCount(detected) {
  let n = 0;
  for (const v of Object.values(detected)) {
    const g = normalizeDetected(v);
    n += g.chat.length + g.embedding.length + g.other.length;
  }
  return n;
}

function matchesModelQuery(m, q) {
  if (!q) return true;
  return m.id.toLowerCase().includes(q);
}

function renderProviderGroups(select, provider, groups, q) {
  const g = normalizeDetected(groups);
  for (const key of ["chat", "embedding", "other"]) {
    const entries = g[key].filter((m) => matchesModelQuery(m, q));
    if (entries.length === 0) continue;
    if (select.tagName === "SELECT") {
      const og = el("optgroup", { label: GROUP_LABELS[key] });
      for (const m of entries) og.append(el("option", { value: provider + ":" + m.id }, m.id + (m.free ? "  ⭐ free" : "")));
      select.append(og);
    }
  }
}

// Rebuild the default-model dropdown from the detected cache, honoring a
// search filter. Returns how many options were rendered.
function renderDetectedModelOptions(select, detected, q) {
  select.replaceChildren(el("option", { value: "" }, "— run detect on a provider to list models —"));
  for (const [provider, groups] of Object.entries(detected)) {
    renderProviderGroups(select, provider, groups, q || "");
  }
  return detectedModelCount(detected);
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
  // #257: search filter over the model list (shown once it exceeds 50 entries).
  const modelFilter = el("input", {
    type: "text",
    placeholder: "filter models…",
    style: "width:100%; margin-bottom:8px; box-sizing:border-box",
  });
  const modelArea = el("div", {}, modelFilter, modelSelect);
  modelFilter.addEventListener("input", () => {
    const total = renderDetectedModelOptions(modelSelect, state.detected, modelFilter.value.trim().toLowerCase());
    modelFilter.style.display = total > 50 ? "" : "none";
    setDefaultModel(state.defaultModel);
  });
  // restore previously detected models from the cache so the dropdown
  // is populated immediately on reopen, before any detect runs
  const cachedTotal = renderDetectedModelOptions(modelSelect, state.detected, "");
  modelFilter.style.display = cachedTotal > 50 ? "" : "none";
  modelFilter.value = "";

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
        state.detected[name] = data.groups || { chat: data.models.map((id) => ({ id, group: "chat", free: false })), embedding: [], other: [] };
        writeDetectedCache(state.detected);
        const total = renderDetectedModelOptions(modelSelect, state.detected, modelFilter.value.trim().toLowerCase());
        modelFilter.style.display = total > 50 ? "" : "none";
        detectOut.textContent = data.models.length + " models detected (grouped)";
        detectOut.className = "ok";
        setDefaultModel(state.defaultModel);
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
      modelArea,
      el("div", { class: "dim", style: "margin:8px 0 4px" }, "cheap tier (summaries, background jobs)"),
      cheapSelect,
    ),
    el("div", { class: "toolbar" }, saveBtn, statusLine),
    el("p", { class: "dim" },
      "keys are stored in ~/.tenjin/providers.yaml (0600). changes apply live — no restart."),
  );
}
