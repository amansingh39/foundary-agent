"use strict";

const $ = id => document.getElementById(id);
const log = $("log");
const scroll = $("scroll");
const input = $("input");
const send = $("send");
const pass = $("pass");

let agentName = "the agent";
let conversation = "";
let busy = false;
let prompts = [];          // the shared catalog
let editable = false;      // the server allows editing with the admin passcode
let adminCode = "";        // set once the server accepted it
let editing = null;        // id of the prompt in the editor, "" for a new one
let running = false;
let stopRequested = false;

const store = {
  get(k) { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* storage off */ } },
};
const local = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
};

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  Object.assign(e, props || {});
  children.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) e.append(c); });
  return e;
}

async function api(path, opts = {}) {
  const headers = { "X-Passcode": pass.value, ...(opts.headers || {}) };
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  if (adminCode) headers["X-Admin-Passcode"] = adminCode;
  const r = await fetch(path, {
    method: opts.method || "GET",
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const data = r.status === 204 ? {} : await r.json().catch(() => ({ error: "Unreadable answer (" + r.status + ")." }));
  return { ok: r.ok, status: r.status, data };
}

/* ---------- services named in a prompt's resource line ---------- */

const SERVICES = [
  { key: "kv", short: "KV", name: "Key Vault", match: /key ?vault/i },
  { key: "st", short: "ST", name: "Storage", match: /storage|table|blob/i },
  { key: "sb", short: "SB", name: "Service Bus", match: /service ?bus|queue/i },
  { key: "sql", short: "SQL", name: "Azure SQL", match: /\bsql\b/i },
  { key: "ais", short: "AIS", name: "AI Search", match: /ai ?search|search/i },
];

// One tag per service, with the resource name that follows it when there is one.
function serviceTags(resource) {
  const text = resource || "";
  const tags = [];
  text.split(/\s*\+\s*/).forEach(part => {
    const svc = SERVICES.find(s => s.match.test(part));
    if (!svc || tags.some(t => t.svc === svc)) return;
    const name = (part.match(/\b([a-z0-9][a-z0-9-]{5,})\b/gi) || []).find(w => /\d|-/.test(w)) || "";
    tags.push({ svc, name });
  });
  if (!tags.length && text) return el("div", { className: "services" }, el("span", { className: "svc", textContent: text }));
  return el("div", { className: "services" }, tags.map(t =>
    el("span", { className: "svc " + t.svc.key, title: text }, el("b", { textContent: t.svc.short }), t.name || t.svc.name)));
}

/* ---------- chat ---------- */

// Text only: `code` spans and line breaks; never HTML from the reply.
function render(target, text) {
  text.split(/(`[^`\n]+`)/).forEach(part => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      target.appendChild(el("code", { textContent: part.slice(1, -1) }));
    } else if (part) {
      target.appendChild(document.createTextNode(part.replace(/\*\*(.+?)\*\*/g, "$1")));
    }
  });
}

function toolLabel(c) {
  const v = c.verdict && c.verdict !== "unknown" ? c.verdict : c.status;
  return [c.name || c.type.replace(/_call$/, ""), v].filter(Boolean).join(" · ");
}

function add(kind, text, tools, reference) {
  document.querySelector(".welcome")?.remove();
  const who = { user: "You", agent: agentName, error: "Error" }[kind];
  const b = el("div", { className: "bubble" });
  render(b, text);
  const m = el("div", { className: "msg " + kind }, el("span", { className: "who", textContent: who }), b);
  if (reference) m.appendChild(el("div", { className: "ref", textContent: "Reference " + reference }));
  if (tools && tools.length) {
    m.appendChild(el("div", { className: "tools" },
      tools.map(c => el("span", { className: "tool " + (c.verdict || c.status || ""), textContent: toolLabel(c) }))));
    tools.filter(c => c.output).forEach(c => {
      m.appendChild(el("details", { className: "result" },
        el("summary", { textContent: "Tool result · " + (c.name || c.type) }),
        el("pre", { textContent: c.output })));
    });
  }
  log.appendChild(m);
  scroll.scrollTop = scroll.scrollHeight;
  return m;
}

function welcome() {
  const mark = document.querySelector(".brand .mark").cloneNode(true);
  log.replaceChildren(el("div", { className: "welcome" },
    mark,
    el("h2", { textContent: "Talk to " + agentName }),
    el("p", { textContent: "Pick a prompt from the library, or type your own. After you change a policy in AuthSec, " +
      "start a new chat: in the same chat the agent may answer from what it already fetched." })));
}

async function chatOnce(text, conversationId) {
  return api("/api/chat", { method: "POST", json: { message: text, conversation_id: conversationId } });
}

async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true; send.disabled = true;
  add("user", text);
  input.value = ""; grow();
  const wait = add("agent", "Working");
  wait.querySelector(".bubble").classList.add("thinking");
  try {
    const { ok, status, data } = await chatOnce(text, conversation);
    wait.remove();
    if (!ok) {
      if (status === 404 || status === 400) conversation = "";
      add("error", data.error || ("Error " + status), null, data.reference);
      return;
    }
    conversation = data.conversation_id;
    add("agent", data.reply || "(no text in the reply)", data.tools);
  } catch {
    wait.remove();
    add("error", "Cannot reach the chat server. Check your connection and try again.");
  } finally {
    busy = false; send.disabled = false; input.focus();
  }
}

function grow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

/* ---------- prompt library (chat sidebar) ---------- */

function renderLibrary() {
  const q = $("libSearch").value.trim().toLowerCase();
  const shown = prompts.filter(p => !q || [p.title, p.resource, p.text].join(" ").toLowerCase().includes(q));
  $("libCount").textContent = q ? `${shown.length} of ${prompts.length}` : String(prompts.length);
  const list = $("libList");
  list.replaceChildren();
  shown.forEach(p => {
    const text = el("p", { className: "lib-text", textContent: p.text });
    const item = el("li", { className: "lib-item" });
    const more = el("button", { type: "button", className: "more", textContent: "Show all" });
    more.addEventListener("click", () => {
      const open = item.classList.toggle("open");
      more.textContent = open ? "Show less" : "Show all";
    });
    const use = el("button", { type: "button", className: "ghost", textContent: "Edit first" });
    use.title = "Put the prompt in the message box";
    use.addEventListener("click", () => { input.value = p.text; grow(); input.focus(); closeLibrary(); });
    const go = el("button", { type: "button", className: "primary", textContent: "Send" });
    go.addEventListener("click", () => { closeLibrary(); ask(p.text); });
    item.append(el("h3", { textContent: p.title }), serviceTags(p.resource), text, el("div", { className: "lib-actions" }, more, use, go));
    list.appendChild(item);
  });
  if (!shown.length) list.appendChild(el("li", { className: "lib-empty", textContent: q ? "No prompt matches." : "The library is empty." }));
}
$("libSearch").addEventListener("input", renderLibrary);

function closeLibrary() {
  $("library").classList.remove("open");
  $("libToggle").setAttribute("aria-expanded", "false");
}
$("libToggle").addEventListener("click", () => {
  const open = $("library").classList.toggle("open");
  $("libToggle").setAttribute("aria-expanded", String(open));
});

/* ---------- views ---------- */

function show(view) {
  $("chatView").hidden = view !== "chat";
  $("runnerView").hidden = view !== "runner";
  $("new").hidden = view !== "chat";
  $("libToggle").hidden = view !== "chat";
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  local.set("view", view);
  history.replaceState(null, "", view === "runner" ? "#runner" : location.pathname);
  if (view === "chat") input.focus();
}

/* ---------- catalog ---------- */

const selected = new Set(JSON.parse(local.get("selected") || "[]"));
function saveSelection() { local.set("selected", JSON.stringify([...selected])); }

async function loadPrompts() {
  const { ok, data } = await api("/api/prompts");
  if (!ok) return;
  prompts = data.prompts || [];
  editable = !!data.editable;
  [...selected].forEach(id => { if (!prompts.some(p => p.id === id)) selected.delete(id); });
  renderCatalog();
  renderLibrary();
}

function renderCatalog() {
  const list = $("catalog");
  list.replaceChildren();
  prompts.forEach(p => {
    const box = el("input", { type: "checkbox", checked: selected.has(p.id), disabled: running });
    box.setAttribute("aria-label", "Select " + p.title);
    box.addEventListener("change", () => {
      box.checked ? selected.add(p.id) : selected.delete(p.id);
      saveSelection(); renderCatalog();
    });
    const actions = el("div", { className: "actions" });
    if (adminCode) {
      const edit = el("button", { type: "button", className: "ghost", textContent: "Edit", disabled: running });
      edit.addEventListener("click", () => openEditor(p));
      const del = el("button", { type: "button", className: "danger", textContent: "Delete", disabled: running });
      del.addEventListener("click", () => removePrompt(p));
      actions.append(edit, del);
    }
    list.appendChild(el("li", { className: selected.has(p.id) ? "on" : "" },
      box,
      el("div", {}, el("div", { className: "title", textContent: p.title }), serviceTags(p.resource)),
      actions,
      el("details", {}, el("summary", { textContent: "Prompt text" }), el("p", { textContent: p.text }))));
  });
  if (!prompts.length) list.appendChild(el("li", { className: "lib-empty", textContent: "The catalog is empty." }));

  const n = prompts.filter(p => selected.has(p.id)).length;
  $("all").checked = n > 0 && n === prompts.length;
  $("all").indeterminate = n > 0 && n < prompts.length;
  $("all").disabled = running;
  $("run").disabled = running || n === 0;
  $("run").textContent = n ? `Run selected (${n})` : "Run selected";
  $("stop").hidden = !running;
  $("addBtn").hidden = !adminCode || running;
  $("resetBtn").hidden = !adminCode || running;
  $("adminBtn").hidden = !editable || !!adminCode;
  $("adminState").textContent = adminCode ? "Editing on" : "";
}

$("all").addEventListener("change", e => {
  prompts.forEach(p => e.target.checked ? selected.add(p.id) : selected.delete(p.id));
  saveSelection(); renderCatalog();
});

/* admin: unlock, add, edit, delete, reset */

$("adminBtn").addEventListener("click", async () => {
  const field = $("adminPass");
  if (field.hidden) { field.hidden = false; field.focus(); return; }
  await unlock();
});
$("adminPass").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); unlock(); } });

async function unlock() {
  const field = $("adminPass");
  if (!field.value) { field.focus(); return; }
  adminCode = field.value;
  const { ok, data } = await api("/api/admin/check", { method: "POST", json: {} });
  if (!ok) {
    adminCode = "";
    $("adminState").textContent = data.error || "Wrong admin passcode.";
    field.select();
    return;
  }
  store.set("admin", adminCode);
  field.value = ""; field.hidden = true;
  renderCatalog();
}

function openEditor(p) {
  editing = p ? p.id : "";
  $("edTitle").value = p ? p.title : "";
  $("edResource").value = p ? (p.resource || "") : "";
  $("edText").value = p ? p.text : "";
  $("edError").textContent = "";
  $("editor").hidden = false;
  $("edTitle").focus();
}
$("addBtn").addEventListener("click", () => openEditor(null));
$("edCancel").addEventListener("click", () => { $("editor").hidden = true; editing = null; });

$("editor").addEventListener("submit", async e => {
  e.preventDefault();
  const body = { title: $("edTitle").value, resource: $("edResource").value, text: $("edText").value };
  const r = editing
    ? await api("/api/prompts/" + editing, { method: "PUT", json: body })
    : await api("/api/prompts", { method: "POST", json: body });
  if (!r.ok) { $("edError").textContent = r.data.error || ("Error " + r.status); return; }
  if (!editing) { selected.add(r.data.prompt.id); saveSelection(); }
  $("editor").hidden = true; editing = null;
  await loadPrompts();
});

async function removePrompt(p) {
  if (!confirm(`Delete "${p.title}" from the shared catalog?`)) return;
  const r = await api("/api/prompts/" + p.id, { method: "DELETE" });
  if (!r.ok) { alert(r.data.error || ("Error " + r.status)); return; }
  selected.delete(p.id); saveSelection();
  await loadPrompts();
}

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Replace the shared catalog with the default prompts P1–P6?")) return;
  const r = await api("/api/prompts/reset", { method: "POST", json: {} });
  if (!r.ok) { alert(r.data.error || ("Error " + r.status)); return; }
  await loadPrompts();
});

/* ---------- runner ---------- */

const results = $("results");

function outcome(tools) {
  if (!tools.length) return "no tool";
  if (tools.some(t => t.verdict === "denied")) return "denied";
  if (tools.some(t => t.verdict === "failed")) return "failed";
  if (tools.every(t => t.verdict === "allowed")) return "allowed";
  return "unknown";
}

// One card per prompt: title, outcome and tools on top, the whole reply below.
function resultCard(p) {
  const card = {
    status: el("span", { className: "pill running", textContent: "Waiting" }),
    tools: el("span", { className: "bar" }),
    body: el("div", {}),
    waiting: true,
  };
  card.root = el("article", { className: "result-card" },
    el("div", { className: "result-head" },
      el("span", { className: "title", textContent: p.title }), card.status, card.tools, serviceTags(p.resource)),
    card.body);
  results.appendChild(card.root);
  return card;
}

function setStatus(card, kind, label) {
  card.status.className = "pill " + kind;
  card.status.textContent = label;
}

function fill(card, kind, label, tools, reply, reference) {
  card.waiting = false;
  card.root.className = "result-card " + kind;
  setStatus(card, kind, label);
  card.tools.replaceChildren(...(tools || []).map(c =>
    el("span", { className: "tool " + (c.verdict || ""), textContent: toolLabel(c) })));
  const parts = [];
  if (reply) parts.push(el("div", { className: "reply-block", textContent: reply }));
  const withOutput = (tools || []).filter(c => c.output);
  if (withOutput.length) {
    parts.push(el("details", {},
      el("summary", { textContent: `Tool results (${withOutput.length})` }),
      withOutput.map(c => el("pre", { textContent: (c.name || c.type) + "\n" + c.output }))));
  }
  if (reference) parts.push(el("div", { className: "muted small mono", textContent: "Reference " + reference }));
  card.body.replaceChildren(...parts);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runOne(p, card) {
  for (let attempt = 0; attempt < 5; attempt++) {
    setStatus(card, "running", "Running");
    let r;
    try {
      r = await chatOnce(p.text, "");   // a new chat for every prompt
    } catch {
      fill(card, "error", "Error", [], "Cannot reach the chat server.");
      return;
    }
    if (r.status === 429 && !stopRequested) {
      const wait = Math.min(Number(r.data.retry_after) || 30, 600);
      for (let s = wait; s > 0 && !stopRequested; s--) {
        setStatus(card, "running", `Rate limited · ${s}s`);
        await sleep(1000);
      }
      continue;
    }
    if (!r.ok && r.data.verdict) {
      // A tool's own HTTP call failed: 401/403 is the block working, any
      // other status (409 Conflict…) got past authorization.
      const code = r.data.upstream_status;
      const label = r.data.verdict === "denied" ? `Denied · HTTP ${code}` : `Allowed · HTTP ${code}`;
      fill(card, r.data.verdict, label, [], r.data.error, r.data.reference);
      return;
    }
    if (!r.ok) { fill(card, "error", "Error", [], r.data.error || ("Error " + r.status), r.data.reference); return; }
    const kind = outcome(r.data.tools || []);
    const label = { allowed: "Allowed", denied: "Denied", failed: "Failed", unknown: "Read reply", "no tool": "No tool called" }[kind];
    fill(card, kind === "no tool" || kind === "unknown" ? "" : kind, label, r.data.tools, r.data.reply || "(no text in the reply)");
    return;
  }
  fill(card, "error", "Error", [], "Still rate limited after several tries.");
}

$("run").addEventListener("click", async () => {
  const batch = prompts.filter(p => selected.has(p.id));
  if (!batch.length || running) return;
  running = true; stopRequested = false;
  renderCatalog();
  results.replaceChildren();
  const cards = batch.map(resultCard);
  const started = new Date();
  for (let i = 0; i < batch.length && !stopRequested; i++) {
    $("runState").textContent = `Running ${i + 1} of ${batch.length}`;
    await runOne(batch[i], cards[i]);
  }
  cards.forEach(c => { if (c.waiting) fill(c, "", "Skipped", [], ""); });
  const counts = cards.reduce((a, c) => {
    const k = c.root.classList.contains("allowed") ? "allowed" : c.root.classList.contains("denied") ? "denied" : "other";
    a[k]++; return a;
  }, { allowed: 0, denied: 0, other: 0 });
  $("runState").textContent = `${stopRequested ? "Stopped" : "Finished"} · ${counts.allowed} allowed · ${counts.denied} denied` +
    (counts.other ? ` · ${counts.other} other` : "") + ` · started ${started.toLocaleTimeString()}`;
  running = false;
  renderCatalog();
});

$("stop").addEventListener("click", () => { stopRequested = true; $("stop").disabled = true; setTimeout(() => { $("stop").disabled = false; }, 500); });
$("clear").addEventListener("click", () => {
  if (running) return;
  results.replaceChildren();
  $("runState").textContent = "No run yet.";
});

/* ---------- start ---------- */

$("form").addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
});
input.addEventListener("input", grow);
pass.addEventListener("change", () => store.set("passcode", pass.value));
$("new").addEventListener("click", () => { conversation = ""; welcome(); input.focus(); });
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));

welcome();
fetch("/api/config").then(r => r.json()).then(c => {
  agentName = c.agent;
  $("agent").textContent = c.agent;
  document.title = "AuthSec Agent Console · " + c.agent;
  if (c.passcode) { pass.hidden = false; pass.value = store.get("passcode"); }
  if (document.querySelector(".welcome")) welcome();
}).catch(() => { /* the header just stays generic */ });

(async () => {
  const saved = store.get("admin");
  if (saved) {
    adminCode = saved;
    const { ok } = await api("/api/admin/check", { method: "POST", json: {} });
    if (!ok) { adminCode = ""; store.set("admin", ""); }
  }
  await loadPrompts();
})();

show(location.hash === "#runner" || (!location.hash && local.get("view") === "runner") ? "runner" : "chat");
