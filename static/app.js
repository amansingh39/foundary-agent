"use strict";

const $ = id => document.getElementById(id);
const log = $("log");
const scroll = $("scroll");
const input = $("input");
const send = $("send");
const pass = $("pass");

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
  children.flat().forEach(c => e.append(c));
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
  return [c.type.replace(/_call$/, ""), c.name, v].filter(Boolean).join(" · ");
}

function add(kind, text, tools, reference) {
  document.querySelector(".empty")?.remove();
  const m = el("div", { className: "msg " + kind });
  const b = el("div", { className: "bubble" });
  render(b, text);
  m.appendChild(b);
  if (reference) m.appendChild(el("div", { className: "ref", textContent: "Reference: " + reference }));
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

function empty() {
  log.replaceChildren();
  const g = el("div", { className: "suggest" });
  prompts.slice(0, 6).forEach(p => {
    const b = el("button", { type: "button" }, el("b", { textContent: p.title }), p.resource || "");
    b.addEventListener("click", () => ask(p.text));
    g.appendChild(b);
  });
  log.appendChild(el("div", { className: "empty" },
    el("h2", { textContent: "Ask the agent something" }),
    el("p", { textContent: "Pick a test prompt or type your own. After you change a policy in AuthSec, " +
      "start a New chat: in the same chat the agent may answer from what it already fetched." }),
    g));
}

async function chatOnce(text, conversationId) {
  const r = await api("/api/chat", { method: "POST", json: { message: text, conversation_id: conversationId } });
  return r;
}

async function ask(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true; send.disabled = true;
  add("user", text);
  input.value = ""; grow();
  const wait = add("agent", "Thinking…");
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
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

/* ---------- views ---------- */

function show(view) {
  $("chatView").hidden = view !== "chat";
  $("runnerView").hidden = view !== "runner";
  $("new").hidden = view !== "chat";
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  local.set("view", view);
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
  if (document.querySelector(".empty")) empty();  // refresh the chat's start buttons
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
      const edit = el("button", { type: "button", textContent: "Edit", disabled: running });
      edit.addEventListener("click", () => openEditor(p));
      const del = el("button", { type: "button", textContent: "Delete", disabled: running });
      del.addEventListener("click", () => removePrompt(p));
      actions.append(edit, del);
    }
    const li = el("li", { className: selected.has(p.id) ? "on" : "" },
      box,
      el("div", {}, el("div", { className: "title", textContent: p.title }), el("div", { className: "res", textContent: p.resource || "" })),
      actions,
      el("details", {}, el("summary", { textContent: "Prompt text" }), el("p", { textContent: p.text })));
    list.appendChild(li);
  });
  if (!prompts.length) list.appendChild(el("li", { className: "muted", textContent: "The catalog is empty." }));

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
    body: el("div", { className: "result-body" }),
    waiting: true,
  };
  card.root = el("article", { className: "result-card" },
    el("div", { className: "result-head" },
      el("span", { className: "title", textContent: p.title }), card.status, card.tools,
      el("span", { className: "res", textContent: p.resource || "" })),
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
    el("span", { className: "pill " + (c.verdict || ""), textContent: (c.name || c.type) + " · " + (c.verdict || c.status || "?") })));
  const parts = [];
  if (reply) parts.push(el("div", { className: "reply-block", textContent: reply }));
  const withOutput = (tools || []).filter(c => c.output);
  if (withOutput.length) {
    parts.push(el("details", {},
      el("summary", { textContent: `Tool results (${withOutput.length})` }),
      withOutput.map(c => el("pre", { textContent: (c.name || c.type) + "\n" + c.output }))));
  }
  if (reference) parts.push(el("div", { className: "muted small", textContent: "Reference: " + reference }));
  card.body.replaceChildren(...parts);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runOne(p, card) {
  for (let attempt = 0; attempt < 5; attempt++) {
    setStatus(card, "running", "Running…");
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
    $("runState").textContent = `${i + 1} of ${batch.length}…`;
    await runOne(batch[i], cards[i]);
  }
  cards.forEach(c => { if (c.waiting) fill(c, "", "Skipped", [], ""); });
  $("runState").textContent = (stopRequested ? "Stopped" : "Done") + " · started " + started.toLocaleTimeString();
  running = false;
  renderCatalog();
});

$("stop").addEventListener("click", () => { stopRequested = true; $("stop").disabled = true; setTimeout(() => { $("stop").disabled = false; }, 500); });
$("clear").addEventListener("click", () => {
  if (running) return;
  results.replaceChildren(el("p", { className: "muted", textContent: "No run yet." }));
  $("runState").textContent = "";
});

/* ---------- start ---------- */

$("form").addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
});
input.addEventListener("input", grow);
pass.addEventListener("change", () => store.set("passcode", pass.value));
$("new").addEventListener("click", () => { conversation = ""; empty(); input.focus(); });
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));

fetch("/api/config").then(r => r.json()).then(c => {
  $("agent").textContent = "· " + c.agent;
  document.title = c.agent + " · Agent Chat";
  if (c.passcode) { pass.hidden = false; pass.value = store.get("passcode"); }
}).catch(() => { /* the header just stays generic */ });

(async () => {
  const saved = store.get("admin");
  if (saved) {
    adminCode = saved;
    const { ok } = await api("/api/admin/check", { method: "POST", json: {} });
    if (!ok) { adminCode = ""; store.set("admin", ""); }
  }
  empty();
  await loadPrompts();
})();

show(local.get("view") === "runner" ? "runner" : "chat");
