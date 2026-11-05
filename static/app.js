"use strict";

// One prompt per resource the AuthSec access policies cover.
const SUGGESTIONS = [
  ["Key Vault · agentigatestkv01", "What is the partner portal API key?"],
  ["Table storage · agentigateststore01", "List the orders for customer C-001."],
  ["Table storage · write", "Create order O-2001 for customer C-001: 5 units of Widget Pro, status placed."],
  ["Azure SQL · iga-test-sql-server", "Which SQL databases are on iga-test-sql-server, and what is the status of free-sql-db-2354988?"],
  ["AI Search · authsec-sales-search", "Which products sold best last quarter? Name the source file."],
  ["Service Bus · agentigatestsb01", "Tell the account manager that customer C-001 just placed a large order."],
];

const log = document.getElementById("log");
const scroll = document.getElementById("scroll");
const input = document.getElementById("input");
const send = document.getElementById("send");
const pass = document.getElementById("pass");
let conversation = "";
let busy = false;

const store = {
  get(k) { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* storage off */ } },
};

// Text only: `code` spans and line breaks; never HTML from the reply.
function render(el, text) {
  text.split(/(`[^`\n]+`)/).forEach(part => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const c = document.createElement("code");
      c.textContent = part.slice(1, -1);
      el.appendChild(c);
    } else if (part) {
      el.appendChild(document.createTextNode(part.replace(/\*\*(.+?)\*\*/g, "$1")));
    }
  });
}

function add(kind, text, tools, reference) {
  document.querySelector(".empty")?.remove();
  const m = document.createElement("div");
  m.className = "msg " + kind;
  const b = document.createElement("div");
  b.className = "bubble";
  render(b, text);
  m.appendChild(b);
  if (reference) {
    const r = document.createElement("div");
    r.className = "ref";
    r.textContent = "Reference: " + reference;
    m.appendChild(r);
  }
  if (tools && tools.length) {
    const t = document.createElement("div");
    t.className = "tools";
    tools.forEach(c => {
      const s = document.createElement("span");
      s.className = "tool " + (c.status || "");
      s.textContent = [c.type.replace(/_call$/, ""), c.name, c.status].filter(Boolean).join(" · ");
      t.appendChild(s);
    });
    m.appendChild(t);
    tools.filter(c => c.output).forEach(c => {
      const d = document.createElement("details");
      d.className = "result";
      const s = document.createElement("summary");
      s.textContent = "Tool result · " + (c.name || c.type);
      const p = document.createElement("pre");
      p.textContent = c.output;
      d.append(s, p);
      m.appendChild(d);
    });
  }
  log.appendChild(m);
  scroll.scrollTop = scroll.scrollHeight;
  return m;
}

function empty() {
  log.replaceChildren();
  const e = document.createElement("div");
  e.className = "empty";
  const h = document.createElement("h2");
  h.textContent = "Ask the agent something";
  const p = document.createElement("p");
  p.textContent = "Each prompt makes the agent use one Azure resource. After you change a policy in AuthSec, " +
    "start a New chat: in the same chat the agent may answer from what it already fetched.";
  const g = document.createElement("div");
  g.className = "suggest";
  SUGGESTIONS.forEach(([label, text]) => {
    const b = document.createElement("button");
    b.type = "button";
    const l = document.createElement("b");
    l.textContent = label;
    b.append(l, text);
    b.addEventListener("click", () => ask(text));
    g.appendChild(b);
  });
  e.append(h, p, g);
  log.appendChild(e);
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
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Passcode": pass.value },
      body: JSON.stringify({ message: text, conversation_id: conversation }),
    });
    const data = await r.json().catch(() => ({ error: "The server sent an unreadable answer (" + r.status + ")." }));
    wait.remove();
    if (!r.ok) {
      if (r.status === 404 || r.status === 400) conversation = "";
      add("error", data.error || ("Error " + r.status), null, data.reference);
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

document.getElementById("form").addEventListener("submit", e => { e.preventDefault(); ask(input.value); });
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); }
});
input.addEventListener("input", grow);
pass.addEventListener("change", () => store.set("passcode", pass.value));
document.getElementById("new").addEventListener("click", () => { conversation = ""; empty(); input.focus(); });

fetch("/api/config").then(r => r.json()).then(c => {
  document.getElementById("agent").textContent = "· " + c.agent;
  document.title = c.agent + " · Agent Chat";
  if (c.passcode) { pass.hidden = false; pass.value = store.get("passcode"); }
}).catch(() => { /* the header just stays generic */ });

empty();
input.focus();
